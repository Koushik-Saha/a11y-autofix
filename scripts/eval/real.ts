/**
 * `npm run eval:real`: runs the real-model eval over test/fixtures/ and
 * writes a dated report to evals/. Needs ANTHROPIC_API_KEY and spends real
 * money, so it is never part of `npm test` or CI.
 *
 *   npm run eval:real                       all fixtures, jsdom
 *   npm run eval:real -- --browser          headless Chromium (adds color-contrast)
 *   npm run eval:real -- --only Vue         fixtures whose path contains "Vue"
 *   npm run eval:real -- --update-baseline  also write evals/baseline.md
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { runEval } from './harness';
import { BASELINE_PATH, EVALS_DIR, FIXTURES_DIR } from './paths';
import { renderReport } from './report';

export const MISSING_KEY_MESSAGE =
  'eval:real needs ANTHROPIC_API_KEY: it runs the real pipeline against the Claude API, one or two calls per violation, and that costs money. Set the key and re-run; nothing was called or written.';

/** `report-2026-10-30T11-45-12Z.md`, sortable by name. */
export function reportFileName(createdAt: string): string {
  return `report-${createdAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}.md`;
}

export interface RealOptions {
  browser?: boolean;
  only?: string[];
  updateBaseline?: boolean;
}

/** The eval:real command; returns the exit code. */
export async function runReal(options: RealOptions): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(MISSING_KEY_MESSAGE);
    return 1;
  }
  const only = options.only ?? [];
  if (options.updateBaseline && only.length > 0) {
    console.error(
      '--update-baseline needs a full run: a baseline from --only would leave the other fixtures ungated.',
    );
    return 1;
  }

  console.error(
    `Running the real-model eval over ${path.relative(process.cwd(), FIXTURES_DIR)} (real API calls)…`,
  );
  const report = await runEval({
    fixturesDir: FIXTURES_DIR,
    browser: Boolean(options.browser),
    only,
    log: (line) => console.error(`  ${line}`),
  });

  mkdirSync(EVALS_DIR, { recursive: true });
  const reportPath = path.join(EVALS_DIR, reportFileName(report.createdAt));
  writeFileSync(reportPath, renderReport(report));
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);
  if (options.updateBaseline) {
    copyFileSync(reportPath, BASELINE_PATH);
    console.log(`Baseline updated: ${path.relative(process.cwd(), BASELINE_PATH)} (commit it)`);
  }
  return 0;
}

/* c8 ignore start -- run via `npm run eval:real` */
if (require.main === module) {
  const program = new Command()
    .name('eval:real')
    .option('--browser', 'detect and verify in headless Chromium (adds color-contrast)')
    .option(
      '--only <substring>',
      'only fixtures whose path contains this (repeatable)',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option('--update-baseline', 'also copy the report to evals/baseline.md')
    .parse(process.argv);
  runReal(program.opts<RealOptions>()).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
