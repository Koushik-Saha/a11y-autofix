/**
 * adapters/vue.ts — the `RenderAdapter` for Vue (`.vue` single-file
 * components). Compiles the `<script setup>` block and the `<template>`
 * block separately with `@vue/compiler-sfc` (mirroring what
 * vue-loader/@vitejs/plugin-vue do at build time), stitches them into one
 * component definition, bundles that with esbuild exactly like the React
 * adapter does, then mounts it with Vue's own `createApp().mount()`.
 *
 * Same tradeoff as the React adapter: Vue is bundled in rather than left
 * external, which assumes a single, hoisted `vue` install shared with this
 * package — see PLAN.md's Open Decisions for the React-side version of
 * this same risk, which applies here too.
 *
 * Scope, deliberately: only `<script setup>` (or a plain `<script>` with a
 * `default export {}` shape) components are compiled — Options API
 * components using `props: {...}`/`data()`/etc. compile fine as long as
 * they still export a default object (compileScript handles a plain
 * `<script>` block the same as `<script setup>`), but nothing here
 * special-cases Options API quirks beyond that.
 *
 * `vue` is deliberately never statically imported here (see
 * `requireFreshVue` below) — `@vue/runtime-dom` caches `document` in a
 * module-scope `const` the first time it's required, which would run at
 * process start (well before `withJsdomEnvironment` sets up any jsdom
 * globals) if this were a normal top-level `import`, and then stay wrong
 * — or worse, point at an already-closed jsdom instance — for every
 * subsequent detect call for the rest of the process.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { compileScript, compileTemplate, parse as parseSfc } from '@vue/compiler-sfc';
import { buildSync } from 'esbuild';
import type { Component } from 'vue';

import {
  COMPONENT_MODULE_ID,
  MOUNT_EPILOGUE,
  MOUNT_PRELUDE,
  bundleForBrowser,
} from './browser-bundle';
import type { RenderAdapter, RenderOptions, RenderResult } from './types';

const VUE_EXTENSIONS = new Set(['.vue']);

/**
 * Compiles an SFC's script + template into one module's source text:
 * `const __sfc__ = { ...compiled script... }; __sfc__.render =
 * ...compiled template...;` — the same shape vue-loader/@vitejs/plugin-vue
 * assemble at build time, just produced by hand since we're not running
 * inside either of those build tools. `exportStatement` finishes it off:
 * `module.exports = __sfc__;` for the jsdom path (bundled to CommonJS and
 * `require`d), `export default __sfc__;` for the browser bundle.
 */
function compileVueModuleSource(options: RenderOptions, exportStatement: string): string {
  const { absolutePath, source } = options;
  const sourceText = source ?? readFileSync(absolutePath, 'utf8');
  const { descriptor } = parseSfc(sourceText, { filename: absolutePath });

  // compileTemplate/compileScript don't need this to be globally unique —
  // it's only used for Vue's scoped-CSS hashing, which we never touch.
  const id = path.basename(absolutePath);

  let scriptModuleText: string;
  if (descriptor.script || descriptor.scriptSetup) {
    const scriptResult = compileScript(descriptor, { id });
    // compileScript's `export default ...` shape varies: a plain object
    // literal for JS `<script setup>`, but `_defineComponent({...})` when
    // `defineProps<T>()` is used with a TS type argument. Only the
    // `export default` keyword itself is guaranteed present, so that's all
    // this replaces — whatever expression follows (object literal or a
    // wrapping call) is left intact.
    scriptModuleText = scriptResult.content.replace(/export default\s*/, 'const __sfc__ = ');
    if (!scriptModuleText.includes('const __sfc__')) {
      throw new Error(
        `Could not assemble a component definition from "${absolutePath}"'s <script> block`,
      );
    }
  } else {
    scriptModuleText = 'const __sfc__ = {};';
  }

  if (!descriptor.template) {
    throw new Error(`"${absolutePath}" has no <template> block to render`);
  }
  const templateResult = compileTemplate({
    source: descriptor.template.content,
    filename: absolutePath,
    id,
    compilerOptions: { mode: 'module' },
  });
  if (templateResult.errors.length > 0) {
    throw new Error(
      `Failed to compile <template> in "${absolutePath}": ${templateResult.errors.join('; ')}`,
    );
  }
  const templateModuleText = templateResult.code.replace(
    'export function render',
    'function render',
  );

  return [scriptModuleText, templateModuleText, '__sfc__.render = render;', exportStatement].join(
    '\n',
  );
}

function loadVueComponentModule(options: RenderOptions): unknown {
  const { absolutePath } = options;
  const assembled = compileVueModuleSource(options, 'module.exports = __sfc__;');

  const result = buildSync({
    stdin: {
      contents: assembled,
      resolveDir: path.dirname(absolutePath),
      sourcefile: `${path.basename(absolutePath)}.ts`,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    absWorkingDir: path.dirname(absolutePath),
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild produced no output for ${absolutePath}`);
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'a11y-autofix-vue-'));
  const tempFile = path.join(tempDir, 'component.cjs');
  writeFileSync(tempFile, output.text);

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(tempFile);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Evicts every `vue`/`@vue/*` entry from Node's module cache and requires
 * `vue` fresh, so `@vue/runtime-dom`'s module-scope `document` capture (see
 * file header) re-reads the *current* jsdom global instead of whatever was
 * global the first time this process happened to load `vue`. Must be
 * called from inside `withJsdomEnvironment`, after its globals are set.
 */
function requireFreshVue(): typeof import('vue') {
  for (const resolvedPath of Object.keys(require.cache)) {
    if (/[\\/]node_modules[\\/](@vue[\\/]|vue[\\/])/.test(resolvedPath)) {
      delete require.cache[resolvedPath];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('vue') as typeof import('vue');
}

function renderVue(options: RenderOptions): RenderResult {
  const component = loadVueComponentModule(options);
  const container = document.createElement('div');
  document.body.appendChild(container);

  const { createApp } = requireFreshVue();
  const app = createApp(component as Component);
  // We render without passing real props (there's no caller-supplied
  // instance to source them from — a component is scanned in isolation,
  // same as the React adapter), so Vue's required-prop dev warning would
  // fire on every scan of a typed component. That's expected noise, not a
  // signal, so it's suppressed rather than left to spam scan output.
  app.config.warnHandler = () => {};
  app.mount(container);

  return {
    container,
    cleanup: () => {
      app.unmount();
      container.remove();
    },
  };
}

// Browser counterpart of `renderVue`. The compiled template and this entry
// both import from 'vue', so the bundle holds a single Vue copy (no
// requireFreshVue workaround needed: each page load is a fresh realm).
// errorHandler is what records a failed mount — without it, Vue's
// production build only logs render errors to the console.
const VUE_MOUNT_SOURCE = `
import { createApp } from 'vue';
import Component from '${COMPONENT_MODULE_ID}';
${MOUNT_PRELUDE}
try {
  const app = createApp(Component);
  app.config.warnHandler = () => {};
  app.config.errorHandler = recordMountError;
  app.mount(container);
} catch (error) {
  recordMountError(error);
}
${MOUNT_EPILOGUE}
`;

function bundleVueForBrowser(options: RenderOptions): Promise<string> {
  return bundleForBrowser({
    render: options,
    mountSource: VUE_MOUNT_SOURCE,
    componentContents: compileVueModuleSource(options, 'export default __sfc__;'),
    componentLoader: 'ts',
    // Compile-time flags Vue's esm-bundler build expects a bundler to set.
    define: {
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
}

export const vueRenderAdapter: RenderAdapter = {
  id: 'vue',
  supports(componentPath: string): boolean {
    return VUE_EXTENSIONS.has(path.extname(componentPath));
  },
  render: renderVue,
  bundleForBrowser: bundleVueForBrowser,
};
