/**
 * A minimal stand-in for the 'vscode' module, used only under test (see
 * vitest.config.ts's `test.alias`, which points the bare specifier
 * 'vscode' at this file). Implements just enough of the real API's
 * runtime shape for src/*.ts to run against — not a full mock of the
 * VS Code API surface.
 */

import { vi } from 'vitest';

export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}

export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}

export class Uri {
  private constructor(public readonly value: string) {}
  static parse(value: string): Uri {
    return new Uri(value);
  }
  static file(value: string): Uri {
    return new Uri(value);
  }
  get fsPath(): string {
    return this.value;
  }
  toString(): string {
    return this.value;
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;
  code?: unknown;
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity,
  ) {}
}

export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  private constructor(public readonly value: string) {}
}

export class CodeAction {
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public title: string,
    public kind?: CodeActionKind,
  ) {}
}

export class WorkspaceEdit {
  replacements: { uri: Uri; range: Range; text: string }[] = [];
  replace(uri: Uri, range: Range, text: string): void {
    this.replacements.push({ uri, range, text });
  }
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export const window = {
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  withProgress: vi.fn(async (_options: unknown, task: (progress: unknown) => Promise<unknown>) =>
    task({}),
  ),
  activeTextEditor: undefined as { document: unknown } | undefined,
};

/**
 * Backs `workspace.getConfiguration(section).get(key, default)` below.
 * Tests set values with `setConfigValue('a11yAutofix.disabledRules', [...])`
 * (section + key joined with '.', matching how real settings are addressed)
 * rather than the mock always falling back to whatever default the caller
 * passed in.
 */
const configValues = new Map<string, unknown>();

export function setConfigValue(fullKey: string, value: unknown): void {
  configValues.set(fullKey, value);
}

export const workspace = {
  applyEdit: vi.fn(async () => true),
  getConfiguration: vi.fn((section?: string) => ({
    get: vi.fn((key: string, def: unknown) => {
      const fullKey = section ? `${section}.${key}` : key;
      return configValues.has(fullKey) ? configValues.get(fullKey) : def;
    }),
  })),
  openTextDocument: vi.fn(),
  onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  textDocuments: [] as unknown[],
};

export const languages = {
  createDiagnosticCollection: vi.fn(() => ({ set: vi.fn(), delete: vi.fn(), dispose: vi.fn() })),
  registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
};

export const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
};

/** Resets every mock function above; call from each test file's beforeEach. */
export function resetVscodeMock(): void {
  window.showWarningMessage.mockClear();
  window.showErrorMessage.mockClear();
  window.showInformationMessage.mockClear();
  window.withProgress.mockClear();
  window.activeTextEditor = undefined;
  workspace.applyEdit.mockClear();
  workspace.applyEdit.mockResolvedValue(true);
  workspace.getConfiguration.mockClear();
  workspace.openTextDocument.mockClear();
  workspace.onDidOpenTextDocument.mockClear();
  workspace.onDidSaveTextDocument.mockClear();
  workspace.onDidCloseTextDocument.mockClear();
  workspace.onDidChangeConfiguration.mockClear();
  workspace.textDocuments = [];
  configValues.clear();
  languages.createDiagnosticCollection.mockClear();
  languages.registerCodeActionsProvider.mockClear();
  commands.registerCommand.mockClear();
}
