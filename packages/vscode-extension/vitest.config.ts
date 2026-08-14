import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    alias: {
      vscode: path.resolve(__dirname, 'test/vscode-mock.ts'),
    },
  },
});
