import { describe, expect, it } from 'vitest';

import * as vscode from 'vscode';

import { A11yAutofixCodeActionProvider, FIX_COMMAND } from '../src/codeActions';
import { DIAGNOSTIC_SOURCE } from '../src/diagnostics';

function fakeDocument(fsPath: string): vscode.TextDocument {
  return { uri: { fsPath, toString: () => fsPath } } as unknown as vscode.TextDocument;
}

function makeDiagnostic(
  source: string,
  code: unknown,
  range = new vscode.Range(new vscode.Position(7, 4), new vscode.Position(7, 29)),
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(range, 'msg', vscode.DiagnosticSeverity.Error);
  diagnostic.source = source;
  diagnostic.code = code;
  return diagnostic;
}

describe('A11yAutofixCodeActionProvider', () => {
  const provider = new A11yAutofixCodeActionProvider();

  it('ignores diagnostics from other sources', () => {
    const document = fakeDocument('/repo/Avatar.tsx');
    const foreign = makeDiagnostic('eslint', 'no-unused-vars');

    const actions = provider.provideCodeActions(document, foreign.range, {
      diagnostics: [foreign],
    } as unknown as vscode.CodeActionContext);

    expect(actions).toEqual([]);
  });

  it('builds one QuickFix CodeAction per matching diagnostic, wired to the fix command', () => {
    const document = fakeDocument('/repo/Avatar.tsx');
    const diagnostic = makeDiagnostic(DIAGNOSTIC_SOURCE, { value: 'image-alt', target: {} });

    const [action] = provider.provideCodeActions(document, diagnostic.range, {
      diagnostics: [diagnostic],
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    expect(action).toBeDefined();
    expect(action!.title).toBe('Fix with a11y-autofix: image-alt');
    expect(action!.kind).toBe(vscode.CodeActionKind.QuickFix);
    expect(action!.diagnostics).toEqual([diagnostic]);
    expect(action!.isPreferred).toBe(true);
    expect(action!.command).toEqual({
      command: FIX_COMMAND,
      title: 'Fix with a11y-autofix',
      arguments: [document.uri, diagnostic.range, 'image-alt'],
    });
  });

  it('reads a bare-string diagnostic code as the rule id too', () => {
    const document = fakeDocument('/repo/Avatar.tsx');
    const diagnostic = makeDiagnostic(DIAGNOSTIC_SOURCE, 'link-name');

    const [action] = provider.provideCodeActions(document, diagnostic.range, {
      diagnostics: [diagnostic],
    } as unknown as vscode.CodeActionContext) as vscode.CodeAction[];

    expect(action!.title).toBe('Fix with a11y-autofix: link-name');
    expect(action!.command?.arguments?.[2]).toBe('link-name');
  });
});
