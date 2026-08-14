import { describe, expect, it } from 'vitest';

import { bucketViolations } from './bucket';

const toRelativePath = (absolutePath) => absolutePath.replace('/repo/', '');

function verifiedEntry(filePath, startLine, endLine, confidence = 'high') {
  return {
    filePath,
    status: 'verified',
    violation: { id: 'image-alt' },
    context: { element: { location: { startLine, endLine } } },
    patch: { oldSnippet: '<img src="x" />', newSnippet: '<img src="x" alt="x" />', confidence },
  };
}

describe('bucketViolations', () => {
  it('puts a verified fix inside the diff into the inline bucket', () => {
    const scanResult = { violations: [verifiedEntry('/repo/src/Card.tsx', 3, 3)] };
    const commentableLinesByFile = new Map([['src/Card.tsx', new Set([1, 2, 3, 4])]]);

    const { inline, summary } = bucketViolations(
      scanResult,
      commentableLinesByFile,
      toRelativePath,
    );

    expect(inline).toHaveLength(1);
    expect(summary).toHaveLength(0);
    expect(inline[0].relativePath).toBe('src/Card.tsx');
  });

  it('routes a medium-confidence verified fix to the summary bucket even when it is inside the diff', () => {
    const scanResult = { violations: [verifiedEntry('/repo/src/Card.tsx', 3, 3, 'medium')] };
    const commentableLinesByFile = new Map([['src/Card.tsx', new Set([1, 2, 3, 4])]]);

    const { inline, summary } = bucketViolations(
      scanResult,
      commentableLinesByFile,
      toRelativePath,
    );

    expect(inline).toHaveLength(0);
    expect(summary).toHaveLength(1);
    expect(summary[0].reason).toBe('verified-not-high-confidence');
  });

  it('routes a verified fix outside the diff to the summary bucket, not silently dropped', () => {
    const scanResult = { violations: [verifiedEntry('/repo/src/Card.tsx', 30, 30)] };
    const commentableLinesByFile = new Map([['src/Card.tsx', new Set([1, 2, 3, 4])]]);

    const { inline, summary } = bucketViolations(
      scanResult,
      commentableLinesByFile,
      toRelativePath,
    );

    expect(inline).toHaveLength(0);
    expect(summary).toHaveLength(1);
    expect(summary[0].reason).toBe('verified-outside-diff');
  });

  it('routes a verified fix in an untouched file to the summary bucket', () => {
    const scanResult = { violations: [verifiedEntry('/repo/src/Untouched.tsx', 1, 1)] };
    const commentableLinesByFile = new Map([['src/Card.tsx', new Set([1])]]);

    const { inline, summary } = bucketViolations(
      scanResult,
      commentableLinesByFile,
      toRelativePath,
    );

    expect(inline).toHaveLength(0);
    expect(summary).toHaveLength(1);
    expect(summary[0].reason).toBe('verified-outside-diff');
  });

  it('routes unverified and errored entries to the summary bucket regardless of diff position', () => {
    const scanResult = {
      violations: [
        {
          filePath: '/repo/src/Card.tsx',
          status: 'unverified',
          violation: { id: 'label' },
          context: { element: { location: { startLine: 1, endLine: 1 } } },
          patch: { oldSnippet: 'a', newSnippet: 'b' },
          verification: { remainingViolations: [], newViolations: [] },
        },
        {
          filePath: '/repo/src/Card.tsx',
          status: 'errored',
          violation: { id: 'button-name' },
          error: 'Claude API error',
        },
      ],
    };
    const commentableLinesByFile = new Map([['src/Card.tsx', new Set([1])]]);

    const { inline, summary } = bucketViolations(
      scanResult,
      commentableLinesByFile,
      toRelativePath,
    );

    expect(inline).toHaveLength(0);
    expect(summary.map((s) => s.reason)).toEqual(['unverified', 'errored']);
  });

  it('requires the whole element range to be commentable, not just one line', () => {
    const scanResult = { violations: [verifiedEntry('/repo/src/Card.tsx', 3, 5)] };
    // Line 4 is missing from the commentable set — the range straddles a diff boundary.
    const commentableLinesByFile = new Map([['src/Card.tsx', new Set([3, 5])]]);

    const { inline, summary } = bucketViolations(
      scanResult,
      commentableLinesByFile,
      toRelativePath,
    );

    expect(inline).toHaveLength(0);
    expect(summary).toHaveLength(1);
  });
});
