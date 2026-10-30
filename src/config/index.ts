/**
 * config/ — project configuration: an `a11y-autofix.config.json` file in
 * the project root, or an "a11y-autofix" key in its package.json (the
 * file wins when both exist; they are never merged). cli/ loads it and
 * layers command-line flags on top; scan/ applies the resulting `ignore`,
 * `disableRules` and `severity` settings.
 *
 * Suppression is never silent: a violation hidden by `disableRules` or
 * `severity` is still detected, never sent to the model, and reported in
 * its own `suppressed` list and count, separate from fixed ones.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import axe from 'axe-core';
import picomatch from 'picomatch';
import { z } from 'zod';

import type { AxeViolation } from '../detect';

export const CONFIG_FILE_NAME = 'a11y-autofix.config.json';
export const PACKAGE_JSON_KEY = 'a11y-autofix';

/** axe-core impact levels, lowest first. */
export const SEVERITIES = ['minor', 'moderate', 'serious', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

const knownRuleIds = new Set(axe.getRules().map((rule) => rule.ruleId));

export const ProjectConfigSchema = z.strictObject({
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name, e.g. "MY_KEY"')
    .optional(),
  ignore: z.array(z.string().min(1, 'glob patterns must not be empty')).optional(),
  disableRules: z
    .array(
      z.string().refine((id) => knownRuleIds.has(id), {
        error: (issue) => `unknown axe-core rule id "${String(issue.input)}"`,
      }),
    )
    .optional(),
  severity: z.enum(SEVERITIES).optional(),
  browser: z.boolean().optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export type ConfigSource = 'file' | 'package' | 'none';

export interface LoadedConfig {
  /** Where the config came from: the config file, package.json's "a11y-autofix" key, or nowhere. */
  source: ConfigSource;
  /** Absolute path of the file it was read from; null when `source` is `'none'`. */
  path: string | null;
  config: ProjectConfig;
}

/** Thrown for a config that exists but can't be read, isn't JSON, or fails the schema. No config at all is not an error. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function formatIssues(where: string, error: z.ZodError): string {
  const lines = error.issues.flatMap((issue) => {
    // Report each unrecognized key on its own line, with the key as its path.
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) =>
        // An API key must never be committed: only the *name* of the
        // variable holding it belongs in config.
        key === 'apiKey'
          ? '  - apiKey: API keys do not belong in config; set the key in an environment variable and name that variable with "apiKeyEnv"'
          : `  - ${key}: unknown setting`,
      );
    }
    const at =
      issue.path
        .map((key, index) =>
          typeof key === 'number' ? `[${key}]` : `${index > 0 ? '.' : ''}${String(key)}`,
        )
        .join('') || '(root)';
    return [`  - ${at}: ${issue.message}`];
  });
  return `Invalid ${where}:\n${lines.join('\n')}`;
}

/** Validates an already-parsed config value; `where` names it in errors. */
export function parseProjectConfig(value: unknown, where: string): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(value);
  if (!result.success) throw new ConfigError(formatIssues(where, result.error));
  return result.data;
}

function readJson(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read ${filePath}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(
      `Could not parse ${path.basename(filePath)} as JSON: ${(error as Error).message}`,
    );
  }
}

/**
 * Reads the project config from `projectRoot`: `a11y-autofix.config.json`
 * if it exists, otherwise the "a11y-autofix" key of `package.json`,
 * otherwise nothing. Throws `ConfigError` for invalid config.
 */
export function loadProjectConfig(projectRoot: string): LoadedConfig {
  const configPath = path.resolve(projectRoot, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    return {
      source: 'file',
      path: configPath,
      config: parseProjectConfig(readJson(configPath), CONFIG_FILE_NAME),
    };
  }

  const packagePath = path.resolve(projectRoot, 'package.json');
  if (existsSync(packagePath)) {
    const packageJson = readJson(packagePath);
    if (
      packageJson !== null &&
      typeof packageJson === 'object' &&
      PACKAGE_JSON_KEY in packageJson
    ) {
      return {
        source: 'package',
        path: packagePath,
        config: parseProjectConfig(
          (packageJson as Record<string, unknown>)[PACKAGE_JSON_KEY],
          `"${PACKAGE_JSON_KEY}" key in package.json`,
        ),
      };
    }
  }

  return { source: 'none', path: null, config: {} };
}

/** Every setting with a value: what a scan actually runs with. */
export interface ResolvedSettings {
  apiKeyEnv: string;
  ignore: string[];
  disableRules: string[];
  severity: Severity;
  browser: boolean;
}

export const DEFAULT_SETTINGS: ResolvedSettings = {
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  ignore: [],
  disableRules: [],
  // Lowest level: report everything.
  severity: 'minor',
  browser: false,
};

/**
 * Layers settings: a flag that was given wins, then the config, then the
 * default. A flag replaces the config's value outright — `--ignore` given
 * on the command line replaces the config's `ignore` list rather than
 * adding to it.
 */
export function resolveSettings(config: ProjectConfig, flags: ProjectConfig): ResolvedSettings {
  const pick = <K extends keyof ResolvedSettings>(key: K): ResolvedSettings[K] =>
    (flags[key] ?? config[key] ?? DEFAULT_SETTINGS[key]) as ResolvedSettings[K];
  return {
    apiKeyEnv: pick('apiKeyEnv'),
    ignore: pick('ignore'),
    disableRules: pick('disableRules'),
    severity: pick('severity'),
    browser: pick('browser'),
  };
}

/**
 * A predicate for "is this file ignored?": `patterns` are globs matched
 * against the file's path relative to `root`, with `/` separators (so
 * `src/legacy/**` and `**\/*.stories.tsx` work the same on every OS).
 */
export function createIgnoreMatcher(
  patterns: readonly string[],
  root: string,
): (absolutePath: string) => boolean {
  if (patterns.length === 0) return () => false;
  const matches = picomatch([...patterns], { dot: true });
  return (absolutePath) => matches(path.relative(root, absolutePath).split(path.sep).join('/'));
}

export type SuppressionReason = 'disabled-rule' | 'below-severity';

export interface SuppressionSettings {
  disableRules?: readonly string[];
  severity?: Severity;
}

/**
 * Why config hides this violation, or null if it is reported. A violation
 * with no impact can't be ranked, so `severity` never hides it.
 */
export function suppressionReason(
  violation: AxeViolation,
  settings: SuppressionSettings,
): SuppressionReason | null {
  if (settings.disableRules?.includes(violation.id)) return 'disabled-rule';
  if (
    settings.severity &&
    violation.impact &&
    SEVERITIES.indexOf(violation.impact) < SEVERITIES.indexOf(settings.severity)
  ) {
    return 'below-severity';
  }
  return null;
}
