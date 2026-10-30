/**
 * scan/ — orchestrates detect/ -> context/ -> generate/ -> verify/ over a
 * file or directory and returns structured results. This is the one place
 * both the CLI and the public library API call into: cli/ renders these
 * results to the terminal (diffs, summary line, exit code); the `scan`
 * export here does the same underlying work without printing anything, for
 * programmatic use (`import { scan } from 'a11y-autofix'`).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createIgnoreMatcher, suppressionReason } from './config';
import type { Severity, SuppressionReason } from './config';
import { detectViolations, resolveComponentFiles } from './detect';
import type { AxeNodeResult, AxeViolation, DetectedFile } from './detect';
import { withBrowserSession } from './detect/browser';
import { gatherContext, locateElements } from './context';
import type { FixContext } from './context';
import { generateFix } from './generate';
import type { Patch, PreviousAttempt } from './generate';
import { StalePatchError, applyPatchToSource, verifyFix } from './verify';
import type { VerificationResult } from './verify';

export interface ScanOptions {
  /** Apply verified fixes directly to their files. Unverified fixes are never applied. */
  write?: boolean;
  /**
   * Detect and verify in headless Chromium (via Playwright) instead of
   * jsdom, which adds `color-contrast` checks. `scan()` rejects with
   * `BrowserUnavailableError` if Playwright or its Chromium isn't
   * installed — it never falls back to jsdom.
   */
  browser?: boolean;
  /**
   * Called for each verified fix, giving the caller a chance to accept it,
   * reject it, or supply an edited replacement — instead of the blanket
   * `write` boolean applying every verified fix unconditionally. See
   * `VerifiedFixDecision`. Never called for `'unverified'`/`'errored'`
   * entries — there's nothing to accept for those.
   */
  onVerifiedFix?: (context: VerifiedFixPromptContext) => Promise<VerifiedFixDecision>;
  /**
   * Fire-and-forget report of how a violation `onVerifiedFix` was asked
   * about was ultimately resolved — called once per violation, after the
   * decision (and any edit) is final. Purely for the caller's own
   * bookkeeping (e.g. cli/'s `--log-corrections`); doesn't influence
   * `scan()`'s behavior.
   */
  onFixResolved?: (info: ResolvedFixInfo) => void | Promise<void>;
  /**
   * Glob patterns for component files to skip entirely, matched against
   * each file's path relative to `root` (see config/'s
   * `createIgnoreMatcher`). Skipped files are never rendered; they are
   * listed in `ScanResult.ignoredFiles`.
   */
  ignore?: string[];
  /** The directory `ignore` patterns are relative to. Defaults to `process.cwd()`. */
  root?: string;
  /**
   * axe-core rule ids never to report. Their violations are still
   * detected but never fixed; they go to `ScanResult.suppressed`.
   */
  disableRules?: string[];
  /**
   * Minimum impact to report. Violations below it go to
   * `ScanResult.suppressed` instead of being fixed. A violation with no
   * impact is always reported.
   */
  severity?: Severity;
  /**
   * Name of the environment variable holding the Anthropic API key. When
   * unset, the SDK's own default (`ANTHROPIC_API_KEY`) applies.
   */
  apiKeyEnv?: string;
}

export interface VerifiedFixPromptContext {
  filePath: string;
  /** 1-indexed line the offending element starts on, for a caller that wants to show or log "where" without needing the full FixContext. */
  startLine: number;
  violation: AxeViolation;
  /** The AI-suggested fix the first time this is called for a violation; the caller's own most recent edit on a retry (see `editRejected`). */
  patch: ScoredPatch;
  /** Set only when this call follows an edit attempt that didn't verify, so the caller can explain why and ask again. */
  editRejected?: { remainingViolations: AxeViolation[]; newViolations: AxeViolation[] };
}

export type VerifiedFixDecision =
  { action: 'accept' } | { action: 'reject' } | { action: 'edit'; newSnippet: string };

export interface ResolvedFixInfo {
  filePath: string;
  /** 1-indexed line the offending element starts on. */
  startLine: number;
  violation: AxeViolation;
  outcome: 'accepted' | 'rejected' | 'edited';
  /** The original AI-suggested patch, regardless of outcome. */
  suggested: ScoredPatch;
  /** Set when `outcome === 'edited'`: the caller's replacement text that verified. */
  editedSnippet?: string;
}

export type PatchConfidence = 'high' | 'medium' | 'low';

/**
 * A Patch plus how much retrying it took to get here — see
 * `resolveFix`'s doc comment below for exactly what each level means.
 * Only `scan.ts` can compute this (it's the one place that knows about
 * retries), so it's a superset of `generate/`'s plain `Patch` rather than
 * a field on `Patch` itself — a bare `generateFix()` call has no basis
 * for claiming any confidence level at all.
 */
export interface ScoredPatch extends Patch {
  confidence: PatchConfidence;
}

interface ScanViolationOutcomeBase {
  filePath: string;
  /**
   * The violation for this one source element: axe-core's result for the
   * rule, narrowed to the node(s) that element rendered. A file with two
   * offending elements for the same rule yields two entries.
   */
  violation: AxeViolation;
}

export interface ScanViolationFixed extends ScanViolationOutcomeBase {
  status: 'verified' | 'unverified';
  context: FixContext;
  patch: ScoredPatch;
  verification: VerificationResult;
  /** Whether the patch was actually written to `filePath` (only possible when `status: 'verified'` and `write` was requested). */
  applied: boolean;
}

export interface ScanViolationErrored extends ScanViolationOutcomeBase {
  status: 'errored';
  /** context/generate/verify threw — the pipeline couldn't produce or check a fix for this violation. */
  error: string;
  /**
   * Set when generate/ refused to attempt a fix because guessing would be
   * unsafe (e.g. low contrast over a background image or gradient). Still
   * unresolved — it needs a human — but nothing went wrong.
   */
  reason?: 'not-auto-fixable';
}

export type ScanViolationResult = ScanViolationFixed | ScanViolationErrored;

/**
 * A violation that was detected but, per `disableRules` or `severity`, not
 * reported or fixed. Kept (not dropped) so output can say how many were
 * hidden and why, rather than hiding them silently.
 */
export interface SuppressedViolation {
  filePath: string;
  /** Narrowed to one source element, like `ScanViolationResult.violation`. */
  violation: AxeViolation;
  reason: SuppressionReason;
}

export interface ScanResult {
  targetPath: string;
  filesScanned: number;
  violations: ScanViolationResult[];
  /** Violations hidden by `disableRules`/`severity` — never fixed, counted separately from `violations`. */
  suppressed: SuppressedViolation[];
  /** Component files under the target skipped by `ignore` (absolute paths, never rendered). */
  ignoredFiles: string[];
}

interface Attempt {
  patch: Patch;
  verification: VerificationResult;
}

/** Options `resolveFix` honours — the subset of `ScanOptions` that affects how a fix is generated and checked. */
export interface ResolveFixOptions {
  /** Verify in headless Chromium instead of jsdom. See `ScanOptions.browser`. */
  browser?: boolean;
  /** See `ScanOptions.apiKeyEnv`. */
  apiKeyEnv?: string;
}

async function attemptFix(
  context: FixContext,
  violation: AxeViolation,
  options: ResolveFixOptions,
  previousAttempt?: PreviousAttempt,
): Promise<Attempt> {
  const patch = await generateFix({
    context,
    ...(previousAttempt ? { previousAttempt } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
  });
  const verification = await verifyFix({
    patch,
    originalViolation: violation,
    browser: Boolean(options.browser),
  });
  return { patch, verification };
}

/**
 * Generates a fix and verifies it; if that first attempt doesn't verify,
 * retries exactly once, feeding the failure back to the model so it has a
 * reason to try something different rather than being asked the same
 * question again (see generate/'s `PreviousAttempt`). `confidence` records
 * which of those two attempts (if either) actually worked:
 *
 *  - `'high'`   — verified on the first attempt.
 *  - `'medium'` — the first attempt failed verification but the retry
 *                 succeeded.
 *  - `'low'`    — both attempts failed; `status` stays `'unverified'`,
 *                 same manual-review fallback as before this existed.
 *
 * Sequential, not concurrent, for the same reason `verify/`'s two
 * detect-in-source calls are: each render swaps process-wide globals for
 * its duration (see detect/'s `withJsdomEnvironment`).
 *
 * Exported (not just an internal `scanFile` helper) so a caller that
 * already has its own `FixContext` — e.g. the VS Code extension's fix
 * command, which locates a single already-known violation itself rather
 * than scanning a whole file — can get the same retry/confidence behavior
 * `scan()` gives every other consumer, without reimplementing this loop.
 */
export async function resolveFix(
  context: FixContext,
  violation: AxeViolation,
  options: ResolveFixOptions = {},
): Promise<{ patch: ScoredPatch; verification: VerificationResult }> {
  const first = await attemptFix(context, violation, options);
  if (first.verification.status === 'verified') {
    return { patch: { ...first.patch, confidence: 'high' }, verification: first.verification };
  }

  const retry = await attemptFix(context, violation, options, {
    newSnippet: first.patch.newSnippet,
    remainingViolations: first.verification.remainingViolations,
    newViolations: first.verification.newViolations,
  });
  const confidence: PatchConfidence = retry.verification.status === 'verified' ? 'medium' : 'low';
  return { patch: { ...retry.patch, confidence }, verification: retry.verification };
}

/**
 * axe-core reports one violation per rule with a node per failing DOM
 * element. This splits it into one violation per *source* element, so
 * each gets its own context, patch and verification: two identical
 * `<img>`s are two fixes, while the nodes one JSX element renders several
 * times (e.g. inside `.map()`) stay together as a single fix. `source` is
 * the file as this scan last saw it, i.e. including fixes it already
 * wrote. A node that can't be located becomes its own entry, so
 * gatherContext reports why.
 */
function splitByElement(file: string, source: string, violation: AxeViolation): AxeViolation[] {
  if (violation.nodes.length <= 1) return [violation];

  let ranges: ReturnType<typeof locateElements>;
  try {
    ranges = locateElements({ componentPath: file, source, nodes: violation.nodes });
  } catch {
    ranges = violation.nodes.map(() => null);
  }

  const groups: AxeNodeResult[][] = [];
  const groupByStart = new Map<number, AxeNodeResult[]>();
  violation.nodes.forEach((node, index) => {
    const range = ranges[index];
    const existing = range ? groupByStart.get(range.start) : undefined;
    if (existing) {
      existing.push(node);
      return;
    }
    const group = [node];
    groups.push(group);
    if (range) groupByStart.set(range.start, group);
  });
  return groups.map((nodes) => ({ ...violation, nodes }));
}

function applyToDisk(patch: Patch): void {
  const currentSource = readFileSync(patch.filePath, 'utf8');
  writeFileSync(patch.filePath, applyPatchToSource(currentSource, patch), 'utf8');
}

/**
 * Runs `options.onVerifiedFix` for an already-verified fix and carries out
 * whatever it decides. An `'edit'` decision is re-verified here — an
 * edited snippet is never applied without the same axe-core confirmation
 * every other patch gets — and if it doesn't verify, `onVerifiedFix` is
 * called again with `editRejected` populated so the caller can explain why
 * and ask again; this loops until `'accept'` or `'reject'`.
 *
 * Rejecting always reports the *original* suggested patch and its own
 * (successful) verification, never a failed edit attempt's — the AI's
 * suggestion genuinely verified regardless of what the caller tried
 * afterward, and misreporting it as unverified because of an unrelated
 * failed edit would be wrong.
 */
async function runInteractiveDecision(
  file: string,
  startLine: number,
  violation: AxeViolation,
  suggested: ScoredPatch,
  suggestedVerification: VerificationResult,
  options: ScanOptions,
): Promise<{ patch: ScoredPatch; verification: VerificationResult; applied: boolean }> {
  let latestAttempt = suggested;
  let editRejected: VerifiedFixPromptContext['editRejected'];

  for (;;) {
    const decision = await options.onVerifiedFix!({
      filePath: file,
      startLine,
      violation,
      patch: latestAttempt,
      ...(editRejected ? { editRejected } : {}),
    });

    if (decision.action === 'reject') {
      await options.onFixResolved?.({
        filePath: file,
        startLine,
        violation,
        outcome: 'rejected',
        suggested,
      });
      return { patch: suggested, verification: suggestedVerification, applied: false };
    }

    if (decision.action === 'accept') {
      // Always the original suggestion, deliberately never `latestAttempt`:
      // once a prior edit in this loop has failed verification,
      // `latestAttempt` holds that *unverified* edit, and applying it here
      // would mean writing a patch that was never confirmed to work — the
      // one thing this whole pipeline exists to prevent. 'accept' only
      // ever means "use the AI's own (already-verified) suggestion"; the
      // only way to apply something else is a fresh edit that itself
      // re-verifies, handled below.
      const applied = Boolean(options.write);
      if (applied) applyToDisk(suggested);
      await options.onFixResolved?.({
        filePath: file,
        startLine,
        violation,
        outcome: 'accepted',
        suggested,
      });
      return { patch: suggested, verification: suggestedVerification, applied };
    }

    // decision.action === 'edit'
    const editedPatch: ScoredPatch = { ...latestAttempt, newSnippet: decision.newSnippet };
    const editedVerification = await verifyFix({
      patch: editedPatch,
      originalViolation: violation,
      browser: Boolean(options.browser),
    });

    if (editedVerification.status === 'verified') {
      const applied = Boolean(options.write);
      if (applied) applyToDisk(editedPatch);
      await options.onFixResolved?.({
        filePath: file,
        startLine,
        violation,
        outcome: 'edited',
        suggested,
        editedSnippet: decision.newSnippet,
      });
      return { patch: editedPatch, verification: editedVerification, applied };
    }

    latestAttempt = editedPatch;
    editRejected = {
      remainingViolations: editedVerification.remainingViolations,
      newViolations: editedVerification.newViolations,
    };
  }
}

/**
 * Each violation is located by axe-core's selectors from the render of
 * `expectedSource`. If something else edited the file since, those
 * selectors may now point at a different element, so stop rather than
 * fix the wrong one.
 */
function assertUnchangedSinceScan(file: string, ruleId: string, expectedSource: string): void {
  if (readFileSync(file, 'utf8') !== expectedSource) {
    throw new StalePatchError(
      `Cannot fix "${ruleId}" in ${file}: file changed since scan (edited by something other than this scan). Re-run scan to get a fresh fix.`,
    );
  }
}

/**
 * Runs context -> generate -> verify (and any write) for one file's
 * violations. `detected.source` is the exact text detect/ rendered, so
 * each later step can tell whether the file is still what was scanned
 * (plus this scan's own writes).
 */
async function fixFile(
  detected: DetectedFile,
  violations: AxeViolation[],
  options: ScanOptions,
): Promise<ScanViolationResult[]> {
  const file = detected.filePath;
  let expectedSource = detected.source;
  const results: ScanViolationResult[] = [];

  for (const ruleViolation of violations) {
    // Split per rule, not all up front: with `write`, fixes already
    // written for earlier rules may have moved this rule's elements.
    for (const violation of splitByElement(file, expectedSource, ruleViolation)) {
      try {
        assertUnchangedSinceScan(file, violation.id, expectedSource);
        const context = await gatherContext({ violation, componentPath: file });
        const resolved = await resolveFix(context, violation, options);

        let patch = resolved.patch;
        let verification = resolved.verification;
        let applied = false;

        if (verification.status === 'verified' && options.onVerifiedFix) {
          const decided = await runInteractiveDecision(
            file,
            context.element.location.startLine,
            violation,
            patch,
            verification,
            options,
          );
          patch = decided.patch;
          verification = decided.verification;
          applied = decided.applied;
        } else if (verification.status === 'verified' && options.write) {
          applyToDisk(patch);
          applied = true;
        }
        if (applied) expectedSource = readFileSync(file, 'utf8');

        results.push({
          status: verification.status,
          filePath: file,
          violation,
          context,
          patch,
          verification,
          applied,
        });
      } catch (error) {
        results.push({
          status: 'errored',
          filePath: file,
          violation,
          error: (error as Error).message,
          // By name rather than instanceof generate/'s NotAutoFixableError, so
          // it holds even when generate/ is loaded twice or mocked.
          ...((error as Error)?.name === 'NotAutoFixableError'
            ? { reason: 'not-auto-fixable' as const }
            : {}),
        });
      }
    }
  }

  return results;
}

/**
 * Scans `targetPath` (a component file or a directory of them) for WCAG
 * violations, generates and verifies a fix for each one, and — when
 * `options.write` is set — applies verified fixes to disk. Throws if
 * `targetPath` doesn't exist; per-violation failures (an unfixable JSX
 * node, a Claude API error, a bad patch) are captured as
 * `status: 'errored'` entries rather than aborting the whole scan.
 *
 * Files matching `options.ignore` are never rendered (`ignoredFiles`).
 * Violations hidden by `options.disableRules` / `options.severity` are
 * detected but never fixed; they go to `suppressed`, not `violations`.
 *
 * With `options.browser`, one headless Chromium is launched up front and
 * shared by every detect/verify render in the scan; if it can't be
 * launched, this rejects with `BrowserUnavailableError` before scanning
 * anything.
 */
export async function scan(targetPath: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteTarget = path.resolve(targetPath);
  const isIgnored = createIgnoreMatcher(options.ignore ?? [], options.root ?? process.cwd());
  const ignoredFiles = resolveComponentFiles(absoluteTarget)
    .map((file) => path.resolve(file))
    .filter(isIgnored);

  const violations: ScanViolationResult[] = [];
  const suppressed: SuppressedViolation[] = [];
  let filesScanned = 0;
  const scanAll = async () => {
    // One detect pass over the whole target (every file is rendered before
    // any fix is generated); its violations are already attributed to
    // their files.
    const detected = await detectViolations({
      componentPath: absoluteTarget,
      browser: Boolean(options.browser),
      exclude: isIgnored,
    });
    filesScanned = detected.files.length;
    for (const file of detected.files) {
      const toFix: AxeViolation[] = [];
      for (const violation of detected.violations) {
        if (violation.filePath !== file.filePath) continue;
        const reason = suppressionReason(violation, options);
        if (!reason) {
          toFix.push(violation);
          continue;
        }
        // Counted per source element, the same unit as `violations`.
        for (const element of splitByElement(file.filePath, file.source, violation)) {
          suppressed.push({ filePath: file.filePath, violation: element, reason });
        }
      }
      violations.push(...(await fixFile(file, toFix, options)));
    }
  };
  await (options.browser ? withBrowserSession(scanAll) : scanAll());

  return { targetPath: absoluteTarget, filesScanned, violations, suppressed, ignoredFiles };
}
