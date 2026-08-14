import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendCorrection, ensureCorrectionsDir } from '../src/cli/corrections-log';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'a11y-autofix-corrections-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('ensureCorrectionsDir', () => {
  it('creates .a11y-autofix/ with a self-contained .gitignore excluding everything in it', () => {
    const dir = ensureCorrectionsDir(tempDir);

    expect(dir).toBe(path.join(tempDir, '.a11y-autofix'));
    const gitignore = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore.trim()).toBe('*');
  });

  it('is idempotent — does not overwrite an existing .gitignore', () => {
    ensureCorrectionsDir(tempDir);
    const gitignorePath = path.join(tempDir, '.a11y-autofix', '.gitignore');
    const firstWrite = readFileSync(gitignorePath, 'utf8');

    ensureCorrectionsDir(tempDir);

    expect(readFileSync(gitignorePath, 'utf8')).toBe(firstWrite);
  });
});

describe('appendCorrection', () => {
  it('appends a JSON-lines entry, creating the directory on first use', () => {
    appendCorrection(tempDir, {
      timestamp: '2026-08-13T00:00:00.000Z',
      filePath: 'src/components/Avatar.tsx',
      startLine: 8,
      violationId: 'image-alt',
      action: 'rejected',
      suggested: '<img src={avatarUrl} alt="User avatar" />',
    });

    const logPath = path.join(tempDir, '.a11y-autofix', 'corrections.log');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.violationId).toBe('image-alt');
    expect(parsed.action).toBe('rejected');
    expect(parsed.startLine).toBe(8);
  });

  it('appends multiple entries across calls without clobbering earlier ones', () => {
    appendCorrection(tempDir, {
      timestamp: '2026-08-13T00:00:00.000Z',
      filePath: 'a.tsx',
      startLine: 1,
      violationId: 'image-alt',
      action: 'rejected',
      suggested: 'x',
    });
    appendCorrection(tempDir, {
      timestamp: '2026-08-13T00:01:00.000Z',
      filePath: 'b.tsx',
      startLine: 2,
      violationId: 'label',
      action: 'edited',
      suggested: 'y',
      edited: 'z',
    });

    const logPath = path.join(tempDir, '.a11y-autofix', 'corrections.log');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).edited).toBe('z');
  });
});
