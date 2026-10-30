/**
 * adapters/react.ts — the `FrameworkAdapter` for React (`.tsx`/`.jsx`).
 * Parses a component with ts-morph and locates the offending JSX element
 * structurally — matching axe's target selector's tag name/nth-child/parent
 * against the AST, with the violation's raw HTML attributes as a
 * tie-breaker — never by string-matching source text.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { JsxElement, JsxSelfClosingElement, SourceFile } from 'ts-morph';
import { Node, Project, SyntaxKind } from 'ts-morph';

import type { AxeNodeResult } from '../../detect';
import { parseHtmlAttributes, parseSelector, tagNameFromHtml } from './axe-selector';
import { SourceResolver } from './resolve';
import type { PropReference, ResolvedSourceContext } from './resolve';
import type {
  ElementFacts,
  FrameworkAdapter,
  FrameworkElementContext,
  GatherElementContextOptions,
  IdAttribute,
  JsxElementSnapshot,
  LocateElementsOptions,
  SourceRange,
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
  const leafTag = leaf?.tagName ?? tagNameFromHtml(node.html);
  if (!leaf || !leafTag) {
    throw new Error(`Could not parse a tag name out of selector "${targetSelector}"`);
  }
  const parentSegment = segments.length > 1 ? segments[segments.length - 2] : undefined;

  const allElements: JsxElementLike[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  let candidates = allElements.filter((el) => getTagName(el).toLowerCase() === leafTag);

  if (leaf.nthChild !== null) {
    candidates = candidates.filter((el) => getElementSiblingIndex(el) === leaf.nthChild);
  }

  if (parentSegment?.tagName) {
    candidates = candidates.filter((el) => {
      const parent = getJsxParentElement(el);
      if (!parent || getTagName(parent).toLowerCase() !== parentSegment.tagName) return false;
      // e.g. "section:nth-child(2) > img": two identical <img>s in two
      // identical <section>s differ only by their parent's position.
      return (
        parentSegment.nthChild === null || getElementSiblingIndex(parent) === parentSegment.nthChild
      );
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

interface ParsedSource {
  sourceFile: SourceFile;
  /**
   * TypeScript drops a leading BOM from the text it parses, so its
   * positions are one short of offsets into the raw file text that
   * verify/ patches. Added to every offset this adapter reports.
   */
  offsetShift: number;
}

function parseSource(componentPath: string, source: string): ParsedSource {
  // In memory: only the given text is parsed, nothing else is read from disk.
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(componentPath, source);
  const bomDropped =
    source.charCodeAt(0) === 0xfeff && sourceFile.getFullText().charCodeAt(0) !== 0xfeff;
  return { sourceFile, offsetShift: bomDropped ? 1 : 0 };
}

function toRange(node: JsxElementLike, offsetShift: number): SourceRange {
  return { start: node.getStart() + offsetShift, end: node.getEnd() + offsetShift };
}

function toSnapshot(
  node: JsxElementLike,
  filePath: string,
  offsetShift: number,
): JsxElementSnapshot {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
  const range = toRange(node, offsetShift);
  return {
    tagName: getTagName(node),
    code: node.getText(),
    location: {
      filePath,
      startLine: start.line,
      startColumn: start.column,
      endLine: end.line,
      endColumn: end.column,
      startOffset: range.start,
      endOffset: range.end,
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

/** The element's `prop={expression}` attributes (not `key`/`ref`/spreads), handlers marked. */
function propReferences(element: JsxElementLike): PropReference[] {
  const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element;
  return opening.getAttributes().flatMap((attribute) => {
    if (!Node.isJsxAttribute(attribute)) return [];
    const prop = attribute.getNameNode().getText();
    if (prop === 'key' || prop === 'ref') return [];
    const initializer = attribute.getInitializer();
    if (!initializer || !Node.isJsxExpression(initializer)) return [];
    const expression = initializer.getExpression();
    if (!expression) return [];
    return [{ prop, expression, isHandler: /^on[A-Z]/.test(prop) }];
  });
}

/** A JSX attribute's value when it is a plain string (`id="x"` or `id={'x'}`), else null. */
function literalAttributeValue(attribute: Node): string | null {
  if (!Node.isJsxAttribute(attribute)) return null;
  const initializer = attribute.getInitializer();
  if (initializer && Node.isStringLiteral(initializer)) return initializer.getLiteralValue();
  if (initializer && Node.isJsxExpression(initializer)) {
    const expression = initializer.getExpression();
    if (expression && Node.isStringLiteral(expression)) return expression.getLiteralValue();
    if (expression && Node.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.getLiteralValue();
    }
  }
  return null;
}

function idAttributeOf(element: JsxElementLike): IdAttribute {
  const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element;
  const attribute = opening.getAttribute('id');
  if (!attribute || !Node.isJsxAttribute(attribute)) return { kind: 'none' };
  const value = literalAttributeValue(attribute);
  if (value !== null) return { kind: 'static', value };
  const initializer = attribute.getInitializer();
  const expression =
    initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
  return expression ? { kind: 'dynamic', expression: expression.getText() } : { kind: 'none' };
}

function elementFacts(sourceFile: SourceFile, element: JsxElementLike): ElementFacts {
  const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element;
  const ownId = opening.getAttribute('id');
  const idsInFile = new Set<string>();
  for (const attribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    if (attribute === ownId || attribute.getNameNode().getText() !== 'id') continue;
    const value = literalAttributeValue(attribute);
    if (value !== null) idsInFile.add(value);
  }
  const parent = element.getParent();
  return {
    id: idAttributeOf(element),
    idsInFile: [...idsInFile].sort(),
    canInsertSibling: Boolean(parent && (Node.isJsxElement(parent) || Node.isJsxFragment(parent))),
  };
}

/** Best-effort: any failure means no resolved context, never a failed gatherContext. */
function resolveElement(
  element: JsxElementLike,
  componentPath: string,
): ResolvedSourceContext | null {
  try {
    const resolver = new SourceResolver(element.getProject(), path.dirname(componentPath));
    return resolver.resolveProps(propReferences(element));
  } catch {
    return null;
  }
}

function gatherElementContext(options: GatherElementContextOptions): FrameworkElementContext {
  const { componentPath, violationNode } = options;

  const source = readFileSync(componentPath, 'utf8');
  const { sourceFile, offsetShift } = parseSource(componentPath, source);

  const element = locateJsxElement(sourceFile, violationNode);
  const parent = getJsxParentElement(element);
  const siblings = parent
    ? getElementChildren(parent).filter((sibling) => sibling !== element)
    : [];

  const resolved = resolveElement(element, componentPath);

  return {
    sourceCode: source,
    element: toSnapshot(element, componentPath, offsetShift),
    parent: parent ? toSnapshot(parent, componentPath, offsetShift) : null,
    siblings: siblings.map((sibling) => toSnapshot(sibling, componentPath, offsetShift)),
    propTypes: extractPropTypes(sourceFile),
    ...(resolved ? { resolved } : {}),
    facts: elementFacts(sourceFile, element),
  };
}

function locateElements(options: LocateElementsOptions): (SourceRange | null)[] {
  const { sourceFile, offsetShift } = parseSource(options.componentPath, options.source);
  return options.nodes.map((node) => {
    try {
      return toRange(locateJsxElement(sourceFile, node), offsetShift);
    } catch {
      return null;
    }
  });
}

export const reactAdapter: FrameworkAdapter = {
  id: 'react',
  supports(componentPath: string): boolean {
    return REACT_EXTENSIONS.has(path.extname(componentPath));
  },
  gatherElementContext,
  locateElements,
};
