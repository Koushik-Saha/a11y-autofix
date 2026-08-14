/**
 * adapters/react.ts — the `FrameworkAdapter` for React (`.tsx`/`.jsx`).
 * Parses a component with ts-morph and locates the offending JSX element
 * structurally — matching axe's target selector's tag name/nth-child/parent
 * against the AST, with the violation's raw HTML attributes as a
 * tie-breaker — never by string-matching source text.
 */

import path from 'node:path';

import type { JsxElement, JsxSelfClosingElement, SourceFile } from 'ts-morph';
import { Node, Project, SyntaxKind } from 'ts-morph';

import type { AxeNodeResult } from '../../detect';
import { parseHtmlAttributes, parseSelector } from './axe-selector';
import type {
  FrameworkAdapter,
  FrameworkElementContext,
  GatherElementContextOptions,
  JsxElementSnapshot,
} from './types';

type JsxElementLike = JsxElement | JsxSelfClosingElement;

const REACT_EXTENSIONS = new Set(['.tsx', '.jsx']);

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

// JSX renames a couple of HTML attributes (`class`/`for`) that would
// otherwise collide with JS keywords/reserved words. axe's raw html string
// always uses the HTML names, so the tie-breaker below has to translate
// before comparing against JSX attribute names.
const HTML_TO_JSX_ATTRIBUTE_NAME: Record<string, string> = {
  class: 'className',
  for: 'htmlFor',
};

function scoreAttributeMatch(node: JsxElementLike, htmlAttrs: Map<string, string>): number {
  const openingElement = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  let score = 0;
  for (const attr of openingElement.getAttributes()) {
    if (!Node.isJsxAttribute(attr)) continue;
    const initializer = attr.getInitializer();
    if (initializer && Node.isStringLiteral(initializer)) {
      const name = attr.getNameNode().getText();
      const htmlName = Object.entries(HTML_TO_JSX_ATTRIBUTE_NAME).find(
        ([, jsxName]) => jsxName === name,
      )?.[0];
      if (htmlAttrs.get(htmlName ?? name) === initializer.getLiteralValue()) {
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

function gatherElementContext(options: GatherElementContextOptions): FrameworkElementContext {
  const { componentPath, violationNode } = options;

  const project = new Project();
  const sourceFile = project.addSourceFileAtPath(componentPath);

  const element = locateJsxElement(sourceFile, violationNode);
  const parent = getJsxParentElement(element);
  const siblings = parent
    ? getElementChildren(parent).filter((sibling) => sibling !== element)
    : [];

  return {
    sourceCode: sourceFile.getFullText(),
    element: toSnapshot(element, componentPath),
    parent: parent ? toSnapshot(parent, componentPath) : null,
    siblings: siblings.map((sibling) => toSnapshot(sibling, componentPath)),
    propTypes: extractPropTypes(sourceFile),
  };
}

export const reactAdapter: FrameworkAdapter = {
  id: 'react',
  supports(componentPath: string): boolean {
    return REACT_EXTENSIONS.has(path.extname(componentPath));
  },
  gatherElementContext,
};
