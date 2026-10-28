import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only generateFix needs live Claude credentials; detect/, context/,
// verify/, scan/ and cli/ run for real.
vi.mock('../src/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate')>()),
  generateFix: vi.fn(),
}));

import { runScan } from '../src/cli';
import { detectViolations, detectViolationsInSource } from '../src/detect';
import { generateFix } from '../src/generate';
import { scan } from '../src/scan';

import { chromiumAvailable } from './helpers/chromium';

// A directory with a React and a Vue component that each have a different
// violation, plus one clean component.
const dir = path.join(__dirname, 'fixtures', 'two-files');
const gallery = path.join(dir, 'Gallery.tsx');
const signupForm = path.join(dir, 'SignupForm.vue');
const clean = path.join(dir, 'Clean.tsx');

const FIXES: Record<string, (code: string) => string> = {
  'image-alt': (code) => code.replace('<img ', '<img alt="A gallery photo" '),
  label: (code) => code.replace('<input ', '<input aria-label="Email address" '),
};

beforeEach(() => {
  vi.mocked(generateFix).mockReset();
  vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
    filePath: context.componentPath,
    violationId: context.violation.id,
    oldSnippet: context.element.code,
    newSnippet: FIXES[context.violation.id]!(context.element.code),
    position: {
      start: context.element.location.startOffset,
      end: context.element.location.endOffset,
    },
  }));
});

describe('detectViolations: per-file attribution', () => {
  async function expectAttributed(browser: boolean): Promise<void> {
    const result = await detectViolations({ componentPath: dir, browser });

    expect(result.violations.map((v) => [v.id, v.filePath])).toEqual([
      ['image-alt', gallery],
      ['label', signupForm],
    ]);
    // Every file rendered is listed — the clean one too — with the text
    // that was checked.
    expect(result.files.map((file) => file.filePath)).toEqual([clean, gallery, signupForm]);
    for (const file of result.files) {
      expect(file.source).toBe(readFileSync(file.filePath, 'utf8'));
    }
  }

  it('attributes each violation in a directory to its file', async () => {
    await expectAttributed(false);
  });

  it.runIf(chromiumAvailable)('does the same in browser mode', async () => {
    await expectAttributed(true);
  });

  it('sets an absolute filePath for a single-file target given as a relative path', async () => {
    const relative = path.relative(process.cwd(), gallery);

    const result = await detectViolations({ componentPath: relative });

    expect(result.violations.map((v) => v.filePath)).toEqual([gallery]);
    expect(result.files.map((file) => file.filePath)).toEqual([gallery]);
  });

  it('sets filePath for in-memory source too', async () => {
    const result = await detectViolationsInSource({
      source: readFileSync(signupForm, 'utf8'),
      filePath: signupForm,
    });

    expect(result.violations.map((v) => [v.id, v.filePath])).toEqual([['label', signupForm]]);
  });
});

describe('scan() and the CLI on a directory', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    previousExitCode = process.exitCode;
  });
  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = previousExitCode;
  });

  it('scan() fixes each violation in the file it was found in', async () => {
    const result = await scan(dir);

    expect(result.filesScanned).toBe(3);
    expect(
      result.violations.map((entry) => [entry.violation.id, entry.filePath, entry.status]),
    ).toEqual([
      ['image-alt', gallery, 'verified'],
      ['label', signupForm, 'verified'],
    ]);
    for (const entry of result.violations) {
      expect(entry.violation.filePath).toBe(entry.filePath);
      if (entry.status !== 'errored') expect(entry.context.componentPath).toBe(entry.filePath);
    }
  });

  it('the CLI prints each violation under its own file', async () => {
    const summary = await runScan(dir);

    expect(summary).toMatchObject({ filesScanned: 3, violationsFound: 2, verified: 2 });
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    const order = [
      `\n${path.relative(process.cwd(), gallery)}`,
      '[violation] image-alt',
      `\n${path.relative(process.cwd(), signupForm)}`,
      '[violation] label',
      '2 violation(s) found across 3 file(s)',
    ].map((needle) => output.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(output).not.toContain(path.relative(process.cwd(), clean));
  });
});
