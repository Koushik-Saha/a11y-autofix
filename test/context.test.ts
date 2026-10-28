import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatherContext } from '../src/context';
import { detectViolations } from '../src/detect';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

function lineOf(filePath: string, needle: string): number {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) {
    throw new Error(`"${needle}" not found in ${filePath}`);
  }
  return index + 1;
}

describe('gatherContext', () => {
  it('maps an image-alt DOM violation back to its exact JSX node, parent, and siblings', async () => {
    const componentPath = fixture('MissingAlt.tsx');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const result = await gatherContext({ violation, componentPath });

    expect(result.element.tagName).toBe('img');
    expect(result.element.code).toContain('<img');
    expect(result.element.location.startLine).toBe(lineOf(componentPath, '<img'));

    expect(result.parent?.tagName).toBe('div');
    expect(result.siblings).toHaveLength(1);
    expect(result.siblings[0]?.tagName).toBe('h1');
    expect(result.siblings[0]?.code).toContain('Gallery');

    expect(result.propTypes).toBeNull();
  });

  it('maps a label DOM violation back to its exact JSX node, parent, and siblings', async () => {
    const componentPath = fixture('MissingLabel.tsx');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'label');
    if (!violation) throw new Error('expected a label violation');

    const result = await gatherContext({ violation, componentPath });

    expect(result.element.tagName).toBe('input');
    expect(result.element.location.startLine).toBe(lineOf(componentPath, '<input'));

    expect(result.parent?.tagName).toBe('form');
    expect(result.siblings).toHaveLength(1);
    expect(result.siblings[0]?.tagName).toBe('button');
  });

  it('resolves same-file prop types for a typed component', async () => {
    const componentPath = fixture('TypedMissingAlt.tsx');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const result = await gatherContext({ violation, componentPath });

    expect(result.element.tagName).toBe('img');
    expect(result.parent?.tagName).toBe('figure');
    expect(result.siblings[0]?.tagName).toBe('figcaption');

    expect(result.propTypes).toContain('imageUrl: string');
    expect(result.propTypes).toContain('caption: string');
  });

  it('maps an image-alt DOM violation back to its exact Vue template node, parent, and siblings', async () => {
    const componentPath = fixture('VueMissingAlt.vue');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const result = await gatherContext({ violation, componentPath });

    expect(result.element.tagName).toBe('img');
    expect(result.element.code).toContain('<img');
    expect(result.element.location.startLine).toBe(lineOf(componentPath, '<img'));

    expect(result.parent?.tagName).toBe('div');
    expect(result.siblings).toHaveLength(1);
    expect(result.siblings[0]?.tagName).toBe('h1');
    expect(result.siblings[0]?.code).toContain('Gallery');

    expect(result.propTypes).toBeNull();
  });

  it('maps a landmark-unique DOM violation back to the correct Vue template node among siblings', async () => {
    const componentPath = fixture('VueDuplicateLandmarks.vue');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'landmark-unique');
    if (!violation) throw new Error('expected a landmark-unique violation');

    const result = await gatherContext({ violation, componentPath });

    expect(result.element.tagName).toBe('nav');
    expect(result.parent?.tagName).toBe('div');
    expect(result.siblings).toHaveLength(1);
    expect(result.siblings[0]?.tagName).toBe('nav');
  });

  it('resolves defineProps<T>() prop types for a typed <script setup> Vue component', async () => {
    const componentPath = fixture('VueTypedMissingAlt.vue');
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const result = await gatherContext({ violation, componentPath });

    expect(result.element.tagName).toBe('img');
    expect(result.parent?.tagName).toBe('figure');
    expect(result.siblings[0]?.tagName).toBe('figcaption');

    expect(result.propTypes).toContain('imageUrl: string');
    expect(result.propTypes).toContain('caption: string');
  });
});

describe('element offsets', () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(__dirname, 'tmp-offsets-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // startOffset/endOffset are what a Patch records as its position, so
  // they must slice the element's exact code out of the raw file text —
  // including when TypeScript has silently dropped a leading BOM.
  it.each([
    { name: 'MissingAlt.tsx', bom: false },
    { name: 'VueMissingAlt.vue', bom: false },
    { name: 'MissingAlt.tsx', bom: true },
    { name: 'VueMissingAlt.vue', bom: true },
  ])('slice the element out of the raw text ($name, BOM: $bom)', async ({ name, bom }) => {
    const componentPath = path.join(tempDir, name);
    writeFileSync(componentPath, (bom ? '﻿' : '') + readFileSync(fixture(name), 'utf8'));
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error('expected an image-alt violation');

    const { element } = await gatherContext({ violation, componentPath });
    const raw = readFileSync(componentPath, 'utf8');

    expect(raw.slice(element.location.startOffset, element.location.endOffset)).toBe(element.code);
    expect(element.code.startsWith('<img')).toBe(true);
  });
});
