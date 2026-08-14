/**
 * detect/ — runs axe-core against rendered components and reports WCAG
 * violations. This is the entry point of the pipeline: its output feeds
 * context/, and its verdict format is reused by verify/ to confirm a fix
 * actually resolved the violation.
 *
 * This module itself is framework-agnostic: it knows how to run axe-core
 * against a mounted DOM container and shape the results, but never
 * compiles or mounts a component itself. All framework-specific work
 * (React/esbuild+testing-library, Vue/@vue/compiler-sfc) lives behind the
 * `RenderAdapter` interface in adapters/ — adding Svelte support later
 * means writing a new adapter and adding it to `ADAPTERS` below, with no
 * changes needed here or in context/generate/verify.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { Result as AxeResult, NodeResult as AxeApiNodeResult } from 'axe-core';
import axe from 'axe-core';
import { JSDOM } from 'jsdom';

import { reactRenderAdapter } from './adapters/react';
import type { RenderAdapter, RenderOptions } from './adapters/types';
import { vueRenderAdapter } from './adapters/vue';

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

/**
 * Adapters are tried in order; the first one whose `supports()` accepts
 * the component's file extension handles rendering it.
 */
const ADAPTERS: RenderAdapter[] = [reactRenderAdapter, vueRenderAdapter];

function findAdapter(componentPath: string): RenderAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.supports(componentPath));
  if (!adapter) {
    throw new Error(`No render adapter supports component file "${componentPath}"`);
  }
  return adapter;
}

function isComponentFile(fileName: string): boolean {
  if (!ADAPTERS.some((adapter) => adapter.supports(fileName))) return false;
  if (/\.(test|spec)\./.test(fileName)) return false;
  return true;
}

/**
 * Lists the component file(s) at `componentPath` — itself if it's a file,
 * or every non-test file directly inside it (of a type some registered
 * adapter supports) if it's a directory (non-recursive). Exported so cli/
 * can resolve a scan target into individual files and run the full
 * per-violation pipeline (which needs a specific file, not a directory)
 * against each one.
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

/**
 * Points every global that jsdom + axe-core (and whichever render adapter
 * runs) expect (window, document, navigator, ...) at a fresh jsdom
 * instance for the duration of `fn`, then restores whatever was there
 * before.
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

async function renderAndDetectViolations(options: RenderOptions): Promise<AxeViolation[]> {
  const adapter = findAdapter(options.absolutePath);

  return withJsdomEnvironment(async () => {
    const { container, cleanup } = adapter.render(options);
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
  return renderAndDetectViolations({ absolutePath });
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
  const violations = await renderAndDetectViolations({ absolutePath, source: options.source });
  return { componentPath: absolutePath, violations };
}
