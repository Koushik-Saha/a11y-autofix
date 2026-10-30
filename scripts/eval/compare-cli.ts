/**
 * `npm run eval:compare [report]`: the regression gate for generate/
 * changes. Compares a report (default: the newest evals/report-*.md)
 * against evals/baseline.md.
 *
 * Exit codes: 0 no regressions; 1 a case the baseline verified is no
 * longer verified; 2 can't compare (no report, an empty baseline, a mode
 * mismatch, or an unreadable file) — never 0, so a gate that couldn't
 * run is never mistaken for a pass.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { CannotCompareError, compareReports, formatComparison } from './compare';
import { ReportFormatError, parseReport } from './report';
import { BASELINE_PATH, EVALS_DIR } from './paths';

export interface CompareRun {
  code: 0 | 1 | 2;
  output: string;
}

function latestReport(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const reports = readdirSync(dir)
    .filter((name) => /^report-.*\.md$/.test(name))
    .sort();
  return reports.length > 0 ? path.join(dir, reports.at(-1)!) : null;
}

export function runCompare(options: {
  reportPath?: string;
  baselinePath?: string;
  evalsDir?: string;
}): CompareRun {
  const baselinePath = options.baselinePath ?? BASELINE_PATH;
  const reportPath = options.reportPath ?? latestReport(options.evalsDir ?? EVALS_DIR);
  if (!reportPath) {
    return {
      code: 2,
      output: 'No report to compare: run `npm run eval:real` first (needs ANTHROPIC_API_KEY).',
    };
  }
  try {
    for (const file of [baselinePath, reportPath]) {
      if (!existsSync(file)) throw new CannotCompareError(`${file} does not exist.`);
    }
    const baseline = parseReport(readFileSync(baselinePath, 'utf8'), path.basename(baselinePath));
    const current = parseReport(readFileSync(reportPath, 'utf8'), path.basename(reportPath));
    const comparison = compareReports(baseline, current);
    return {
      code: comparison.regressions.length > 0 ? 1 : 0,
      output: `Comparing ${path.basename(reportPath)} with ${path.basename(baselinePath)}\n${formatComparison(comparison)}`,
    };
  } catch (error) {
    if (error instanceof CannotCompareError || error instanceof ReportFormatError) {
      return { code: 2, output: `Cannot compare: ${error.message}` };
    }
    throw error;
  }
}

/* c8 ignore start -- run via `npm run eval:compare` */
if (require.main === module) {
  const program = new Command()
    .name('eval:compare')
    .argument('[report]', 'report to check (default: newest evals/report-*.md)')
    .option('--baseline <path>', 'baseline to compare against', BASELINE_PATH)
    .parse(process.argv);
  const [reportPath] = program.args;
  const { code, output } = runCompare({
    ...(reportPath ? { reportPath } : {}),
    baselinePath: program.opts<{ baseline: string }>().baseline,
  });
  (code === 0 ? console.log : console.error)(output);
  process.exitCode = code;
}
/* c8 ignore stop */
