/**
 * codeActions.ts — surfaces a "Fix with a11y-autofix" quick fix for each
 * of this extension's own diagnostics. No fix logic lives here; each
 * action just invokes the `a11y-autofix.fix` command (see applyFix.ts),
 * passing along enough to re-locate the exact violation.
 */

import * as vscode from 'vscode';

import { DIAGNOSTIC_SOURCE } from './diagnostics';

export const FIX_COMMAND = 'a11y-autofix.fix';

function ruleIdFor(diagnostic: vscode.Diagnostic): string {
  const { code } = diagnostic;
  if (typeof code === 'object' && code !== null && 'value' in code) {
    return String(code.value);
  }
  return String(code);
}

function buildCodeAction(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction {
  const ruleId = ruleIdFor(diagnostic);
  const action = new vscode.CodeAction(
    `Fix with a11y-autofix: ${ruleId}`,
    vscode.CodeActionKind.QuickFix,
  );
  action.diagnostics = [diagnostic];
  action.isPreferred = true;
  action.command = {
    command: FIX_COMMAND,
    title: 'Fix with a11y-autofix',
    arguments: [document.uri, diagnostic.range, ruleId],
  };
  return action;
}

export class A11yAutofixCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter((diagnostic) => diagnostic.source === DIAGNOSTIC_SOURCE)
      .map((diagnostic) => buildCodeAction(document, diagnostic));
  }
}
