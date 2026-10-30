/**
 * The eval report: a markdown file people read, with the full run data
 * embedded at the end (between `<!-- eval-data -->` markers, in a fenced
 * JSON block) so eval:compare reads exactly what the run recorded rather
 * than re-parsing the prose.
 */

import { PRICING_AS_OF } from './pricing';
import { REPORT_FORMAT, REPORT_VERSION } from './harness';
import type { CompleteReport, EmptyBaseline, EvalCase, EvalReport, TokenTotals } from './harness';

const DATA_START = '<!-- eval-data:start -->';
const DATA_END = '<!-- eval-data:end -->';

/** A code fence longer than any backtick run in `text`, so quoted code can't close it early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function codeBlock(text: string, language = 'jsx'): string {
  const fence = fenceFor(text);
  return `${fence}${language}\n${text}\n${fence}`;
}

const usd = (value: number | null, digits = 4) =>
  value === null ? 'unknown' : `$${value.toFixed(digits)}`;
const count = (value: number) => value.toLocaleString('en-US');
const percent = (part: number, whole: number) =>
  whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`;

export interface TypeStats {
  ruleId: string;
  cases: number;
  verified: number;
  /** Verified on the first attempt (confidence 'high'). */
  firstTry: number;
  unverified: number;
  errored: number;
}

/** Acceptance per axe-core rule id, sorted by rule id. */
export function typeStats(report: CompleteReport): TypeStats[] {
  const byRule = new Map<string, TypeStats>();
  for (const evalCase of report.fixtures.flatMap((fixture) => fixture.cases)) {
    const stats = byRule.get(evalCase.ruleId) ?? {
      ruleId: evalCase.ruleId,
      cases: 0,
      verified: 0,
      firstTry: 0,
      unverified: 0,
      errored: 0,
    };
    stats.cases += 1;
    stats[evalCase.status] += 1;
    if (evalCase.status === 'verified' && evalCase.confidence === 'high') stats.firstTry += 1;
    byRule.set(evalCase.ruleId, stats);
  }
  return [...byRule.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

function tokensLine(totals: TokenTotals): string {
  return (
    `${count(totals.calls)} call(s); ${count(totals.inputTokens)} input, ` +
    `${count(totals.outputTokens)} output (of which ${count(totals.thinkingTokens)} thinking), ` +
    `${count(totals.cacheReadInputTokens)} cache-read, ${count(totals.cacheCreationInputTokens)} cache-write tokens`
  );
}

function rejectedAttemptsSection(cases: EvalCase[]): string[] {
  const lines: string[] = [];
  for (const evalCase of cases) {
    const rejected = evalCase.attempts.filter((attempt) => !attempt.verified);
    if (rejected.length === 0 && evalCase.status !== 'errored') continue;

    const outcome =
      evalCase.status === 'verified'
        ? 'verified on retry'
        : evalCase.status === 'unverified'
          ? 'never verified'
          : 'errored';
    lines.push(
      `### \`${evalCase.key}\` (${outcome})`,
      '',
      `Line ${evalCase.startLine ?? '?'}, impact ${evalCase.impact ?? 'unknown'}.`,
      '',
    );
    if (evalCase.oldSnippet !== null) {
      lines.push('Original element:', '', codeBlock(evalCase.oldSnippet), '');
    }
    for (const attempt of rejected) {
      const why = [
        attempt.stillFlagged.length > 0 ? `still flagged: ${attempt.stillFlagged.join(', ')}` : '',
        attempt.introduced.length > 0 ? `introduced: ${attempt.introduced.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      lines.push(
        `Attempt ${attempt.attempt}, rejected (${why || 'not verified'}):`,
        '',
        codeBlock(attempt.newSnippet),
        '',
      );
    }
    if (evalCase.status === 'errored') {
      lines.push(`Error: ${evalCase.failureReason ?? 'unknown'}`, '');
    }
  }
  return lines.length > 0 ? lines : ['None — every attempt verified.', ''];
}

export function renderReport(report: CompleteReport): string {
  const cases = report.fixtures.flatMap((fixture) => fixture.cases);
  const verified = cases.filter((c) => c.status === 'verified');
  const firstTry = verified.filter((c) => c.confidence === 'high').length;
  const unverified = cases.filter((c) => c.status === 'unverified').length;
  const errored = cases.filter((c) => c.status === 'errored').length;
  const fixtureErrors = report.fixtures.filter((fixture) => fixture.error !== null);
  const { totals } = report;
  const perViolation =
    totals.costUsd === null || cases.length === 0 ? null : totals.costUsd / cases.length;

  const lines: string[] = [
    `# generate/ eval — ${report.createdAt}`,
    '',
    `- **Models:** ${report.models.join(', ') || 'none called'}`,
    `- **Render mode:** ${report.mode}${report.mode === 'jsdom' ? ' (color-contrast is not checked; run with `--browser` to include it)' : ''}`,
    `- **Fixtures:** ${report.fixtures.length}${report.only.length > 0 ? ` (limited to: ${report.only.join(', ')})` : ''}`,
    `- **Violations:** ${cases.length}. ${verified.length} verified (${percent(verified.length, cases.length)}; ${firstTry} first try, ${verified.length - firstTry} after a retry), ${unverified} unverified, ${errored} errored.`,
    ...(fixtureErrors.length > 0
      ? [`- **Fixtures that failed to scan:** ${fixtureErrors.map((f) => f.fixture).join(', ')}`]
      : []),
    `- **Tokens:** ${tokensLine(totals)}.`,
    `- **Estimated cost:** ${usd(totals.costUsd)} total; ${usd(perViolation)} per violation on average, so about ${usd(perViolation === null ? null : perViolation * 100, 2)} per 100 violations. Only generate/ costs money: detect and verify run locally. Prices as of ${PRICING_AS_OF} (scripts/eval/pricing.ts).`,
    '',
    '## Acceptance by violation type',
    '',
    '| Rule | Violations | Verified | First try | Unverified | Errored | Acceptance |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...typeStats(report).map(
      (stats) =>
        `| \`${stats.ruleId}\` | ${stats.cases} | ${stats.verified} | ${stats.firstTry} | ${stats.unverified} | ${stats.errored} | ${percent(stats.verified, stats.cases)} |`,
    ),
    '',
    '## Per fixture',
    '',
    '| Fixture | Violations found | Outcome | Calls | Input tokens | Output tokens (thinking) | Est. cost |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.fixtures.map((fixture) => {
      const outcome = fixture.error
        ? `scan failed: ${fixture.error.replace(/\|/g, '\\|').split('\n')[0]}`
        : fixture.cases.length === 0
          ? 'clean'
          : fixture.cases
              .map((c) => `${c.ruleId}: ${c.status}${c.confidence ? ` (${c.confidence})` : ''}`)
              .join('<br>');
      return `| \`${fixture.fixture}\` | ${fixture.violationsFound.join(', ') || 'none'} | ${outcome} | ${fixture.usage.calls} | ${count(fixture.usage.inputTokens)} | ${count(fixture.usage.outputTokens)} (${count(fixture.usage.thinkingTokens)}) | ${usd(fixture.usage.costUsd)} |`;
    }),
    '',
    '## Rejected fixes',
    '',
    'Every attempt verify/ rejected, quoted in full, including first attempts that a retry then fixed. These are the interesting data.',
    '',
    ...rejectedAttemptsSection(cases),
    '## Accepted fixes',
    '',
    '<details><summary>Every verified fix, as written to the file</summary>',
    '',
    ...verified.flatMap((c) => [
      `**\`${c.key}\`** (${c.confidence}):`,
      '',
      codeBlock(c.newSnippet ?? ''),
      '',
    ]),
    '</details>',
    '',
    ...dataSection(report),
  ];
  return lines.join('\n');
}

function dataSection(report: EvalReport): string[] {
  const json = JSON.stringify(report, null, 2);
  return [
    '## Raw data',
    '',
    '<details><summary>Read by <code>npm run eval:compare</code>. Do not edit by hand, except to doctor a report when testing the gate.</summary>',
    '',
    DATA_START,
    codeBlock(json, 'json'),
    DATA_END,
    '',
    '</details>',
    '',
  ];
}

/** The committed placeholder until a real run produces a baseline. */
export function renderEmptyBaseline(baseline: EmptyBaseline): string {
  return [
    '# generate/ eval baseline: not yet recorded',
    '',
    `No real-model run has been recorded. ${baseline.reason}`,
    '',
    'To record one: `ANTHROPIC_API_KEY=… npm run eval:real -- --update-baseline`, then commit `evals/baseline.md`. Until then, `npm run eval:compare` exits 2 ("no baseline"), not 0, so a missing baseline is never mistaken for a pass.',
    '',
    ...dataSection(baseline),
  ].join('\n');
}

export function emptyBaseline(reason: string, now = new Date()): EmptyBaseline {
  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    status: 'empty',
    createdAt: now.toISOString(),
    reason,
  };
}

export class ReportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportFormatError';
  }
}

/** Reads the embedded data back out of a report or baseline file. */
export function parseReport(markdown: string, source = 'report'): EvalReport {
  const start = markdown.indexOf(DATA_START);
  const end = markdown.indexOf(DATA_END, start);
  if (start === -1 || end === -1) {
    throw new ReportFormatError(
      `${source} has no eval data section (${DATA_START} … ${DATA_END}).`,
    );
  }
  const block = markdown.slice(start + DATA_START.length, end).trim();
  const fence = /^(`{3,})json\n/.exec(block)?.[1];
  if (!fence || !block.endsWith(fence)) {
    throw new ReportFormatError(`${source}: the eval data section is not a fenced JSON block.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(block.slice(fence.length + 'json\n'.length, -fence.length));
  } catch (error) {
    throw new ReportFormatError(
      `${source}: eval data is not valid JSON: ${(error as Error).message}`,
    );
  }
  const report = data as Partial<EvalReport>;
  if (report.format !== REPORT_FORMAT || report.version !== REPORT_VERSION) {
    throw new ReportFormatError(
      `${source}: expected ${REPORT_FORMAT} version ${REPORT_VERSION}, found ${String(report.format)} version ${String(report.version)}.`,
    );
  }
  if (report.status !== 'complete' && report.status !== 'empty') {
    throw new ReportFormatError(`${source}: unknown status ${String(report.status)}.`);
  }
  return report as EvalReport;
}
