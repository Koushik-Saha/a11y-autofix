import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir;
let originalEnv;
let originalExitCode;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'a11y-autofix-check-'));
  originalEnv = { ...process.env };
  originalExitCode = process.exitCode;
});

afterEach(() => {
  process.env = originalEnv;
  process.exitCode = originalExitCode;
  rmSync(tempDir, { recursive: true, force: true });
});

function writeResult(violations) {
  const resultFile = path.join(tempDir, 'result.json');
  writeFileSync(resultFile, JSON.stringify({ violations }), 'utf8');
  process.env.RESULT_FILE = resultFile;
  return resultFile;
}

describe('check-unresolved main()', () => {
  it('does not set a non-zero exit code when every violation is verified', async () => {
    writeResult([{ status: 'verified' }, { status: 'verified' }]);

    const { main } = await import('./check-unresolved.js');
    main();

    expect(process.exitCode).not.toBe(1);
  });

  it('does not set a non-zero exit code when there are no violations at all', async () => {
    writeResult([]);

    const { main } = await import('./check-unresolved.js');
    main();

    expect(process.exitCode).not.toBe(1);
  });

  it('sets exit code 1 when an unverified violation remains', async () => {
    writeResult([{ status: 'verified' }, { status: 'unverified' }]);

    const { main } = await import('./check-unresolved.js');
    main();

    expect(process.exitCode).toBe(1);
  });

  it('sets exit code 1 when an errored violation remains', async () => {
    writeResult([{ status: 'errored' }]);

    const { main } = await import('./check-unresolved.js');
    main();

    expect(process.exitCode).toBe(1);
  });
});
