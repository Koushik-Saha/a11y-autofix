/**
 * A standalone HTML report: one file, inline CSS, no JavaScript, no
 * external assets (the only URLs are links to axe-core's rule docs). It is
 * held to the standard the tool checks: test/report.test.ts runs our own
 * axe-core scan over it, in jsdom and in Chromium (where contrast is
 * measured), and requires zero violations.
 */

import type { ScanResult } from '../scan';

import { FIX_STATUS_LABELS, IMPACTS, relativePath, reportItems, wcagInfo } from './items';
import type { FixStatus, Impact, ReportItem } from './items';

import { version as packageVersion } from '../../package.json';

export interface HtmlReportOptions {
  /** Paths are shown relative to this. Defaults to `process.cwd()`. */
  root?: string;
  /** Defaults to now; pass a fixed date for reproducible output. */
  generatedAt?: Date;
  toolVersion?: string;
}

/** Escapes text for HTML element content and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const IMPACT_LABELS: Record<Impact | 'unknown', string> = {
  critical: 'Critical',
  serious: 'Serious',
  moderate: 'Moderate',
  minor: 'Minor',
  unknown: 'Unknown impact',
};

/** Table columns, in order. "Verified fix available" includes fixes already applied. */
const STATUS_COLUMNS: { label: string; statuses: FixStatus[] }[] = [
  { label: 'Verified fix available', statuses: ['verified-fix', 'fixed'] },
  { label: 'Fix did not verify', statuses: ['unverified-fix'] },
  { label: 'Not auto-fixable', statuses: ['not-auto-fixable'] },
  { label: 'Error', statuses: ['error'] },
  { label: 'Suppressed by config', statuses: ['suppressed'] },
];

// Every foreground/background pair here has a contrast ratio of at least
// 7:1, checked by axe-core in Chromium in test/report.test.ts.
const STYLES = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1b1b1b;background:#fff}
header,main,footer{max-width:64rem;margin:0 auto;padding:1rem 1.25rem}
header{border-bottom:2px solid #1b1b1b}
h1{font-size:1.75rem;margin:.5rem 0}
h2{font-size:1.375rem;margin:2rem 0 .75rem;border-bottom:1px solid #6b6b6b;padding-bottom:.25rem}
h3{font-size:1.125rem;margin:1.5rem 0 .25rem}
a{color:#0b4f9c}
a:focus-visible{outline:3px solid #0b4f9c;outline-offset:2px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9rem}
pre{margin:.25rem 0 0;padding:.5rem .75rem;background:#f4f4f4;border:1px solid #6b6b6b;white-space:pre-wrap;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;margin:.5rem 0}
caption{text-align:left;font-weight:600;padding-bottom:.25rem}
th,td{border:1px solid #6b6b6b;padding:.375rem .5rem;text-align:right}
th[scope=row],thead th:first-child{text-align:left}
thead th{background:#f4f4f4}
.meta{margin:0 0 .5rem;color:#3d3d3d}
.rule-id{font-weight:400;color:#3d3d3d}
ul.occurrences{list-style:none;padding:0;margin:0}
ul.occurrences>li{border-left:4px solid #6b6b6b;padding:.25rem 0 .5rem .75rem;margin:.75rem 0}
.status{display:inline-block;padding:0 .4rem;border:1px solid currentColor;border-radius:.25rem;font-weight:600}
.status-fixed,.status-verified-fix{color:#0a5c2b;background:#e8f5ec}
.status-unverified-fix{color:#6b3f00;background:#fff4e0}
.status-not-auto-fixable{color:#4f2580;background:#f3ecfa}
.status-error{color:#8a1717;background:#fdecec}
.status-suppressed{color:#333;background:#f0f0f0}
figure{margin:.5rem 0 0}
figcaption{font-weight:600}
footer{border-top:2px solid #1b1b1b;margin-top:2rem}
`.trim();

function impactKey(impact: Impact | null): Impact | 'unknown' {
  return impact ?? 'unknown';
}

function where(item: ReportItem, root: string): string {
  const file = relativePath(item.filePath, root) ?? item.filePath;
  return item.location ? `${file}:${item.location.startLine}` : file;
}

function codeFigure(caption: string, code: string): string {
  return `<figure><figcaption>${escapeHtml(caption)}</figcaption><pre><code>${escapeHtml(code)}</code></pre></figure>`;
}

function occurrence(item: ReportItem, root: string): string {
  const parts = [
    `<p><span class="status status-${item.status}">${escapeHtml(FIX_STATUS_LABELS[item.status])}</span> <code>${escapeHtml(where(item, root))}</code></p>`,
  ];
  if (item.detail) {
    const lead =
      item.status === 'unverified-fix'
        ? 'Rejected by re-running axe-core: '
        : item.status === 'suppressed'
          ? 'Not reported because '
          : '';
    parts.push(`<p>${escapeHtml(lead + item.detail)}</p>`);
  }
  if (item.patch) {
    const verified = item.status === 'fixed' || item.status === 'verified-fix';
    const kind = item.patch.kind === 'insert' ? ' (inserts an element)' : '';
    parts.push(codeFigure('Current code', item.patch.oldSnippet));
    parts.push(
      codeFigure(
        verified
          ? `Verified fix${kind}, ${item.patch.confidence} confidence${item.status === 'fixed' ? ', applied' : ''}`
          : `Proposed fix${kind}, did not verify`,
        item.patch.newSnippet,
      ),
    );
  } else if (item.renderedHtml) {
    parts.push(codeFigure('Element as rendered', item.renderedHtml));
  }
  return `<li>${parts.join('')}</li>`;
}

function ruleSection(items: ReportItem[], root: string): string {
  const first = items[0]!;
  const wcag = wcagInfo(first.ruleId);
  const meta = [
    `Impact: ${IMPACT_LABELS[impactKey(first.impact)]}`,
    wcag.levels.length > 0 ? wcag.levels.join(', ') : null,
    wcag.criteria.length > 0
      ? `Success criteri${wcag.criteria.length === 1 ? 'on' : 'a'} ${wcag.criteria.join(', ')}`
      : null,
    wcag.bestPractice ? 'Best practice (not a WCAG requirement)' : null,
    `${items.length} element${items.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return [
    '<section>',
    `<h3>${escapeHtml(first.help)} <span class="rule-id">(${escapeHtml(first.ruleId)})</span></h3>`,
    `<p class="meta">${escapeHtml(meta.join(' · '))}. <a href="${escapeHtml(first.helpUrl)}">How to fix ${escapeHtml(first.ruleId)} (Deque University)</a></p>`,
    `<ul class="occurrences">${items.map((item) => occurrence(item, root)).join('')}</ul>`,
    '</section>',
  ].join('\n');
}

function summaryTable(items: ReportItem[]): string {
  const rowKeys = [...IMPACTS, 'unknown' as const];
  const count = (key: Impact | 'unknown' | null, statuses: FixStatus[]) =>
    items.filter(
      (item) => (key === null || impactKey(item.impact) === key) && statuses.includes(item.status),
    ).length;
  const allStatuses = STATUS_COLUMNS.flatMap((column) => column.statuses);
  const row = (label: string, key: Impact | 'unknown' | null) =>
    `<tr><th scope="row">${escapeHtml(label)}</th><td>${count(key, allStatuses)}</td>${STATUS_COLUMNS.map((column) => `<td>${count(key, column.statuses)}</td>`).join('')}</tr>`;
  return [
    '<table>',
    '<caption>Violations by severity and fix status</caption>',
    `<thead><tr><th scope="col">Severity</th><th scope="col">Total</th>${STATUS_COLUMNS.map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join('')}</tr></thead>`,
    '<tbody>',
    ...rowKeys
      .filter((key) => key !== 'unknown' || count('unknown', allStatuses) > 0)
      .map((key) => row(IMPACT_LABELS[key], key)),
    row('All severities', null),
    '</tbody>',
    '</table>',
  ].join('\n');
}

export function toHtmlReport(result: ScanResult, options: HtmlReportOptions = {}): string {
  const root = options.root ?? process.cwd();
  const generatedAt = (options.generatedAt ?? new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const items = reportItems(result);
  const reported = items.filter((item) => item.status !== 'suppressed');
  const verified = reported.filter(
    (item) => item.status === 'verified-fix' || item.status === 'fixed',
  );
  const target = relativePath(result.targetPath, root) ?? result.targetPath;
  const ignored = result.ignoredFiles ?? [];

  const byRule = new Map<string, ReportItem[]>();
  for (const item of items) byRule.set(item.ruleId, [...(byRule.get(item.ruleId) ?? []), item]);
  // Most severe first; no impact last.
  const severityRank = (item: ReportItem) =>
    item.impact ? IMPACTS.indexOf(item.impact) : IMPACTS.length;
  const groups = [...byRule.values()].sort(
    (a, b) => severityRank(a[0]!) - severityRank(b[0]!) || a[0]!.ruleId.localeCompare(b[0]!.ruleId),
  );

  const modeNote =
    result.mode === 'jsdom'
      ? ' This scan rendered components in jsdom, which cannot measure color contrast, so contrast was not checked; run with --browser to include it.'
      : result.mode === 'browser'
        ? ' This scan rendered components in headless Chromium, so color contrast was checked.'
        : '';

  const suppressedCount = items.length - reported.length;
  const suppressedNote =
    suppressedCount > 0
      ? `<p>${suppressedCount} more ${suppressedCount === 1 ? 'was' : 'were'} suppressed by the project config; ${suppressedCount === 1 ? 'it is' : 'they are'} listed below and counted separately, not fixed.</p>\n`
      : '';
  const summary =
    reported.length === 0
      ? `<p>No violations were reported in ${result.filesScanned} file${result.filesScanned === 1 ? '' : 's'}.</p>`
      : `<p>${reported.length} violation${reported.length === 1 ? '' : 's'} reported across ${result.filesScanned} file${result.filesScanned === 1 ? '' : 's'}; ${verified.length} ha${verified.length === 1 ? 's' : 've'} a verified fix.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility report for ${escapeHtml(target)} (a11y-autofix)</title>
<style>
${STYLES}
</style>
</head>
<body>
<header>
<h1>Accessibility report</h1>
<p>Target: <code>${escapeHtml(target)}</code>. Generated ${escapeHtml(generatedAt)}.</p>
</header>
<main>
<h2>Summary</h2>
${summary}
${suppressedNote}${summaryTable(items)}
<h2>Violations by rule</h2>
${groups.length > 0 ? groups.map((group) => ruleSection(group, root)).join('\n') : '<p>None.</p>'}
${ignored.length > 0 ? `<h2>Files skipped by config</h2>\n<p>These files matched an ignore pattern and were not scanned.</p>\n<ul>${ignored.map((file) => `<li><code>${escapeHtml(relativePath(file, root) ?? file)}</code></li>`).join('')}</ul>\n` : ''}</main>
<footer>
<p><strong>What this report cannot tell you.</strong> Automated checks, including this one, find roughly 30–40% of WCAG issues. A report with no violations does not mean the interface is accessible or conforms to WCAG: test it with a keyboard and a screen reader, and review content, focus order and interactions by hand.${escapeHtml(modeNote)} Components were checked one at a time, so page-level requirements such as titles, landmarks and skip links were not.</p>
<p>Generated by a11y-autofix ${escapeHtml(options.toolVersion ?? packageVersion)} using axe-core.</p>
</footer>
</body>
</html>
`;
}
