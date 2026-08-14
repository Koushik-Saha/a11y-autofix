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
    expect(entry.patch.confidence).toBe('high');
    expect(entry.verification.remainingViolations).toEqual([]);
    expect(generateFix).toHaveBeenCalledTimes(1);

    expect(readFileSync(componentPath, 'utf8')).toContain('alt="A scenic photo in the gallery"');
  });

  it('returns an unverified, low-confidence result and never writes to disk, even when write is true', async () => {
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
    expect(entry.patch.confidence).toBe('low');
    expect(entry.verification.remainingViolations.map((v) => v.id)).toContain('image-alt');
    // Both the first attempt and the retry failed verification.
    expect(generateFix).toHaveBeenCalledTimes(2);

    expect(readFileSync(componentPath, 'utf8')).toBe(MISSING_ALT_SOURCE);
  });

  it('retries once and reports medium confidence when the first attempt fails but the retry succeeds', async () => {
    vi.mocked(generateFix)
      .mockImplementationOnce(async ({ context }) => ({
        filePath: context.componentPath,
        violationId: context.violation.id,
        oldSnippet: context.element.code,
        newSnippet: '<img src="https://example.com/photo.jpg" data-fixed="true" />',
      }))
      .mockImplementationOnce(async ({ context }) => ({
        filePath: context.componentPath,
        violationId: context.violation.id,
        oldSnippet: context.element.code,
        newSnippet:
          '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
      }));

    const result = await scan(componentPath);

    const entry = result.violations[0]!;
    expect(entry.status).toBe('verified');
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.patch.confidence).toBe('medium');
    expect(entry.patch.newSnippet).toContain('alt="A scenic photo in the gallery"');
    expect(generateFix).toHaveBeenCalledTimes(2);

    // The retry call was told about the first attempt's failure.
    const retryOptions = vi.mocked(generateFix).mock.calls[1]?.[0];
    expect(retryOptions?.previousAttempt?.newSnippet).toContain('data-fixed="true"');
    expect(retryOptions?.previousAttempt?.remainingViolations.map((v) => v.id)).toContain(
      'image-alt',
    );
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
    // A thrown error isn't a failed verification, so it doesn't get retried.
    expect(generateFix).toHaveBeenCalledTimes(1);
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

describe('scan interactive decisions (onVerifiedFix / onFixResolved)', () => {
  const GOOD_FIX =
    '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />';
  const BAD_FIX = '<img src="https://example.com/photo.jpg" data-fixed="true" />';
  const EDITED_GOOD_FIX = '<img src="https://example.com/photo.jpg" alt="A user-edited caption" />';

  beforeEach(() => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: GOOD_FIX,
    }));
  });

  it('applies the suggestion and reports it accepted when onVerifiedFix accepts', async () => {
    const onVerifiedFix = vi.fn().mockResolvedValue({ action: 'accept' });
    const onFixResolved = vi.fn();

    const result = await scan(componentPath, { write: true, onVerifiedFix, onFixResolved });

    const entry = result.violations[0]!;
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.applied).toBe(true);
    expect(entry.patch.newSnippet).toBe(GOOD_FIX);
    expect(readFileSync(componentPath, 'utf8')).toContain('alt="A scenic photo in the gallery"');

    expect(onVerifiedFix).toHaveBeenCalledTimes(1);
    expect(onFixResolved).toHaveBeenCalledTimes(1);
    expect(onFixResolved.mock.calls[0]![0]).toMatchObject({ outcome: 'accepted' });
  });

  it('does not write to disk on accept when write is not passed, even with onVerifiedFix set', async () => {
    const onVerifiedFix = vi.fn().mockResolvedValue({ action: 'accept' });

    const result = await scan(componentPath, { onVerifiedFix });

    const entry = result.violations[0]!;
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.applied).toBe(false);
    expect(readFileSync(componentPath, 'utf8')).toBe(MISSING_ALT_SOURCE);
  });

  it('never writes anything and reports the original suggestion when onVerifiedFix rejects', async () => {
    const onVerifiedFix = vi.fn().mockResolvedValue({ action: 'reject' });
    const onFixResolved = vi.fn();

    const result = await scan(componentPath, { write: true, onVerifiedFix, onFixResolved });

    const entry = result.violations[0]!;
    expect(entry.status).toBe('verified');
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.applied).toBe(false);
    // The original (verified) suggestion is still reported, not discarded.
    expect(entry.patch.newSnippet).toBe(GOOD_FIX);
    expect(readFileSync(componentPath, 'utf8')).toBe(MISSING_ALT_SOURCE);

    expect(onFixResolved).toHaveBeenCalledTimes(1);
    expect(onFixResolved.mock.calls[0]![0]).toMatchObject({
      outcome: 'rejected',
      suggested: { newSnippet: GOOD_FIX },
    });
  });

  it('re-verifies an edit before applying it, and applies the edited text on success', async () => {
    const onVerifiedFix = vi
      .fn()
      .mockResolvedValue({ action: 'edit', newSnippet: EDITED_GOOD_FIX });
    const onFixResolved = vi.fn();

    const result = await scan(componentPath, { write: true, onVerifiedFix, onFixResolved });

    const entry = result.violations[0]!;
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.status).toBe('verified');
    expect(entry.applied).toBe(true);
    expect(entry.patch.newSnippet).toBe(EDITED_GOOD_FIX);
    expect(readFileSync(componentPath, 'utf8')).toContain('A user-edited caption');

    expect(onFixResolved).toHaveBeenCalledTimes(1);
    expect(onFixResolved.mock.calls[0]![0]).toMatchObject({
      outcome: 'edited',
      editedSnippet: EDITED_GOOD_FIX,
    });
  });

  it('never applies an unverified edit — asks again with editRejected, and a later accept applies the original, not the failed edit', async () => {
    const onVerifiedFix = vi
      .fn()
      .mockResolvedValueOnce({ action: 'edit', newSnippet: BAD_FIX })
      .mockResolvedValueOnce({ action: 'accept' });
    const onFixResolved = vi.fn();

    const result = await scan(componentPath, { write: true, onVerifiedFix, onFixResolved });

    const entry = result.violations[0]!;
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    // Accepted the ORIGINAL suggestion, not the failed edit attempt.
    expect(entry.patch.newSnippet).toBe(GOOD_FIX);
    expect(entry.applied).toBe(true);
    expect(readFileSync(componentPath, 'utf8')).toContain('alt="A scenic photo in the gallery"');
    expect(readFileSync(componentPath, 'utf8')).not.toContain('data-fixed');

    expect(onVerifiedFix).toHaveBeenCalledTimes(2);
    const secondCallContext = onVerifiedFix.mock.calls[1]![0];
    expect(secondCallContext.editRejected).toBeDefined();
    expect(
      secondCallContext.editRejected.remainingViolations.map((v: { id: string }) => v.id),
    ).toContain('image-alt');

    expect(onFixResolved).toHaveBeenCalledTimes(1);
    expect(onFixResolved.mock.calls[0]![0]).toMatchObject({ outcome: 'accepted' });
  });

  it('lets a second edit attempt succeed after the first one fails', async () => {
    const onVerifiedFix = vi
      .fn()
      .mockResolvedValueOnce({ action: 'edit', newSnippet: BAD_FIX })
      .mockResolvedValueOnce({ action: 'edit', newSnippet: EDITED_GOOD_FIX });

    const result = await scan(componentPath, { write: true, onVerifiedFix });

    const entry = result.violations[0]!;
    if (entry.status === 'errored') throw new Error('expected a fixed result');
    expect(entry.applied).toBe(true);
    expect(entry.patch.newSnippet).toBe(EDITED_GOOD_FIX);
    expect(onVerifiedFix).toHaveBeenCalledTimes(2);
  });

  it('rejecting after a failed edit reports the outcome as rejected, not edited', async () => {
    const onVerifiedFix = vi
      .fn()
      .mockResolvedValueOnce({ action: 'edit', newSnippet: BAD_FIX })
      .mockResolvedValueOnce({ action: 'reject' });
    const onFixResolved = vi.fn();

    await scan(componentPath, { write: true, onVerifiedFix, onFixResolved });

    expect(onFixResolved).toHaveBeenCalledTimes(1);
    expect(onFixResolved.mock.calls[0]![0]).toMatchObject({ outcome: 'rejected' });
  });

  it('never calls onVerifiedFix for an unverified violation', async () => {
    vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
      filePath: context.componentPath,
      violationId: context.violation.id,
      oldSnippet: context.element.code,
      newSnippet: BAD_FIX,
    }));
    const onVerifiedFix = vi.fn().mockResolvedValue({ action: 'accept' });

    const result = await scan(componentPath, { write: true, onVerifiedFix });

    expect(result.violations[0]!.status).toBe('unverified');
    expect(onVerifiedFix).not.toHaveBeenCalled();
  });
});
