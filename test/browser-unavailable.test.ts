import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Simulates Playwright (or its Chromium) being missing — no real browser
// needed, so these run everywhere. The point being pinned: --browser
// fails loudly and never quietly falls back to jsdom, which can't check
// color-contrast.
vi.mock('../src/detect/playwright', () => ({
  importPlaywright: vi.fn(),
}));
vi.mock('../src/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate')>()),
  generateFix: vi.fn(),
}));

import { runScan } from '../src/cli';
import { BrowserUnavailableError, detectViolations } from '../src/detect';
import { importPlaywright } from '../src/detect/playwright';
import { generateFix } from '../src/generate';
import { scan } from '../src/scan';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

function playwrightNotInstalled(): void {
  vi.mocked(importPlaywright).mockRejectedValue(
    Object.assign(new Error("Cannot find module 'playwright'"), { code: 'MODULE_NOT_FOUND' }),
  );
}

function chromiumNotInstalled(): void {
  vi.mocked(importPlaywright).mockResolvedValue({
    chromium: {
      launch: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "browserType.launch: Executable doesn't exist at /cache/ms-playwright/chromium_headless_shell-1228/chrome-mac/headless_shell\nLooks like Playwright was just installed or updated.",
          ),
        ),
    },
  } as unknown as typeof import('playwright'));
}

beforeEach(() => {
  vi.mocked(importPlaywright).mockReset();
  vi.mocked(generateFix).mockReset();
});

describe('--browser when Playwright/Chromium is unavailable', () => {
  it('explains how to install Playwright when the package is missing', async () => {
    playwrightNotInstalled();

    const error = await detectViolations({
      componentPath: fixture('LowContrastText.tsx'),
      browser: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserUnavailableError);
    expect((error as Error).message).toContain('npm install --save-dev playwright');
    expect((error as Error).message).toContain('npx playwright install chromium');
    expect((error as Error).message).toContain('cannot check color-contrast');
  });

  it('explains how to install Chromium when only the browser binary is missing', async () => {
    chromiumNotInstalled();

    const error = await detectViolations({
      componentPath: fixture('LowContrastText.tsx'),
      browser: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BrowserUnavailableError);
    expect((error as Error).message).toContain(
      "Playwright's Chromium build, which is not installed",
    );
    expect((error as Error).message).toContain('npx playwright install chromium');
  });

  it('scan() rejects instead of falling back to jsdom — even for a file jsdom could scan', async () => {
    playwrightNotInstalled();

    // MissingAlt has a violation jsdom finds; a fallback would resolve
    // with it. Rejecting proves there is no fallback.
    await expect(scan(fixture('MissingAlt.tsx'), { browser: true })).rejects.toBeInstanceOf(
      BrowserUnavailableError,
    );
    expect(vi.mocked(generateFix)).not.toHaveBeenCalled();
  });

  it('jsdom mode (the default) never loads Playwright', async () => {
    playwrightNotInstalled();

    const { violations } = await detectViolations({ componentPath: fixture('MissingAlt.tsx') });

    expect(violations.map((v) => v.id)).toEqual(['image-alt']);
    expect(vi.mocked(importPlaywright)).not.toHaveBeenCalled();
  });

  describe('CLI', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let previousExitCode: typeof process.exitCode;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      previousExitCode = process.exitCode;
    });
    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = previousExitCode;
    });

    it('scan --browser prints the install instructions and exits non-zero', async () => {
      chromiumNotInstalled();

      await runScan(fixture('LowContrastText.tsx'), { browser: true });

      expect(process.exitCode).toBe(1);
      const errors = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(errors).toContain('npx playwright install chromium');
      expect(errors).not.toContain('Could not read path');
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
