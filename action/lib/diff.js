'use strict';

/**
 * diff.js — parses the unified-diff `patch` text GitHub's "list pull
 * request files" API returns per file, into the set of new-file line
 * numbers that are actually visible in that diff.
 *
 * This matters because GitHub's review-comment API rejects a comment
 * anchored to a line outside the diff (a 422 error) — you can only comment
 * on a line the "Files changed" view actually shows, which is exactly the
 * union of added lines and the unchanged context lines surrounding them
 * within each `@@ ... @@` hunk. A line elsewhere in the file (outside every
 * hunk) was not touched by this PR and can't be commented on inline, no
 * matter how confident the fix is — see bucket.js for what happens to a
 * fix that lands there instead.
 */

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * @param {string | undefined | null} patch raw unified-diff text for one file, as returned by GitHub's pulls-files API (`file.patch`)
 * @returns {Set<number>} new-file (RIGHT-side) line numbers visible in the diff
 */
function parseCommentableLines(patch) {
  const commentable = new Set();
  if (!patch) return commentable;

  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (line.startsWith('+')) {
      commentable.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      // Removed line: exists only on the old side, doesn't consume a new-file line number.
    } else if (line.startsWith('\\')) {
      // e.g. "\ No newline at end of file" — not a content line.
    } else {
      // Context line (starts with a space, or is empty inside a hunk): unchanged, exists on both sides.
      commentable.add(newLine);
      newLine += 1;
    }
  }

  return commentable;
}

/**
 * True when every line in `[startLine, endLine]` is visible in the diff —
 * the whole range must be commentable, not just its first or last line,
 * since a multi-line suggestion covers the entire range.
 */
function isRangeCommentable(commentableLines, startLine, endLine) {
  for (let line = startLine; line <= endLine; line += 1) {
    if (!commentableLines.has(line)) return false;
  }
  return true;
}

module.exports = { parseCommentableLines, isRangeCommentable };
