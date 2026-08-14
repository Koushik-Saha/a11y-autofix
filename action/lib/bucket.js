'use strict';

const { isRangeCommentable } = require('./diff');

/**
 * Splits a ScanResult's violations into two buckets: fixes eligible for an
 * inline suggested change, and everything else, which only ever goes into
 * the summary comment for manual review.
 *
 * Three things all have to be true for a fix to be inline-eligible, not
 * one:
 *
 *  1. `status === 'verified'` — axe-core re-confirmed the fix actually
 *     resolves the violation.
 *  2. `patch.confidence === 'high'` — it verified on the *first*
 *     generation attempt, with no retry needed (see scan.ts's
 *     `resolveViolation`). A `'medium'`-confidence fix is still verified —
 *     axe-core confirms it works exactly as strongly as a high-confidence
 *     one — but it only got there after the model was shown a rejected
 *     first attempt and told why, which is enough signal that a human
 *     should glance at it before it becomes a one-click-acceptable
 *     suggestion on someone else's PR.
 *  3. The fix's location is part of the diff GitHub will let a review
 *     comment anchor to (see diff.js) — a verified fix outside the diff is
 *     still a *correct* fix, but GitHub's API rejects a comment on a line
 *     outside it, so it can't become an inline suggestion no matter how
 *     confident detect/verify are in it.
 *
 * Anything that fails any one of these is routed to the summary instead of
 * silently dropped, tagged with which condition it failed.
 *
 * @param {{violations: Array<Record<string, unknown>>}} scanResult parsed ScanResult (from `a11y-autofix scan --json`)
 * @param {Map<string, Set<number>>} commentableLinesByFile relative file path -> commentable new-file line numbers (from diff.js, per changed PR file)
 * @param {(absolutePath: string) => string} toRelativePath
 * @returns {{ inline: Array<Record<string, unknown>>, summary: Array<Record<string, unknown>> }}
 */
function bucketViolations(scanResult, commentableLinesByFile, toRelativePath) {
  const inline = [];
  const summary = [];

  for (const entry of scanResult.violations) {
    const relativePath = toRelativePath(entry.filePath);

    if (entry.status === 'errored') {
      summary.push({ ...entry, relativePath, reason: 'errored' });
      continue;
    }

    if (entry.status === 'unverified') {
      summary.push({ ...entry, relativePath, reason: 'unverified' });
      continue;
    }

    // entry.status === 'verified'
    if (entry.patch.confidence !== 'high') {
      summary.push({ ...entry, relativePath, reason: 'verified-not-high-confidence' });
      continue;
    }

    const commentableLines = commentableLinesByFile.get(relativePath);
    const { startLine, endLine } = entry.context.element.location;
    const inDiff =
      commentableLines !== undefined && isRangeCommentable(commentableLines, startLine, endLine);

    if (inDiff) {
      inline.push({ ...entry, relativePath });
    } else {
      summary.push({ ...entry, relativePath, reason: 'verified-outside-diff' });
    }
  }

  return { inline, summary };
}

module.exports = { bucketViolations };
