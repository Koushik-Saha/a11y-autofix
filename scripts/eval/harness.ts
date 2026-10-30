/**
 * The real-model eval: runs the same scan() pipeline the CLI uses
 * (detect -> context -> generate -> verify, with its one retry) over every
 * component fixture in test/fixtures/, and records what happened to each
 * violation, every attempt the model made, and what the calls cost.
 *
 * Nothing here talks to the model directly; generate/ does, exactly as in
 * a normal scan. scan()'s `onAttempt` / `onUsage` hooks only observe.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveComponentFiles } from '../../src/detect';
import { withBrowserSession } from '../../src/detect/browser';
import type { FixContext } from '../../src/context';
import type { GenerationUsage } from '../../src/generate';
import type { AttemptInfo, ScanViolationResult } from '../../src/scan';
import { scan } from '../../src/scan';

import { callCost } from './pricing';

export const REPORT_FORMAT = 'a11y-autofix-eval';
export const REPORT_VERSION = 1;

export interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Part of `outputTokens`; counted only when the API reports it. */
  thinkingTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** USD; null if any call was to a model with no known price. */
  costUsd: number | null;
}

export interface EvalAttempt {
  attempt: 1 | 2;
  newSnippet: string;
  verified: boolean;
  /** Rule ids still flagged after applying this attempt. */
  stillFlagged: string[];
  /** Rule ids this attempt introduced. */
  introduced: string[];
}

export type CaseStatus = 'verified' | 'unverified' | 'errored';

export interface EvalCase {
  /** Stable id used by eval:compare: `<fixture>#<rule>#<n>`, n counting that rule's elements in the fixture. */
  key: string;
  fixture: string;
  ruleId: string;
  impact: string | null;
  startLine: number | null;
  status: CaseStatus;
  confidence: 'high' | 'medium' | 'low' | null;
  /** The element as scanned. */
  oldSnippet: string | null;
  /** The final proposed fix (the retry's, if there was one). */
  newSnippet: string | null;
  /** Why it isn't verified: still-flagged/introduced rules, or the error. Null when verified. */
  failureReason: string | null;
  /** Every generate+verify attempt, in order; a 'medium' case has a rejected first attempt here. */
  attempts: EvalAttempt[];
  usage: TokenTotals;
}

export interface EvalFixture {
  fixture: string;
  /** Rule ids axe-core reported, one per offending element. Empty for a clean fixture. */
  violationsFound: string[];
  /** Set when scanning the fixture failed outright (no cases recorded). */
  error: string | null;
  cases: EvalCase[];
  /** All calls made for this fixture, including any not tied to a recorded case. */
  usage: TokenTotals;
}

export interface CompleteReport {
  format: typeof REPORT_FORMAT;
  version: typeof REPORT_VERSION;
  status: 'complete';
  createdAt: string;
  mode: 'jsdom' | 'browser';
  /** Models that served the calls (from the API responses). */
  models: string[];
  /** Substring filters the run was limited to; empty means every fixture. */
  only: string[];
  fixtures: EvalFixture[];
  totals: TokenTotals;
}

/** The committed placeholder until the first real run: compare refuses to gate against it. */
export interface EmptyBaseline {
  format: typeof REPORT_FORMAT;
  version: typeof REPORT_VERSION;
  status: 'empty';
  createdAt: string;
  reason: string;
}

export type EvalReport = CompleteReport | EmptyBaseline;

export function emptyTotals(): TokenTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0,
  };
}

function addUsage(totals: TokenTotals, usage: GenerationUsage): void {
  totals.calls += 1;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.thinkingTokens += usage.thinkingTokens ?? 0;
  totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  totals.cacheReadInputTokens += usage.cacheReadInputTokens;
  const cost = callCost(usage);
  totals.costUsd = totals.costUsd === null || cost === null ? null : totals.costUsd + cost;
}

export function sumTotals(all: TokenTotals[]): TokenTotals {
  return all.reduce(
    (sum, totals) => ({
      calls: sum.calls + totals.calls,
      inputTokens: sum.inputTokens + totals.inputTokens,
      outputTokens: sum.outputTokens + totals.outputTokens,
      thinkingTokens: sum.thinkingTokens + totals.thinkingTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + totals.cacheCreationInputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + totals.cacheReadInputTokens,
      costUsd:
        sum.costUsd === null || totals.costUsd === null ? null : sum.costUsd + totals.costUsd,
    }),
    emptyTotals(),
  );
}

/**
 * Every component file in `fixturesDir` and its immediate subdirectories
 * (e.g. two-files/), as paths relative to `fixturesDir`. Non-component
 * files (like lib/projectActions.ts) are never listed.
 */
export function listFixtures(fixturesDir: string): string[] {
  const directories = [
    fixturesDir,
    ...readdirSync(fixturesDir)
      .map((entry) => path.join(fixturesDir, entry))
      .filter((entry) => statSync(entry).isDirectory()),
  ];
  return directories
    .flatMap((directory) => resolveComponentFiles(directory))
    .map((file) => path.relative(fixturesDir, file).split(path.sep).join('/'))
    .sort();
}

/** Identifies one source element's violation, the same way from a FixContext and from a scan result. */
function elementKey(context: FixContext): string {
  return `${context.violation.id}@${context.element.location.startOffset}`;
}

function failureReason(entry: ScanViolationResult): string | null {
  if (entry.status === 'verified') return null;
  if (entry.status === 'errored') {
    return entry.reason === 'not-auto-fixable' ? `not auto-fixable: ${entry.error}` : entry.error;
  }
  const parts = [];
  const { remainingViolations, newViolations } = entry.verification;
  if (remainingViolations.length > 0) {
    parts.push(`still flagged: ${remainingViolations.map((v) => v.id).join(', ')}`);
  }
  if (newViolations.length > 0) {
    parts.push(`introduced: ${newViolations.map((v) => v.id).join(', ')}`);
  }
  return parts.join('; ') || 'not verified';
}

export interface RunEvalOptions {
  fixturesDir: string;
  /** Detect and verify in headless Chromium (adds color-contrast). */
  browser?: boolean;
  /** Only fixtures whose relative path contains one of these substrings. */
  only?: string[];
  now?: () => Date;
  /** Progress lines (one per fixture). */
  log?: (line: string) => void;
}

async function evaluateFixture(
  fixturesDir: string,
  fixture: string,
  browser: boolean,
  models: Set<string>,
): Promise<EvalFixture> {
  const attempts = new Map<string, EvalAttempt[]>();
  const usageByElement = new Map<string, TokenTotals>();
  const fixtureUsage = emptyTotals();

  const onAttempt = ({ context, attempt, patch, verification }: AttemptInfo) => {
    const key = elementKey(context);
    attempts.set(key, [
      ...(attempts.get(key) ?? []),
      {
        attempt,
        newSnippet: patch.newSnippet,
        verified: verification.status === 'verified',
        stillFlagged: verification.remainingViolations.map((v) => v.id),
        introduced: verification.newViolations.map((v) => v.id),
      },
    ]);
  };
  const onUsage = (usage: GenerationUsage, context: FixContext) => {
    models.add(usage.model);
    addUsage(fixtureUsage, usage);
    const key = elementKey(context);
    const totals = usageByElement.get(key) ?? emptyTotals();
    addUsage(totals, usage);
    usageByElement.set(key, totals);
  };

  let result;
  try {
    result = await scan(path.join(fixturesDir, fixture), { browser, onAttempt, onUsage });
  } catch (error) {
    // No Chromium means no fixture can run: stop rather than record
    // every fixture as failed.
    if ((error as Error)?.name === 'BrowserUnavailableError') throw error;
    return {
      fixture,
      violationsFound: [],
      error: (error as Error).message,
      cases: [],
      usage: fixtureUsage,
    };
  }

  const occurrences = new Map<string, number>();
  const cases = result.violations.map((entry): EvalCase => {
    const ruleId = entry.violation.id;
    const occurrence = (occurrences.get(ruleId) ?? 0) + 1;
    occurrences.set(ruleId, occurrence);
    const key = entry.status === 'errored' ? null : elementKey(entry.context);
    return {
      key: `${fixture}#${ruleId}#${occurrence}`,
      fixture,
      ruleId,
      impact: entry.violation.impact,
      startLine: entry.status === 'errored' ? null : entry.context.element.location.startLine,
      status: entry.status,
      confidence: entry.status === 'errored' ? null : entry.patch.confidence,
      oldSnippet: entry.status === 'errored' ? null : entry.patch.oldSnippet,
      newSnippet: entry.status === 'errored' ? null : entry.patch.newSnippet,
      failureReason: failureReason(entry),
      attempts: (key && attempts.get(key)) || [],
      usage: (key && usageByElement.get(key)) || emptyTotals(),
    };
  });

  return {
    fixture,
    violationsFound: result.violations.map((entry) => entry.violation.id),
    error: null,
    cases,
    usage: fixtureUsage,
  };
}

/** Runs the real pipeline over the fixtures. Makes real model calls unless generate/ is mocked. */
export async function runEval(options: RunEvalOptions): Promise<CompleteReport> {
  const browser = Boolean(options.browser);
  const only = options.only ?? [];
  const fixtures = listFixtures(options.fixturesDir).filter(
    (fixture) => only.length === 0 || only.some((filter) => fixture.includes(filter)),
  );
  const createdAt = (options.now?.() ?? new Date()).toISOString();

  const results: EvalFixture[] = [];
  const models = new Set<string>();
  const runAll = async () => {
    for (const fixture of fixtures) {
      const result = await evaluateFixture(options.fixturesDir, fixture, browser, models);
      results.push(result);
      const verified = result.cases.filter((c) => c.status === 'verified').length;
      options.log?.(
        result.error
          ? `${fixture}: error — ${result.error}`
          : `${fixture}: ${result.cases.length} violation(s), ${verified} verified, ${result.usage.calls} call(s)`,
      );
    }
  };
  await (browser ? withBrowserSession(runAll) : runAll());

  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    status: 'complete',
    createdAt,
    mode: browser ? 'browser' : 'jsdom',
    models: [...models].sort(),
    only,
    fixtures: results,
    totals: sumTotals(results.map((fixture) => fixture.usage)),
  };
}
