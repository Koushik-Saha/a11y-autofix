/**
 * verify/ — applies a proposed Patch to the component's source in memory
 * (the file on disk is never touched), re-runs axe-core via detect/, and
 * confirms the targeted violation is actually gone and that the patch
 * didn't introduce a new one. This is the trust boundary of the pipeline:
 * a patch that doesn't verify is never discarded — it comes back with
 * `status: 'unverified'` plus the violations that prove it, for cli/ to
 * surface rather than silently drop.
 *
 * Patches are applied by position (the element's offsets recorded by
 * context/), so when a file has several identical offending elements each
 * one's patch touches only its own element — and verification only holds
 * a patch responsible for violations on that element, not for identical
 * ones elsewhere in the file that have patches of their own.
 *
 * An insertion patch (`kind: 'insert'`) is checked with the same rigor
 * plus more: its parts must be consistent and allowed for the rule (see
 * `validateInsertion`), and any id it makes non-unique that a label or
 * ARIA attribute points at fails it. axe-core reports that case
 * (`duplicate-id-aria`) only as "needs review", so it's asked for
 * explicitly.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { locateElements } from '../context';
import type { SourceRange } from '../context';
import type { AxeViolation } from '../detect';
import { detectViolationsInSource } from '../detect';
import type { Patch } from '../generate/patch';
import {
  INSERTION_RULES,
  composeInsertion,
  insertionSeparator,
  openingTagName,
} from '../generate/patch';

/** Checked for insertion patches only: ids a label or ARIA attribute points at must stay unique. */
const INSERTION_REVIEW_RULES = ['duplicate-id-aria'];

/** An insertion patch whose parts are inconsistent or not allowed for its rule. */
export class InvalidPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPatchError';
  }
}

/**
 * Throws `InvalidPatchError` unless an insertion patch is well-formed:
 * its rule allows insertion, of this element; its anchor is the patched
 * range; the anchor keeps its tag; and `newSnippet` is exactly the
 * inserted element and anchor composed as generate/ composes them.
 * Replacement patches pass through untouched.
 */
export function validateInsertion(source: string, patch: Patch): void {
  if ((patch.kind ?? 'replace') === 'replace') {
    if (patch.insertion) {
      throw new InvalidPatchError(
        `A replacement patch for "${patch.violationId}" has insertion details.`,
      );
    }
    return;
  }
  const { insertion } = patch;
  const fail = (why: string) => {
    throw new InvalidPatchError(`Invalid insertion for "${patch.violationId}": ${why}`);
  };
  if (!insertion) return fail('it has no insertion details.');
  const allowedTags = INSERTION_RULES[patch.violationId];
  if (!allowedTags) return fail(`insertion isn't allowed for this rule, only replacement.`);
  if (
    !patch.position ||
    insertion.anchor.start !== patch.position.start ||
    insertion.anchor.end !== patch.position.end
  ) {
    return fail('its anchor is not the patched element.');
  }
  const insertedTag = openingTagName(insertion.snippet);
  if (!insertedTag || !allowedTags.includes(insertedTag)) {
    return fail(
      `it inserts <${insertedTag ?? '?'}>; this rule allows ${allowedTags.map((tag) => `<${tag}>`).join(', ')}.`,
    );
  }
  if (openingTagName(insertion.anchorSnippet) !== openingTagName(patch.oldSnippet)) {
    return fail('it changes the flagged element into a different element.');
  }
  const expected = composeInsertion(insertion, insertionSeparator(source, patch.position.start));
  if (patch.newSnippet !== expected) {
    return fail('its newSnippet is not the inserted element and the anchor, composed.');
  }
}

export type VerificationStatus = 'verified' | 'unverified';

export interface VerificationResult {
  status: VerificationStatus;
  patch: Patch;
  targetViolation: AxeViolation;
  /**
   * Post-patch violations sharing the target's rule id that this patch is
   * responsible for — empty when resolved. With a positioned patch that's
   * nodes on (or inside) the patched element, plus any new instance of the
   * rule; other elements already failing the same rule before the patch
   * are left out, since each gets its own patch. A patch without
   * `position` is held responsible for every node of the rule, as before.
   */
  remainingViolations: AxeViolation[];
  /** Post-patch violations whose rule id wasn't present before patching — regressions. */
  newViolations: AxeViolation[];
}

export interface VerifyFixOptions {
  patch: Patch;
  originalViolation: AxeViolation;
  /**
   * Re-check in headless Chromium instead of jsdom — must match the mode
   * the violation was detected in (a color-contrast violation can only be
   * confirmed fixed in browser mode). See detect/'s `DetectOptions.browser`.
   */
  browser?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
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
 * Thrown by `applyPatchToSource` when the text at a patch's recorded
 * position is no longer its `oldSnippet` — the file was edited after it
 * was scanned. The fix is stale; re-scanning produces a fresh one.
 */
export class StalePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StalePatchError';
  }
}

/** The snippet's first line, shortened — enough to recognise the element in a message. */
function describeSnippet(snippet: string): string {
  const firstLine = snippet.split('\n')[0] ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

function isValidRange(range: SourceRange, sourceLength: number): boolean {
  const { start, end } = range;
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start <= end &&
    end <= sourceLength
  );
}

/**
 * Replaces the patched element in `source` with `patch.newSnippet`. Shared
 * by `verifyFix` (in memory), scan/'s `write` step (the CLI's `--write`)
 * and the VS Code extension.
 *
 * - With `patch.position`: replaces exactly that range, after checking it
 *   still holds `patch.oldSnippet`. If it doesn't, the file changed since
 *   the scan and this throws `StalePatchError` rather than patching
 *   whatever is there now.
 * - Without it (patches from older versions): `oldSnippet` must occur
 *   exactly once, refusing to guess which occurrence to touch.
 */
export function applyPatchToSource(source: string, patch: Patch): string {
  if (patch.position) {
    const { start, end } = patch.position;
    if (
      !isValidRange(patch.position, source.length) ||
      source.slice(start, end) !== patch.oldSnippet
    ) {
      throw new StalePatchError(
        `Cannot apply the "${patch.violationId}" fix to ${patch.filePath}: file changed since scan — ${JSON.stringify(describeSnippet(patch.oldSnippet))} is no longer where it was when scanned. Re-run scan to get a fresh fix.`,
      );
    }
    return source.slice(0, start) + patch.newSnippet + source.slice(end);
  }

  const occurrences = countOccurrences(source, patch.oldSnippet);
  if (occurrences !== 1) {
    throw new Error(
      `Cannot apply patch for violation "${patch.violationId}": expected its oldSnippet to appear exactly once in the source, found ${occurrences} (in ${patch.filePath})`,
    );
  }
  return source.replace(patch.oldSnippet, () => patch.newSnippet);
}

interface Attribution {
  filePath: string;
  ruleId: string;
  before: AxeViolation[];
  after: AxeViolation[];
  originalSource: string;
  patchedSource: string;
  position: SourceRange;
  newSnippet: string;
}

/**
 * The post-patch nodes of `ruleId` this patch is responsible for, found by
 * locating each node's element in the patched source:
 *
 * - inside the replaced range → the patched element still fails (or
 *   something the patch added inside it does);
 * - outside it, at an element that had a node of the rule before the
 *   patch → a different element's pre-existing violation, not counted;
 * - outside it anywhere else → a new instance the patch introduced.
 *
 * A node that can't be located is counted: if it can't be placed, it
 * can't be ruled out as the patched element.
 */
function attributeToPatch(options: Attribution): AxeViolation[] {
  const { filePath, ruleId, position, newSnippet } = options;
  const afterOfRule = options.after.filter((violation) => violation.id === ruleId);
  if (afterOfRule.length === 0) return [];

  const beforeNodes = options.before
    .filter((violation) => violation.id === ruleId)
    .flatMap((violation) => violation.nodes);
  const failingBefore = new Set(
    locateElements({ componentPath: filePath, source: options.originalSource, nodes: beforeNodes })
      .filter((range): range is SourceRange => range !== null)
      .map((range) => range.start),
  );

  const regionStart = position.start;
  const regionEnd = position.start + newSnippet.length;
  const shift = newSnippet.length - (position.end - position.start);

  return afterOfRule.flatMap((violation) => {
    const ranges = locateElements({
      componentPath: filePath,
      source: options.patchedSource,
      nodes: violation.nodes,
    });
    const nodes = violation.nodes.filter((_, index) => {
      const range = ranges[index];
      if (!range) return true;
      if (range.start >= regionStart && range.end <= regionEnd) return true;
      const startBeforePatch = range.start < regionStart ? range.start : range.start - shift;
      return !failingBefore.has(startBeforePatch);
    });
    return nodes.length > 0 ? [{ ...violation, nodes }] : [];
  });
}

/**
 * "Needs review" `duplicate-id-aria` nodes present after the patch but not
 * before (compared by their HTML), returned as violations: an id the
 * patch made non-unique.
 */
function newlyDuplicatedIds(before: AxeViolation[], after: AxeViolation[]): AxeViolation[] {
  const seen = new Set(before.flatMap((result) => result.nodes.map((node) => node.html)));
  return after.flatMap((result) => {
    const nodes = result.nodes.filter((node) => !seen.has(node.html));
    return nodes.length > 0 ? [{ ...result, nodes }] : [];
  });
}

export async function verifyFix(options: VerifyFixOptions): Promise<VerificationResult> {
  const { patch, originalViolation } = options;
  const browser = Boolean(options.browser);

  // jsdom never reports color-contrast, so a jsdom re-check would call any
  // patch "verified". Refuse rather than return a false positive.
  if (!browser && originalViolation.id === 'color-contrast') {
    throw new Error(
      'color-contrast fixes can only be verified in browser mode (--browser / { browser: true }); jsdom cannot measure contrast.',
    );
  }
  const filePath = path.resolve(patch.filePath);

  const originalSource = readFileSync(filePath, 'utf8');
  const isInsertion = patch.kind === 'insert';
  if (isInsertion) validateInsertion(originalSource, patch);
  const patchedSource = applyPatchToSource(originalSource, { ...patch, filePath });
  const reviewRules = isInsertion ? INSERTION_REVIEW_RULES : [];

  // Sequential, not Promise.all: each render swaps process-wide globals
  // (see detect/'s withJsdomEnvironment) for its duration, so two renders
  // can't safely run concurrently in this process.
  const before = await detectViolationsInSource({
    source: originalSource,
    filePath,
    browser,
    reviewRules,
  });
  const after = await detectViolationsInSource({
    source: patchedSource,
    filePath,
    browser,
    reviewRules,
  });

  const beforeRuleIds = new Set(before.violations.map((violation) => violation.id));
  const remainingViolations = patch.position
    ? attributeToPatch({
        filePath,
        ruleId: originalViolation.id,
        before: before.violations,
        after: after.violations,
        originalSource,
        patchedSource,
        position: patch.position,
        newSnippet: patch.newSnippet,
      })
    : after.violations.filter((violation) => violation.id === originalViolation.id);
  const newViolations = [
    ...after.violations.filter((violation) => !beforeRuleIds.has(violation.id)),
    ...newlyDuplicatedIds(before.needsReview ?? [], after.needsReview ?? []),
  ];

  const status: VerificationStatus =
    remainingViolations.length === 0 && newViolations.length === 0 ? 'verified' : 'unverified';

  return {
    status,
    patch,
    targetViolation: originalViolation,
    remainingViolations,
    newViolations,
  };
}
