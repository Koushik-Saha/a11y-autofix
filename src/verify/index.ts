/**
 * verify/ — applies a proposed Patch to a scratch copy of the component,
 * re-runs axe-core (via detect/), and confirms the original violation is
 * gone and no new violations were introduced. Only verified fixes are
 * surfaced to the user by cli/.
 */

import type { AxeViolation } from '../detect';
import type { Patch } from '../generate';

export interface VerificationResult {
  passed: boolean;
  resolvedViolation: AxeViolation;
  remainingViolations: AxeViolation[];
  newViolations: AxeViolation[];
}

export interface VerifyFixOptions {
  patch: Patch;
  originalViolation: AxeViolation;
}

export async function verifyFix(_options: VerifyFixOptions): Promise<VerificationResult> {
  throw new Error('Not implemented');
}
