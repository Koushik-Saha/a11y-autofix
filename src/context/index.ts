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
import type { FrameworkAdapter, JsxElementSnapshot, ResolvedSourceContext } from './adapters/types';
import { vueAdapter } from './adapters/vue';
import type { AxeViolation } from '../detect';
import type { LocateElementsOptions, SourceRange } from './adapters/types';

export type {
  JsxElementSnapshot,
  JsxSourceLocation,
  FrameworkAdapter,
  LocateElementsOptions,
  IdAttribute,
  ResolvedHandler,
  ResolvedSourceContext,
  ResolvedValue,
  SourceRange,
} from './adapters/types';
import type { IdAttribute } from './adapters/types';

/**
 * What a `label` fix needs to add a real `<label>`: the input's id (or
 * that it has none, so the fix must add one), ids it must not reuse, the
 * attribute that points a label at it, and whether a sibling can go next
 * to it at all.
 */
export interface LabelTargetContext {
  id: IdAttribute;
  /** Literal ids on other elements in this file. Components it renders may add more that aren't visible here. */
  idsInFile: string[];
  /** `htmlFor` in JSX, `for` in a Vue template. */
  forAttribute: 'htmlFor' | 'for';
  canInsertSibling: boolean;
}

export interface FixContext {
  violation: AxeViolation;
  componentPath: string;
  sourceCode: string;
  relatedFiles: string[];
  element: JsxElementSnapshot;
  parent: JsxElementSnapshot | null;
  siblings: JsxElementSnapshot[];
  propTypes: string | null;
  /**
   * Best-effort, purely static resolution of the element's dynamic props:
   * constant values (`src={avatarUrl}` → the string) and event handler
   * bodies, from this file and its relatively-imported local files.
   * Absent when nothing could be resolved — never a guess.
   */
  resolved?: ResolvedSourceContext;
  /** Present only for `label` violations. */
  labelTarget?: LabelTargetContext;
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
  const { facts, ...elementContext } = adapter.gatherElementContext({
    componentPath: absoluteComponentPath,
    violationNode,
  });

  return {
    violation,
    componentPath: absoluteComponentPath,
    relatedFiles: [],
    ...elementContext,
    ...(violation.id === 'label'
      ? {
          labelTarget: {
            ...facts,
            forAttribute: adapter.id === 'vue' ? ('for' as const) : ('htmlFor' as const),
          },
        }
      : {}),
  };
}

/**
 * Where each axe-core node's element sits in `source`, located the same
 * structural way `gatherContext` locates one; null for a node that can't
 * be located unambiguously. verify/ uses this to tell which violations a
 * patch is responsible for.
 */
export function locateElements(options: LocateElementsOptions): (SourceRange | null)[] {
  const absoluteComponentPath = path.resolve(options.componentPath);
  return findAdapter(absoluteComponentPath).locateElements({
    ...options,
    componentPath: absoluteComponentPath,
  });
}
