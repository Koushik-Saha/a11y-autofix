/**
 * detect/ — runs axe-core against rendered React components and reports
 * WCAG violations. This is the entry point of the pipeline: its output
 * feeds context/, and its verdict format is reused by verify/ to confirm
 * a fix actually resolved the violation.
 */

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Result as AxeResult, NodeResult as AxeApiNodeResult } from 'axe-core';
import axe from 'axe-core';
import { buildSync } from 'esbuild';
import * as React from 'react';
import { cleanup, render } from '@testing-library/react';
import { JSDOM } from 'jsdom';

export interface AxeNodeResult {
  target: string[];
  html: string;
  failureSummary?: string;
}

export interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeNodeResult[];
}

export interface DetectOptions {
  componentPath: string;
}

export interface DetectResult {
  componentPath: string;
  violations: AxeViolation[];
}

const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx']);

function isComponentFile(fileName: string): boolean {
  const ext = path.extname(fileName);
  if (!COMPONENT_EXTENSIONS.has(ext)) return false;
  if (/\.(test|spec)\./.test(fileName)) return false;
  return true;
}

/**
 * Lists the component file(s) at `componentPath` — itself if it's a file,
 * or every non-test `.tsx`/`.jsx` file directly inside it if it's a
 * directory (non-recursive). Exported so cli/ can resolve a scan target
 * into individual files and run the full per-violation pipeline (which
 * needs a specific file, not a directory) against each one.
 */
export function resolveComponentFiles(componentPath: string): string[] {
  const stats = statSync(componentPath);
  if (stats.isFile()) {
    return [componentPath];
  }
  return readdirSync(componentPath)
    .filter(isComponentFile)
    .map((entry) => path.join(componentPath, entry))
    .sort();
}

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
function loadComponentModule(options: { absolutePath: string; source?: string }): unknown {
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

/**
 * Points every global that jsdom + @testing-library/react + axe-core expect
 * (window, document, navigator, ...) at a fresh jsdom instance for the
 * duration of `fn`, then restores whatever was there before.
 *
 * Only copies keys that don't already exist on globalThis (plus window,
 * document, and navigator, which are always forced). jsdom's `window` is a
 * full separate realm and carries its own copies of ordinary JS builtins
 * (Array, Math, JSON, Infinity, ...); blindly copying every own property
 * would clobber Node's versions of those (some of which are non-writable,
 * so restoring them afterward throws) and cross wires between the two
 * realms' prototypes.
 */
async function withJsdomEnvironment<T>(fn: () => Promise<T>): Promise<T> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const windowRecord = window as unknown as Record<string, unknown>;

  const globalTarget = globalThis as unknown as Record<string, unknown>;
  const forcedKeys = ['window', 'document', 'navigator'];
  const newKeys = Object.getOwnPropertyNames(window).filter(
    (key) => !key.startsWith('_') && !forcedKeys.includes(key) && !(key in globalTarget),
  );
  const installedKeys = [...newKeys, ...forcedKeys];

  const restore = new Map<string, { had: boolean; value: unknown }>();
  for (const key of installedKeys) {
    restore.set(key, { had: key in globalTarget, value: globalTarget[key] });
  }
  for (const key of installedKeys) {
    try {
      globalTarget[key] = windowRecord[key];
    } catch {
      // Some window properties are non-configurable accessors; skip those.
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, previous] of restore) {
      try {
        if (previous.had) {
          globalTarget[key] = previous.value;
        } else {
          delete globalTarget[key];
        }
      } catch {
        // Leave in place if the property turned out to be non-configurable.
      }
    }
    dom.window.close();
  }
}

function flattenTarget(target: unknown): string[] {
  if (Array.isArray(target)) {
    return target.flatMap((entry) => flattenTarget(entry));
  }
  return [String(target)];
}

function toAxeNodeResult(node: AxeApiNodeResult): AxeNodeResult {
  const result: AxeNodeResult = {
    target: flattenTarget(node.target),
    html: node.html,
  };
  if (node.failureSummary) {
    result.failureSummary = node.failureSummary;
  }
  return result;
}

function toAxeViolation(violation: AxeResult): AxeViolation {
  return {
    id: violation.id,
    impact: (violation.impact ?? null) as AxeViolation['impact'],
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.map(toAxeNodeResult),
  };
}

async function renderAndDetectViolations(componentModule: unknown): Promise<AxeViolation[]> {
  const Component = resolveDefaultExport(componentModule);

  return withJsdomEnvironment(async () => {
    const { container } = render(React.createElement(Component));
    try {
      // color-contrast needs real layout/rendering (canvas, computed
      // paint), which jsdom can't provide; axe-core's own docs recommend
      // disabling it in jsdom-based test environments.
      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      });
      return results.violations.map(toAxeViolation);
    } finally {
      cleanup();
    }
  });
}

async function detectViolationsInFile(filePath: string): Promise<AxeViolation[]> {
  const absolutePath = path.resolve(filePath);
  return renderAndDetectViolations(loadComponentModule({ absolutePath }));
}

export async function detectViolations(options: DetectOptions): Promise<DetectResult> {
  const files = resolveComponentFiles(options.componentPath);
  const violations: AxeViolation[] = [];

  for (const file of files) {
    violations.push(...(await detectViolationsInFile(file)));
  }

  return { componentPath: options.componentPath, violations };
}

export interface DetectInSourceOptions {
  source: string;
  filePath: string;
}

/**
 * Same rendering + axe-core pipeline as `detectViolations`, but takes
 * component source text directly instead of reading `filePath` from disk.
 * `filePath` is still used to resolve local imports and to label the
 * result — the text itself is never written anywhere. This is what
 * verify/ uses to check a patched component without touching the original
 * file.
 */
export async function detectViolationsInSource(
  options: DetectInSourceOptions,
): Promise<DetectResult> {
  const absolutePath = path.resolve(options.filePath);
  const violations = await renderAndDetectViolations(
    loadComponentModule({ absolutePath, source: options.source }),
  );
  return { componentPath: absolutePath, violations };
}
