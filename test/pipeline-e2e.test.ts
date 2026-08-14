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
  {
    label: 'ARIA attribute values (aria-valid-attr-value)',
    fixtureName: 'InvalidAriaAttributeValue.tsx',
    violationId: 'aria-valid-attr-value',
    buildFix: (old) => old.replace('aria-checked="maybe"', 'aria-checked="false"'),
  },
  {
    label: 'ARIA widget accessible names (aria-input-field-name)',
    fixtureName: 'MissingAriaWidgetName.tsx',
    violationId: 'aria-input-field-name',
    buildFix: (old) => old.replace('role="textbox"', 'role="textbox" aria-label="Comment"'),
  },
  {
    label: 'frame titles (frame-title)',
    fixtureName: 'MissingFrameTitle.tsx',
    violationId: 'frame-title',
    buildFix: (old) => old.replace('<iframe ', '<iframe title="Map of our headquarters" '),
  },
  {
    label: 'input button names (input-button-name)',
    fixtureName: 'MissingInputButtonName.tsx',
    violationId: 'input-button-name',
    buildFix: (old) => old.replace('<input type="button"', '<input type="button" value="Submit"'),
  },
  {
    label: 'positive tabindex (tabindex)',
    fixtureName: 'PositiveTabIndex.tsx',
    violationId: 'tabindex',
    buildFix: (old) => old.replace('tabIndex={3}', 'tabIndex={0}'),
  },
  {
    label: 'Vue: alt text (image-alt)',
    fixtureName: 'VueMissingAlt.vue',
    violationId: 'image-alt',
    buildFix: () =>
      '<img src="https://example.com/photo.jpg" alt="A scenic photo in the gallery" />',
  },
  {
    label: 'Vue: form labels (label)',
    fixtureName: 'VueMissingLabel.vue',
    violationId: 'label',
    buildFix: () => '<input type="text" name="email" aria-label="Email address" />',
  },
  {
    label: 'Vue: button names (button-name)',
    fixtureName: 'VueMissingButtonName.vue',
    violationId: 'button-name',
    buildFix: (old) =>
      old.replace('<button @click="() => {}">', '<button @click="() => {}" aria-label="Close">'),
  },
  {
    label: 'Vue: link names (link-name)',
    fixtureName: 'VueMissingLinkName.vue',
    violationId: 'link-name',
    buildFix: () =>
      '<a href="/articles/wcag-2026-update">Read more: New accessibility guidelines released</a>',
  },
  {
    label: 'Vue: landmark roles (landmark-unique)',
    fixtureName: 'VueDuplicateLandmarks.vue',
    violationId: 'landmark-unique',
    buildFix: (old) => old.replace('<nav>', '<nav aria-label="Primary">'),
  },
];

describe('pipeline end-to-end across the 10 target violation types, in both React and Vue', () => {
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
