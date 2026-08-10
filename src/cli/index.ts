#!/usr/bin/env node

/**
 * cli/ — the bin entry point. Wires detect/ -> context/ -> generate/ -> verify/
 * into a single scan command and renders verified fix diffs for the user.
 *
 * `runScan` is exported (not just invoked via commander) so it can be
 * driven directly in tests without going through process.argv/process.exit.
 * `program.parse` only runs when this file is executed directly.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { detectViolations, resolveComponentFiles } from '../detect';
import type { AxeViolation } from '../detect';
import { gatherContext } from '../context';
import { generateFix } from '../generate';
import type { Patch } from '../generate';
import { applyPatchToSource, verifyFix } from '../verify';
import type { VerificationResult } from '../verify';

import { version } from '../../package.json';

export interface ScanOptions {
  write?: boolean;
}

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

async function scanFile(file: string, options: ScanOptions, summary: ScanSummary): Promise<void> {
  const { violations } = await detectViolations({ componentPath: file });
  if (violations.length === 0) return;

  console.log(`\n${displayPath(path.resolve(file))}`);

  for (const violation of violations) {
    summary.violationsFound += 1;
    printViolationHeader(violation);

    let contextResult;
    try {
      contextResult = await gatherContext({ violation, componentPath: file });
    } catch (error) {
      summary.errored += 1;
      console.log(`  [error] could not locate a fixable JSX node: ${(error as Error).message}`);
      continue;
    }

    let patch: Patch;
    try {
      patch = await generateFix({ context: contextResult });
    } catch (error) {
      summary.errored += 1;
      console.log(`  [error] could not generate a fix: ${(error as Error).message}`);
      continue;
    }

    let result: VerificationResult;
    try {
      result = await verifyFix({ patch, originalViolation: violation });
    } catch (error) {
      summary.errored += 1;
      console.log(`  [error] could not verify the generated fix: ${(error as Error).message}`);
      continue;
    }

    console.log(
      renderUnifiedDiff(
        displayPath(path.resolve(file)),
        contextResult.element.location.startLine,
        patch,
      ),
    );

    let applied = false;
    if (result.status === 'verified' && options.write) {
      const currentSource = readFileSync(patch.filePath, 'utf8');
      writeFileSync(patch.filePath, applyPatchToSource(currentSource, patch), 'utf8');
      applied = true;
    }
    printVerificationOutcome(result, applied);

    if (result.status === 'verified') {
      summary.verified += 1;
    } else {
      summary.unverified += 1;
    }
  }
}

export async function runScan(targetPath: string, options: ScanOptions = {}): Promise<ScanSummary> {
  const summary: ScanSummary = {
    filesScanned: 0,
    violationsFound: 0,
    verified: 0,
    unverified: 0,
    errored: 0,
  };

  const absoluteTarget = path.resolve(targetPath);
  let files: string[];
  try {
    files = resolveComponentFiles(absoluteTarget);
  } catch (error) {
    console.error(`Could not read path "${targetPath}": ${(error as Error).message}`);
    process.exitCode = 1;
    return summary;
  }

  for (const file of files) {
    summary.filesScanned += 1;
    await scanFile(file, options, summary);
  }

  if (summary.violationsFound === 0) {
    console.log(`No accessibility violations found in ${displayPath(absoluteTarget)}.`);
    return summary;
  }

  const resolvedCount = options.write ? summary.verified : 0;
  const unresolvedCount = summary.violationsFound - resolvedCount;

  console.log(
    `\n${summary.violationsFound} violation(s) found across ${summary.filesScanned} file(s): ` +
      `${summary.verified} verified, ${summary.unverified} unverified, ${summary.errored} errored.`,
  );

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
