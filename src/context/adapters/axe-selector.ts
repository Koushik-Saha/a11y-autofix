/**
 * axe-selector.ts — parsing helpers for axe-core's own output format
 * (target selectors and raw HTML strings). This is deliberately not
 * React- or Vue-specific: it only ever looks at strings axe-core produces,
 * never at a framework's AST, so every adapter can share it instead of
 * re-implementing the same selector/attribute parsing.
 */

// axe-core's selector segments look like "form", "img", or
// "div:nth-child(2)" — a tag name plus an optional disambiguating
// nth-child. It never includes ids/classes for our purposes since we
// render fixtures with no ids/classes, but the tag/nth-child pair is
// axe's primary disambiguator and is enough to walk a template/JSX tree.
export interface SelectorSegment {
  tagName: string | null;
  nthChild: number | null;
}

export function parseSelector(selector: string): SelectorSegment[] {
  return selector
    .split('>')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((segment) => {
      const nthMatch = segment.match(/:nth-child\((\d+)\)/);
      const tagMatch = segment.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      return {
        tagName: tagMatch ? tagMatch[0].toLowerCase() : null,
        nthChild: nthMatch?.[1] ? Number(nthMatch[1]) : null,
      };
    });
}

/**
 * The element's tag from axe-core's raw HTML (`<input id="x">` → "input").
 * For a target selector with no tag in its last segment — axe uses a bare
 * `#id` for an element whose id is unique — this supplies the tag, and the
 * id itself then picks the element via `parseHtmlAttributes`.
 */
export function tagNameFromHtml(html: string): string | null {
  return /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html)?.[1]?.toLowerCase() ?? null;
}

/**
 * Extracts static name="value" pairs from a single opening tag, e.g.
 * `<input type="text" name="email">`. Used only as a tie-breaker between
 * multiple candidate elements that already match on tag name/position —
 * never as the primary way of locating source, which is driven by AST
 * structure.
 */
export function parseHtmlAttributes(html: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const openingTagMatch = html.match(
    /^<[a-zA-Z][a-zA-Z0-9-]*((?:\s+[^\s=<>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)/,
  );
  if (!openingTagMatch?.[1]) {
    return attrs;
  }

  const attrRegex =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(openingTagMatch[1])) !== null) {
    const name = (match[1] ?? match[3] ?? '').toLowerCase();
    const value = match[2] ?? match[4] ?? '';
    attrs.set(name, value);
  }
  return attrs;
}
