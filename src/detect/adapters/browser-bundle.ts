/**
 * adapters/browser-bundle.ts — the esbuild step behind every adapter's
 * `bundleForBrowser()`. The jsdom path bundles a component to CommonJS and
 * `require`s it in Node; the real-browser path (`--browser`) needs the
 * same component bundled for a browser instead, plus a small
 * framework-specific "mount" entry that renders it.
 *
 * The component is exposed to the mount entry as the virtual module
 * `a11y-autofix:component`, served from `RenderOptions.source` when given
 * (verify/'s in-memory patch path) or the file on disk otherwise. Its
 * imports still resolve against the component's real directory, exactly
 * like the jsdom path. Nothing is written to disk.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';
import type { Loader, Plugin } from 'esbuild';

import type { RenderOptions } from './types';

export const COMPONENT_MODULE_ID = 'a11y-autofix:component';

/** Globals the mount entry sets; read back by detect/browser.ts. */
export const CONTAINER_GLOBAL = '__a11yAutofixContainer';
export const MOUNT_ERROR_GLOBAL = '__a11yAutofixMountError';

/**
 * JS (as a string) for the start of a mount entry: creates the container
 * the same way @testing-library/react does in jsdom (a plain `<div>`
 * appended to `<body>`) and a helper that records a mount failure.
 */
export const MOUNT_PRELUDE = `
const container = document.createElement('div');
document.body.appendChild(container);
let mountError = null;
const recordMountError = (error) => {
  if (mountError === null) mountError = error && error.stack ? String(error.stack) : String(error);
};
`;

/** JS (as a string) for the end of a mount entry: publishes the outcome. */
export const MOUNT_EPILOGUE = `
if (mountError !== null) {
  window.${MOUNT_ERROR_GLOBAL} = mountError;
} else {
  window.${CONTAINER_GLOBAL} = container;
}
`;

export interface BrowserBundleOptions {
  render: RenderOptions;
  /** ESM source of the mount entry. Imports the component from `COMPONENT_MODULE_ID`. */
  mountSource: string;
  /** The component module's contents. Defaults to `render.source`, then the file on disk. */
  componentContents?: string;
  componentLoader: Loader;
  /** Extra compile-time constants (e.g. Vue's feature flags). */
  define?: Record<string, string>;
}

function componentModulePlugin(options: BrowserBundleOptions): Plugin {
  const { absolutePath, source } = options.render;
  return {
    name: 'a11y-autofix-component',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^a11y-autofix:component$/ }, () => ({
        path: absolutePath,
        namespace: 'a11y-autofix-component',
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: 'a11y-autofix-component' }, () => ({
        contents: options.componentContents ?? source ?? readFileSync(absolutePath, 'utf8'),
        loader: options.componentLoader,
        resolveDir: path.dirname(absolutePath),
      }));
    },
  };
}

export async function bundleForBrowser(options: BrowserBundleOptions): Promise<string> {
  const { absolutePath } = options.render;
  const result = await build({
    stdin: {
      contents: options.mountSource,
      resolveDir: path.dirname(absolutePath),
      sourcefile: 'a11y-autofix-mount.js',
      loader: 'js',
    },
    plugins: [componentModulePlugin(options)],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    jsx: 'automatic',
    jsxImportSource: 'react',
    absWorkingDir: path.dirname(absolutePath),
    logLevel: 'silent',
    define: {
      'process.env.NODE_ENV': '"production"',
      ...options.define,
    },
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild produced no browser bundle for ${absolutePath}`);
  }
  return output.text;
}
