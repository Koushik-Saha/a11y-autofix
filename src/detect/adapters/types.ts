/**
 * adapters/ — the framework boundary inside detect/, mirroring
 * context/adapters/'s split. Everything outside this directory (the rest
 * of detect/, plus context/, generate/, verify/, scan.ts) is
 * framework-agnostic; a `RenderAdapter` is the only thing that's allowed
 * to know how to compile and mount a specific UI framework's component
 * into a DOM container. Adding Svelte support later means writing a new
 * adapter and registering it in detect/index.ts's `ADAPTERS` list —
 * nothing outside this directory should need to change.
 *
 * This is a separate interface from context/adapters/'s `FrameworkAdapter`
 * (not a shared/extended one) because context/ depends on detect/'s types,
 * not the other way around — see PLAN.md's module-boundaries note.
 */

export interface RenderOptions {
  /** Absolute path to the component file (used to resolve local imports and, when `source` is omitted, read from disk). */
  absolutePath: string;
  /** When provided, this text is compiled/rendered instead of reading `absolutePath` from disk (verify/'s in-memory patch path). */
  source?: string;
}

export interface RenderResult {
  container: Element;
  /** Unmounts/tears down the rendered component. Always called in a `finally`, after axe-core has run against `container`. */
  cleanup: () => void;
}

export interface RenderAdapter {
  /** Short, stable identifier for this adapter (e.g. "react"), used only for diagnostics. */
  readonly id: string;
  /** Whether this adapter knows how to compile/render `componentPath`, typically decided by file extension. */
  supports(componentPath: string): boolean;
  /** Compiles and mounts the component into a fresh DOM container. Must be called inside the shared jsdom environment (see detect/index.ts's `withJsdomEnvironment`). */
  render(options: RenderOptions): RenderResult;
}
