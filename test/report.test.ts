import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Only generateFix is mocked (no model calls); detect/, context/,
// verify/, scan/, report/ and cli/ run for real.
vi.mock('../src/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate')>()),
  generateFix: vi.fn(),
}));

import { runReport, runScan } from '../src/cli';
import { detectViolationsInHtml } from '../src/detect';
import { generateFix } from '../src/generate';
import { IMPACT_TO_LEVEL, escapeHtml, toHtmlReport, toSarif, wcagInfo } from '../src/report';
import type { SarifLog } from '../src/report';
import { scan } from '../src/scan';
import type { ScanResult } from '../src/scan';
import { applyPatchToSource } from '../src/verify';

import { chromiumAvailable } from './helpers/chromium';
import { sarifProblems } from './helpers/sarif-shape';

// One element per outcome: image-alt gets a verified fix, label a fix that
// doesn't verify, button-name is declined as not auto-fixable, link-name
// errors, and the empty <h4> is suppressed twice over (heading-order by
// disableRules, empty-heading by severity).
const TEAM = `export default function Team() {
  return (
    <main>
      <h1>Team</h1>
      <img src="/team/ceo.jpg" />
      <form>
        <input type="email" name="email" />
      </form>
      <button>
        <svg aria-hidden="true" />
      </button>
      <a href="/team"></a>
      <h4></h4>
    </main>
  );
}
`;
const IMAGE_FIX = '<img alt="Portrait of the CEO" src="/team/ceo.jpg" />';

let dir: string;
let teamPath: string;
let result: ScanResult;

function mockModel(): void {
  vi.mocked(generateFix).mockImplementation(async ({ context }) => {
    const id = context.violation.id;
    if (id === 'button-name') {
      const error = new Error('Not auto-fixable: the icon has no recoverable meaning (test).');
      error.name = 'NotAutoFixableError';
      throw error;
    }
    if (id === 'link-name') throw new Error('529 overloaded (test)');
    return {
      filePath: context.componentPath,
      violationId: id,
      oldSnippet: context.element.code,
      // label: returned unchanged, so verify rejects it.
      newSnippet: id === 'image-alt' ? IMAGE_FIX : context.element.code,
      position: {
        start: context.element.location.startOffset,
        end: context.element.location.endOffset,
      },
    };
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(__dirname, 'tmp-report-'));
  teamPath = path.join(dir, 'Team.tsx');
  writeFileSync(teamPath, TEAM);
  writeFileSync(
    path.join(dir, 'Legacy.tsx'),
    'export default function Legacy() {\n  return <img src="/old.png" />;\n}\n',
  );
  mockModel();
  result = await scan(dir, {
    root: dir,
    ignore: ['Legacy.tsx'],
    disableRules: ['heading-order'],
    severity: 'moderate',
  });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.mocked(generateFix).mockReset();
  mockModel();
});

const sarif = (): SarifLog => toSarif(result, { root: dir, toolVersion: '0.0.0-test' });
const resultFor = (log: SarifLog, ruleId: string) =>
  log.runs[0]!.results.find((r) => r.ruleId === ruleId)!;

describe('the fixture scan covers every status', () => {
  it('has a verified, an unverified, a not-auto-fixable, an errored and two suppressed elements', () => {
    expect(result.violations.map((v) => [v.violation.id, v.status])).toEqual([
      ['button-name', 'errored'],
      ['image-alt', 'verified'],
      ['label', 'unverified'],
      ['link-name', 'errored'],
    ]);
    expect(result.suppressed.map((s) => [s.violation.id, s.reason])).toEqual([
      ['empty-heading', 'below-severity'],
      ['heading-order', 'disabled-rule'],
    ]);
    expect(result.ignoredFiles).toEqual([path.join(dir, 'Legacy.tsx')]);
    expect(result.mode).toBe('jsdom');
  });

  it('keeps the location of errored and suppressed elements when they were located', () => {
    const notFixable = result.violations.find((v) => v.violation.id === 'button-name');
    expect(notFixable?.status === 'errored' && notFixable.location?.startLine).toBe(9);
    expect(result.suppressed.map((s) => s.location?.startLine)).toEqual([13, 13]);
  });
});

describe('SARIF', () => {
  it('passes the structural SARIF 2.1.0 checks', () => {
    expect(sarifProblems(sarif())).toEqual([]);
  });

  it('the structural check is not vacuous: it catches a broken log', () => {
    const broken = structuredClone(sarif()) as unknown as {
      runs: { results: Record<string, unknown>[] }[];
    };
    broken.runs[0]!.results[0]!.level = 'critical';
    broken.runs[0]!.results[1]!.ruleIndex = 99;
    (
      broken.runs[0]!.results[2]!.locations as {
        physicalLocation: { region: { startLine: number } };
      }[]
    )[0]!.physicalLocation.region.startLine = 0;

    expect(sarifProblems(broken)).toEqual([
      'runs[0].results[0].level is invalid',
      'runs[0].results[1].ruleIndex does not point at its ruleId',
      'runs[0].results[2].locations[0].physicalLocation.region.startLine must be an integer ≥ 1',
    ]);
  });

  it('golden structure: a verified fix becomes a result with a SARIF fix and its status in properties', () => {
    const start = TEAM.indexOf('<img');
    const element = '<img src="/team/ceo.jpg" />';
    const location = { uri: 'Team.tsx', uriBaseId: '%SRCROOT%' };

    expect(resultFor(sarif(), 'image-alt')).toEqual({
      ruleId: 'image-alt',
      ruleIndex: 3,
      level: 'error',
      message: {
        text: 'Images must have alternative text. A verified fix is available (high confidence).',
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: location,
            region: {
              startLine: 5,
              startColumn: 7,
              endLine: 5,
              endColumn: 7 + element.length,
              snippet: { text: element },
            },
          },
        },
      ],
      partialFingerprints: { 'a11yAutofixElement/v1': expect.stringMatching(/^[0-9a-f]{64}$/) },
      fixes: [
        {
          description: {
            text: 'Replace the element; verified by re-running axe-core (high confidence).',
          },
          artifactChanges: [
            {
              artifactLocation: location,
              replacements: [
                {
                  deletedRegion: { charOffset: start, charLength: element.length },
                  insertedContent: { text: IMAGE_FIX },
                },
              ],
            },
          ],
        },
      ],
      properties: {
        a11yAutofix: {
          status: 'verified-fix',
          verifiedFixAvailable: true,
          applied: false,
          impact: 'critical',
          confidence: 'high',
          patchKind: 'replace',
          detail: null,
        },
      },
    });
  });

  it('applying the SARIF fix gives exactly what --write would', () => {
    const fix = resultFor(sarif(), 'image-alt').fixes![0]!.artifactChanges[0]!.replacements[0]!;
    const { charOffset, charLength } = fix.deletedRegion as {
      charOffset: number;
      charLength: number;
    };
    const viaSarif =
      TEAM.slice(0, charOffset) + fix.insertedContent.text + TEAM.slice(charOffset + charLength);
    const entry = result.violations.find((v) => v.violation.id === 'image-alt')!;

    expect(entry.status === 'verified' && viaSarif).toBe(applyPatchToSource(TEAM, entry.patch));
  });

  it('records every other status without a fix, and suppressed ones with SARIF suppressions', () => {
    const log = sarif();
    const summary = log.runs[0]!.results.map((r) => [
      r.ruleId,
      r.level,
      r.properties.a11yAutofix.status,
      r.properties.a11yAutofix.verifiedFixAvailable,
      Boolean(r.fixes),
      r.suppressions?.[0]?.kind ?? null,
    ]);

    expect(summary).toEqual([
      ['button-name', 'error', 'not-auto-fixable', false, false, null],
      ['image-alt', 'error', 'verified-fix', true, true, null],
      ['label', 'error', 'unverified-fix', false, false, null],
      ['link-name', 'error', 'error', false, false, null],
      ['empty-heading', 'note', 'suppressed', false, false, 'external'],
      ['heading-order', 'warning', 'suppressed', false, false, 'external'],
    ]);
    expect(resultFor(log, 'label').message.text).toBe(
      'Form elements must have labels. A fix was generated but did not verify (still flagged: label).',
    );
    expect(resultFor(log, 'button-name').message.text).toContain(
      'Not auto-fixable: the icon has no recoverable meaning (test).',
    );
    // A snippet is source text, so only results with a patch have one; the
    // rendered HTML never stands in for it.
    expect(resultFor(log, 'heading-order').locations[0]!.physicalLocation.region).toEqual({
      startLine: 13,
      startColumn: 7,
      endLine: 13,
      endColumn: 16,
    });
    expect(resultFor(log, 'heading-order').suppressions![0]!.justification).toBe(
      'a11y-autofix project config: the rule is turned off by disableRules in the project config',
    );
  });

  it('maps severity to SARIF levels', () => {
    expect(IMPACT_TO_LEVEL).toEqual({
      critical: 'error',
      serious: 'error',
      moderate: 'warning',
      minor: 'note',
    });
  });

  it('describes each rule with its WCAG criteria as tags and the Deque help URI', () => {
    const rules = sarif().runs[0]!.tool.driver.rules;
    expect(rules.map((rule) => rule.id)).toEqual(
      ['button-name', 'empty-heading', 'image-alt', 'label', 'link-name', 'heading-order'].sort(),
    );
    const imageAlt = rules.find((rule) => rule.id === 'image-alt')!;
    expect(imageAlt).toMatchObject({
      name: 'ImageAlt',
      shortDescription: { text: 'Images must have alternative text' },
      helpUri: expect.stringMatching(
        /^https:\/\/dequeuniversity\.com\/rules\/axe\/[\d.]+\/image-alt/,
      ),
      properties: { wcag: { criteria: ['1.1.1'], levels: ['WCAG 2.0 A'] } },
    });
    expect(imageAlt.properties.tags).toEqual(
      expect.arrayContaining(['accessibility', 'WCAG 2.0 A', 'WCAG 1.1.1']),
    );
    expect(rules.find((rule) => rule.id === 'empty-heading')!.properties.tags).toContain(
      'best-practice',
    );
  });

  it('parses WCAG tags, including two-digit criteria and 2.1/2.2 levels', () => {
    expect(wcagInfo('target-size')).toMatchObject({ criteria: ['2.5.8'], levels: ['WCAG 2.2 AA'] });
    expect(wcagInfo('color-contrast')).toMatchObject({
      criteria: ['1.4.3'],
      levels: ['WCAG 2.0 AA'],
    });
    expect(wcagInfo('autocomplete-valid').levels).toEqual(['WCAG 2.1 AA']);
  });

  it('gives each element a distinct fingerprint, stable across identical runs', () => {
    const fingerprints = sarif().runs[0]!.results.map(
      (r) => r.partialFingerprints['a11yAutofixElement/v1'],
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(
      sarif().runs[0]!.results.map((r) => r.partialFingerprints['a11yAutofixElement/v1']),
    ).toEqual(fingerprints);
  });

  it('records run-level totals, the ignored files and the mode', () => {
    const run = sarif().runs[0]!;
    expect(run.tool.driver).toMatchObject({ name: 'a11y-autofix', version: '0.0.0-test' });
    expect(run.properties.a11yAutofix).toEqual({
      filesScanned: 1,
      ignoredFiles: ['Legacy.tsx'],
      mode: 'jsdom',
      byStatus: {
        fixed: 0,
        'verified-fix': 1,
        'unverified-fix': 1,
        'not-auto-fixable': 1,
        error: 1,
        suppressed: 2,
      },
      byImpact: { critical: 3, serious: 1, moderate: 0, minor: 0, unknown: 0 },
    });
  });

  it('marks an applied fix as fixed', async () => {
    const writeDir = mkdtempSync(path.join(__dirname, 'tmp-report-'));
    try {
      const file = path.join(writeDir, 'Alt.tsx');
      writeFileSync(
        file,
        'export default function Alt() {\n  return <main><img src="/team/ceo.jpg" /></main>;\n}\n',
      );
      const written = await scan(file, { write: true, root: writeDir, reports: ['sarif', 'html'] });

      const [only] = written.reports!.sarif!.runs[0]!.results;
      expect(only!.properties.a11yAutofix).toMatchObject({
        status: 'fixed',
        applied: true,
        verifiedFixAvailable: true,
      });
      expect(written.reports!.html).toContain('Fixed (verified fix applied)');
      expect(sarifProblems(written.reports!.sarif)).toEqual([]);
    } finally {
      rmSync(writeDir, { recursive: true, force: true });
    }
  });
});

describe('HTML report', () => {
  const html = () =>
    toHtmlReport(result, {
      root: dir,
      generatedAt: new Date('2026-10-30T12:00:00Z'),
      toolVersion: '0.0.0-test',
    });

  it('passes our own axe-core scan of the whole document with zero violations (jsdom)', async () => {
    expect(await detectViolationsInHtml({ html: html() })).toEqual([]);
  });

  it.runIf(chromiumAvailable)(
    'passes in Chromium too, where color contrast is measured',
    async () => {
      expect(await detectViolationsInHtml({ html: html(), browser: true })).toEqual([]);
    },
  );

  it('the self-scan is not vacuous: it flags an inaccessible document, page-level rules included', async () => {
    const ids = (
      await detectViolationsInHtml({
        html: '<!doctype html><html><body><img src="x.png"></body></html>',
      })
    ).map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['document-title', 'html-has-lang', 'image-alt']));
  });

  it('an empty report and one full of hostile text pass too', async () => {
    const clean: ScanResult = {
      targetPath: dir,
      filesScanned: 3,
      violations: [],
      suppressed: [],
      ignoredFiles: [],
      mode: 'browser',
    };
    const hostile = structuredClone(result);
    const entry = hostile.violations.find((v) => v.violation.id === 'image-alt')!;
    if (entry.status !== 'verified') throw new Error('expected verified');
    entry.patch.newSnippet = '</code></pre><script>alert(1)</script><img src=x onerror=alert(1)>';
    entry.violation.help = 'Images <b>must</b> & "should" have alt';

    for (const report of [
      toHtmlReport(clean, { root: dir }),
      toHtmlReport(hostile, { root: dir }),
    ]) {
      expect(await detectViolationsInHtml({ html: report })).toEqual([]);
    }
    const escaped = toHtmlReport(hostile, { root: dir });
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escaped).toContain('Images &lt;b&gt;must&lt;/b&gt; &amp; &quot;should&quot; have alt');
    expect(toHtmlReport(clean, { root: dir })).toContain('No violations were reported in 3 files.');
  });

  it('is self-contained: inline CSS, no JavaScript, no external assets', () => {
    const report = html();
    expect(report).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(report).toContain('<style>');
    for (const forbidden of [
      '<script',
      '<link',
      '<img',
      '<iframe',
      '<object',
      'url(',
      '@import',
      'javascript:',
    ]) {
      expect([forbidden, report.includes(forbidden)]).toEqual([forbidden, false]);
    }
    // No src or inline handler on any real tag (escaped snippets don't count).
    expect(report).not.toMatch(/<[a-z][^>]*\s(src|on[a-z]+)=/i);
    // The only URLs are links to the rule docs.
    const urls = [...report.matchAll(/https?:\/\/[^"<\s]+/g)].map((match) => match[0]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith('https://dequeuniversity.com/rules/axe/'))).toBe(
      true,
    );
  });

  it('golden structure: totals by severity, grouped violations with WCAG criteria and fix status, the coverage note', () => {
    const report = html();

    expect(report).toContain('<title>Accessibility report for . (a11y-autofix)</title>');
    expect(report).toContain('<caption>Violations by severity and fix status</caption>');
    expect(report).toContain(
      '<tr><th scope="row">Critical</th><td>3</td><td>1</td><td>1</td><td>1</td><td>0</td><td>0</td></tr>',
    );
    expect(report).toContain(
      '<tr><th scope="row">Serious</th><td>1</td><td>0</td><td>0</td><td>0</td><td>1</td><td>0</td></tr>',
    );
    expect(report).toContain(
      '<tr><th scope="row">Moderate</th><td>1</td><td>0</td><td>0</td><td>0</td><td>0</td><td>1</td></tr>',
    );
    expect(report).toContain(
      '<tr><th scope="row">All severities</th><td>6</td><td>1</td><td>1</td><td>1</td><td>1</td><td>2</td></tr>',
    );
    expect(report).toContain('4 violations reported across 1 file; 1 has a verified fix.');
    expect(report).toContain('2 more were suppressed by the project config');

    // Grouped by rule, most severe first, each with WCAG criteria and a docs link.
    const headings = [
      ...report.matchAll(/<h3>(.*?) <span class="rule-id">\((.*?)\)<\/span><\/h3>/g),
    ].map((m) => m[2]);
    expect(headings).toEqual([
      'button-name',
      'image-alt',
      'label',
      'link-name',
      'heading-order',
      'empty-heading',
    ]);
    expect(report).toContain(
      'Impact: Critical · WCAG 2.0 A · Success criterion 1.1.1 · 1 element.',
    );
    expect(report).toContain('<a href="https://dequeuniversity.com/rules/axe/');

    for (const label of [
      'Verified fix available',
      'Fix did not verify',
      'Not auto-fixable',
      'Error',
      'Suppressed by config',
    ]) {
      expect(report).toContain(`">${label}</span>`);
    }
    expect(report).toContain('Rejected by re-running axe-core: still flagged: label');
    expect(report).toContain(
      'Not reported because the rule is turned off by disableRules in the project config',
    );
    expect(report).toContain('<figcaption>Verified fix, high confidence</figcaption>');
    expect(report).toContain(
      '<figcaption>Element as rendered</figcaption><pre><code>&lt;h4&gt;&lt;/h4&gt;</code></pre>',
    );
    expect(report).toContain('2 more were suppressed by the project config; they are listed below');
    expect(report).toContain('<h2>Files skipped by config</h2>');
    expect(report).toContain('<li><code>Legacy.tsx</code></li>');

    expect(report).toContain('find roughly 30–40% of WCAG issues');
    expect(report).toContain('so contrast was not checked; run with --browser to include it.');
  });

  it('escapes HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('cli: --format, --output and report', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let outDir: string;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    outDir = mkdtempSync(path.join(__dirname, 'tmp-report-out-'));
  });
  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(outDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('scan --format sarif prints only a valid SARIF log', async () => {
    await runScan(teamPath, { format: 'sarif', projectRoot: dir });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(sarifProblems(log)).toEqual([]);
    expect(log.runs[0].results).toHaveLength(6);
    expect(process.exitCode).toBe(1);
  });

  it('scan --format html --output writes the report to a file', async () => {
    const output = path.join(outDir, 'report.html');

    await runScan(teamPath, { format: 'html', output, projectRoot: dir });

    expect(logSpy).not.toHaveBeenCalled();
    const report = readFileSync(output, 'utf8');
    expect(report).toContain('<h1>Accessibility report</h1>');
    expect(await detectViolationsInHtml({ html: report })).toEqual([]);
  });

  it('report renders a saved --json result without scanning again', async () => {
    const saved = path.join(outDir, 'result.json');
    await runScan(teamPath, { format: 'json', output: saved, projectRoot: dir });
    const callsAfterScan = vi.mocked(generateFix).mock.calls.length;

    const code = runReport(saved, { format: 'sarif', projectRoot: dir });

    expect(code).toBe(0);
    expect(vi.mocked(generateFix).mock.calls.length).toBe(callsAfterScan);
    const fromReport = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
    const savedResult = JSON.parse(readFileSync(saved, 'utf8'));
    expect(fromReport).toEqual(toSarif(savedResult, { root: dir }));
    expect(sarifProblems(fromReport)).toEqual([]);
  });

  it('rejects contradictory or unusable format options', async () => {
    const cases: [Parameters<typeof runScan>[1], string][] = [
      [{ format: 'pdf' as never }, 'Unknown --format "pdf"'],
      [{ json: true, format: 'sarif' }, '--json cannot be combined with --format sarif.'],
      [{ output: path.join(outDir, 'x') }, '--output needs a machine format'],
      [
        { format: 'html', interactive: true },
        '--interactive cannot be combined with --format html on stdout',
      ],
    ];
    for (const [options, message] of cases) {
      errorSpy.mockClear();
      await runScan(teamPath, { ...options, projectRoot: dir });
      expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(message);
    }
    expect(runReport(path.join(outDir, 'missing.json'), { format: 'sarif' })).toBe(1);
    expect(runReport(path.join(outDir, 'missing.json'), { format: 'json' })).toBe(1);
  });
});
