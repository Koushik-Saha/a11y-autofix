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
import type { ResolvedSourceContext } from './resolve';

export type { ResolvedHandler, ResolvedSourceContext, ResolvedValue } from './resolve';

export interface JsxSourceLocation {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /**
   * 0-based offset of the element's first character in the file's text
   * exactly as `fs.readFileSync(path, 'utf8')` returns it (a leading BOM
   * counts as one character) — so `text.slice(startOffset, endOffset)`
   * is the element's `code`. This is what a Patch records as its
   * `position`, which verify/ uses to patch this element and not an
   * identical one elsewhere in the file.
   */
  startOffset: number;
  /** 0-based offset just past the element's last character (exclusive). */
  endOffset: number;
}

/** A half-open `[start, end)` range of character offsets into a file's text. */
export interface SourceRange {
  start: number;
  end: number;
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
  /**
   * What the element's dynamic props resolve to — constant values and
   * event handler bodies, read statically from this file and its local
   * imports (see resolve.ts). Absent when nothing resolved.
   */
  resolved?: ResolvedSourceContext;
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
  /**
   * Locates each axe-core node's element in `source` (text supplied by
   * the caller, not read from disk — verify/ uses this on patched source
   * that only exists in memory) with the same structural matching as
   * `gatherElementContext`. An entry is null when that node can't be
   * located unambiguously; this never throws for a single bad node.
   */
  locateElements(options: LocateElementsOptions): (SourceRange | null)[];
}

export interface LocateElementsOptions {
  /** Absolute path the source belongs to — used for parsing (file type) and error messages only. */
  componentPath: string;
  source: string;
  nodes: AxeNodeResult[];
}
