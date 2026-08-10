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
import type { Patch } from './generate';
import { applyPatchToSource, verifyFix } from './verify';
import type { VerificationResult } from './verify';

export interface ScanOptions {
  /** Apply verified fixes directly to their files. Unverified fixes are never applied. */
  write?: boolean;
}

interface ScanViolationOutcomeBase {
  filePath: string;
  violation: AxeViolation;
}

export interface ScanViolationFixed extends ScanViolationOutcomeBase {
  status: 'verified' | 'unverified';
  context: FixContext;
  patch: Patch;
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

async function scanFile(file: string, options: ScanOptions): Promise<ScanViolationResult[]> {
  const { violations } = await detectViolations({ componentPath: file });
  const results: ScanViolationResult[] = [];

  for (const violation of violations) {
    try {
      const context = await gatherContext({ violation, componentPath: file });
      const patch = await generateFix({ context });
      const verification = await verifyFix({ patch, originalViolation: violation });

      let applied = false;
      if (verification.status === 'verified' && options.write) {
        const currentSource = readFileSync(patch.filePath, 'utf8');
        writeFileSync(patch.filePath, applyPatchToSource(currentSource, patch), 'utf8');
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
