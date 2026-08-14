/**
 * adapters/ — the framework boundary inside context/. Everything upstream
 * (detect/, generate/, verify/, scan.ts) and everything downstream in
 * context/index.ts is framework-agnostic; a `FrameworkAdapter` is the only
 * thing that's allowed to know what "the source" and "an element" mean for
 * a specific UI framework. Adding Vue/Svelte support later means writing a
 * new adapter and registering it in context/index.ts's `ADAPTERS` list —
 * nothing outside this directory should need to change.
 */

import type { AxeNodeResult } from '../../detect';

export interface JsxSourceLocation {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * A framework-agnostic snapshot of one located element: its tag, its exact
 * source text, and where it lives. Despite the "Jsx" prefix (kept for
 * backward compatibility with the pre-adapter API), nothing about this
 * shape is React-specific — a Vue or Svelte adapter produces the same
 * shape from its own template AST.
 */
export interface JsxElementSnapshot {
  tagName: string;
  code: string;
  location: JsxSourceLocation;
}

export interface GatherElementContextOptions {
  /** Absolute path to the component file. */
  componentPath: string;
  /** The specific axe-core node (target selector + raw HTML) to locate. */
  violationNode: AxeNodeResult;
}

/** Everything an adapter can extract by parsing one component's source. */
export interface FrameworkElementContext {
  sourceCode: string;
  element: JsxElementSnapshot;
  parent: JsxElementSnapshot | null;
  siblings: JsxElementSnapshot[];
  propTypes: string | null;
}

/**
 * A `FrameworkAdapter` owns everything about locating and describing an
 * element for one UI framework: parsing source into that framework's AST,
 * matching axe's target selector against it, and walking to
 * parent/siblings/prop types. `context/index.ts` never touches an AST
 * directly — it only ever calls `gatherElementContext` and assembles the
 * result into a `FixContext`.
 */
export interface FrameworkAdapter {
  /** Short, stable identifier for this adapter (e.g. "react"), used only for diagnostics. */
  readonly id: string;
  /** Whether this adapter knows how to parse `componentPath`, typically decided by file extension. */
  supports(componentPath: string): boolean;
  gatherElementContext(options: GatherElementContextOptions): FrameworkElementContext;
}
