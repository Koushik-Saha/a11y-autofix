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
 * Deliberately duplicates (not imports) the same replace-exactly-once
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
 * @param {string} source full file text
 * @param {{oldSnippet: string, newSnippet: string}} patch
 * @returns {string} `source` with `oldSnippet` replaced by `newSnippet`
 * @throws if `oldSnippet` doesn't occur in `source` exactly once
 */
function applyPatch(source, patch) {
  const occurrences = countOccurrences(source, patch.oldSnippet);
  if (occurrences !== 1) {
    throw new Error(
      `Expected oldSnippet to appear exactly once in the source, found ${occurrences}`,
    );
  }
  return source.replace(patch.oldSnippet, patch.newSnippet);
}

/**
 * @param {string} fileContent the file's current (unpatched) full text
 * @param {{oldSnippet: string, newSnippet: string}} patch
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
