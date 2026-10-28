/**
 * adapters/react.ts — the `RenderAdapter` for React (`.tsx`/`.jsx`).
 * Compiles a component (plus its local imports) to a self-contained
 * CommonJS module via esbuild, then mounts it with
 * `@testing-library/react`. For detect/'s real-browser path it bundles the
 * same component for the browser instead and mounts it with
 * `react-dom/client` (see `bundleReactForBrowser`).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSync } from 'esbuild';
import * as React from 'react';
import { cleanup, render } from '@testing-library/react';

import {
  COMPONENT_MODULE_ID,
  MOUNT_EPILOGUE,
  MOUNT_PRELUDE,
  bundleForBrowser,
} from './browser-bundle';
import type { RenderAdapter, RenderOptions, RenderResult } from './types';

const REACT_EXTENSIONS = new Set(['.tsx', '.jsx']);

function loaderForPath(absolutePath: string): 'tsx' | 'jsx' {
  return path.extname(absolutePath) === '.jsx' ? 'jsx' : 'tsx';
}

/**
 * Compiles a component (plus its local imports) to a self-contained
 * CommonJS module via esbuild, so it can be `require`d without the caller
 * needing a build step of their own. Reads from disk unless `source` is
 * given, in which case that text is compiled as if it lived at
 * `absolutePath` — used by verify/ to render a patched component without
 * ever writing it to disk. Either way, imports still resolve against the
 * real directory on disk via `absWorkingDir`/`resolveDir`.
 *
 * React is bundled in (not left external), which assumes a single, hoisted
 * `react` install shared with this package — true here and for typical
 * single-project setups. Scanning a target with its own separately
 * installed React copy could produce a duplicate-React / "invalid hook
 * call" mismatch against the render harness below; that's an open
 * rendering-approach question noted in PLAN.md, not solved here.
 */
function loadComponentModule(options: RenderOptions): unknown {
  const { absolutePath, source } = options;
  const result = buildSync({
    ...(source === undefined
      ? { entryPoints: [absolutePath] }
      : {
          stdin: {
            contents: source,
            resolveDir: path.dirname(absolutePath),
            sourcefile: path.basename(absolutePath),
            loader: loaderForPath(absolutePath),
          },
        }),
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    jsxImportSource: 'react',
    target: 'node18',
    absWorkingDir: path.dirname(absolutePath),
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild produced no output for ${absolutePath}`);
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'a11y-autofix-'));
  const tempFile = path.join(tempDir, 'component.cjs');
  writeFileSync(tempFile, output.text);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(tempFile);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveDefaultExport(componentModule: unknown): React.ComponentType {
  const mod = componentModule as { default?: unknown };
  const candidate = mod.default ?? componentModule;
  if (typeof candidate !== 'function') {
    throw new Error('Component file must have a default export that is a React component');
  }
  return candidate as React.ComponentType;
}

function renderReact(options: RenderOptions): RenderResult {
  const componentModule = loadComponentModule(options);
  const Component = resolveDefaultExport(componentModule);
  const { container } = render(React.createElement(Component));
  return { container, cleanup };
}

// Mirrors `resolveDefaultExport` above. `flushSync` makes the first render
// synchronous, so the DOM is complete before axe-core runs. React 19
// reports uncaught render errors via `onUncaughtError` instead of
// throwing, so that hook is what records a failed mount.
const REACT_MOUNT_SOURCE = `
import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as componentModule from '${COMPONENT_MODULE_ID}';
${MOUNT_PRELUDE}
try {
  const Component = componentModule.default ?? componentModule;
  if (typeof Component !== 'function') {
    throw new Error('Component file must have a default export that is a React component');
  }
  const root = createRoot(container, { onUncaughtError: recordMountError });
  flushSync(() => root.render(React.createElement(Component)));
} catch (error) {
  recordMountError(error);
}
${MOUNT_EPILOGUE}
`;

function bundleReactForBrowser(options: RenderOptions): Promise<string> {
  return bundleForBrowser({
    render: options,
    mountSource: REACT_MOUNT_SOURCE,
    componentLoader: loaderForPath(options.absolutePath),
  });
}

export const reactRenderAdapter: RenderAdapter = {
  id: 'react',
  supports(componentPath: string): boolean {
    return REACT_EXTENSIONS.has(path.extname(componentPath));
  },
  render: renderReact,
  bundleForBrowser: bundleReactForBrowser,
};
