import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the Anthropic SDK is mocked: the harness, scan(), detect/,
// context/, generate/'s prompt building, verify/ and the retry all run
// for real. The fake model answers per rule, so each fixture lands on a
// known outcome; the usage numbers are test data, not measurements.
const { parse, AnthropicMock } = vi.hoisted(() => {
  const parse = vi.fn();
  const AnthropicMock = vi.fn(function () {
    return { messages: { parse } };
  });
  return { parse, AnthropicMock };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));

import { compareReports } from '../scripts/eval/compare';
import { runCompare } from '../scripts/eval/compare-cli';
import { listFixtures, runEval } from '../scripts/eval/harness';
import type { CompleteReport, EvalCase } from '../scripts/eval/harness';
import {
  emptyBaseline,
  parseReport,
  renderEmptyBaseline,
  renderReport,
} from '../scripts/eval/report';
import { MISSING_KEY_MESSAGE, reportFileName, runReal } from '../scripts/eval/real';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ONLY = [
  'ResolvedAvatar.tsx',
  'MissingLabel.tsx',
  'MissingButtonName.tsx',
  'AccessibleCard.tsx',
];

/** 1,000 input + 200 output tokens on claude-opus-5 ($5 / $25 per MTok) = $0.01 per call. */
const USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  output_tokens_details: { thinking_tokens: 50 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function fakeModel(request: { messages: { content: string }[] }) {
  const prompt = request.messages[0]!.content;
  const rule = /^Violation: (\S+)/.exec(prompt)![1];
  const element = /replace only this\):\n```jsx\n([\s\S]*?)\n```/.exec(prompt)![1]!;
  const retry = prompt.includes('This is a retry.');
  let newSnippet = element;
  if (rule === 'image-alt') newSnippet = element.replace('<img ', '<img alt="Gallery photo" ');
  // First attempt changes nothing (rejected); the retry fixes it.
  if (rule === 'label' && retry)
    newSnippet = element.replace('<input ', '<input aria-label="Email" ');
  // button-name: never fixed, so both attempts are rejected.
  return {
    parsed_output: { newSnippet },
    stop_reason: 'end_turn',
    model: 'claude-opus-5',
    usage: USAGE,
  };
}

let report: CompleteReport;
beforeEach(async () => {
  parse.mockReset();
  parse.mockImplementation(async (request) => fakeModel(request));
});

async function evalReport(): Promise<CompleteReport> {
  report ??= await runEval({
    fixturesDir: FIXTURES_DIR,
    only: ONLY,
    now: () => new Date('2026-10-30T12:34:56.789Z'),
  });
  return report;
}

const caseFor = (r: CompleteReport, key: string): EvalCase =>
  r.fixtures.flatMap((f) => f.cases).find((c) => c.key === key)!;

describe('runEval over the fixtures (model mocked)', () => {
  it('lists every component fixture, subdirectories included, and nothing else', () => {
    const fixtures = listFixtures(FIXTURES_DIR);
    expect(fixtures).toContain('MissingAlt.tsx');
    expect(fixtures).toContain('VueMissingAlt.vue');
    expect(fixtures).toContain('two-files/SignupForm.vue');
    expect(fixtures).not.toContain('lib/projectActions.ts');
  });

  it('records found / proposed / verified / why-not for each fixture, through the real pipeline', async () => {
    const r = await evalReport();

    expect(r.fixtures.map((f) => [f.fixture, f.violationsFound])).toEqual([
      ['AccessibleCard.tsx', []],
      ['MissingButtonName.tsx', ['button-name']],
      ['MissingLabel.tsx', ['label']],
      ['ResolvedAvatar.tsx', ['image-alt']],
    ]);

    const alt = caseFor(r, 'ResolvedAvatar.tsx#image-alt#1');
    expect(alt).toMatchObject({ status: 'verified', confidence: 'high', failureReason: null });
    expect(alt.newSnippet).toBe('<img alt="Gallery photo" src={avatarUrl} />');

    // Rejected first attempt, verified retry: both attempts kept.
    const label = caseFor(r, 'MissingLabel.tsx#label#1');
    expect(label).toMatchObject({ status: 'verified', confidence: 'medium' });
    expect(label.attempts.map((a) => [a.attempt, a.verified, a.stillFlagged])).toEqual([
      [1, false, ['label']],
      [2, true, []],
    ]);

    const button = caseFor(r, 'MissingButtonName.tsx#button-name#1');
    expect(button).toMatchObject({
      status: 'unverified',
      confidence: 'low',
      failureReason: 'still flagged: button-name',
    });
    expect(button.attempts).toHaveLength(2);
  });

  it('records tokens and cost per fixture and in total', async () => {
    const r = await evalReport();
    const usage = Object.fromEntries(
      r.fixtures.map((f) => [f.fixture, [f.usage.calls, f.usage.costUsd]]),
    );

    expect(usage).toEqual({
      'AccessibleCard.tsx': [0, 0],
      'ResolvedAvatar.tsx': [1, 0.01],
      'MissingButtonName.tsx': [2, 0.02],
      'MissingLabel.tsx': [2, 0.02],
    });
    expect(r.models).toEqual(['claude-opus-5']);
    expect(r.totals).toMatchObject({
      calls: 5,
      inputTokens: 5000,
      outputTokens: 1000,
      thinkingTokens: 250,
    });
    expect(r.totals.costUsd).toBeCloseTo(0.05, 10);
    expect(caseFor(r, 'MissingLabel.tsx#label#1').usage.calls).toBe(2);
  });

  it('reports an unknown price as unknown, not as a guess', async () => {
    parse.mockImplementation(async (request) => ({
      ...fakeModel(request),
      model: 'claude-unpriced-9',
    }));

    const r = await runEval({ fixturesDir: FIXTURES_DIR, only: ['ResolvedAvatar.tsx'] });

    expect(r.totals.costUsd).toBeNull();
    expect(renderReport(r)).toContain('**Estimated cost:** unknown total');
  });

  it('records an API error as an errored case with the message', async () => {
    parse.mockRejectedValue(new Error('529 overloaded'));

    const r = await runEval({ fixturesDir: FIXTURES_DIR, only: ['ResolvedAvatar.tsx'] });

    expect(caseFor(r, 'ResolvedAvatar.tsx#image-alt#1')).toMatchObject({
      status: 'errored',
      failureReason: '529 overloaded',
    });
  });
});

describe('the markdown report', () => {
  it('has per-type acceptance, per-fixture cost, and every rejected attempt quoted in full', async () => {
    const markdown = renderReport(await evalReport());

    expect(markdown).toContain('| `image-alt` | 1 | 1 | 1 | 0 | 0 | 100% |');
    expect(markdown).toContain('| `label` | 1 | 1 | 0 | 0 | 0 | 100% |');
    expect(markdown).toContain('| `button-name` | 1 | 0 | 0 | 1 | 0 | 0% |');
    expect(markdown).toContain(
      '| `ResolvedAvatar.tsx` | image-alt | image-alt: verified (high) | 1 | 1,000 | 200 (50) | $0.0100 |',
    );
    expect(markdown).toContain(
      '$0.0167 per violation on average, so about $1.67 per 100 violations',
    );
    expect(markdown).toContain('### `MissingLabel.tsx#label#1` (verified on retry)');
    expect(markdown).toContain(
      'Attempt 1, rejected (still flagged: label):\n\n```jsx\n<input type="text" name="email" />\n```',
    );
    expect(markdown).toContain('### `MissingButtonName.tsx#button-name#1` (never verified)');
    // The full multi-line element, not a summary of it.
    expect(markdown).toContain('<line x1="15" y1="1" x2="1" y2="15" stroke="currentColor" />');
  });

  it('round-trips its data, even when a snippet contains a code fence', async () => {
    const r = structuredClone(await evalReport());
    caseFor(r, 'ResolvedAvatar.tsx#image-alt#1').newSnippet = 'a ``` b ```` c';

    expect(parseReport(renderReport(r))).toEqual(r);
  });

  it('names the file by date, sortably', () => {
    expect(reportFileName('2026-10-30T12:34:56.789Z')).toBe('report-2026-10-30T12-34-56Z.md');
  });
});

describe('eval:compare, the regression gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'a11y-eval-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeReport(name: string, markdown: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, markdown);
    return file;
  }

  /** Edits a case's status in the report file's raw data, the way someone doctoring it by hand would. */
  function doctor(markdown: string, key: string, status: string): string {
    const pattern = new RegExp(
      `("key": "${key.replace(/[.#]/g, '\\$&')}",[\\s\\S]*?"status": )"\\w+"`,
    );
    expect(pattern.test(markdown)).toBe(true);
    return markdown.replace(pattern, `$1"${status}"`);
  }

  it('passes an identical report', async () => {
    const markdown = renderReport(await evalReport());
    const result = runCompare({
      baselinePath: writeReport('baseline.md', markdown),
      reportPath: writeReport('report.md', markdown),
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain(
      'PASS: no previously verified case regressed (3 unchanged, 0 improved).',
    );
  });

  it('fails (exit 1) when a doctored report turns a verified case into a rejected one', async () => {
    const markdown = renderReport(await evalReport());
    const result = runCompare({
      baselinePath: writeReport('baseline.md', markdown),
      reportPath: writeReport(
        'report.md',
        doctor(markdown, 'ResolvedAvatar.tsx#image-alt#1', 'unverified'),
      ),
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('REGRESSIONS (1): verified in the baseline, not now');
    expect(result.output).toContain('✗ ResolvedAvatar.tsx#image-alt#1: verified → unverified');
    expect(result.output).toContain('image-alt: 1/1 → 0/1');
    expect(result.output).toContain('FAIL: 1 previously verified case(s) regressed.');
  });

  it('fails when a previously verified case disappears, and passes an improvement', async () => {
    const r = await evalReport();
    const withoutAlt = structuredClone(r);
    withoutAlt.fixtures.find((f) => f.fixture === 'ResolvedAvatar.tsx')!.cases = [];
    expect(compareReports(r, withoutAlt).regressions).toEqual([
      expect.objectContaining({ key: 'ResolvedAvatar.tsx#image-alt#1', after: 'missing' }),
    ]);

    const fixedButton = structuredClone(r);
    caseFor(fixedButton, 'MissingButtonName.tsx#button-name#1').status = 'verified';
    const comparison = compareReports(r, fixedButton);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.improvements.map((c) => c.key)).toEqual([
      'MissingButtonName.tsx#button-name#1',
    ]);
  });

  it('does not gate fixtures an --only run skipped', async () => {
    const r = await evalReport();
    const partial: CompleteReport = {
      ...structuredClone(r),
      only: ['MissingLabel'],
      fixtures: structuredClone(r.fixtures.filter((f) => f.fixture === 'MissingLabel.tsx')),
    };

    const comparison = compareReports(r, partial);

    expect(comparison.regressions).toEqual([]);
    expect(comparison.notRun.sort()).toEqual([
      'MissingButtonName.tsx#button-name#1',
      'ResolvedAvatar.tsx#image-alt#1',
    ]);
  });

  it('exits 2, never 0, when it cannot compare', async () => {
    const markdown = renderReport(await evalReport());
    const report = writeReport('report-2026-10-30T12-34-56Z.md', markdown);
    const cases = {
      'an empty baseline': renderEmptyBaseline(emptyBaseline('No key yet.')),
      'a different render mode': markdown.replace('"mode": "jsdom"', '"mode": "browser"'),
      'a corrupted data block': markdown.replace('"format": "a11y-autofix-eval",', '"format": '),
    };
    for (const [label, baseline] of Object.entries(cases)) {
      const result = runCompare({
        baselinePath: writeReport(`${label}.md`, baseline),
        reportPath: report,
      });
      expect([label, result.code]).toEqual([label, 2]);
    }
    expect(runCompare({ evalsDir: dir, baselinePath: report }).output).toContain(
      'Comparing report-2026-10-30T12-34-56Z.md',
    );
    expect(runCompare({ evalsDir: path.join(dir, 'none'), baselinePath: report }).code).toBe(2);
  });

  it('can read the committed baseline (an empty marker until a real run is recorded)', () => {
    const baseline = parseReport(
      readFileSync(path.join(__dirname, '..', 'evals', 'baseline.md'), 'utf8'),
    );
    expect(['empty', 'complete']).toContain(baseline.status);
  });
});

describe('eval:real without a key', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it('exits 1 with a clear message before calling anything', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runReal({})).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(MISSING_KEY_MESSAGE);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
