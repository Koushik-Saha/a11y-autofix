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

import { generateFix } from '../src/generate';
import { runScan } from '../src/cli';

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
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('runScan', () => {
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
