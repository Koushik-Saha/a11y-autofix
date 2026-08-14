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

import { detectViolations, resolveComponentFiles } from './detect';
import type { AxeViolation } from './detect';
import { gatherContext } from './context';
import type { FixContext } from './context';
import { generateFix } from './generate';
import type { Patch, PreviousAttempt } from './generate';
import { applyPatchToSource, verifyFix } from './verify';
import type { VerificationResult } from './verify';

export interface ScanOptions {
  /** Apply verified fixes directly to their files. Unverified fixes are never applied. */
  write?: boolean;
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
 * `resolveViolation`'s doc comment below for exactly what each level
 * means. Only `scan.ts` can compute this (it's the one place that knows
 * about retries), so it's a superset of `generate/`'s plain `Patch`
 * rather than a field on `Patch` itself — a bare `generateFix()` call has
 * no basis for claiming any confidence level at all.
 */
export interface ScoredPatch extends Patch {
  confidence: PatchConfidence;
}

interface ScanViolationOutcomeBase {
  filePath: string;
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
}

export type ScanViolationResult = ScanViolationFixed | ScanViolationErrored;

export interface ScanResult {
  targetPath: string;
  filesScanned: number;
  violations: ScanViolationResult[];
}

interface Attempt {
  patch: Patch;
  verification: VerificationResult;
}

async function attemptFix(
  context: FixContext,
  violation: AxeViolation,
  previousAttempt?: PreviousAttempt,
): Promise<Attempt> {
  const patch = await generateFix({ context, ...(previousAttempt ? { previousAttempt } : {}) });
  const verification = await verifyFix({ patch, originalViolation: violation });
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
 */
async function resolveViolation(
  context: FixContext,
  violation: AxeViolation,
): Promise<{ patch: ScoredPatch; verification: VerificationResult }> {
  const first = await attemptFix(context, violation);
  if (first.verification.status === 'verified') {
    return { patch: { ...first.patch, confidence: 'high' }, verification: first.verification };
  }

  const retry = await attemptFix(context, violation, {
    newSnippet: first.patch.newSnippet,
    remainingViolations: first.verification.remainingViolations,
    newViolations: first.verification.newViolations,
  });
  const confidence: PatchConfidence = retry.verification.status === 'verified' ? 'medium' : 'low';
  return { patch: { ...retry.patch, confidence }, verification: retry.verification };
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

async function scanFile(file: string, options: ScanOptions): Promise<ScanViolationResult[]> {
  const { violations } = await detectViolations({ componentPath: file });
  const results: ScanViolationResult[] = [];

  for (const violation of violations) {
    try {
      const context = await gatherContext({ violation, componentPath: file });
      const resolved = await resolveViolation(context, violation);

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
      });
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
 */
export async function scan(targetPath: string, options: ScanOptions = {}): Promise<ScanResult> {
  const absoluteTarget = path.resolve(targetPath);
  const files = resolveComponentFiles(absoluteTarget);

  const violations: ScanViolationResult[] = [];
  for (const file of files) {
    violations.push(...(await scanFile(file, options)));
  }

  return { targetPath: absoluteTarget, filesScanned: files.length, violations };
}
