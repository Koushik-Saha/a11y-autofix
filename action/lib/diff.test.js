import { describe, expect, it } from 'vitest';

import { parseCommentableLines, isRangeCommentable } from './diff';

describe('parseCommentableLines', () => {
  it('returns an empty set for a missing/empty patch', () => {
    expect(parseCommentableLines(undefined).size).toBe(0);
    expect(parseCommentableLines('').size).toBe(0);
  });

  it('marks added lines and their surrounding context lines as commentable', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' line one',
      '-line two old',
      '+line two new',
      '+line three added',
      ' line four',
    ].join('\n');

    const commentable = parseCommentableLines(patch);

    // new-file line numbers: 1 (context), 2 (+), 3 (+), 4 (context)
    expect([...commentable].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('does not consume a new-file line number for a removed-only line', () => {
    const patch = ['@@ -1,2 +1,1 @@', ' kept', '-removed'].join('\n');

    const commentable = parseCommentableLines(patch);

    expect([...commentable]).toEqual([1]);
  });

  it('advances correctly across multiple hunks', () => {
    const patch = ['@@ -1,2 +1,2 @@', ' a', '+b', '@@ -10,2 +11,2 @@', ' k', '+l'].join('\n');

    const commentable = parseCommentableLines(patch);

    expect([...commentable].sort((a, b) => a - b)).toEqual([1, 2, 11, 12]);
  });

  it('ignores "no newline at end of file" markers without shifting line numbers', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n');

    const commentable = parseCommentableLines(patch);

    expect([...commentable]).toEqual([1]);
  });
});

describe('isRangeCommentable', () => {
  it('is true only when every line in the range is commentable', () => {
    const commentable = new Set([5, 6, 7, 8]);

    expect(isRangeCommentable(commentable, 5, 7)).toBe(true);
    expect(isRangeCommentable(commentable, 6, 6)).toBe(true);
    expect(isRangeCommentable(commentable, 4, 6)).toBe(false);
    expect(isRangeCommentable(commentable, 7, 9)).toBe(false);
  });
});
