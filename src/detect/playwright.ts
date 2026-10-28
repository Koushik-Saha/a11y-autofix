/**
 * playwright.ts — the single place that loads Playwright. It is an
 * optional peer dependency (only `--browser` needs it), so it's imported
 * lazily rather than at the top of detect/. Kept in its own module so
 * tests can simulate Playwright being missing.
 */

export function importPlaywright(): Promise<typeof import('playwright')> {
  return import('playwright');
}
