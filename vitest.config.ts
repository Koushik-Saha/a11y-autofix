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
  },
});
