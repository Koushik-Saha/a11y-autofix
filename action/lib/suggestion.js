'use strict';

/**
 * suggestion.js — builds the exact text for a GitHub "suggested change"
 * code block (see https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-a-pull-request/incorporating-feedback-in-your-pull-request).
 * A suggestion replaces the *entire* line range it's anchored to, not just
 * the substring that changed — so if `oldSnippet` is only part of a line
 * (e.g. a JSX element inline alongside other content), pasting
 * `patch.newSnippet` straight into a ```suggestion block would silently
 * drop everything else on that line. Instead this applies the patch to the
 * full file text first, then slices out the (now-fixed) line range —
 * exactly what ends up on disk with `--write`, just not written anywhere.
 *
 * Deliberately duplicates (not imports) the same patch-application
 * logic `src/verify/index.ts`'s `applyPatchToSource` uses, so this
 * directory has no dependency on a prior `npm run build` of the main
 * package to test or run — see the module boundary note in action.yml.
 * Keep the two in sync if that logic's semantics ever change.
 */

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * @typedef {{start: number, end: number}} SourceRange
 * @typedef {{oldSnippet: string, newSnippet: string, position?: SourceRange}} PatchLike
 */

/**
 * With `patch.position` (scans from versions that record it), replaces
 * exactly that range — so two identical elements in one file each get
 * their own suggestion — after checking it still holds `oldSnippet`.
 * Without it (older results), `oldSnippet` must occur exactly once.
 *
 * @param {string} source full file text
 * @param {PatchLike} patch
 * @returns {string} `source` with the patched element replaced by `newSnippet`
 * @throws if the text at `position` isn't `oldSnippet` (the file changed
 *   since the scan), or, without `position`, if `oldSnippet` doesn't occur
 *   exactly once
 */
function applyPatch(source, patch) {
  if (patch.position) {
    const { start, end } = patch.position;
    const valid =
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      start <= end &&
      end <= source.length;
    if (!valid || source.slice(start, end) !== patch.oldSnippet) {
      throw new Error('File changed since scan: oldSnippet is no longer at its recorded position');
    }
    return source.slice(0, start) + patch.newSnippet + source.slice(end);
  }

  const occurrences = countOccurrences(source, patch.oldSnippet);
  if (occurrences !== 1) {
    throw new Error(
      `Expected oldSnippet to appear exactly once in the source, found ${occurrences}`,
    );
  }
  return source.replace(patch.oldSnippet, () => patch.newSnippet);
}

/**
 * @param {string} fileContent the file's current (unpatched) full text
 * @param {PatchLike} patch
 * @param {number} startLine 1-indexed
 * @param {number} endLine 1-indexed, inclusive
 * @returns {string} the fixed line range's text, suitable for a ```suggestion block
 */
function buildSuggestionBody(fileContent, patch, startLine, endLine) {
  const patched = applyPatch(fileContent, patch);
  const lines = patched.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

module.exports = { applyPatch, buildSuggestionBody };
