#!/usr/bin/env node

/**
 * cli/ — the bin entry point. Renders the results of scan/'s
 * detect -> context -> generate -> verify pipeline to the terminal: a
 * unified diff plus a verified/unverified/errored outcome for every
 * violation, an optional --write of verified fixes to disk, and a summary
 * line with a non-zero exit code when anything is left unresolved.
 *
 * `runScan` is exported (not just invoked via commander) so it can be
 * driven directly in tests without going through process.argv/process.exit.
 * `program.parse` only runs when this file is executed directly.
 */

import path from 'node:path';

import { Command } from 'commander';

import { ConfigError, loadProjectConfig, parseProjectConfig, resolveSettings } from '../config';
import type { LoadedConfig, ProjectConfig, ResolvedSettings } from '../config';
import { appendCorrection } from './corrections-log';
import { createInteractiveHandler } from './interactive';
import type { InteractiveHandler } from './interactive';
import type { AxeViolation } from '../detect';
import { BrowserUnavailableError } from '../detect';
import type { Patch } from '../generate';
import { openingTagName } from '../generate/patch';
import type { PatchConfidence, ScanOptions, ScanResult, ScanViolationResult } from '../scan';
import { scan } from '../scan';
import type { VerificationResult } from '../verify';

import { version } from '../../package.json';

export type { ScanOptions } from '../scan';

export interface ScanSummary {
  filesScanned: number;
  violationsFound: number;
  verified: number;
  unverified: number;
  errored: number;
  /** Detected but hidden by config (`disableRules`/`severity`); not in `violationsFound`. */
  suppressed: number;
  /** Component files skipped by config `ignore`; not in `filesScanned`. */
  filesIgnored: number;
}

function emptySummary(): ScanSummary {
  return {
    filesScanned: 0,
    violationsFound: 0,
    verified: 0,
    unverified: 0,
    errored: 0,
    suppressed: 0,
    filesIgnored: 0,
  };
}

function displayPath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath) || absolutePath;
}

function renderUnifiedDiff(relativePath: string, startLine: number, patch: Patch): string {
  const oldLines = patch.oldSnippet.split('\n');
  const newLines = patch.newSnippet.split('\n');
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

function printViolationHeader(violation: AxeViolation): void {
  console.log(
    `  [violation] ${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}`,
  );
}

function printVerificationOutcome(
  result: VerificationResult,
  applied: boolean,
  confidence: PatchConfidence,
): void {
  if (result.status === 'verified') {
    console.log(
      `${applied ? '  [verified] fix applied to disk' : '  [verified] fix confirmed (pass --write to apply)'} (confidence: ${confidence})`,
    );
    return;
  }

  console.log(
    `  [unverified] this fix did not resolve the violation — not applied (confidence: ${confidence})`,
  );
  if (result.remainingViolations.length > 0) {
    console.log(`    still flagged: ${result.remainingViolations.map((v) => v.id).join(', ')}`);
  }
  if (result.newViolations.length > 0) {
    console.log(
      `    new violations introduced: ${result.newViolations.map((v) => v.id).join(', ')}`,
    );
  }
}

/**
 * For an insertion, what was added and where; for a fallback replacement,
 * why insertion wasn't used. Nothing for an ordinary replacement, whose
 * output is unchanged.
 */
function printPatchKind(patch: Patch, applied: boolean): void {
  if (patch.kind === 'insert' && patch.insertion) {
    const tag = openingTagName(patch.insertion.snippet) ?? 'element';
    console.log(
      `    kind: insert — ${applied ? 'added' : 'adds'} a new <${tag}> ${patch.insertion.position} the flagged element`,
    );
  } else if (patch.fallback) {
    console.log(`    kind: replace (fallback — ${patch.fallback.reason})`);
  }
}

function printViolationResult(entry: ScanViolationResult): void {
  printViolationHeader(entry.violation);

  if (entry.status === 'errored') {
    const label = entry.reason === 'not-auto-fixable' ? 'not auto-fixable' : 'error';
    console.log(`  [${label}] ${entry.error}`);
    return;
  }

  console.log(
    renderUnifiedDiff(
      displayPath(entry.filePath),
      entry.context.element.location.startLine,
      entry.patch,
    ),
  );
  printVerificationOutcome(entry.verification, entry.applied, entry.patch.confidence);
  printPatchKind(entry.patch, entry.applied);
}

function summarize(result: ScanResult): ScanSummary {
  const summary: ScanSummary = {
    ...emptySummary(),
    filesScanned: result.filesScanned,
    violationsFound: result.violations.length,
    suppressed: result.suppressed.length,
    filesIgnored: result.ignoredFiles.length,
  };

  for (const entry of result.violations) {
    if (entry.status === 'verified') summary.verified += 1;
    else if (entry.status === 'unverified') summary.unverified += 1;
    else summary.errored += 1;
  }

  return summary;
}

/**
 * " 3 suppressed by config (region ×2, heading-order ×1). 1 file(s) skipped
 * by config ignore." — empty when config hid nothing. Suppressed
 * violations are always counted, never silently dropped.
 */
function describeConfigEffects(result: ScanResult): string {
  const parts: string[] = [];
  if (result.suppressed.length > 0) {
    const byRule = new Map<string, number>();
    for (const entry of result.suppressed) {
      byRule.set(entry.violation.id, (byRule.get(entry.violation.id) ?? 0) + 1);
    }
    const rules = [...byRule].map(([id, count]) => `${id} ×${count}`).join(', ');
    parts.push(`${result.suppressed.length} suppressed by config (${rules}).`);
  }
  if (result.ignoredFiles.length > 0) {
    parts.push(`${result.ignoredFiles.length} file(s) skipped by config ignore.`);
  }
  return parts.map((part) => ` ${part}`).join('');
}

function printScanResult(result: ScanResult, summary: ScanSummary): void {
  const configEffects = describeConfigEffects(result);
  if (result.violations.length === 0) {
    console.log(
      configEffects
        ? `No accessibility violations to fix in ${displayPath(result.targetPath)}.${configEffects}`
        : `No accessibility violations found in ${displayPath(result.targetPath)}.`,
    );
    return;
  }

  let currentFile: string | null = null;
  for (const entry of result.violations) {
    if (entry.filePath !== currentFile) {
      currentFile = entry.filePath;
      console.log(`\n${displayPath(currentFile)}`);
    }

    printViolationResult(entry);
  }

  console.log(
    `\n${summary.violationsFound} violation(s) found across ${summary.filesScanned} file(s): ` +
      `${summary.verified} verified, ${summary.unverified} unverified, ${summary.errored} errored.` +
      configEffects,
  );
}

export interface CliScanOptions extends ScanOptions {
  /** Print the full ScanResult as JSON instead of a human-readable diff — for machine consumers (e.g. the GitHub Action). */
  json?: boolean;
  /** Review each verified fix before applying it: accept, reject, or edit. Without --write, this is a dry-run review (nothing is ever written, accept or not). */
  interactive?: boolean;
  /**
   * When used with --interactive, appends every rejected or edited fix to
   * `.a11y-autofix/corrections.log` — fully local, opt-in, never sent
   * anywhere. See README.md's "Local corrections log" section. Has no
   * effect without --interactive (nothing is ever rejected or edited
   * outside it).
   */
  logCorrections?: boolean;
  /**
   * Where to look for `a11y-autofix.config.json` / package.json, and what
   * `ignore` globs are relative to. Defaults to `process.cwd()`.
   */
  projectRoot?: string;
}

/**
 * The config-backed settings given as command-line flags (or by a direct
 * `runScan` caller), validated like the config itself. Unset keys are left
 * out so `resolveSettings` falls through to the config.
 */
function flagSettings(options: CliScanOptions): ProjectConfig {
  const flags: Record<string, unknown> = {
    apiKeyEnv: options.apiKeyEnv,
    ignore: options.ignore,
    disableRules: options.disableRules,
    severity: options.severity,
    browser: options.browser,
  };
  for (const key of Object.keys(flags)) {
    if (flags[key] === undefined) delete flags[key];
  }
  return parseProjectConfig(flags, 'command-line options');
}

function buildCorrectionsLogger(): NonNullable<ScanOptions['onFixResolved']> {
  return (info) => {
    if (info.outcome === 'accepted') return;
    appendCorrection(process.cwd(), {
      timestamp: new Date().toISOString(),
      filePath: displayPath(info.filePath),
      startLine: info.startLine,
      violationId: info.violation.id,
      action: info.outcome === 'edited' ? 'edited' : 'rejected',
      kind: info.suggested.kind ?? 'replace',
      suggested: info.suggested.newSnippet,
      ...(info.editedSnippet ? { edited: info.editedSnippet } : {}),
    });
  };
}

export async function runScan(
  targetPath: string,
  options: CliScanOptions = {},
): Promise<ScanSummary> {
  const { json, interactive, logCorrections, projectRoot = process.cwd(), ...flags } = options;

  if (json && interactive) {
    console.error(
      '--interactive cannot be combined with --json: interactive prompts would corrupt the JSON written to stdout.',
    );
    process.exitCode = 1;
    return emptySummary();
  }

  // Flags win over the config file (or package.json key), which wins over
  // the defaults.
  let loaded: LoadedConfig;
  let settings: ResolvedSettings;
  let flagConfig: ProjectConfig;
  try {
    loaded = loadProjectConfig(projectRoot);
    flagConfig = flagSettings(flags);
    settings = resolveSettings(loaded.config, flagConfig);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(json ? JSON.stringify({ error: error.message }) : error.message);
    process.exitCode = 1;
    return emptySummary();
  }

  const scanOptions: ScanOptions = {
    ...flags,
    browser: settings.browser,
    ignore: settings.ignore,
    root: projectRoot,
    disableRules: settings.disableRules,
    severity: settings.severity,
  };
  // Only when set explicitly: otherwise the SDK's own default lookup applies, as before config existed.
  const explicitApiKeyEnv = flagConfig.apiKeyEnv ?? loaded.config.apiKeyEnv;
  if (explicitApiKeyEnv) scanOptions.apiKeyEnv = explicitApiKeyEnv;
  else delete scanOptions.apiKeyEnv;

  if (logCorrections && !interactive) {
    console.error(
      '--log-corrections has no effect without --interactive: nothing is ever rejected or edited outside interactive mode.',
    );
  }

  let interactiveHandler: InteractiveHandler | undefined;
  if (interactive) {
    interactiveHandler = createInteractiveHandler();
    scanOptions.onVerifiedFix = interactiveHandler.onVerifiedFix;
  }
  if (logCorrections && interactive) {
    scanOptions.onFixResolved = buildCorrectionsLogger();
  }

  let result: ScanResult;
  try {
    try {
      result = await scan(targetPath, scanOptions);
    } catch (error) {
      if (json) {
        console.error(JSON.stringify({ error: (error as Error).message }));
      } else if (error instanceof BrowserUnavailableError) {
        console.error(error.message);
      } else {
        console.error(`Could not read path "${targetPath}": ${(error as Error).message}`);
      }
      process.exitCode = 1;
      return emptySummary();
    }
  } finally {
    interactiveHandler?.close();
  }

  const summary = summarize(result);
  if (json) {
    const config = { source: loaded.source, path: loaded.path, settings };
    console.log(JSON.stringify({ ...result, config }, null, 2));
  } else {
    if (loaded.path) console.log(`Using config from ${displayPath(loaded.path)}`);
    printScanResult(result, summary);
  }

  const resolvedCount = scanOptions.write ? summary.verified : 0;
  const unresolvedCount = summary.violationsFound - resolvedCount;
  if (unresolvedCount > 0) {
    process.exitCode = 1;
  }

  return summary;
}

/* c8 ignore start -- exercised via the actual CLI binary, not unit tests */
/** Commander collector for a repeatable option: `--ignore a --ignore b` gives `['a', 'b']`. */
function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function main(): void {
  const program = new Command();

  program
    .name('a11y-autofix')
    .description(
      'Scan React and Vue components with axe-core, generate verified WCAG fix diffs via the Claude API.',
    )
    .version(version);

  program
    .command('scan')
    .description(
      'Scan a React or Vue component (or directory) for WCAG violations and propose verified fixes',
    )
    .argument('<path>', 'path to a component file or directory')
    .option(
      '--write',
      'apply verified fixes directly to files (unverified fixes are never applied)',
    )
    .option('--json', 'print the full scan result as JSON instead of a human-readable diff')
    .option(
      '--browser',
      'render in headless Chromium (via Playwright) instead of jsdom, so color-contrast is checked too — needs `npm i -D playwright && npx playwright install chromium`',
    )
    .option('--no-browser', 'render in jsdom even if the project config sets "browser": true')
    .option(
      '--ignore <glob>',
      'skip component files matching this glob, relative to the current directory (repeatable; replaces the config\'s "ignore")',
      collect,
    )
    .option(
      '--disable-rule <id>',
      'never report this axe-core rule; its violations are counted as suppressed (repeatable; replaces the config\'s "disableRules")',
      collect,
    )
    .option(
      '--severity <level>',
      'minimum impact to report: critical, serious, moderate, or minor (default); lower ones are counted as suppressed',
    )
    .option(
      '--api-key-env <name>',
      'environment variable holding the Anthropic API key (default: ANTHROPIC_API_KEY)',
    )
    .option(
      '--interactive',
      'review each verified fix before applying it: accept, reject, or edit (without --write, this only reviews — nothing is ever written)',
    )
    .option(
      '--log-corrections',
      'with --interactive, save rejected/edited fixes to .a11y-autofix/corrections.log for your own reference — fully local, opt-in, never sent anywhere',
    )
    .action(async (targetPath: string, options: CliScanOptions & { disableRule?: string[] }) => {
      const { disableRule, ...rest } = options;
      await runScan(targetPath, { ...rest, ...(disableRule ? { disableRules: disableRule } : {}) });
    });

  program.parse(process.argv);
}

if (require.main === module) {
  main();
}
/* c8 ignore stop */
