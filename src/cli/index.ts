#!/usr/bin/env node

/**
 * cli/ — the bin entry point. Renders the results of scan/'s
 * detect -> context -> generate -> verify pipeline to the terminal: a
 * unified diff plus a verified/unverified/errored outcome for every
 * violation, an optional --write of verified fixes to disk, and a summary
 * line with a non-zero exit code when anything is left unresolved.
 *
 * `runScan` is exported (not just invoked via commander) so it can be
 * driven directly in tests without going through process.argv/process.exit.
 * `program.parse` only runs when this file is executed directly.
 */

import path from 'node:path';

import { Command } from 'commander';

import type { AxeViolation } from '../detect';
import type { Patch } from '../generate';
import type { ScanOptions, ScanResult, ScanViolationResult } from '../scan';
import { scan } from '../scan';
import type { VerificationResult } from '../verify';

import { version } from '../../package.json';

export type { ScanOptions } from '../scan';

export interface ScanSummary {
  filesScanned: number;
  violationsFound: number;
  verified: number;
  unverified: number;
  errored: number;
}

function displayPath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath) || absolutePath;
}

function renderUnifiedDiff(relativePath: string, startLine: number, patch: Patch): string {
  const oldLines = patch.oldSnippet.split('\n');
  const newLines = patch.newSnippet.split('\n');
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

function printViolationHeader(violation: AxeViolation): void {
  console.log(
    `  [violation] ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}`,
  );
}

function printVerificationOutcome(result: VerificationResult, applied: boolean): void {
  if (result.status === 'verified') {
    console.log(
      applied
        ? '  [verified] fix applied to disk'
        : '  [verified] fix confirmed (pass --write to apply)',
    );
    return;
  }

  console.log('  [unverified] this fix did not resolve the violation — not applied');
  if (result.remainingViolations.length > 0) {
    console.log(`    still flagged: ${result.remainingViolations.map((v) => v.id).join(', ')}`);
  }
  if (result.newViolations.length > 0) {
    console.log(
      `    new violations introduced: ${result.newViolations.map((v) => v.id).join(', ')}`,
    );
  }
}

function printViolationResult(entry: ScanViolationResult): void {
  printViolationHeader(entry.violation);

  if (entry.status === 'errored') {
    console.log(`  [error] ${entry.error}`);
    return;
  }

  console.log(
    renderUnifiedDiff(
      displayPath(entry.filePath),
      entry.context.element.location.startLine,
      entry.patch,
    ),
  );
  printVerificationOutcome(entry.verification, entry.applied);
}

function printScanResult(result: ScanResult): ScanSummary {
  const summary: ScanSummary = {
    filesScanned: result.filesScanned,
    violationsFound: result.violations.length,
    verified: 0,
    unverified: 0,
    errored: 0,
  };

  if (result.violations.length === 0) {
    console.log(`No accessibility violations found in ${displayPath(result.targetPath)}.`);
    return summary;
  }

  let currentFile: string | null = null;
  for (const entry of result.violations) {
    if (entry.filePath !== currentFile) {
      currentFile = entry.filePath;
      console.log(`\n${displayPath(currentFile)}`);
    }

    printViolationResult(entry);

    if (entry.status === 'verified') summary.verified += 1;
    else if (entry.status === 'unverified') summary.unverified += 1;
    else summary.errored += 1;
  }

  console.log(
    `\n${summary.violationsFound} violation(s) found across ${summary.filesScanned} file(s): ` +
      `${summary.verified} verified, ${summary.unverified} unverified, ${summary.errored} errored.`,
  );

  return summary;
}

export async function runScan(targetPath: string, options: ScanOptions = {}): Promise<ScanSummary> {
  let result: ScanResult;
  try {
    result = await scan(targetPath, options);
  } catch (error) {
    console.error(`Could not read path "${targetPath}": ${(error as Error).message}`);
    process.exitCode = 1;
    return { filesScanned: 0, violationsFound: 0, verified: 0, unverified: 0, errored: 0 };
  }

  const summary = printScanResult(result);

  const resolvedCount = options.write ? summary.verified : 0;
  const unresolvedCount = summary.violationsFound - resolvedCount;
  if (unresolvedCount > 0) {
    process.exitCode = 1;
  }

  return summary;
}

/* c8 ignore start -- exercised via the actual CLI binary, not unit tests */
function main(): void {
  const program = new Command();

  program
    .name('a11y-autofix')
    .description(
      'Scan React components with axe-core, generate verified WCAG fix diffs via the Claude API.',
    )
    .version(version);

  program
    .command('scan')
    .description(
      'Scan a React component (or directory) for WCAG violations and propose verified fixes',
    )
    .argument('<path>', 'path to a component file or directory')
    .option(
      '--write',
      'apply verified fixes directly to files (unverified fixes are never applied)',
    )
    .action(async (targetPath: string, options: ScanOptions) => {
      await runScan(targetPath, options);
    });

  program.parse(process.argv);
}

if (require.main === module) {
  main();
}
/* c8 ignore stop */
