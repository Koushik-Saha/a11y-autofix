import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// generateFix is the only piece of the pipeline that needs live Claude
// credentials. Mocking just this module lets detect/, context/, and
// verify/ run for real against a real fixture.
vi.mock('../src/generate', () => ({
  generateFix: vi.fn(),
}));

import { generateFix } from '../src/generate';
import { scan } from '../src/scan';

const MISSING_ALT_SOURCE = `import * as React from 'react';

export default function MissingAlt() {
  return (
    <div>
      <h1>Gallery</h1>
      <img src="https://example.com/photo.jpg" />
    </div>
  );
}
`;

const CLEAN_SOURCE = [
  "import * as React from 'react';",
  '',
  'export default function Clean() {',
  '  return <img src="x.jpg" alt="x" />;',
  '}',
  '',
].join('\n');

let tempDir: string;
let componentPath: string;

beforeEach(() => {
  // Must live inside the repo, not the OS temp dir: esbuild resolves
  // "react/jsx-runtime" by walking up from the compiled file's own
  // directory, and an OS temp dir has no node_modules tree above it.
  tempDir = mkdtempSync(path.join(__dirname, 'tmp-scan-'));
  componentPath = path.join(tempDir, 'MissingAlt.tsx');
  writeFileSync(componentPath, MISSING_ALT_SOURCE, 'utf8');
  vi.mocked(generateFix).mockReset();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('scan', () => {
  it('returns a verified result and applies the fix to disk when write is true', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    }));

    const result = await scan(componentPath, { write: true });

    expect(result.filesScanned).toBe(1);
    expect(result.violations).toHaveLength(1);

    const entry = result.violations[0]!;
    expect(entry.status).toBe('verified');
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.applied).toBe(true);
    expect(entry.violation.id).toBe('image-alt');
    expect(entry.patch.newSnippet).toContain('alt="A scenic photo in the gallery"');
    expect(entry.verification.remainingViolations).toEqual([]);

    expect(readFileSync(componentPath, 'utf8')).toContain('alt="A scenic photo in the gallery"');
  });

  it('returns an unverified result and never writes to disk, even when write is true', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" data-fixed="true" />',
    }));

    const result = await scan(componentPath, { write: true });

    const entry = result.violations[0]!;
    expect(entry.status).toBe('unverified');
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.applied).toBe(false);
    expect(entry.verification.remainingViolations.map((v) => v.id)).toContain('image-alt');

    expect(readFileSync(componentPath, 'utf8')).toBe(MISSING_ALT_SOURCE);
  });

  it('does not apply a verified fix when write is not requested', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    }));

    const result = await scan(componentPath);

    const entry = result.violations[0]!;
    expect(entry.status).toBe('verified');
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.applied).toBe(false);
    expect(readFileSync(componentPath, 'utf8')).toBe(MISSING_ALT_SOURCE);
  });

  it('captures a generateFix failure as an errored result instead of throwing', async () => {
    vi.mocked(generateFix).mockRejectedValue(new Error('Claude API unavailable'));

    const result = await scan(componentPath);

    const entry = result.violations[0]!;
    expect(entry.status).toBe('errored');
    if (entry.status !== 'errored') throw new Error('expected an errored result');
    expect(entry.error).toContain('Claude API unavailable');
  });

  it('scans every component file in a directory and reports zero violations for clean ones', async () => {
    writeFileSync(path.join(tempDir, 'Clean.tsx'), CLEAN_SOURCE, 'utf8');
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    }));

    const result = await scan(tempDir, { write: true });

    expect(result.filesScanned).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.filePath).toBe(componentPath);
  });

  it('throws when the target path does not exist', async () => {
    await expect(scan(path.join(tempDir, 'does-not-exist.tsx'))).rejects.toThrow();
  });
});
