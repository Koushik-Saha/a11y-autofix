/**
 * page/ — whole-page scanning of a live or local URL (`scan-url`). Loads
 * the page in headless Chromium, waits for the network to go idle plus a
 * settle delay, and runs axe-core's WCAG 2.0–2.2 A/AA rules and best
 * practices over the whole document, including the document-level rules
 * component mode can't check (`html-has-lang`, `document-title`, `bypass`,
 * `page-has-heading-one`, landmarks). Results are grouped by rule.
 *
 * Reports only: page mode never generates fixes (a live page has no
 * component source to patch). Component mode (`scan`) fixes.
 *
 * Safety: http(s) only; every request the page makes goes through a
 * filtering proxy that refuses private, loopback and link-local
 * addresses (see guard.ts and proxy.ts), unless the caller allowlists a
 * host. No clicking or typing: the only interaction is optional scrolling
 * to trigger lazy-loaded content.
 */

import axe from 'axe-core';
import type { Page } from 'playwright';

import { withBrowser } from '../detect/browser';
import { wcagInfo } from '../report/items';
import type { Impact } from '../report/items';

import { createEgressGuard } from './guard';
import type { Lookup } from './guard';
import { startEgressProxy } from './proxy';
import type { BlockedRequest } from './proxy';

export { createEgressGuard, isBlockedAddress } from './guard';
export type { BlockedRequest } from './proxy';

/** axe-core tags page mode runs: WCAG 2.0, 2.1 and 2.2 at levels A and AA, plus best practices (headings, landmarks). */
export const PAGE_RULE_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
];

export const PAGE_MODE_NOTE =
  'Page mode reports issues only: no fixes are generated. To get verified fixes, scan the components that render this page with `a11y-autofix scan`.';

const IMPACT_ORDER: readonly Impact[] = ['critical', 'serious', 'moderate', 'minor'];

/** Refused before anything is loaded: a non-http(s) URL, or a host the SSRF guard blocks. */
export class UrlNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlNotAllowedError';
  }
}

export class PageScanTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageScanTimeoutError';
  }
}

export interface ScanUrlOptions {
  /** Overall budget for loading, waiting and checking, in ms. Default 30000. */
  timeoutMs?: number;
  /** Extra wait after the network goes idle, for late rendering, in ms. Default 1000. */
  settleMs?: number;
  /** Scroll through the page (and back) before checking, to trigger lazy-loaded content. */
  scroll?: boolean;
  /**
   * Hosts the scan may reach even though they're private or loopback, as
   * `host` or `host:port` — e.g. `localhost:3000` to scan a dev server.
   * Only these; everything else private stays blocked.
   */
  allowHosts?: string[];
  /** DNS resolver for the SSRF guard; defaults to the system's. For tests. */
  lookup?: Lookup;
}

export interface PageElement {
  /** axe-core's CSS selector for the element. */
  selector: string;
  /** The element's outer HTML as rendered (truncated by axe-core for large elements). */
  html: string;
  failureSummary: string | null;
}

/** One failing rule, with every element that fails it. */
export interface PageViolation {
  ruleId: string;
  impact: Impact | null;
  help: string;
  description: string;
  helpUrl: string;
  wcag: { criteria: string[]; levels: string[] };
  bestPractice: boolean;
  elementCount: number;
  elements: PageElement[];
}

export interface PageScanResult {
  mode: 'page';
  /** The URL asked for. */
  url: string;
  /** Where the page ended up after redirects. */
  finalUrl: string;
  /** HTTP status of the page's response, when there was one. */
  httpStatus: number | null;
  title: string | null;
  scannedAt: string;
  /** axe-core tags that were run. */
  ruleTags: string[];
  /** Always false: page mode reports, it never fixes. */
  fixesGenerated: false;
  note: string;
  /** Whether the network went idle before the settle delay (a page that keeps polling may never). */
  networkIdle: boolean;
  /** Requests the SSRF guard refused (subresources, redirects), with why. */
  blockedRequests: BlockedRequest[];
  /** Grouped by rule, most severe first, then most elements. */
  violations: PageViolation[];
  totals: { rules: number; elements: number; elementsByImpact: Record<Impact | 'unknown', number> };
}

function deadline(timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  return {
    remaining: () => Math.max(1, end - Date.now()),
    expired: () => Date.now() >= end,
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PageScanTimeoutError(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Scrolls down a viewport at a time to the bottom (bounded), then back to the top. No clicks. */
async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
    for (let step = 0; step < 50; step += 1) {
      const before = window.scrollY;
      window.scrollBy(0, window.innerHeight);
      await pause();
      if (window.scrollY === before) break;
    }
    window.scrollTo(0, 0);
    await pause();
  });
}

function group(results: axe.Result[]): PageViolation[] {
  return results
    .map((result): PageViolation => {
      const wcag = wcagInfo(result.id);
      return {
        ruleId: result.id,
        impact: (result.impact ?? null) as Impact | null,
        help: result.help,
        description: result.description,
        helpUrl: result.helpUrl,
        wcag: { criteria: wcag.criteria, levels: wcag.levels },
        bestPractice: wcag.bestPractice,
        elementCount: result.nodes.length,
        elements: result.nodes.map((node) => ({
          selector: node.target.map(String).join(' '),
          html: node.html,
          failureSummary: node.failureSummary ?? null,
        })),
      };
    })
    .sort((a, b) => {
      const rank = (v: PageViolation) =>
        v.impact ? IMPACT_ORDER.indexOf(v.impact) : IMPACT_ORDER.length;
      return (
        rank(a) - rank(b) || b.elementCount - a.elementCount || a.ruleId.localeCompare(b.ruleId)
      );
    });
}

/** Loopback and private-LAN hosts, where a local dev server might run. */
const DEV_SERVER_HOST =
  /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

/** Throws `UrlNotAllowedError` unless `url` is http(s) and its host passes the guard. */
async function assertScannable(
  url: string,
  guard: ReturnType<typeof createEgressGuard>,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlNotAllowedError(`Not a valid URL: "${url}".`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlNotAllowedError(
      `Only http and https URLs can be scanned, not "${parsed.protocol}".`,
    );
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const verdict = await guard.check(parsed.hostname, port);
  if (!verdict.allowed) {
    // Only suggest allowlisting where a dev server plausibly lives —
    // never, say, the cloud metadata address.
    const hint = DEV_SERVER_HOST.test(parsed.hostname)
      ? ` If this is your own local server, allow just that host: --allow-host ${parsed.host}.`
      : '';
    throw new UrlNotAllowedError(`Refusing to scan ${parsed.href}: ${verdict.reason}.${hint}`);
  }
  return parsed;
}

/**
 * Loads `url` in headless Chromium and reports its accessibility
 * violations, grouped by rule. Rejects with `UrlNotAllowedError` for a
 * refused URL (before any browser starts), `BrowserUnavailableError` if
 * Playwright/Chromium isn't installed, and `PageScanTimeoutError` past
 * `timeoutMs`.
 */
export async function scanUrl(url: string, options: ScanUrlOptions = {}): Promise<PageScanResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const settleMs = options.settleMs ?? 1_000;
  const guard = createEgressGuard({
    ...(options.allowHosts ? { allowHosts: options.allowHosts } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  });
  const target = await assertScannable(url, guard);
  const clock = deadline(timeoutMs);
  const proxy = await startEgressProxy(guard);
  const timedOut = (step: string) =>
    `scan-url timed out after ${timeoutMs} ms (${step}). Raise --timeout if the page is slow.`;

  try {
    return await withBrowser(async (browser) => {
      const context = await browser.newContext({
        // `<-loopback>`: Chromium otherwise sends loopback requests
        // directly, skipping the proxy and its checks.
        proxy: { server: proxy.url, bypass: '<-loopback>' },
        // So axe-core can be injected on pages with a strict CSP.
        bypassCSP: true,
        // Service workers could make requests outside the context's proxy.
        serviceWorkers: 'block',
      });
      try {
        const page = await context.newPage();
        let response;
        try {
          response = await page.goto(target.href, {
            waitUntil: 'load',
            timeout: clock.remaining(),
          });
        } catch (error) {
          if ((error as Error).name === 'TimeoutError')
            throw new PageScanTimeoutError(timedOut('loading the page'));
          throw error;
        }
        const finalUrl = page.url();
        const navigationBlock = proxy.blocked.find((entry) => entry.url === finalUrl);
        if (navigationBlock) {
          throw new UrlNotAllowedError(
            `Refusing to scan ${target.href}: it redirected to ${finalUrl}, and ${navigationBlock.reason}.`,
          );
        }

        const networkIdle = await page
          .waitForLoadState('networkidle', { timeout: clock.remaining() })
          .then(
            () => true,
            () => false,
          );
        if (options.scroll && !clock.expired()) {
          await withTimeout(scrollThrough(page), clock.remaining(), timedOut('scrolling'));
          await page
            .waitForLoadState('networkidle', { timeout: clock.remaining() })
            .catch(() => {});
        }
        if (clock.expired())
          throw new PageScanTimeoutError(timedOut('waiting for the page to settle'));
        await page.waitForTimeout(Math.min(settleMs, clock.remaining()));

        await page.addScriptTag({ content: axe.source });
        const results = await withTimeout(
          page.evaluate(async (tags) => {
            const pageAxe = (globalThis as unknown as { axe: typeof axe }).axe;
            const run = await pageAxe.run(document, {
              runOnly: { type: 'tag', values: tags },
              resultTypes: ['violations'],
              // Frames aren't checked (axe-core isn't injected into them).
              iframes: false,
            });
            return run.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              description: v.description,
              helpUrl: v.helpUrl,
              tags: v.tags,
              nodes: v.nodes.map((n) => ({
                target: n.target,
                html: n.html,
                failureSummary: n.failureSummary,
              })),
            }));
          }, PAGE_RULE_TAGS),
          clock.remaining(),
          timedOut('running axe-core'),
        );

        const violations = group(results as unknown as axe.Result[]);
        const elementsByImpact = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
        for (const violation of violations)
          elementsByImpact[violation.impact ?? 'unknown'] += violation.elementCount;

        return {
          mode: 'page' as const,
          url: target.href,
          finalUrl,
          httpStatus: response?.status() ?? null,
          title: (await page.title()) || null,
          scannedAt: new Date().toISOString(),
          ruleTags: [...PAGE_RULE_TAGS],
          fixesGenerated: false as const,
          note: PAGE_MODE_NOTE,
          networkIdle,
          blockedRequests: [...proxy.blocked],
          violations,
          totals: {
            rules: violations.length,
            elements: violations.reduce((sum, v) => sum + v.elementCount, 0),
            elementsByImpact,
          },
        };
      } finally {
        await context.close();
      }
    });
  } finally {
    await proxy.close();
  }
}
