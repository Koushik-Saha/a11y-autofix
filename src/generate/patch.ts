/**
 * The Patch shape shared by generate/ (which produces patches), verify/
 * (which checks and applies them), scan/ and cli/. No SDK imports, so
 * verify/ can use the insertion rules without loading the API client.
 *
 * A patch is always one contiguous edit: `newSnippet` replaces the anchor
 * element's text (`oldSnippet`, at `position`). An insertion is the same
 * edit, with the new sibling and the (possibly updated) anchor joined in
 * `newSnippet`, plus the parts recorded in `insertion` so it can be
 * checked and audited. That is what lets every existing consumer of
 * `newSnippet` (the CLI's diff and --write, the GitHub Action's
 * suggestions, the VS Code extension) apply an insertion correctly.
 */

import type { SourceRange } from '../context';

export type PatchKind = 'replace' | 'insert';

export interface Insertion {
  /**
   * The element the new one is placed next to: the flagged element.
   * Always the same range as `Patch.position`, which is what gets
   * replaced.
   */
  anchor: SourceRange;
  /** Where the new element goes relative to the anchor. */
  position: 'before' | 'after';
  /** The inserted element's source, exactly as written into the file. */
  snippet: string;
  /**
   * The anchor as it reads after the patch: unchanged, or with only the
   * attribute the new element needs (e.g. the `id` a label points at).
   */
  anchorSnippet: string;
}

/** On a replacement for a rule where insertion is preferred: why the fallback was used. */
export interface PatchFallback {
  preferred: 'insert';
  reason: string;
}

export interface Patch {
  filePath: string;
  violationId: string;
  /** The element's exact source text when scanned. With `position`, a check that the file hasn't changed; without it, how the element is found. */
  oldSnippet: string;
  /**
   * What replaces `oldSnippet`. For `kind: 'insert'` this is the inserted
   * element and the anchor together, in order (see `composeInsertion`).
   */
  newSnippet: string;
  /**
   * Where `oldSnippet` sat in the file when it was scanned: character
   * offsets from context/'s AST (`element.location.startOffset` /
   * `endOffset`). verify/'s `applyPatchToSource` replaces exactly this
   * range, so a file with two identical offending elements can have each
   * fixed separately. Optional only for patches from before it existed
   * (e.g. a saved `--json` result), which fall back to requiring
   * `oldSnippet` to occur exactly once.
   */
  position?: SourceRange;
  /** 'replace' when absent (patches from before kinds existed). */
  kind?: PatchKind;
  /** Set exactly when `kind` is 'insert'. */
  insertion?: Insertion;
  /** Set on a replacement for an insertion-eligible rule: insertion wasn't used, and why. */
  fallback?: PatchFallback;
}

/**
 * The rules for which a patch may insert a sibling instead of replacing
 * the element, and the elements it may insert. Every other rule only
 * ever gets a replacement: generate/ doesn't offer insertion for it and
 * verify/ rejects one.
 *
 * `bypass` is listed for skip links and headings, but axe-core checks it
 * on the whole page (`<html>`), so a single rendered component never
 * reports it today.
 */
export const INSERTION_RULES: Readonly<Record<string, readonly string[]>> = {
  label: ['label'],
  bypass: ['a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
};

export function isInsertionRule(ruleId: string): boolean {
  return Object.hasOwn(INSERTION_RULES, ruleId);
}

/** The tag name an element's source opens with (`<input …` → "input"), or null. */
export function openingTagName(snippet: string): string | null {
  return /^<\s*([A-Za-z][\w.:-]*)/.exec(snippet.trimStart())?.[1] ?? null;
}

/**
 * What goes between the inserted element and the anchor: a newline plus
 * the anchor line's indentation when the anchor starts its own line, so
 * the new element sits on its own line at the same depth; nothing when
 * the anchor shares its line with other code.
 */
export function insertionSeparator(source: string, anchorStart: number): string {
  const lineStart = source.lastIndexOf('\n', anchorStart - 1) + 1;
  const prefix = source.slice(lineStart, anchorStart);
  return /^[ \t]*$/.test(prefix) ? `\n${prefix}` : '';
}

/** The text that replaces the anchor: the new element and the anchor, in order. */
export function composeInsertion(
  insertion: Pick<Insertion, 'position' | 'snippet' | 'anchorSnippet'>,
  separator: string,
): string {
  return insertion.position === 'before'
    ? `${insertion.snippet}${separator}${insertion.anchorSnippet}`
    : `${insertion.anchorSnippet}${separator}${insertion.snippet}`;
}
