/**
 * resolve.ts — best-effort, purely static resolution of what a flagged
 * element's dynamic props refer to, so generate/ can write specific alt
 * text and labels: `src={avatarUrl}` → the string `avatarUrl` is a
 * constant for, `onClick={handleDelete}` → `handleDelete`'s source.
 *
 * Purely static: values are read off the AST (string/number literals,
 * template literals, `+` concatenation, `const` declarations, object
 * literal properties). Nothing is ever evaluated or executed.
 *
 * Refused — resolution yields nothing rather than a guess:
 *  - `let`/`var` bindings (could be reassigned), function parameters and
 *    destructured props (their value comes from the caller), function
 *    calls, conditionals, and anything else that isn't a literal or a
 *    `const` chain to one;
 *  - imports that aren't relative (`react`, `@/lib/x`, any package), and
 *    any path containing a `node_modules` segment;
 *  - files other than .ts/.tsx/.js/.jsx/.mts/.cts, files over
 *    `LIMITS.maxFileBytes`, and more than `LIMITS.maxFiles` imported files.
 *
 * Shared by the React adapter (the component's own ts-morph SourceFile)
 * and the Vue adapter (its `<script setup>` block, parsed the same way).
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type {
  Expression,
  FunctionDeclaration,
  Project,
  SourceFile,
  Statement,
  VariableDeclaration,
} from 'ts-morph';
import { Node, VariableDeclarationKind } from 'ts-morph';

export const RESOLVE_LIMITS = {
  /** Identifier/import hops followed for a single value. */
  maxDepth: 6,
  /** Imported local files read per element. */
  maxFiles: 8,
  maxFileBytes: 256 * 1024,
  /** A resolved value longer than this is cut. */
  maxValueChars: 300,
  /** Handler bodies longer than this are cut. */
  maxHandlerLines: 30,
  /** Cap on all resolved values plus handler bodies for one element. */
  maxTotalChars: 4000,
};

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];

export interface ResolvedValue {
  /** The prop, e.g. `src`. */
  prop: string;
  /** Its value as written, e.g. `avatarUrl`. */
  expression: string;
  /** The statically resolved string. Parts that couldn't be resolved stay as `${expr}`. */
  value: string;
  /** False when some part stayed unresolved (kept as `${expr}` in `value`). */
  complete: boolean;
  /** The declarations it was read from, e.g. `const avatarUrl (Avatar.tsx:3)`. */
  from: string[];
}

export interface ResolvedHandler {
  /** The event prop, e.g. `onClick` (or `@click` for Vue). */
  prop: string;
  /** The handler as written, e.g. `handleDelete`. */
  expression: string;
  /** Where it's defined, e.g. `handleDelete (Toolbar.tsx:5)`. */
  from: string;
  /** The handler's source, at most `RESOLVE_LIMITS.maxHandlerLines` lines. */
  code: string;
  truncated: boolean;
}

/** Statically resolved values and handler bodies for one element. */
export interface ResolvedSourceContext {
  values: ResolvedValue[];
  handlers: ResolvedHandler[];
}

/** One prop of the flagged element, as an expression to resolve. */
export interface PropReference {
  prop: string;
  expression: Expression;
  isHandler: boolean;
}

/** How a file is named, and which line is its first, in `from` labels. */
export interface FileLabel {
  name: string;
  lineOffset: number;
}

type Binding =
  | { kind: 'const'; declaration: VariableDeclaration }
  | { kind: 'function'; declaration: FunctionDeclaration }
  | { kind: 'namespace'; module: SourceFile }
  | { kind: 'export-default-expression'; expression: Expression };

interface ResolvedString {
  text: string;
  complete: boolean;
  /** Whether anything beyond what's already written inline was resolved. */
  resolvedAny: boolean;
}

function unwrap(expression: Expression): Expression {
  let current = expression;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/** Names bound by a parameter or variable name, including destructuring patterns. */
function boundNames(nameNode: Node): string[] {
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
  if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
    return nameNode
      .getElements()
      .flatMap((element) =>
        Node.isBindingElement(element) ? boundNames(element.getNameNode()) : [],
      );
  }
  return [];
}

export class SourceResolver {
  private readonly loaded = new Map<string, SourceFile | null>();
  private readonly origins: string[] = [];

  constructor(
    private readonly project: Project,
    /** Directory `from` labels are relative to (the component's). */
    private readonly baseDir: string,
    private readonly labels = new Map<string, FileLabel>(),
  ) {}

  /** Resolves the flagged element's props, within the size caps. Null when nothing resolved. */
  resolveProps(props: PropReference[]): ResolvedSourceContext | null {
    const values: ResolvedValue[] = [];
    const handlers: ResolvedHandler[] = [];
    let budget = RESOLVE_LIMITS.maxTotalChars;

    for (const { prop, expression } of props.filter((reference) => !reference.isHandler)) {
      const value = this.resolveValue(prop, expression);
      if (value && value.value.length <= budget) {
        values.push(value);
        budget -= value.value.length;
      }
    }
    for (const { prop, expression } of props.filter((reference) => reference.isHandler)) {
      const handler = this.resolveHandler(prop, expression);
      if (handler && handler.code.length <= budget) {
        handlers.push(handler);
        budget -= handler.code.length;
      }
    }

    return values.length > 0 || handlers.length > 0 ? { values, handlers } : null;
  }

  private resolveValue(prop: string, expression: Expression): ResolvedValue | null {
    this.origins.length = 0;
    const resolved = this.resolveString(expression, 0);
    if (!resolved?.resolvedAny) return null;
    const value =
      resolved.text.length > RESOLVE_LIMITS.maxValueChars
        ? `${resolved.text.slice(0, RESOLVE_LIMITS.maxValueChars)}…`
        : resolved.text;
    return {
      prop,
      expression: expression.getText(),
      value,
      complete: resolved.complete,
      from: [...this.origins],
    };
  }

  private resolveHandler(prop: string, expression: Expression): ResolvedHandler | null {
    const found = this.findFunction(unwrap(expression), 0);
    if (!found) return null;
    const lines = found.code.split('\n');
    const truncated = lines.length > RESOLVE_LIMITS.maxHandlerLines;
    const code = truncated
      ? [
          ...lines.slice(0, RESOLVE_LIMITS.maxHandlerLines),
          `// … ${lines.length - RESOLVE_LIMITS.maxHandlerLines} more lines not shown`,
        ].join('\n')
      : found.code;
    return { prop, expression: expression.getText(), from: found.from, code, truncated };
  }

  // --- strings -------------------------------------------------------------

  private resolveString(raw: Expression, depth: number): ResolvedString | null {
    if (depth > RESOLVE_LIMITS.maxDepth) return null;
    const expression = unwrap(raw);

    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
      return { text: expression.getLiteralValue(), complete: true, resolvedAny: false };
    }
    if (Node.isNumericLiteral(expression)) {
      return { text: expression.getText(), complete: true, resolvedAny: false };
    }

    if (Node.isTemplateExpression(expression)) {
      const parts: ResolvedString[] = [
        { text: expression.getHead().getLiteralText(), complete: true, resolvedAny: false },
      ];
      for (const span of expression.getTemplateSpans()) {
        parts.push(
          this.resolveString(span.getExpression(), depth + 1) ?? placeholder(span.getExpression()),
        );
        parts.push({
          text: span.getLiteral().getLiteralText(),
          complete: true,
          resolvedAny: false,
        });
      }
      return join(parts);
    }

    if (Node.isBinaryExpression(expression) && expression.getOperatorToken().getText() === '+') {
      const left = this.resolveString(expression.getLeft(), depth + 1);
      const right = this.resolveString(expression.getRight(), depth + 1);
      if (!left && !right) return null;
      return join([
        left ?? placeholder(expression.getLeft()),
        right ?? placeholder(expression.getRight()),
      ]);
    }

    if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
      const initializer = this.constInitializer(expression, depth);
      if (!initializer) return null;
      const resolved = this.resolveString(initializer, depth + 1);
      return resolved ? { ...resolved, resolvedAny: true } : null;
    }

    return null;
  }

  /**
   * The initializer an identifier (`avatarUrl`) or property access
   * (`IMAGES.ceo`, `images.ceo` for `import * as images`) statically
   * refers to — only through `const` declarations and object literals.
   */
  private constInitializer(expression: Expression, depth: number): Expression | null {
    if (Node.isIdentifier(expression)) {
      const binding = this.findBinding(expression.getText(), expression, depth);
      if (binding?.kind === 'const') {
        const initializer = binding.declaration.getInitializer();
        if (!initializer) return null;
        this.origins.push(
          this.label(binding.declaration, `const ${binding.declaration.getName()}`),
        );
        return initializer;
      }
      if (binding?.kind === 'export-default-expression') return binding.expression;
      return null;
    }

    if (Node.isPropertyAccessExpression(expression)) {
      const object = unwrap(expression.getExpression());
      const name = expression.getName();
      if (!Node.isIdentifier(object)) return null;
      const binding = this.findBinding(object.getText(), object, depth);
      if (binding?.kind === 'namespace') {
        const exported = this.findExport(binding.module, name, depth + 1);
        if (exported?.kind !== 'const') return null;
        this.origins.push(this.label(exported.declaration, `const ${name}`));
        return exported.declaration.getInitializer() ?? null;
      }
      if (binding?.kind !== 'const') return null;
      const literal = binding.declaration.getInitializer();
      const objectLiteral = literal ? unwrap(literal) : undefined;
      if (!objectLiteral || !Node.isObjectLiteralExpression(objectLiteral)) return null;
      const property = objectLiteral.getProperty(name);
      if (!property || !Node.isPropertyAssignment(property)) return null;
      const initializer = property.getInitializer();
      if (!initializer) return null;
      this.origins.push(
        this.label(binding.declaration, `const ${binding.declaration.getName()}.${name}`),
      );
      return initializer;
    }

    return null;
  }

  // --- functions -----------------------------------------------------------

  private findFunction(
    expression: Expression,
    depth: number,
  ): { code: string; from: string } | null {
    if (depth > RESOLVE_LIMITS.maxDepth) return null;

    let binding: Binding | null = null;
    let name: string;
    if (Node.isIdentifier(expression)) {
      name = expression.getText();
      binding = this.findBinding(name, expression, depth);
    } else if (Node.isPropertyAccessExpression(expression)) {
      // Only `ns.fn` for `import * as ns from './local'`.
      const object = unwrap(expression.getExpression());
      if (!Node.isIdentifier(object)) return null;
      const namespace = this.findBinding(object.getText(), object, depth);
      if (namespace?.kind !== 'namespace') return null;
      name = expression.getName();
      binding = this.findExport(namespace.module, name, depth + 1);
    } else {
      return null;
    }

    if (binding?.kind === 'function') {
      return {
        code: binding.declaration.getText(),
        from: this.label(binding.declaration, binding.declaration.getName() ?? name),
      };
    }
    if (binding?.kind === 'const') {
      const initializer = binding.declaration.getInitializer();
      if (!initializer) return null;
      const value = unwrap(initializer);
      if (isFunctionExpression(value) || isUseCallback(value)) {
        const statement = binding.declaration.getVariableStatement() ?? binding.declaration;
        return {
          code: statement.getText(),
          from: this.label(binding.declaration, binding.declaration.getName()),
        };
      }
      // `const onRemove = handleDelete;`
      if (Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) {
        return this.findFunction(value, depth + 1);
      }
    }
    if (binding?.kind === 'export-default-expression') {
      const value = unwrap(binding.expression);
      if (isFunctionExpression(value)) {
        return { code: value.getText(), from: this.label(value, `default export`) };
      }
      if (Node.isIdentifier(value)) return this.findFunction(value, depth + 1);
    }
    return null;
  }

  // --- bindings ------------------------------------------------------------

  /**
   * What `name` refers to at `at`: walks outward through enclosing scopes.
   * A parameter (or destructured prop) of an enclosing function shadows
   * everything outside it and isn't resolvable, so it ends the search.
   */
  private findBinding(name: string, at: Node, depth: number): Binding | null {
    for (let scope = at.getParent(); scope; scope = scope.getParent()) {
      if (
        Node.isFunctionDeclaration(scope) ||
        Node.isFunctionExpression(scope) ||
        Node.isArrowFunction(scope) ||
        Node.isMethodDeclaration(scope)
      ) {
        const isParameter = scope
          .getParameters()
          .some((parameter) => boundNames(parameter.getNameNode()).includes(name));
        if (isParameter) return null;
      }
      // Loop and catch variables shadow outer names too and aren't constants.
      if (
        Node.isForOfStatement(scope) ||
        Node.isForInStatement(scope) ||
        Node.isForStatement(scope)
      ) {
        const initializer = scope.getInitializer();
        const declaresName =
          Node.isVariableDeclarationList(initializer) &&
          initializer
            .getDeclarations()
            .some((declaration) => boundNames(declaration.getNameNode()).includes(name));
        if (declaresName) return null;
      }
      if (Node.isCatchClause(scope)) {
        const variable = scope.getVariableDeclaration();
        if (variable && boundNames(variable.getNameNode()).includes(name)) return null;
      }
      if (Node.isBlock(scope) || Node.isSourceFile(scope) || Node.isModuleBlock(scope)) {
        const found = this.bindingInStatements(scope.getStatements(), name, depth);
        if (found !== undefined) return found;
      }
    }
    return null;
  }

  /** `undefined` when `name` isn't declared here (keep looking outward); null when it's declared but not resolvable. */
  private bindingInStatements(
    statements: Statement[],
    name: string,
    depth: number,
  ): Binding | null | undefined {
    for (const statement of statements) {
      if (Node.isVariableStatement(statement)) {
        for (const declaration of statement.getDeclarations()) {
          if (!boundNames(declaration.getNameNode()).includes(name)) continue;
          const isPlainConst =
            statement.getDeclarationKind() === VariableDeclarationKind.Const &&
            Node.isIdentifier(declaration.getNameNode());
          return isPlainConst ? { kind: 'const', declaration } : null;
        }
      } else if (Node.isFunctionDeclaration(statement) && statement.getName() === name) {
        return { kind: 'function', declaration: statement };
      } else if (Node.isImportDeclaration(statement)) {
        const found = this.bindingFromImport(statement, name, depth);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  private bindingFromImport(
    statement: Node,
    name: string,
    depth: number,
  ): Binding | null | undefined {
    if (!Node.isImportDeclaration(statement)) return undefined;
    const specifier = statement.getModuleSpecifierValue();
    const sourceFile = statement.getSourceFile();

    if (statement.getDefaultImport()?.getText() === name) {
      const module = this.loadLocalModule(sourceFile, specifier);
      return module ? this.findExport(module, 'default', depth + 1) : null;
    }
    if (statement.getNamespaceImport()?.getText() === name) {
      const module = this.loadLocalModule(sourceFile, specifier);
      return module ? { kind: 'namespace', module } : null;
    }
    for (const named of statement.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      if (localName !== name) continue;
      const module = this.loadLocalModule(sourceFile, specifier);
      return module ? this.findExport(module, named.getName(), depth + 1) : null;
    }
    return undefined;
  }

  /** What `module` exports as `exportName` — declarations, `export { a as b }`, `export default`, and re-exports from other local files. */
  private findExport(module: SourceFile, exportName: string, depth: number): Binding | null {
    if (depth > RESOLVE_LIMITS.maxDepth) return null;
    const statements = module.getStatements();

    for (const statement of statements) {
      if (exportName === 'default') {
        if (Node.isFunctionDeclaration(statement) && statement.isDefaultExport()) {
          return { kind: 'function', declaration: statement };
        }
        if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
          const expression = unwrap(statement.getExpression());
          if (Node.isIdentifier(expression)) {
            return this.bindingInStatements(statements, expression.getText(), depth) ?? null;
          }
          return { kind: 'export-default-expression', expression };
        }
      }

      if (Node.isExportDeclaration(statement)) {
        const reExportFrom = statement.getModuleSpecifierValue();
        for (const named of statement.getNamedExports()) {
          const exportedAs = named.getAliasNode()?.getText() ?? named.getName();
          if (exportedAs !== exportName) continue;
          if (reExportFrom) {
            const target = this.loadLocalModule(module, reExportFrom);
            return target ? this.findExport(target, named.getName(), depth + 1) : null;
          }
          return this.bindingInStatements(statements, named.getName(), depth) ?? null;
        }
        if (
          reExportFrom &&
          statement.isNamespaceExport() === false &&
          !statement.hasNamedExports()
        ) {
          // `export * from './other'`
          const target = this.loadLocalModule(module, reExportFrom);
          const found = target ? this.findExport(target, exportName, depth + 1) : null;
          if (found) return found;
        }
      }

      if (exportName !== 'default') {
        if (Node.isVariableStatement(statement) && statement.isExported()) {
          const found = this.bindingInStatements([statement], exportName, depth);
          if (found !== undefined) return found;
        }
        if (
          Node.isFunctionDeclaration(statement) &&
          statement.isExported() &&
          statement.getName() === exportName
        ) {
          return { kind: 'function', declaration: statement };
        }
      }
    }
    return null;
  }

  /**
   * Reads a relatively-imported local file into the project. Anything that
   * isn't relative (packages, path aliases) or lands in node_modules is
   * refused, as are non-script files and files over the size cap.
   */
  private loadLocalModule(from: SourceFile, specifier: string): SourceFile | null {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;

    const base = path.resolve(path.dirname(from.getFilePath()), specifier);
    const candidates = [
      base,
      ...SCRIPT_EXTENSIONS.map((extension) => `${base}${extension}`),
      ...SCRIPT_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
    ];

    for (const candidate of candidates) {
      if (candidate.split(/[\\/]/).includes('node_modules')) return null;
      if (!SCRIPT_EXTENSIONS.includes(path.extname(candidate))) continue;
      if (this.loaded.has(candidate)) return this.loaded.get(candidate) ?? null;

      const existing = this.project.getSourceFile(candidate);
      if (existing) return existing;

      let size: number;
      try {
        const stats = statSync(candidate);
        if (!stats.isFile()) continue;
        size = stats.size;
      } catch {
        continue;
      }

      if (this.loaded.size >= RESOLVE_LIMITS.maxFiles || size > RESOLVE_LIMITS.maxFileBytes) {
        this.loaded.set(candidate, null);
        return null;
      }
      const module = this.project.createSourceFile(candidate, readFileSync(candidate, 'utf8'), {
        overwrite: true,
      });
      this.loaded.set(candidate, module);
      return module;
    }
    return null;
  }

  private label(node: Node, what: string): string {
    const filePath = node.getSourceFile().getFilePath();
    const fileLabel = this.labels.get(filePath);
    const name =
      fileLabel?.name ?? (path.relative(this.baseDir, filePath) || path.basename(filePath));
    const line = node.getStartLineNumber() + (fileLabel?.lineOffset ?? 0);
    return `${what} (${name}:${line})`;
  }
}

function isFunctionExpression(node: Node): boolean {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node);
}

/** `useCallback(() => …, deps)` or `React.useCallback(…)` with an inline function. */
function isUseCallback(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression().getText();
  const [first] = node.getArguments();
  return (
    (callee === 'useCallback' || callee === 'React.useCallback') &&
    first !== undefined &&
    isFunctionExpression(first)
  );
}

function placeholder(expression: Expression): ResolvedString {
  return { text: `\${${expression.getText()}}`, complete: false, resolvedAny: false };
}

function join(parts: ResolvedString[]): ResolvedString {
  return {
    text: parts.map((part) => part.text).join(''),
    complete: parts.every((part) => part.complete),
    resolvedAny: parts.some((part) => part.resolvedAny),
  };
}
