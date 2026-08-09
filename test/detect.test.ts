import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectViolations } from '../src/detect';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

describe('detectViolations', () => {
  it('flags an <img> missing alt text', async () => {
    const result = await detectViolations({ componentPath: fixture('MissingAlt.tsx') });

    const violation = result.violations.find((v) => v.id === 'image-alt');
    expect(violation).toBeDefined();
    expect(violation?.nodes.length).toBeGreaterThan(0);
    expect(violation?.nodes[0]?.html).toContain('<img');
    expect(violation?.nodes[0]?.target).toEqual(['img']);
  });

  it('flags a form input missing an associated label', async () => {
    const result = await detectViolations({ componentPath: fixture('MissingLabel.tsx') });

    const violation = result.violations.find((v) => v.id === 'label');
    expect(violation).toBeDefined();
    expect(violation?.nodes[0]?.html).toContain('<input');
  });

  it('reports no violations for an accessible component', async () => {
    const result = await detectViolations({ componentPath: fixture('AccessibleCard.tsx') });

    expect(result.violations).toEqual([]);
  });

  it('scans every component file when given a directory', async () => {
    const result = await detectViolations({ componentPath: path.join(__dirname, 'fixtures') });

    const ids = new Set(result.violations.map((v) => v.id));
    expect(ids.has('image-alt')).toBe(true);
    expect(ids.has('label')).toBe(true);
  });
});
