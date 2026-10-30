/**
 * eval:compare's logic: diffs a new report against the baseline, case by
 * case. The gate fails on any case the baseline verified that the new
 * report doesn't. That covers "a violation type that used to be accepted
 * is now rejected" at the finest grain: a type at 3/3 that drops to 2/3
 * fails, not just one that drops to 0/3.
 */

import type { CaseStatus, CompleteReport, EvalCase, EvalReport } from './harness';
import { typeStats } from './report';

export interface CaseChange {
  key: string;
  ruleId: string;
  before: CaseStatus;
  /** 'missing' when the new run has no such case (violation no longer detected, or the fixture failed to scan). */
  after: CaseStatus | 'missing';
  /** The new run's reason, when it has one. */
  reason: string | null;
}

export interface TypeChange {
  ruleId: string;
  before: { verified: number; cases: number };
  after: { verified: number; cases: number };
}

export interface Comparison {
  /** Verified in the baseline, not verified now: these fail the gate. */
  regressions: CaseChange[];
  /** Not verified in the baseline, verified now. */
  improvements: CaseChange[];
  /** Cases only in the new run. */
  added: string[];
  /** Baseline cases from fixtures the new run deliberately skipped (`--only`): neither pass nor fail. */
  notRun: string[];
  /** Per-type acceptance where it changed. */
  typeChanges: TypeChange[];
  unchanged: number;
}

/** Thrown when two reports can't be meaningfully compared; eval:compare exits 2. */
export class CannotCompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CannotCompareError';
  }
}

function indexCases(report: CompleteReport): Map<string, EvalCase> {
  return new Map(report.fixtures.flatMap((fixture) => fixture.cases).map((c) => [c.key, c]));
}

function wasRun(report: CompleteReport, fixture: string): boolean {
  return report.only.length === 0 || report.only.some((filter) => fixture.includes(filter));
}

export function compareReports(baseline: EvalReport, current: EvalReport): Comparison {
  if (baseline.status === 'empty') {
    throw new CannotCompareError(
      `The baseline is empty: ${baseline.reason} Record one with \`npm run eval:real -- --update-baseline\` (needs ANTHROPIC_API_KEY) and commit evals/baseline.md.`,
    );
  }
  if (current.status === 'empty') {
    throw new CannotCompareError('The report to compare is an empty baseline marker, not a run.');
  }
  if (baseline.mode !== current.mode) {
    throw new CannotCompareError(
      `The baseline was run in ${baseline.mode} mode and this report in ${current.mode} mode, so they check different rules. Re-run with${baseline.mode === 'browser' ? '' : 'out'} --browser.`,
    );
  }

  const before = indexCases(baseline);
  const after = indexCases(current);
  const comparison: Comparison = {
    regressions: [],
    improvements: [],
    added: [],
    notRun: [],
    typeChanges: [],
    unchanged: 0,
  };

  for (const [key, old] of before) {
    if (!wasRun(current, old.fixture)) {
      comparison.notRun.push(key);
      continue;
    }
    const now = after.get(key);
    const change: CaseChange = {
      key,
      ruleId: old.ruleId,
      before: old.status,
      after: now?.status ?? 'missing',
      reason:
        now?.failureReason ??
        (now ? null : (current.fixtures.find((f) => f.fixture === old.fixture)?.error ?? null)),
    };
    const wasVerified = old.status === 'verified';
    const isVerified = change.after === 'verified';
    if (wasVerified && !isVerified) comparison.regressions.push(change);
    else if (!wasVerified && isVerified) comparison.improvements.push(change);
    else comparison.unchanged += 1;
  }
  for (const key of after.keys()) {
    if (!before.has(key)) comparison.added.push(key);
  }

  const oldStats = new Map(typeStats(baseline).map((stats) => [stats.ruleId, stats]));
  const newStats = new Map(typeStats(current).map((stats) => [stats.ruleId, stats]));
  for (const ruleId of [...new Set([...oldStats.keys(), ...newStats.keys()])].sort()) {
    const was = oldStats.get(ruleId) ?? { verified: 0, cases: 0 };
    const now = newStats.get(ruleId) ?? { verified: 0, cases: 0 };
    if (was.verified !== now.verified || was.cases !== now.cases) {
      comparison.typeChanges.push({
        ruleId,
        before: { verified: was.verified, cases: was.cases },
        after: { verified: now.verified, cases: now.cases },
      });
    }
  }
  return comparison;
}

export function formatComparison(comparison: Comparison): string {
  const lines: string[] = [];
  if (comparison.regressions.length > 0) {
    lines.push(`REGRESSIONS (${comparison.regressions.length}): verified in the baseline, not now`);
    for (const change of comparison.regressions) {
      lines.push(
        `  ✗ ${change.key}: ${change.before} → ${change.after}${change.reason ? ` (${change.reason})` : ''}`,
      );
    }
  }
  if (comparison.improvements.length > 0) {
    lines.push(`Improvements (${comparison.improvements.length}):`);
    for (const change of comparison.improvements) {
      lines.push(`  ✓ ${change.key}: ${change.before} → ${change.after}`);
    }
  }
  if (comparison.typeChanges.length > 0) {
    lines.push('Acceptance by type, where it changed:');
    for (const change of comparison.typeChanges) {
      lines.push(
        `  ${change.ruleId}: ${change.before.verified}/${change.before.cases} → ${change.after.verified}/${change.after.cases}`,
      );
    }
  }
  if (comparison.added.length > 0) {
    lines.push(`New cases, not in the baseline (not gated): ${comparison.added.join(', ')}`);
  }
  if (comparison.notRun.length > 0) {
    lines.push(
      `Not run this time (--only), not gated: ${comparison.notRun.length} baseline case(s)`,
    );
  }
  lines.push(
    comparison.regressions.length > 0
      ? `FAIL: ${comparison.regressions.length} previously verified case(s) regressed.`
      : `PASS: no previously verified case regressed (${comparison.unchanged} unchanged, ${comparison.improvements.length} improved).`,
  );
  return lines.join('\n');
}
