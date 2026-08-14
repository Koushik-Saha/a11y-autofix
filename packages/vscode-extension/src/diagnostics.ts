/**
 * diagnostics.ts — turns a11y-autofix's own `detectViolations` +
 * `gatherContext` output into VS Code `Diagnostic`s (the red squiggles).
 * No detection or AST-location logic lives here; this module only
 * translates between the core library's types and VS Code's.
 */

import * as vscode from 'vscode';
import { detectViolations, gatherContext } from 'a11y-autofix';
import type { AxeViolation, FixContext } from 'a11y-autofix';

/** Tags every diagnostic this extension creates, so codeActions.ts can tell ours apart from any other extension's/language server's diagnostics sharing the same range. */
export const DIAGNOSTIC_SOURCE = 'a11y-autofix';

const SUPPORTED_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue']);

function disabledRuleIds(): Set<string> {
  const configured = vscode.workspace
    .getConfiguration('a11yAutofix')
    .get<string[]>('disabledRules', []);
  return new Set(configured);
}

export function isSupportedDocument(document: vscode.TextDocument): boolean {
  const fsPath = document.uri.fsPath;
  const dot = fsPath.lastIndexOf('.');
  if (dot === -1) return false;
  return SUPPORTED_EXTENSIONS.has(fsPath.slice(dot));
}

function rangeFor(context: FixContext): vscode.Range {
  const { startLine, startColumn, endLine, endColumn } = context.element.location;
  // The core library's locations are 1-indexed (line and column); VS
  // Code's Position is 0-indexed for both.
  return new vscode.Range(
    new vscode.Position(startLine - 1, startColumn - 1),
    new vscode.Position(endLine - 1, endColumn - 1),
  );
}

function severityFor(violation: AxeViolation): vscode.DiagnosticSeverity {
  return violation.impact === 'critical' || violation.impact === 'serious'
    ? vscode.DiagnosticSeverity.Error
    : vscode.DiagnosticSeverity.Warning;
}

function toDiagnostic(violation: AxeViolation, context: FixContext): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    rangeFor(context),
    `${violation.help} (${violation.id})`,
    severityFor(violation),
  );
  diagnostic.source = DIAGNOSTIC_SOURCE;
  // Object form (not a bare string) so the Problems panel shows a
  // clickable link to axe-core's own rule documentation, and so
  // codeActions.ts has a single, unambiguous shape to read the rule id
  // back from.
  diagnostic.code = { value: violation.id, target: vscode.Uri.parse(violation.helpUrl) };
  return diagnostic;
}

/**
 * Scans `document`'s file **on disk** — deliberately not the live editor
 * buffer — via the core library's `detectViolations` + `gatherContext`,
 * both of which read from disk. Using the buffer for one and disk for the
 * other risks the squiggle's location drifting from what a fix would
 * actually target; keeping both on the same (disk) content is what keeps
 * them consistent. This is also why scans only run on open/save (see
 * extension.ts), not on every keystroke: an unsaved edit isn't reflected
 * here until it's written to disk.
 *
 * Returns an empty list (rather than throwing) if the file doesn't
 * compile/render right now — e.g. a mid-edit syntax error already has its
 * own red squiggle from TypeScript/ESLint; this extension has nothing
 * useful to add in that case.
 */
export async function scanDocument(document: vscode.TextDocument): Promise<vscode.Diagnostic[]> {
  if (!isSupportedDocument(document)) return [];

  const componentPath = document.uri.fsPath;

  let violations: AxeViolation[];
  try {
    ({ violations } = await detectViolations({ componentPath }));
  } catch {
    return [];
  }

  const disabled = disabledRuleIds();
  const diagnostics: vscode.Diagnostic[] = [];
  for (const violation of violations) {
    if (disabled.has(violation.id)) continue;
    try {
      const context = await gatherContext({ violation, componentPath });
      diagnostics.push(toDiagnostic(violation, context));
    } catch {
      // Couldn't locate this one violation's element — skip just this
      // one rather than losing every diagnostic in the file over it.
    }
  }
  return diagnostics;
}
