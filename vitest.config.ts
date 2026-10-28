import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Workspace packages (packages/*) run their own `test` script — each
    // has its own vitest config (e.g. vscode-extension's 'vscode' module
    // alias) that this root config doesn't provide. Without this exclude,
    // vitest's default recursive glob picks up their test files too and
    // runs them without that setup, since node_modules is the only
    // directory excluded by default.
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/**'],
    // detect/scan tests render real components (esbuild bundle + jsdom +
    // axe-core). The directory-scan test takes ~2s alone but can exceed
    // vitest's 5s default when every test file runs in parallel. A timed-out
    // test keeps running in the background and leaves axe-core's cached
    // jsdom globals pointing at the wrong window, so the following tests
    // fail with "axe.run arguments are invalid".
    testTimeout: 30_000,
  },
});
