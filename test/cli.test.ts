import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// generateFix is the only piece of the pipeline that needs live Claude
// credentials. Mocking just this module lets detect/, context/, and
// verify/ run for real (real esbuild compile, real jsdom render, real
// axe-core run) against a real fixture, so the test proves the CLI's
// wiring and its write/no-write behavior, not a hand-rolled fake.
vi.mock('../src/generate', () => ({
  generateFix: vi.fn(),
}));

// interactive.ts's real prompt flow (readline against process.stdin) is
// already covered by test/interactive.test.ts with injected streams; here
// we only need to prove runScan wires --interactive/--log-corrections
// through to scan() correctly, so the handler itself is mocked.
vi.mock('../src/cli/interactive', () => ({
  createInteractiveHandler: vi.fn(),
}));

import { generateFix } from '../src/generate';
import { runScan } from '../src/cli';
import { createInteractiveHandler } from '../src/cli/interactive';

const FIXTURE_SOURCE = `import * as React from 'react';

export default function MissingAlt() {
  return (
    <div>
      <h1>Gallery</h1>
      <img src="https://example.com/photo.jpg" />
    </div>
  );
}
`;

let tempDir: string;
let componentPath: string;

beforeEach(() => {
  // Scratch files must live inside the repo (not the OS temp dir): esbuild
  // resolves "react/jsx-runtime" by walking up from the compiled file's own
  // directory, and an OS temp dir has no node_modules tree above it to find.
  tempDir = mkdtempSync(path.join(__dirname, 'tmp-cli-'));
  componentPath = path.join(tempDir, 'MissingAlt.tsx');
  writeFileSync(componentPath, FIXTURE_SOURCE, 'utf8');
  vi.mocked(generateFix).mockReset();
  vi.mocked(createInteractiveHandler).mockReset();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('runScan', () => {
  it('prints confidence alongside the verified/unverified outcome in the human-readable output', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runScan(componentPath, {});
      const printed = logSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(printed).toContain(
        '[verified] fix confirmed (pass --write to apply) (confidence: high)',
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('applies a verified fix to disk when --write is passed', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    }));

    const summary = await runScan(componentPath, { write: true });

    expect(summary.violationsFound).toBe(1);
    expect(summary.verified).toBe(1);
    expect(summary.unverified).toBe(0);
    expect(process.exitCode).not.toBe(1);

    const written = readFileSync(componentPath, 'utf8');
    expect(written).toContain('alt="A scenic photo in the gallery"');
    expect(written).not.toBe(FIXTURE_SOURCE);
  });

  it('never writes an unverified fix to disk, even with --write', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      // Doesn't add alt text, so axe should still flag image-alt afterward.
      newSnippet: '<img src="https://example.com/photo.jpg" data-fixed="true" />',
    }));

    const summary = await runScan(componentPath, { write: true });

    expect(summary.violationsFound).toBe(1);
    expect(summary.verified).toBe(0);
    expect(summary.unverified).toBe(1);
    expect(process.exitCode).toBe(1);

    const untouched = readFileSync(componentPath, 'utf8');
    expect(untouched).toBe(FIXTURE_SOURCE);
  });

  it('reports a verified fix without writing it when --write is not passed', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    }));

    const summary = await runScan(componentPath, {});

    expect(summary.verified).toBe(1);
    // Nothing was written, so the violation is still unresolved on disk.
    expect(process.exitCode).toBe(1);

    const untouched = readFileSync(componentPath, 'utf8');
    expect(untouched).toBe(FIXTURE_SOURCE);
  });

  it('prints the full ScanResult as JSON, and nothing else, when --json is passed', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const summary = await runScan(componentPath, { json: true });
      expect(summary.verified).toBe(1);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = logSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(printed);

      expect(parsed.targetPath).toBe(componentPath);
      expect(parsed.filesScanned).toBe(1);
      expect(parsed.violations).toHaveLength(1);
      expect(parsed.violations[0].status).toBe('verified');
      expect(parsed.violations[0].violation.id).toBe('image-alt');
      expect(parsed.violations[0].context.element.location.startLine).toBeGreaterThan(0);
      expect(parsed.violations[0].patch.newSnippet).toContain('alt=');
      expect(parsed.violations[0].patch.confidence).toBe('high');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reports zero violations, and never calls generateFix, for a clean component', async () => {
    const cleanPath = path.join(tempDir, 'Clean.tsx');
    writeFileSync(
      cleanPath,
      [
        "import * as React from 'react';",
        '',
        'export default function Clean() {',
        '  return <img src="x.jpg" alt="x" />;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const summary = await runScan(cleanPath, {});

    expect(summary.violationsFound).toBe(0);
    expect(generateFix).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(1);
  });
});

describe('runScan --interactive / --log-corrections', () => {
  const GOOD_FIX =
    '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />';
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: GOOD_FIX,
    }));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
  });

  function mockHandler(onVerifiedFix: (...args: unknown[]) => unknown) {
    const close = vi.fn();
    vi.mocked(createInteractiveHandler).mockReturnValue({
      onVerifiedFix: onVerifiedFix as never,
      close,
    });
    return close;
  }

  it('wires --interactive through to scan(): an accepted fix is applied', async () => {
    const close = mockHandler(async () => ({ action: 'accept' }));

    const summary = await runScan(componentPath, { write: true, interactive: true });

    expect(summary.verified).toBe(1);
    expect(readFileSync(componentPath, 'utf8')).toContain('alt="A scenic photo in the gallery"');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the interactive handler even when scan() throws', async () => {
    const close = mockHandler(async () => ({ action: 'accept' }));

    await runScan(path.join(tempDir, 'does-not-exist.tsx'), { interactive: true });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects --interactive combined with --json before scanning at all', async () => {
    mockHandler(async () => ({ action: 'accept' }));

    const summary = await runScan(componentPath, { interactive: true, json: true });

    expect(summary.violationsFound).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(generateFix).not.toHaveBeenCalled();
  });

  it('logs a rejected fix to .a11y-autofix/corrections.log, fully local, when --log-corrections is set', async () => {
    mockHandler(async () => ({ action: 'reject' }));
    process.chdir(tempDir);

    await runScan(componentPath, { interactive: true, logCorrections: true });

    const logPath = path.join(tempDir, '.a11y-autofix', 'corrections.log');
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(entry.action).toBe('rejected');
    expect(entry.violationId).toBe('image-alt');
    expect(entry.suggested).toBe(GOOD_FIX);
    expect(entry.edited).toBeUndefined();

    // The self-contained .gitignore is written alongside it.
    const gitignore = readFileSync(path.join(tempDir, '.a11y-autofix', '.gitignore'), 'utf8');
    expect(gitignore.trim()).toBe('*');
  });

  it('logs an edited fix with both the suggested and edited text', async () => {
    const EDITED = '<img src="https://example.com/photo.jpg" alt="A team outing" />';
    mockHandler(async () => ({ action: 'edit', newSnippet: EDITED }));
    process.chdir(tempDir);

    await runScan(componentPath, { interactive: true, write: true, logCorrections: true });

    const logPath = path.join(tempDir, '.a11y-autofix', 'corrections.log');
    const entry = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(entry.action).toBe('edited');
    expect(entry.suggested).toBe(GOOD_FIX);
    expect(entry.edited).toBe(EDITED);
  });

  it('does not log an accepted fix — only rejections and edits are corrections', async () => {
    mockHandler(async () => ({ action: 'accept' }));
    process.chdir(tempDir);

    await runScan(componentPath, { interactive: true, write: true, logCorrections: true });

    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(tempDir, '.a11y-autofix', 'corrections.log'))).toBe(false);
  });

  it('warns and does not log anything when --log-corrections is passed without --interactive', async () => {
    process.chdir(tempDir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runScan(componentPath, { write: true, logCorrections: true });

    // Assert before restoring: mockRestore() also clears the recorded
    // call history, so checking after it would always see zero calls.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('--log-corrections has no effect'),
    );
    errorSpy.mockRestore();

    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(tempDir, '.a11y-autofix'))).toBe(false);
    expect(createInteractiveHandler).not.toHaveBeenCalled();
  });
});
