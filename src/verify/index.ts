/**
 * verify/ — applies a proposed Patch to the component's source in memory
 * (the file on disk is never touched), re-runs axe-core via detect/, and
 * confirms the targeted violation is actually gone and that the patch
 * didn't introduce a new one. This is the trust boundary of the pipeline:
 * a patch that doesn't verify is never discarded — it comes back with
 * `status: 'unverified'` plus the violations that prove it, for cli/ to
 * surface rather than silently drop.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { AxeViolation } from '../detect';
import { detectViolationsInSource } from '../detect';
import type { Patch } from '../generate';

export type VerificationStatus = 'verified' | 'unverified';

export interface VerificationResult {
  status: VerificationStatus;
  patch: Patch;
  targetViolation: AxeViolation;
  /** Post-patch violations sharing the target's rule id — empty when resolved. */
  remainingViolations: AxeViolation[];
  /** Post-patch violations whose rule id wasn't present before patching — regressions. */
  newViolations: AxeViolation[];
}

export interface VerifyFixOptions {
  patch: Patch;
  originalViolation: AxeViolation;
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
 * Replaces `patch.oldSnippet` with `patch.newSnippet` in `source`, requiring
 * exactly one occurrence — refusing to guess which one to touch rather than
 * silently patching the wrong element. Shared by `verifyFix` (in memory)
 * and cli/'s `--write` step (applied to a file it then writes to disk).
 */
export function applyPatchToSource(source: string, patch: Patch): string {
  const occurrences = countOccurrences(source, patch.oldSnippet);
  if (occurrences !== 1) {
    throw new Error(
      `Cannot apply patch for violation "${patch.violationId}": expected its oldSnippet to appear exactly once in the source, found ${occurrences}`,
    );
  }
  return source.replace(patch.oldSnippet, patch.newSnippet);
}

export async function verifyFix(options: VerifyFixOptions): Promise<VerificationResult> {
  const { patch, originalViolation } = options;
  const filePath = path.resolve(patch.filePath);

  const originalSource = readFileSync(filePath, 'utf8');
  let patchedSource: string;
  try {
    patchedSource = applyPatchToSource(originalSource, patch);
  } catch (error) {
    throw new Error(`${(error as Error).message} (in ${filePath})`);
  }

  // Sequential, not Promise.all: each render swaps process-wide globals
  // (see detect/'s withJsdomEnvironment) for its duration, so two renders
  // can't safely run concurrently in this process.
  const before = await detectViolationsInSource({ source: originalSource, filePath });
  const after = await detectViolationsInSource({ source: patchedSource, filePath });

  const beforeRuleIds = new Set(before.violations.map((violation) => violation.id));
  const remainingViolations = after.violations.filter(
    (violation) => violation.id === originalViolation.id,
  );
  const newViolations = after.violations.filter((violation) => !beforeRuleIds.has(violation.id));

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
