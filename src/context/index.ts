/**
 * context/ — gathers the source code and surrounding project context
 * needed to fix a single violation: the offending component's source,
 * related files, and existing conventions. Its output is the prompt
 * material handed to generate/.
 */

import type { AxeViolation } from '../detect';

export interface FixContext {
  violation: AxeViolation;
  componentPath: string;
  sourceCode: string;
  relatedFiles: string[];
}

export interface GatherContextOptions {
  violation: AxeViolation;
  componentPath: string;
}

export async function gatherContext(_options: GatherContextOptions): Promise<FixContext> {
  throw new Error('Not implemented');
}
