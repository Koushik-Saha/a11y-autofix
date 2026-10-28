/**
 * Whether Playwright's headless Chromium can actually launch here. Browser
 * tests use `describe.runIf(chromiumAvailable)` so a local checkout
 * without `npx playwright install chromium` still runs everything else.
 *
 * CI sets A11Y_AUTOFIX_REQUIRE_BROWSER=1, which turns "not available" into
 * a hard failure — so the browser tests can never be silently skipped
 * there.
 */

async function canLaunchChromium(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error).split('\n')[0] ?? '' };
  }
}

const probe = await canLaunchChromium();

if (!probe.ok && process.env.A11Y_AUTOFIX_REQUIRE_BROWSER) {
  throw new Error(
    `A11Y_AUTOFIX_REQUIRE_BROWSER is set but Chromium can't launch: ${probe.reason}. Run: npx playwright install chromium`,
  );
}

export const chromiumAvailable = probe.ok;
