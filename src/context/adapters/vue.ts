/**
 * adapters/vue.ts — the `FrameworkAdapter` for Vue (`.vue` single-file
 * components). Parses the component with `@vue/compiler-sfc` and locates
 * the offending template element structurally — matching axe's target
 * selector's tag name/nth-child/parent against the template AST, with the
 * violation's raw HTML attributes as a tie-breaker — mirroring
 * `react.ts`'s approach exactly, just against Vue's template AST instead
 * of ts-morph's JSX AST.
 *
 * Scope, deliberately: only `<script setup lang="ts">` components with a
 * `defineProps<Props>()` call are understood for prop-type extraction
 * (Options API `props: {...}` isn't), and only static template structure
 * is walked — `v-if`/`v-for`/`v-else` branches are separate AST node
 * types this adapter doesn't recurse into, so elements inside them won't
 * be found. Both mirror the same "cover the common case, not every case"
 * scoping the React adapter already uses (e.g. its prop-type extraction
 * only looks at a typed first function parameter).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ElementNode, RootNode, TemplateChildNode } from '@vue/compiler-core';
import { NodeTypes } from '@vue/compiler-core';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { Project, SyntaxKind, Node as TsNode } from 'ts-morph';

import type { AxeNodeResult } from '../../detect';
import { parseHtmlAttributes, parseSelector } from './axe-selector';
import { SourceResolver } from './resolve';
import type { ResolvedSourceContext } from './resolve';
import type {
  FrameworkAdapter,
  FrameworkElementContext,
  GatherElementContextOptions,
  JsxElementSnapshot,
  LocateElementsOptions,
  SourceRange,
} from './types';

const VUE_EXTENSIONS = new Set(['.vue']);

function isElementNode(node: TemplateChildNode | RootNode): node is ElementNode {
  return node.type === NodeTypes.ELEMENT;
}

interface WalkEntry {
  node: ElementNode;
  parent: ElementNode | null;
}

/** Flattens the template tree into every element plus its structural parent. Does not recurse into v-if/v-for/v-else branch nodes — see file header. */
function collectElements(root: RootNode): WalkEntry[] {
  const out: WalkEntry[] = [];
  function visit(node: RootNode | ElementNode, parent: ElementNode | null) {
    for (const child of node.children) {
      if (isElementNode(child)) {
        out.push({ node: child, parent });
        visit(child, child);
      }
    }
  }
  visit(root, null);
  return out;
}

function elementChildrenOf(node: RootNode | ElementNode): ElementNode[] {
  return node.children.filter(isElementNode);
}

function getSiblingIndex(entry: WalkEntry, root: RootNode): number {
  const siblings = elementChildrenOf(entry.parent ?? root);
  return siblings.indexOf(entry.node) + 1;
}

function scoreAttributeMatch(node: ElementNode, htmlAttrs: Map<string, string>): number {
  let score = 0;
  for (const prop of node.props) {
    if (prop.type === NodeTypes.ATTRIBUTE && prop.value) {
      if (htmlAttrs.get(prop.name) === prop.value.content) {
        score += 1;
      }
    }
  }
  return score;
}

/**
 * Locates the template element a given axe-core violation node came from,
 * matching structurally: tag name plus (when axe's selector includes it)
 * nth-child position and immediate parent tag, with the violation's raw
 * HTML attributes as a tie-breaker when more than one candidate remains.
 * No source-text/string matching.
 */
function locateElement(root: RootNode, node: AxeNodeResult): WalkEntry {
  const targetSelector = node.target[0];
  if (!targetSelector) {
    throw new Error(`Violation node has no target selector to locate`);
  }

  const segments = parseSelector(targetSelector);
  const leaf = segments[segments.length - 1];
  if (!leaf?.tagName) {
    throw new Error(`Could not parse a tag name out of selector "${targetSelector}"`);
  }
  const parentSegment = segments.length > 1 ? segments[segments.length - 2] : undefined;

  const allEntries = collectElements(root);

  let candidates = allEntries.filter((entry) => entry.node.tag.toLowerCase() === leaf.tagName);

  if (leaf.nthChild !== null) {
    candidates = candidates.filter((entry) => getSiblingIndex(entry, root) === leaf.nthChild);
  }

  if (parentSegment?.tagName) {
    candidates = candidates.filter((entry) => {
      const parent = entry.parent;
      if (!parent || parent.tag.toLowerCase() !== parentSegment.tagName) return false;
      if (parentSegment.nthChild === null) return true;
      // e.g. "section:nth-child(2) > img": two identical <img>s in two
      // identical <section>s differ only by their parent's position.
      const parentEntry = allEntries.find((other) => other.node === parent);
      return parentEntry ? getSiblingIndex(parentEntry, root) === parentSegment.nthChild : false;
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      `Could not locate a template element matching selector "${targetSelector}" (${node.html})`,
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
    .map((entry) => ({ entry, score: scoreAttributeMatch(entry.node, htmlAttrs) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || (runnerUp && runnerUp.score === best.score)) {
    throw new Error(
      `Selector "${targetSelector}" matches ${candidates.length} template elements and attribute matching couldn't disambiguate them`,
    );
  }

  return best.entry;
}

function toSnapshot(node: ElementNode, filePath: string, sourceText: string): JsxElementSnapshot {
  return {
    tagName: node.tag,
    code: sourceText.slice(node.loc.start.offset, node.loc.end.offset),
    location: {
      filePath,
      startLine: node.loc.start.line,
      startColumn: node.loc.start.column,
      endLine: node.loc.end.line,
      endColumn: node.loc.end.column,
      startOffset: node.loc.start.offset,
      endOffset: node.loc.end.offset,
    },
  };
}

/**
 * Finds a `defineProps<Props>()` call in the `<script setup>` block and
 * returns the referenced interface/type alias's source text — the
 * `<script setup>` analog of react.ts's typed-first-parameter extraction.
 * Returns null when there's no `<script setup>`, no `defineProps<T>()`
 * call, or the type argument isn't a named reference.
 */
function extractPropTypes(scriptSetupContent: string | undefined): string | null {
  if (!scriptSetupContent) return null;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('__script-setup.ts', scriptSetupContent);

  const definePropsCall = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((call) => call.getExpression().getText() === 'defineProps');
  if (!definePropsCall) return null;

  const typeArg = definePropsCall.getTypeArguments()[0];
  if (!typeArg || !TsNode.isTypeReference(typeArg)) return null;

  const name = typeArg.getTypeName().getText();
  const iface = sourceFile.getInterface(name);
  if (iface) return iface.getText();
  const alias = sourceFile.getTypeAlias(name);
  if (alias) return alias.getText();
  return null;
}

function parseTemplate(componentPath: string, sourceText: string) {
  const { descriptor } = parseSfc(sourceText, { filename: componentPath });
  const root = descriptor.template?.ast;
  if (!root) {
    throw new Error(`"${componentPath}" has no parseable <template> block to locate elements in`);
  }
  return { descriptor, root };
}

/** `:src="expr"` / `@click="expr"` bindings on the element, with a static argument. */
function templateBindings(
  element: ElementNode,
): { prop: string; source: string; isHandler: boolean }[] {
  return element.props.flatMap((prop) => {
    if (prop.type !== NodeTypes.DIRECTIVE) return [];
    if (prop.name !== 'bind' && prop.name !== 'on') return [];
    const arg = prop.arg;
    const exp = prop.exp;
    if (!arg || arg.type !== NodeTypes.SIMPLE_EXPRESSION || !arg.isStatic) return [];
    if (!exp || exp.type !== NodeTypes.SIMPLE_EXPRESSION || !exp.content.trim()) return [];
    if (prop.name === 'bind' && (arg.content === 'key' || arg.content === 'ref')) return [];
    return [
      {
        prop: prop.name === 'on' ? `@${arg.content}` : `:${arg.content}`,
        source: exp.content,
        isHandler: prop.name === 'on',
      },
    ];
  });
}

/**
 * Resolves the element's template bindings against `<script setup>`: the
 * script is parsed with ts-morph and the template expressions are
 * appended as one probe statement, so they're looked up in the script's
 * top-level scope exactly as the template would see them. Parsed only,
 * never executed. Best-effort: null on any failure.
 */
function resolveElement(
  element: ElementNode,
  componentPath: string,
  scriptSetup: { content: string; loc: { start: { line: number } } } | null | undefined,
): ResolvedSourceContext | null {
  if (!scriptSetup) return null;
  const bindings = templateBindings(element);
  if (bindings.length === 0) return null;

  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const scriptPath = path.join(
      path.dirname(componentPath),
      `${path.basename(componentPath)}.script-setup.ts`,
    );
    const probe = `\n;[${bindings.map((binding) => `(${binding.source})`).join(', ')}];\n`;
    const sourceFile = project.createSourceFile(scriptPath, scriptSetup.content + probe);

    const last = sourceFile.getStatements().at(-1);
    const array = TsNode.isExpressionStatement(last) ? last.getExpression() : undefined;
    if (!array || !TsNode.isArrayLiteralExpression(array)) return null;
    const expressions = array.getElements();
    if (expressions.length !== bindings.length) return null;

    const resolver = new SourceResolver(
      project,
      path.dirname(componentPath),
      new Map([
        [
          sourceFile.getFilePath(),
          { name: path.basename(componentPath), lineOffset: scriptSetup.loc.start.line - 1 },
        ],
      ]),
    );
    return resolver.resolveProps(
      bindings.map((binding, index) => {
        const element = expressions[index]!;
        const expression = TsNode.isParenthesizedExpression(element)
          ? element.getExpression()
          : element;
        return { prop: binding.prop, expression, isHandler: binding.isHandler };
      }),
    );
  } catch {
    return null;
  }
}

function gatherElementContext(options: GatherElementContextOptions): FrameworkElementContext {
  const { componentPath, violationNode } = options;

  const sourceText = readFileSync(componentPath, 'utf8');
  const { descriptor, root } = parseTemplate(componentPath, sourceText);

  const { node: element, parent } = locateElement(root, violationNode);
  const resolved = resolveElement(element, componentPath, descriptor.scriptSetup);
  const siblings = elementChildrenOf(parent ?? root).filter((sibling) => sibling !== element);

  return {
    sourceCode: sourceText,
    element: toSnapshot(element, componentPath, sourceText),
    parent: parent ? toSnapshot(parent, componentPath, sourceText) : null,
    siblings: siblings.map((sibling) => toSnapshot(sibling, componentPath, sourceText)),
    propTypes: extractPropTypes(descriptor.scriptSetup?.content),
    ...(resolved ? { resolved } : {}),
  };
}

function locateElements(options: LocateElementsOptions): (SourceRange | null)[] {
  let root: RootNode;
  try {
    ({ root } = parseTemplate(options.componentPath, options.source));
  } catch {
    return options.nodes.map(() => null);
  }
  return options.nodes.map((node) => {
    try {
      const { loc } = locateElement(root, node).node;
      return { start: loc.start.offset, end: loc.end.offset };
    } catch {
      return null;
    }
  });
}

export const vueAdapter: FrameworkAdapter = {
  id: 'vue',
  supports(componentPath: string): boolean {
    return VUE_EXTENSIONS.has(path.extname(componentPath));
  },
  gatherElementContext,
  locateElements,
};
