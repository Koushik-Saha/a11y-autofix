/**
 * One flat list of report items from a ScanResult (fixed, unfixed and
 * suppressed violations alike, each with its fix status), plus axe-core
 * rule metadata. SARIF and HTML both render from this, so they can't
 * disagree about a status.
 */

import path from 'node:path';

import axe from 'axe-core';

import type { JsxSourceLocation } from '../context';
import type { AxeViolation } from '../detect';
import type { ScanResult, ScoredPatch } from '../scan';
import type { SuppressionReason } from '../config';

export type FixStatus =
  /** A verified fix was written to disk (`--write`). */
  | 'fixed'
  /** A fix verified, but wasn't applied. */
  | 'verified-fix'
  /** A fix was generated but verify/ rejected it. */
  | 'unverified-fix'
  /** generate/ declined: guessing would be unsafe (e.g. contrast over an image). */
  | 'not-auto-fixable'
  /** Something failed before a fix could be produced or checked. */
  | 'error'
  /** Hidden by project config (disableRules / severity); never fixed. */
  | 'suppressed';

export const FIX_STATUS_LABELS: Record<FixStatus, string> = {
  fixed: 'Fixed (verified fix applied)',
  'verified-fix': 'Verified fix available',
  'unverified-fix': 'Fix did not verify',
  'not-auto-fixable': 'Not auto-fixable',
  error: 'Error',
  suppressed: 'Suppressed by config',
};

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor';
/** Most severe first. */
export const IMPACTS: readonly Impact[] = ['critical', 'serious', 'moderate', 'minor'];

export interface ReportItem {
  ruleId: string;
  impact: Impact | null;
  help: string;
  description: string;
  helpUrl: string;
  filePath: string;
  location: JsxSourceLocation | null;
  status: FixStatus;
  /** Why it isn't fixed: the verify failure, the error, or the suppression. Null when there's a verified fix. */
  detail: string | null;
  /** The generated patch (verified or not); null when none was produced. */
  patch: ScoredPatch | null;
  /** The element's source text as scanned, when known (from the patch). */
  snippet: string | null;
  /** The element as axe-core saw it rendered (HTML, not source). */
  renderedHtml: string | null;
  suppressionReason: SuppressionReason | null;
}

const SUPPRESSION_DETAILS: Record<SuppressionReason, string> = {
  'disabled-rule': 'the rule is turned off by disableRules in the project config',
  'below-severity': 'its impact is below the minimum severity set in the project config',
};

function rejectionDetail(verification: {
  remainingViolations: AxeViolation[];
  newViolations: AxeViolation[];
}): string {
  const parts = [
    ...verification.remainingViolations.map((v) => `still flagged: ${v.id}`),
    ...verification.newViolations.map((v) => `introduced: ${v.id}`),
  ];
  return parts.join('; ') || 'not verified';
}

function base(violation: AxeViolation, filePath: string) {
  return {
    ruleId: violation.id,
    impact: violation.impact,
    help: violation.help,
    description: violation.description,
    helpUrl: violation.helpUrl,
    filePath,
  };
}

export function reportItems(result: ScanResult): ReportItem[] {
  const items = result.violations.map((entry): ReportItem => {
    if (entry.status === 'errored') {
      return {
        ...base(entry.violation, entry.filePath),
        location: entry.location ?? null,
        status: entry.reason === 'not-auto-fixable' ? 'not-auto-fixable' : 'error',
        detail: entry.error.replace(/^Not auto-fixable:\s*/, ''),
        patch: null,
        snippet: null,
        renderedHtml: entry.violation.nodes[0]?.html ?? null,
        suppressionReason: null,
      };
    }
    const verified = entry.status === 'verified';
    return {
      ...base(entry.violation, entry.filePath),
      location: entry.context.element.location,
      status: verified ? (entry.applied ? 'fixed' : 'verified-fix') : 'unverified-fix',
      detail: verified ? null : rejectionDetail(entry.verification),
      patch: entry.patch,
      snippet: entry.patch.oldSnippet,
      renderedHtml: entry.violation.nodes[0]?.html ?? null,
      suppressionReason: null,
    };
  });
  for (const entry of result.suppressed ?? []) {
    items.push({
      ...base(entry.violation, entry.filePath),
      location: entry.location ?? null,
      status: 'suppressed',
      detail: SUPPRESSION_DETAILS[entry.reason],
      patch: null,
      snippet: null,
      renderedHtml: entry.violation.nodes[0]?.html ?? null,
      suppressionReason: entry.reason,
    });
  }
  return items;
}

export interface WcagInfo {
  /** Success criteria, e.g. ["1.1.1"]. */
  criteria: string[];
  /** e.g. ["WCAG 2.0 A"]; empty for best-practice rules. */
  levels: string[];
  bestPractice: boolean;
  /** axe-core's raw tags for the rule. */
  axeTags: string[];
}

const axeRuleTags = new Map(axe.getRules().map((rule) => [rule.ruleId, rule.tags]));

/** `wcag111` → "1.1.1", `wcag1410` → "1.4.10"; `wcag21aa` → "WCAG 2.1 AA". */
export function wcagInfo(ruleId: string): WcagInfo {
  const axeTags = axeRuleTags.get(ruleId) ?? [];
  const criteria: string[] = [];
  const levels: string[] = [];
  for (const tag of axeTags) {
    const level = /^wcag(2)(\d?)(a{1,3})$/.exec(tag);
    if (level) {
      levels.push(`WCAG 2.${level[2] || '0'} ${level[3]!.toUpperCase()}`);
      continue;
    }
    const criterion = /^wcag(\d)(\d)(\d{1,2})$/.exec(tag);
    if (criterion) criteria.push(`${criterion[1]}.${criterion[2]}.${criterion[3]}`);
  }
  return { criteria, levels, bestPractice: axeTags.includes('best-practice'), axeTags };
}

/** A path relative to `root` with `/` separators ("." for `root` itself), or null when it is outside `root`. */
export function relativePath(filePath: string, root: string): string | null {
  const relative = path.relative(root, filePath);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}
