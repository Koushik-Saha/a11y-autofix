/**
 * context/ — gathers the source code and surrounding project context
 * needed to fix a single violation: the offending element (located by
 * parsing the component's AST, not by string-matching source text), its
 * immediate parent and siblings, and any typed prop information. Its
 * output is the prompt material handed to generate/.
 *
 * This module itself is framework-agnostic: it knows how to turn a
 * `FrameworkElementContext` into a `FixContext`, but never parses an AST
 * directly. All framework-specific work (React/ts-morph, Vue/
 * @vue/compiler-sfc) lives behind the `FrameworkAdapter` interface in
 * adapters/ — adding Svelte support later means writing a new adapter and
 * adding it to `ADAPTERS` below, with no changes needed here or in
 * detect/generate/verify.
 */

import path from 'node:path';

import { reactAdapter } from './adapters/react';
import type { FrameworkAdapter, JsxElementSnapshot } from './adapters/types';
import { vueAdapter } from './adapters/vue';
import type { AxeViolation } from '../detect';

export type { JsxElementSnapshot, JsxSourceLocation, FrameworkAdapter } from './adapters/types';

export interface FixContext {
  violation: AxeViolation;
  componentPath: string;
  sourceCode: string;
  relatedFiles: string[];
  element: JsxElementSnapshot;
  parent: JsxElementSnapshot | null;
  siblings: JsxElementSnapshot[];
  propTypes: string | null;
}

export interface GatherContextOptions {
  violation: AxeViolation;
  componentPath: string;
}

/**
 * Adapters are tried in order; the first one whose `supports()` accepts
 * the component's file extension handles the violation.
 */
const ADAPTERS: FrameworkAdapter[] = [reactAdapter, vueAdapter];

function findAdapter(componentPath: string): FrameworkAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.supports(componentPath));
  if (!adapter) {
    throw new Error(`No framework adapter supports component file "${componentPath}"`);
  }
  return adapter;
}

export async function gatherContext(options: GatherContextOptions): Promise<FixContext> {
  const { violation } = options;
  const violationNode = violation.nodes[0];
  if (!violationNode) {
    throw new Error(`Violation "${violation.id}" has no offending nodes to locate`);
  }

  const absoluteComponentPath = path.resolve(options.componentPath);
  const adapter = findAdapter(absoluteComponentPath);
  const elementContext = adapter.gatherElementContext({
    componentPath: absoluteComponentPath,
    violationNode,
  });

  return {
    violation,
    componentPath: absoluteComponentPath,
    relatedFiles: [],
    ...elementContext,
  };
}
