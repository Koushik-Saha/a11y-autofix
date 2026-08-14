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

import { appendCorrection } from './corrections-log';
import { createInteractiveHandler } from './interactive';
import type { InteractiveHandler } from './interactive';
import type { AxeViolation } from '../detect';
import type { Patch } from '../generate';
import type { PatchConfidence, ScanOptions, ScanResult, ScanViolationResult } from '../scan';
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

function printVerificationOutcome(
  result: VerificationResult,
  applied: boolean,
  confidence: PatchConfidence,
): void {
  if (result.status === 'verified') {
    console.log(
      `${applied ? '  [verified] fix applied to disk' : '  [verified] fix confirmed (pass --write to apply)'} (confidence: ${confidence})`,
    );
    return;
  }

  console.log(
    `  [unverified] this fix did not resolve the violation — not applied (confidence: ${confidence})`,
  );
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
  printVerificationOutcome(entry.verification, entry.applied, entry.patch.confidence);
}

function summarize(result: ScanResult): ScanSummary {
  const summary: ScanSummary = {
    filesScanned: result.filesScanned,
    violationsFound: result.violations.length,
    verified: 0,
    unverified: 0,
    errored: 0,
  };

  for (const entry of result.violations) {
    if (entry.status === 'verified') summary.verified += 1;
    else if (entry.status === 'unverified') summary.unverified += 1;
    else summary.errored += 1;
  }

  return summary;
}

function printScanResult(result: ScanResult, summary: ScanSummary): void {
  if (result.violations.length === 0) {
    console.log(`No accessibility violations found in ${displayPath(result.targetPath)}.`);
    return;
  }

  let currentFile: string | null = null;
  for (const entry of result.violations) {
    if (entry.filePath !== currentFile) {
      currentFile = entry.filePath;
      console.log(`\n${displayPath(currentFile)}`);
    }

    printViolationResult(entry);
  }

  console.log(
    `\n${summary.violationsFound} violation(s) found across ${summary.filesScanned} file(s): ` +
      `${summary.verified} verified, ${summary.unverified} unverified, ${summary.errored} errored.`,
  );
}

export interface CliScanOptions extends ScanOptions {
  /** Print the full ScanResult as JSON instead of a human-readable diff — for machine consumers (e.g. the GitHub Action). */
  json?: boolean;
  /** Review each verified fix before applying it: accept, reject, or edit. Without --write, this is a dry-run review (nothing is ever written, accept or not). */
  interactive?: boolean;
  /**
   * When used with --interactive, appends every rejected or edited fix to
   * `.a11y-autofix/corrections.log` — fully local, opt-in, never sent
   * anywhere. See README.md's "Local corrections log" section. Has no
   * effect without --interactive (nothing is ever rejected or edited
   * outside it).
   */
  logCorrections?: boolean;
}

function buildCorrectionsLogger(): NonNullable<ScanOptions['onFixResolved']> {
  return (info) => {
    if (info.outcome === 'accepted') return;
    appendCorrection(process.cwd(), {
      timestamp: new Date().toISOString(),
      filePath: displayPath(info.filePath),
      startLine: info.startLine,
      violationId: info.violation.id,
      action: info.outcome === 'edited' ? 'edited' : 'rejected',
      suggested: info.suggested.newSnippet,
      ...(info.editedSnippet ? { edited: info.editedSnippet } : {}),
    });
  };
}

export async function runScan(
  targetPath: string,
  options: CliScanOptions = {},
): Promise<ScanSummary> {
  const { json, interactive, logCorrections, ...scanOptions } = options;

  if (json && interactive) {
    console.error(
      '--interactive cannot be combined with --json: interactive prompts would corrupt the JSON written to stdout.',
    );
    process.exitCode = 1;
    return { filesScanned: 0, violationsFound: 0, verified: 0, unverified: 0, errored: 0 };
  }

  if (logCorrections && !interactive) {
    console.error(
      '--log-corrections has no effect without --interactive: nothing is ever rejected or edited outside interactive mode.',
    );
  }

  let interactiveHandler: InteractiveHandler | undefined;
  if (interactive) {
    interactiveHandler = createInteractiveHandler();
    scanOptions.onVerifiedFix = interactiveHandler.onVerifiedFix;
  }
  if (logCorrections && interactive) {
    scanOptions.onFixResolved = buildCorrectionsLogger();
  }

  let result: ScanResult;
  try {
    try {
      result = await scan(targetPath, scanOptions);
    } catch (error) {
      if (json) {
        console.error(JSON.stringify({ error: (error as Error).message }));
      } else {
        console.error(`Could not read path "${targetPath}": ${(error as Error).message}`);
      }
      process.exitCode = 1;
      return { filesScanned: 0, violationsFound: 0, verified: 0, unverified: 0, errored: 0 };
    }
  } finally {
    interactiveHandler?.close();
  }

  const summary = summarize(result);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printScanResult(result, summary);
  }

  const resolvedCount = scanOptions.write ? summary.verified : 0;
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
      'Scan React and Vue components with axe-core, generate verified WCAG fix diffs via the Claude API.',
    )
    .version(version);

  program
    .command('scan')
    .description(
      'Scan a React or Vue component (or directory) for WCAG violations and propose verified fixes',
    )
    .argument('<path>', 'path to a component file or directory')
    .option(
      '--write',
      'apply verified fixes directly to files (unverified fixes are never applied)',
    )
    .option('--json', 'print the full scan result as JSON instead of a human-readable diff')
    .option(
      '--interactive',
      'review each verified fix before applying it: accept, reject, or edit (without --write, this only reviews — nothing is ever written)',
    )
    .option(
      '--log-corrections',
      'with --interactive, save rejected/edited fixes to .a11y-autofix/corrections.log for your own reference — fully local, opt-in, never sent anywhere',
    )
    .action(async (targetPath: string, options: CliScanOptions) => {
      await runScan(targetPath, options);
    });

  program.parse(process.argv);
}

if (require.main === module) {
  main();
}
/* c8 ignore stop */
