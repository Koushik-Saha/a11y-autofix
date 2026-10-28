import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    alias: [
      { find: /^vscode$/, replacement: path.resolve(__dirname, 'test/vscode-mock.ts') },
      // Point the root package at its TypeScript source rather than its
      // package.json exports (./dist/index.js), so the tests run against
      // source and work on a fresh clone where dist/ hasn't been built.
      { find: /^a11y-autofix$/, replacement: path.resolve(__dirname, '../../src/index.ts') },
    ],
  },
});
