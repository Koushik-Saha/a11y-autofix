import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { gatherContext } from '../src/context';
import { detectViolations } from '../src/detect';
import type { Patch } from '../src/generate';
import { verifyFix } from '../src/verify';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

describe('verifyFix', () => {
  it('marks a patch verified when it actually resolves the violation, with no regressions', async () => {
    const componentPath = fixture('MissingAlt.tsx');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const context = await gatherContext({ violation, componentPath });
    const patch: Patch = {
      filePath: context.componentPath,
      violationId: violation.id,
      oldSnippet: context.element.code,
      newSnippet: '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
    };

    // The source on disk is untouched by verification.
    const sourceBefore = readFileSync(context.componentPath, 'utf8');

    const result = await verifyFix({ patch, originalViolation: violation });

    expect(result.status).toBe('verified');
    expect(result.remainingViolations).toEqual([]);
    expect(result.newViolations).toEqual([]);
    expect(result.patch).toBe(patch);
    expect(result.targetViolation).toBe(violation);
    expect(readFileSync(context.componentPath, 'utf8')).toBe(sourceBefore);
  });

  it('marks a patch unverified when the violation is still present afterward', async () => {
    const componentPath = fixture('MissingAlt.tsx');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const context = await gatherContext({ violation, componentPath });
    const patch: Patch = {
      filePath: context.componentPath,
      violationId: violation.id,
      oldSnippet: context.element.code,
      // A no-op "fix" that changes something irrelevant and leaves the
      // image still missing alt text.
      newSnippet: '<img src="https://example.com/photo.jpg" data-fixed="true" />',
    };

    const result = await verifyFix({ patch, originalViolation: violation });

    expect(result.status).toBe('unverified');
    expect(result.remainingViolations).toHaveLength(1);
    expect(result.remainingViolations[0]?.id).toBe('image-alt');
    expect(result.newViolations).toEqual([]);
  });

  it('throws rather than silently guessing when the patch does not apply cleanly', async () => {
    const componentPath = fixture('MissingAlt.tsx');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const patch: Patch = {
      filePath: componentPath,
      violationId: violation.id,
      oldSnippet: '<img src="this text does not appear in the file" />',
      newSnippet: '<img src="https://example.com/photo.jpg" alt="fixed" />',
    };

    await expect(verifyFix({ patch, originalViolation: violation })).rejects.toThrow();
  });
});
