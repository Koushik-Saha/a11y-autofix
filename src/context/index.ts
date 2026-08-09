/**
 * context/ — gathers the source code and surrounding project context
 * needed to fix a single violation: the offending JSX element (located by
 * parsing the component's AST, not by string-matching source text), its
 * immediate parent and siblings, and any TypeScript prop types. Its output
 * is the prompt material handed to generate/.
 */

import path from 'node:path';

import type { JsxElement, JsxSelfClosingElement, SourceFile } from 'ts-morph';
import { Node, Project, SyntaxKind } from 'ts-morph';

import type { AxeNodeResult, AxeViolation } from '../detect';

type JsxElementLike = JsxElement | JsxSelfClosingElement;

export interface JsxSourceLocation {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface JsxElementSnapshot {
  tagName: string;
  code: string;
  location: JsxSourceLocation;
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
}

export interface GatherContextOptions {
  violation: AxeViolation;
  componentPath: string;
}

// axe-core's selector segments look like "form", "img", or
// "div:nth-child(2)" — a tag name plus an optional disambiguating
// nth-child. It never includes ids/classes for our purposes since we
// render fixtures with no ids/classes, but the tag/nth-child pair is
// axe's primary disambiguator and is enough to walk the JSX tree.
interface SelectorSegment {
  tagName: string | null;
  nthChild: number | null;
}

function parseSelector(selector: string): SelectorSegment[] {
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

function getTagName(node: Node): string {
  if (Node.isJsxElement(node)) {
    return node.getOpeningElement().getTagNameNode().getText();
  }
  if (Node.isJsxSelfClosingElement(node)) {
    return node.getTagNameNode().getText();
  }
  return 'Fragment';
}

function getJsxParentElement(node: Node): JsxElement | undefined {
  return node.getParentIfKind(SyntaxKind.JsxElement);
}

function getElementChildren(parent: JsxElement): JsxElementLike[] {
  return parent
    .getJsxChildren()
    .filter(
      (child): child is JsxElementLike =>
        Node.isJsxElement(child) || Node.isJsxSelfClosingElement(child),
    );
}

function getElementSiblingIndex(node: JsxElementLike): number {
  const parent = getJsxParentElement(node);
  if (!parent) {
    return 1;
  }
  const siblings = getElementChildren(parent);
  return siblings.indexOf(node) + 1;
}

const HTML_TO_JSX_ATTRIBUTE_NAME: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
};

/**
 * Extracts static name="value" pairs from a single opening tag, e.g.
 * `<input type="text" name="email">`. Used only as a tie-breaker between
 * multiple JSX elements that already match on tag name/position — never as
 * the primary way of locating source, which is driven by AST structure.
 */
function parseHtmlAttributes(html: string): Map<string, string> {
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
    attrs.set(HTML_TO_JSX_ATTRIBUTE_NAME[name] ?? name, value);
  }
  return attrs;
}

function scoreAttributeMatch(node: JsxElementLike, htmlAttrs: Map<string, string>): number {
  const openingElement = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  let score = 0;
  for (const attr of openingElement.getAttributes()) {
    if (!Node.isJsxAttribute(attr)) continue;
    const initializer = attr.getInitializer();
    if (initializer && Node.isStringLiteral(initializer)) {
      const name = attr.getNameNode().getText();
      if (htmlAttrs.get(name) === initializer.getLiteralValue()) {
        score += 1;
      }
    }
  }
  return score;
}

/**
 * Locates the JSX element a given axe-core violation node came from by
 * parsing the component's AST and matching structurally: tag name plus
 * (when axe's selector includes it) nth-child position and immediate
 * parent tag, with the violation's raw HTML attributes as a tie-breaker
 * when more than one candidate remains. No source-text/string matching.
 */
function locateJsxElement(sourceFile: SourceFile, node: AxeNodeResult): JsxElementLike {
  const targetSelector = node.target[0];
  if (!targetSelector) {
    throw new Error(
      `Violation node has no target selector to locate in ${sourceFile.getFilePath()}`,
    );
  }

  const segments = parseSelector(targetSelector);
  const leaf = segments[segments.length - 1];
  if (!leaf?.tagName) {
    throw new Error(`Could not parse a tag name out of selector "${targetSelector}"`);
  }
  const parentSegment = segments.length > 1 ? segments[segments.length - 2] : undefined;

  const allElements: JsxElementLike[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  let candidates = allElements.filter((el) => getTagName(el).toLowerCase() === leaf.tagName);

  if (leaf.nthChild !== null) {
    candidates = candidates.filter((el) => getElementSiblingIndex(el) === leaf.nthChild);
  }

  if (parentSegment?.tagName) {
    candidates = candidates.filter((el) => {
      const parent = getJsxParentElement(el);
      return parent ? getTagName(parent).toLowerCase() === parentSegment.tagName : false;
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not locate a JSX element matching selector "${targetSelector}" (${node.html}) in ${sourceFile.getFilePath()}`,
    );
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (!only) {
      throw new Error('Unreachable: candidates.length === 1');
    }
    return only;
  }

  const htmlAttrs = parseHtmlAttributes(node.html);
  const scored = candidates
    .map((el) => ({ el, score: scoreAttributeMatch(el, htmlAttrs) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || (runnerUp && runnerUp.score === best.score)) {
    throw new Error(
      `Selector "${targetSelector}" matches ${candidates.length} JSX elements in ${sourceFile.getFilePath()} and attribute matching couldn't disambiguate them`,
    );
  }

  return best.el;
}

function toSnapshot(node: JsxElementLike, filePath: string): JsxElementSnapshot {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
  return {
    tagName: getTagName(node),
    code: node.getText(),
    location: {
      filePath,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
    },
  };
}

/**
 * Finds the first typed component parameter in the file (e.g.
 * `function Card({ title }: CardProps)`) and returns its prop type's
 * source text — resolving a same-file `interface`/`type` by name when the
 * annotation is a reference, or the inline type literal's text otherwise.
 * Returns null when no component in the file has a typed first parameter.
 */
function extractPropTypes(sourceFile: SourceFile): string | null {
  const functionLikes = [
    ...sourceFile.getFunctions(),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ].sort((a, b) => a.getStart() - b.getStart());

  for (const fn of functionLikes) {
    const typeNode = fn.getParameters()[0]?.getTypeNode();
    if (!typeNode) continue;

    if (Node.isTypeReference(typeNode)) {
      const name = typeNode.getTypeName().getText();
      const iface = sourceFile.getInterface(name);
      if (iface) return iface.getText();
      const alias = sourceFile.getTypeAlias(name);
      if (alias) return alias.getText();
    }

    return typeNode.getText();
  }

  return null;
}

export async function gatherContext(options: GatherContextOptions): Promise<FixContext> {
  const { violation } = options;
  const violationNode = violation.nodes[0];
  if (!violationNode) {
    throw new Error(`Violation "${violation.id}" has no offending nodes to locate`);
  }

  const absoluteComponentPath = path.resolve(options.componentPath);
  const project = new Project();
  const sourceFile = project.addSourceFileAtPath(absoluteComponentPath);

  const element = locateJsxElement(sourceFile, violationNode);
  const parent = getJsxParentElement(element);
  const siblings = parent
    ? getElementChildren(parent).filter((sibling) => sibling !== element)
    : [];

  return {
    violation,
    componentPath: absoluteComponentPath,
    sourceCode: sourceFile.getFullText(),
    relatedFiles: [],
    element: toSnapshot(element, absoluteComponentPath),
    parent: parent ? toSnapshot(parent, absoluteComponentPath) : null,
    siblings: siblings.map((sibling) => toSnapshot(sibling, absoluteComponentPath)),
    propTypes: extractPropTypes(sourceFile),
  };
}
