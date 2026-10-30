/**
 * SARIF 2.1.0 output, for GitHub code scanning (the Security tab and PR
 * annotations) and any other SARIF viewer. One result per offending
 * element, suppressed ones included (marked with SARIF `suppressions`
 * rather than dropped). A verified fix is attached as a SARIF `fix`; its
 * status is also recorded in each result's property bag.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import type { ScanResult } from '../scan';

import { IMPACTS, relativePath, reportItems, wcagInfo } from './items';
import type { FixStatus, Impact, ReportItem } from './items';

import { version as packageVersion } from '../../package.json';

export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFORMATION_URI = 'https://github.com/Koushik-Saha/a11y-autofix';
const SRCROOT = '%SRCROOT%';

export type SarifLevel = 'error' | 'warning' | 'note';

/** critical/serious → error, moderate → warning, minor → note; no impact → warning. */
export const IMPACT_TO_LEVEL: Record<Impact, SarifLevel> = {
  critical: 'error',
  serious: 'error',
  moderate: 'warning',
  minor: 'note',
};

// The subset of SARIF 2.1.0 this produces.
interface SarifMessage {
  text: string;
}
interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}
interface SarifRegion {
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  charOffset?: number;
  charLength?: number;
  snippet?: { text: string };
}
export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: SarifMessage;
  locations: {
    physicalLocation: { artifactLocation: SarifArtifactLocation; region?: SarifRegion };
  }[];
  partialFingerprints: Record<string, string>;
  fixes?: {
    description: SarifMessage;
    artifactChanges: {
      artifactLocation: SarifArtifactLocation;
      replacements: { deletedRegion: SarifRegion; insertedContent: { text: string } }[];
    }[];
  }[];
  suppressions?: { kind: 'external'; status: 'accepted'; justification: string }[];
  properties: { a11yAutofix: Record<string, unknown> };
}
export interface SarifRule {
  id: string;
  name: string;
  shortDescription: SarifMessage;
  fullDescription: SarifMessage;
  helpUri: string;
  help: { text: string; markdown: string };
  properties: { tags: string[]; wcag: { criteria: string[]; levels: string[] }; axeTags: string[] };
}
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: {
    tool: {
      driver: { name: string; version: string; informationUri: string; rules: SarifRule[] };
    };
    originalUriBaseIds: Record<string, { uri: string }>;
    columnKind: 'utf16CodeUnits';
    invocations: { executionSuccessful: boolean }[];
    results: SarifResult[];
    properties: { a11yAutofix: Record<string, unknown> };
  }[];
}

export interface SarifOptions {
  /** File paths in the log are relative to this (the repository root, for GitHub). Defaults to `process.cwd()`. */
  root?: string;
  toolVersion?: string;
}

function ruleName(ruleId: string): string {
  return ruleId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toRule(item: ReportItem): SarifRule {
  const wcag = wcagInfo(item.ruleId);
  const tags = [
    'accessibility',
    ...wcag.levels,
    ...wcag.criteria.map((criterion) => `WCAG ${criterion}`),
    ...(wcag.bestPractice ? ['best-practice'] : []),
  ];
  return {
    id: item.ruleId,
    name: ruleName(item.ruleId),
    shortDescription: { text: item.help },
    fullDescription: { text: item.description },
    helpUri: item.helpUrl,
    help: {
      text: `${item.description} See ${item.helpUrl}`,
      markdown: `${item.description}\n\n[How to fix ${item.ruleId} (Deque University)](${item.helpUrl})`,
    },
    properties: {
      tags,
      wcag: { criteria: wcag.criteria, levels: wcag.levels },
      axeTags: wcag.axeTags,
    },
  };
}

const STATUS_SENTENCES: Record<FixStatus, (item: ReportItem) => string> = {
  fixed: (item) => `Fixed: a verified fix was applied (${item.patch?.confidence} confidence).`,
  'verified-fix': (item) => `A verified fix is available (${item.patch?.confidence} confidence).`,
  'unverified-fix': (item) => `A fix was generated but did not verify (${item.detail}).`,
  'not-auto-fixable': (item) => `Not auto-fixable: ${item.detail}`,
  error: (item) => `No fix: ${item.detail}`,
  suppressed: (item) => `Suppressed: ${item.detail}.`,
};

function artifactLocation(filePath: string, root: string): SarifArtifactLocation {
  const relative = relativePath(filePath, root);
  return relative === null
    ? { uri: pathToFileURL(filePath).href }
    : { uri: relative.split('/').map(encodeURIComponent).join('/'), uriBaseId: SRCROOT };
}

function region(item: ReportItem): SarifRegion | undefined {
  if (!item.location) return undefined;
  const { startLine, startColumn, endLine, endColumn } = item.location;
  return {
    startLine,
    startColumn,
    endLine,
    endColumn,
    ...(item.snippet ? { snippet: { text: item.snippet } } : {}),
  };
}

export function toSarif(result: ScanResult, options: SarifOptions = {}): SarifLog {
  const root = options.root ?? process.cwd();
  const items = reportItems(result);

  const ruleIds = [...new Set(items.map((item) => item.ruleId))].sort();
  const rules = ruleIds.map((id) => toRule(items.find((item) => item.ruleId === id)!));
  const occurrences = new Map<string, number>();

  const results = items.map((item): SarifResult => {
    const location = artifactLocation(item.filePath, root);
    const elementRegion = region(item);
    // Stable across runs as long as the element's text doesn't change,
    // even if lines above it move; numbered so identical elements differ.
    const identity = `${item.ruleId}\0${location.uri}\0${item.snippet ?? item.renderedHtml ?? ''}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const fingerprint = createHash('sha256').update(`${identity}\0${occurrence}`).digest('hex');

    const verifiedFix =
      (item.status === 'verified-fix' || item.status === 'fixed') && item.patch?.position
        ? item.patch
        : null;

    return {
      ruleId: item.ruleId,
      ruleIndex: ruleIds.indexOf(item.ruleId),
      level: item.impact ? IMPACT_TO_LEVEL[item.impact] : 'warning',
      message: { text: `${item.help}. ${STATUS_SENTENCES[item.status](item)}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: location,
            ...(elementRegion ? { region: elementRegion } : {}),
          },
        },
      ],
      partialFingerprints: { 'a11yAutofixElement/v1': fingerprint },
      ...(verifiedFix && verifiedFix.position
        ? {
            fixes: [
              {
                description: {
                  text: `${verifiedFix.kind === 'insert' ? 'Insert an element' : 'Replace the element'}; verified by re-running axe-core (${verifiedFix.confidence} confidence).`,
                },
                artifactChanges: [
                  {
                    artifactLocation: location,
                    replacements: [
                      {
                        deletedRegion: {
                          charOffset: verifiedFix.position.start,
                          charLength: verifiedFix.position.end - verifiedFix.position.start,
                        },
                        insertedContent: { text: verifiedFix.newSnippet },
                      },
                    ],
                  },
                ],
              },
            ],
          }
        : {}),
      ...(item.status === 'suppressed'
        ? {
            suppressions: [
              {
                kind: 'external' as const,
                status: 'accepted' as const,
                justification: `a11y-autofix project config: ${item.detail}`,
              },
            ],
          }
        : {}),
      properties: {
        a11yAutofix: {
          status: item.status,
          verifiedFixAvailable: item.status === 'verified-fix' || item.status === 'fixed',
          applied: item.status === 'fixed',
          impact: item.impact,
          confidence: item.patch?.confidence ?? null,
          patchKind: item.patch ? (item.patch.kind ?? 'replace') : null,
          detail: item.detail,
          ...(item.patch?.fallback ? { fallback: item.patch.fallback.reason } : {}),
        },
      },
    };
  });

  const byStatus = Object.fromEntries(
    (
      [
        'fixed',
        'verified-fix',
        'unverified-fix',
        'not-auto-fixable',
        'error',
        'suppressed',
      ] as const
    ).map((status) => [status, items.filter((item) => item.status === status).length]),
  );
  const byImpact = Object.fromEntries(
    [...IMPACTS, null].map((impact) => [
      impact ?? 'unknown',
      items.filter((item) => item.impact === impact && item.status !== 'suppressed').length,
    ]),
  );

  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'a11y-autofix',
            version: options.toolVersion ?? packageVersion,
            informationUri: INFORMATION_URI,
            rules,
          },
        },
        // A directory URI must end in "/".
        originalUriBaseIds: { [SRCROOT]: { uri: pathToFileURL(root).href.replace(/\/?$/, '/') } },
        columnKind: 'utf16CodeUnits',
        invocations: [{ executionSuccessful: true }],
        results,
        properties: {
          a11yAutofix: {
            filesScanned: result.filesScanned,
            ignoredFiles: (result.ignoredFiles ?? []).map(
              (file) => relativePath(file, root) ?? file,
            ),
            mode: result.mode ?? null,
            byStatus,
            byImpact,
          },
        },
      },
    ],
  };
}
