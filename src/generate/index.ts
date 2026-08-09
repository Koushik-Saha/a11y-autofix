/**
 * generate/ — sends a FixContext to the Claude API and returns a proposed
 * diff plus a plain-language explanation. Output is unverified until
 * verify/ re-runs axe-core against the patched component.
 */

import type { FixContext } from '../context';

export interface FixDiff {
  filePath: string;
  diff: string;
  explanation: string;
}

export interface GenerateFixOptions {
  context: FixContext;
}

export async function generateFix(_options: GenerateFixOptions): Promise<FixDiff> {
  throw new Error('Not implemented');
}
