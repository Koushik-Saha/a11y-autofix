import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

// generateFix is the only piece needing live Claude credentials, so it's
// mocked here with a hand-authored "ideal" fix per violation type. That
// proves the rest of the pipeline (AST location in context/, patch
// application, re-verification in verify/) works correctly for each type;
// it does not evaluate generate/'s actual prompt quality, which needs a
// real model call — see PLAN.md for that limitation and how to re-check it
// once credentials are available.
vi.mock('../src/generate', () => ({
  generateFix: vi.fn(),
}));

import { gatherContext } from '../src/context';
import { detectViolations } from '../src/detect';
import { generateFix } from '../src/generate';
import { verifyFix } from '../src/verify';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

interface Case {
  label: string;
  fixtureName: string;
  violationId: string;
  buildFix: (oldSnippet: string) => string;
}

const cases: Case[] = [
  {
    label: 'alt text (image-alt)',
    fixtureName: 'MissingAlt.tsx',
    violationId: 'image-alt',
    buildFix: () =>
      '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
  },
  {
    label: 'form labels (label)',
    fixtureName: 'MissingLabel.tsx',
    violationId: 'label',
    buildFix: () => '<input type="text" name="email" aria-label="Email address" />',
  },
  {
    label: 'button names (button-name)',
    fixtureName: 'MissingButtonName.tsx',
    violationId: 'button-name',
    buildFix: (old) =>
      old.replace('<button onClick={() => {}}>', '<button onClick={() => {}} aria-label="Close">'),
  },
  {
    label: 'link names (link-name)',
    fixtureName: 'MissingLinkName.tsx',
    violationId: 'link-name',
    buildFix: () =>
      '<a href="/articles/wcag-2026-update">Read more: New accessibility guidelines released</a>',
  },
  {
    label: 'landmark roles (landmark-unique)',
    fixtureName: 'DuplicateLandmarks.tsx',
    violationId: 'landmark-unique',
    buildFix: (old) => old.replace('<nav>', '<nav aria-label="Primary">'),
  },
];

describe('pipeline end-to-end across the 5 target violation types', () => {
  it.each(cases)(
    'detects and verifies a fix for $label',
    async ({ fixtureName, violationId, buildFix }) => {
      const componentPath = fixture(fixtureName);

      const { violations } = await detectViolations({ componentPath });
      const violation = violations.find((v) => v.id === violationId);
      if (!violation) throw new Error(`expected a "${violationId}" violation in ${fixtureName}`);

      const context = await gatherContext({ violation, componentPath });

      vi.mocked(generateFix).mockReset();
      vi.mocked(generateFix).mockResolvedValueOnce({
        filePath: context.componentPath,
        violationId: violation.id,
        oldSnippet: context.element.code,
        newSnippet: buildFix(context.element.code),
      });

      const patch = await generateFix({ context });
      const result = await verifyFix({ patch, originalViolation: violation });

      expect(result.status).toBe('verified');
      expect(result.remainingViolations).toEqual([]);
      expect(result.newViolations).toEqual([]);
    },
  );

  it('color-contrast is not detectable through this pipeline (documented gap, not a bug)', async () => {
    const componentPath = fixture('LowContrastText.tsx');
    const { violations } = await detectViolations({ componentPath });

    // detect/ explicitly disables axe-core's color-contrast rule because
    // jsdom has no real canvas/paint implementation to measure against.
    // This assertion makes that gap visible in the test suite rather than
    // silently rediscovered later — see PLAN.md and the fixture's own
    // doc comment.
    expect(violations.find((v) => v.id === 'color-contrast')).toBeUndefined();
  });
});
