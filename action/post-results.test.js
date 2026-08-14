import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir;
let originalCwd;
let originalEnv;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'a11y-autofix-action-'));
  originalCwd = process.cwd();
  originalEnv = { ...process.env };
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('post-results main()', () => {
  it('posts an inline suggestion for an in-diff verified fix and a summary comment for an unverified one', async () => {
    const componentPath = path.join(tempDir, 'Card.tsx');
    writeFileSync(
      componentPath,
      ['import React from "react";', '', '<img src="x.jpg" />', ''].join('\n'),
      'utf8',
    );

    const eventPath = path.join(tempDir, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { number: 42, head: { sha: 'abc123' } } }),
      'utf8',
    );

    const resultFile = path.join(tempDir, 'result.json');
    writeFileSync(
      resultFile,
      JSON.stringify({
        targetPath: tempDir,
        filesScanned: 1,
        violations: [
          {
            filePath: componentPath,
            status: 'verified',
            violation: {
              id: 'image-alt',
              impact: 'critical',
              help: 'Images must have alternative text',
              helpUrl: 'https://dequeuniversity.com/rules/axe/image-alt',
            },
            context: { element: { location: { startLine: 3, endLine: 3 } } },
            patch: {
              oldSnippet: '<img src="x.jpg" />',
              newSnippet: '<img src="x.jpg" alt="x" />',
              confidence: 'high',
            },
            verification: { remainingViolations: [], newViolations: [] },
            applied: false,
          },
          {
            filePath: componentPath,
            status: 'unverified',
            violation: { id: 'label', impact: 'serious', help: 'Form elements must have labels' },
            context: { element: { location: { startLine: 1, endLine: 1 } } },
            patch: {
              oldSnippet: 'import React from "react";',
              newSnippet: 'import React from "react"; // x',
            },
            verification: {
              remainingViolations: [{ id: 'label' }],
              newViolations: [],
            },
            applied: false,
          },
        ],
      }),
      'utf8',
    );

    process.env.GITHUB_TOKEN = 'fake-token';
    process.env.RESULT_FILE = resultFile;
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = 'octocat/example';
    process.env.REVIEW_EVENT = 'COMMENT';

    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        calls.push({
          url: String(url),
          method: options.method,
          body: options.body ? JSON.parse(options.body) : null,
        });

        if (String(url).includes('/pulls/42/files')) {
          if (String(url).includes('page=2')) return jsonResponse([]);
          return jsonResponse([
            { filename: 'Card.tsx', patch: '@@ -1,4 +1,4 @@\n line1\n line2\n+line3\n line4' },
          ]);
        }
        if (String(url).includes('/pulls/42/reviews')) {
          return jsonResponse({ id: 1 });
        }
        if (String(url).includes('/issues/42/comments') && options.method === 'GET') {
          if (String(url).includes('page=2')) return jsonResponse([]);
          return jsonResponse([]);
        }
        if (String(url).includes('/issues/42/comments') && options.method === 'POST') {
          return jsonResponse({ id: 99 });
        }
        throw new Error(`Unexpected fetch call: ${options.method} ${url}`);
      }),
    );

    const { main } = await import('./post-results.js');
    await main();

    const reviewCall = calls.find((c) => c.url.includes('/reviews'));
    expect(reviewCall).toBeDefined();
    expect(reviewCall.body.commit_id).toBe('abc123');
    expect(reviewCall.body.event).toBe('COMMENT');
    expect(reviewCall.body.comments).toHaveLength(1);
    expect(reviewCall.body.comments[0].path).toBe('Card.tsx');
    expect(reviewCall.body.comments[0].line).toBe(3);
    expect(reviewCall.body.comments[0].body).toContain(
      '```suggestion\n<img src="x.jpg" alt="x" />\n```',
    );

    const summaryCall = calls.find(
      (c) => c.url.includes('/issues/42/comments') && c.method === 'POST',
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall.body.body).toContain('1 verified fix');
    expect(summaryCall.body.body).toContain('1 issue needs manual review');
    expect(summaryCall.body.body).toContain('Card.tsx:1');
  });

  it('updates the existing sticky comment instead of creating a new one', async () => {
    const eventPath = path.join(tempDir, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { number: 7, head: { sha: 'sha1' } } }),
      'utf8',
    );

    const resultFile = path.join(tempDir, 'result.json');
    writeFileSync(
      resultFile,
      JSON.stringify({ targetPath: tempDir, filesScanned: 0, violations: [] }),
      'utf8',
    );

    process.env.GITHUB_TOKEN = 'fake-token';
    process.env.RESULT_FILE = resultFile;
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = 'octocat/example';

    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, options) => {
        calls.push({
          url: String(url),
          method: options.method,
          body: options.body ? JSON.parse(options.body) : null,
        });

        if (String(url).includes('/pulls/7/files')) return jsonResponse([]);
        if (String(url).includes('/issues/7/comments') && options.method === 'GET') {
          if (String(url).includes('page=2')) return jsonResponse([]);
          return jsonResponse([{ id: 55, body: '<!-- a11y-autofix-summary -->\nold content' }]);
        }
        if (String(url).includes('/issues/comments/55') && options.method === 'PATCH') {
          return jsonResponse({ id: 55 });
        }
        throw new Error(`Unexpected fetch call: ${options.method} ${url}`);
      }),
    );

    const { main } = await import('./post-results.js');
    await main();

    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall.url).toContain('/issues/comments/55');
    expect(patchCall.body.body).toContain('No accessibility violations found');
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/comments'))).toBe(false);
  });

  it('skips posting entirely when the event is not a pull_request', async () => {
    const eventPath = path.join(tempDir, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ push: {} }), 'utf8');

    process.env.GITHUB_TOKEN = 'fake-token';
    process.env.RESULT_FILE = path.join(tempDir, 'result.json');
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = 'octocat/example';

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { main } = await import('./post-results.js');
    await main();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
