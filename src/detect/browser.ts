/**
 * detect/browser.ts — the real-browser detection path (`scan --browser`,
 * `scan(path, { browser: true })`). Renders the component in headless
 * Chromium via Playwright and runs axe-core's full default ruleset in the
 * page — including `color-contrast`, which the jsdom path has to disable
 * because jsdom has no layout or paint for axe-core to measure.
 *
 * Compilation reuses each RenderAdapter's esbuild setup
 * (`bundleForBrowser`), and results go through the same `toAxeViolation`
 * mapping as the jsdom path, so callers get identical `AxeViolation`s.
 *
 * There is deliberately no fallback to jsdom: if Playwright or Chromium is
 * missing, this throws `BrowserUnavailableError`. Silently scanning in
 * jsdom instead would silently skip contrast — the gap this path exists
 * to close.
 */

import type { Result as AxeResult } from 'axe-core';
import axe from 'axe-core';
import type { Browser } from 'playwright';

import { CONTAINER_GLOBAL, MOUNT_ERROR_GLOBAL } from './adapters/browser-bundle';
import type { RenderAdapter, RenderOptions } from './adapters/types';
import { importPlaywright } from './playwright';

/** Thrown when `--browser` was requested but Playwright or its Chromium can't be used. */
export class BrowserUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserUnavailableError';
  }
}

const NO_FALLBACK_NOTE =
  'Scanning without --browser uses jsdom, which cannot check color-contrast.';

function firstLine(error: unknown): string {
  return String((error as Error)?.message ?? error).split('\n')[0] ?? '';
}

function isModuleNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
}

async function launchChromium(): Promise<Browser> {
  let playwright: typeof import('playwright');
  try {
    playwright = await importPlaywright();
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw new BrowserUnavailableError(
        '--browser needs Playwright, which is not installed. Install it and its Chromium build with:\n' +
          '  npm install --save-dev playwright\n' +
          '  npx playwright install chromium\n' +
          NO_FALLBACK_NOTE,
        { cause: error },
      );
    }
    throw new BrowserUnavailableError(
      `--browser could not load Playwright: ${firstLine(error)}\n${NO_FALLBACK_NOTE}`,
      { cause: error },
    );
  }

  try {
    return await playwright.chromium.launch({ headless: true });
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (message.includes("Executable doesn't exist")) {
      throw new BrowserUnavailableError(
        "--browser needs Playwright's Chromium build, which is not installed. Install it with:\n" +
          '  npx playwright install chromium\n' +
          '(on a Linux CI runner: npx playwright install --with-deps chromium)\n' +
          NO_FALLBACK_NOTE,
        { cause: error },
      );
    }
    throw new BrowserUnavailableError(
      `--browser could not launch headless Chromium: ${firstLine(error)}\n` +
        'On Linux, its system libraries can be installed with: npx playwright install-deps chromium\n' +
        NO_FALLBACK_NOTE,
      { cause: error },
    );
  }
}

/**
 * One Chromium instance shared by every detect call made while a session
 * is open, so a scan doesn't launch a browser per render (verify/ renders
 * twice per fix attempt). Reference-counted: the browser closes when the
 * last user finishes, so nothing keeps the process alive afterwards.
 */
interface SharedBrowser {
  browser: Promise<Browser>;
  users: number;
}

let shared: SharedBrowser | null = null;

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  if (!shared) {
    shared = { browser: launchChromium(), users: 0 };
    // Rejections are surfaced to every awaiting caller below; this only
    // stops Node reporting the shared promise itself as unhandled.
    shared.browser.catch(() => {});
  }
  const session = shared;
  session.users += 1;
  try {
    return await fn(await session.browser);
  } finally {
    session.users -= 1;
    if (session.users === 0) {
      if (shared === session) shared = null;
      const browser = await session.browser.catch(() => null);
      await browser?.close();
    }
  }
}

/**
 * Keeps one Chromium open for the duration of `fn`, so every browser-mode
 * detect call inside it (including verify/'s) reuses it. Launches up
 * front, so a missing Playwright/Chromium fails before any work starts.
 */
export function withBrowserSession<T>(fn: () => Promise<T>): Promise<T> {
  return withBrowser(() => fn());
}

const PAGE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>a11y-autofix</title></head><body></body></html>';

type MountOutcome = { ok: true } | { ok: false; error: string };

/**
 * Renders the component in a fresh page and returns axe-core's raw
 * violations, plus its "needs review" (incomplete) results for any rule in
 * `reviewRules`.
 */
export async function runAxeInBrowser(
  adapter: RenderAdapter,
  options: RenderOptions,
  reviewRules: readonly string[] = [],
): Promise<{ violations: AxeResult[]; incomplete: AxeResult[] }> {
  const bundle = await adapter.bundleForBrowser(options);

  return withBrowser(async (browser) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // Keep scans hermetic: a component's remote images/fonts/APIs are
      // never fetched. Contrast is computed from CSS colors, not from
      // loaded image pixels (axe-core reports text over images as
      // "needs review" either way).
      await page.route('**/*', (route) => route.abort());
      await page.setContent(PAGE_HTML);
      await page.addScriptTag({ content: bundle });

      const outcome = await page.evaluate(
        ({ containerKey, errorKey }): MountOutcome => {
          const win = globalThis as unknown as Record<string, unknown>;
          if (typeof win[errorKey] === 'string') return { ok: false, error: win[errorKey] };
          if (!win[containerKey]) return { ok: false, error: 'mount script did not run' };
          return { ok: true };
        },
        { containerKey: CONTAINER_GLOBAL, errorKey: MOUNT_ERROR_GLOBAL },
      );
      if (!outcome.ok) {
        throw new Error(
          `Failed to render ${options.absolutePath} in Chromium: ${outcome.error.split('\n')[0]}`,
        );
      }

      await page.addScriptTag({ content: axe.source });
      return await page.evaluate(
        async ({ containerKey, reviewRules }) => {
          const win = globalThis as unknown as Record<string, unknown>;
          const pageAxe = win.axe as typeof axe;
          // Full default ruleset — nothing disabled, unlike the jsdom path.
          const results = await pageAxe.run(win[containerKey] as Parameters<typeof axe.run>[0], {
            resultTypes: reviewRules.length > 0 ? ['violations', 'incomplete'] : ['violations'],
          });
          const serialize = (violation: (typeof results.violations)[number]) => ({
            id: violation.id,
            impact: violation.impact,
            tags: violation.tags,
            description: violation.description,
            help: violation.help,
            helpUrl: violation.helpUrl,
            nodes: violation.nodes.map((node) => ({
              target: node.target,
              html: node.html,
              failureSummary: node.failureSummary,
              any: [],
              all: [],
              none: [],
            })),
          });
          return {
            violations: results.violations.map(serialize) as AxeResult[],
            incomplete: results.incomplete
              .filter((result) => reviewRules.includes(result.id))
              .map(serialize) as AxeResult[],
          };
        },
        { containerKey: CONTAINER_GLOBAL, reviewRules: [...reviewRules] },
      );
    } finally {
      await context.close();
    }
  });
}

/**
 * Loads a complete HTML document (no component, no bundle) and returns
 * axe-core's violations for the whole page, full default ruleset. Every
 * network request is blocked, so a document that depends on external
 * assets is checked without them.
 */
export async function runAxeOnDocumentInBrowser(html: string): Promise<AxeResult[]> {
  return withBrowser(async (browser) => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(html);
      await page.addScriptTag({ content: axe.source });
      return await page.evaluate(async () => {
        const pageAxe = (globalThis as unknown as Record<string, unknown>).axe as typeof axe;
        const results = await pageAxe.run(document, { resultTypes: ['violations'] });
        return results.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          tags: violation.tags,
          description: violation.description,
          help: violation.help,
          helpUrl: violation.helpUrl,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            html: node.html,
            failureSummary: node.failureSummary,
            any: [],
            all: [],
            none: [],
          })),
        })) as AxeResult[];
      });
    } finally {
      await context.close();
    }
  });
}
