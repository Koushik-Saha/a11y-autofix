/**
 * corrections-log.ts — an opt-in, fully local record of fixes the user
 * rejected or edited in `--interactive` mode, written to
 * `.a11y-autofix/corrections.log` for the user's own reference. Nothing
 * here makes a network call or is reachable unless the CLI's
 * `--log-corrections` flag is passed — see cli/index.ts and README.md's
 * "Local corrections log" section for the full privacy framing.
 *
 * The directory gets its own `.gitignore` (containing just `*`) the first
 * time it's created, so the log is excluded from git regardless of
 * whether the user's own project `.gitignore` mentions it — "local only"
 * shouldn't depend on the user remembering to add an entry themselves.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CORRECTIONS_DIR_NAME = '.a11y-autofix';
export const CORRECTIONS_LOG_NAME = 'corrections.log';

export interface CorrectionLogEntry {
  timestamp: string;
  /** Relative to `projectRoot`, for a log a human can actually read. */
  filePath: string;
  startLine: number;
  violationId: string;
  action: 'rejected' | 'edited';
  /** The AI's original suggestion. */
  suggested: string;
  /** Only set when `action === 'edited'`: the user's replacement that verified. */
  edited?: string;
}

/**
 * Creates `<projectRoot>/.a11y-autofix/` (and its self-contained
 * `.gitignore`) if it doesn't already exist. Idempotent — safe to call
 * before every append.
 */
export function ensureCorrectionsDir(projectRoot: string): string {
  const dir = path.join(projectRoot, CORRECTIONS_DIR_NAME);
  const gitignorePath = path.join(dir, '.gitignore');

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n', 'utf8');
  }

  return dir;
}

/**
 * Appends one JSON-lines entry to `.a11y-autofix/corrections.log`,
 * creating the directory (and its `.gitignore`) first if needed.
 */
export function appendCorrection(projectRoot: string, entry: CorrectionLogEntry): void {
  const dir = ensureCorrectionsDir(projectRoot);
  const logPath = path.join(dir, CORRECTIONS_LOG_NAME);
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}
