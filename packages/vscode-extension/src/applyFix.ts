/**
 * applyFix.ts — the `a11y-autofix.fix` command handler. Re-locates the
 * violation a diagnostic pointed at, then hands it to the core library's
 * own `resolveFix` (generate + verify + one retry + confidence) and
 * `applyPatchToSource` — no generation, verification, or patch-application
 * logic is reimplemented here.
 */

import * as vscode from 'vscode';
import { detectViolations, gatherContext, resolveFix, applyPatchToSource } from 'a11y-autofix';
import type { AxeViolation, FixContext } from 'a11y-autofix';

/**
 * Diagnostics don't carry a live reference back to the AxeViolation that
 * produced them, so the fix command re-runs detectViolations and matches
 * by rule id plus gatherContext's own start position — the same position
 * diagnostics.ts used to place the squiggle in the first place. If the
 * file changed since the last scan, positions won't line up and this
 * correctly returns null (rather than guessing and fixing the wrong
 * element) — the caller reports that as "couldn't re-locate."
 */
async function findViolation(
  componentPath: string,
  ruleId: string,
  range: vscode.Range,
): Promise<{ violation: AxeViolation; context: FixContext } | null> {
  const { violations } = await detectViolations({ componentPath });
  const candidates = violations.filter((violation) => violation.id === ruleId);

  for (const violation of candidates) {
    const context = await gatherContext({ violation, componentPath });
    const { startLine, startColumn } = context.element.location;
    if (startLine - 1 === range.start.line && startColumn - 1 === range.start.character) {
      return { violation, context };
    }
  }
  return null;
}

export async function applyFix(
  document: vscode.TextDocument,
  range: vscode.Range,
  ruleId: string,
): Promise<void> {
  if (document.isDirty) {
    void vscode.window.showWarningMessage(
      'a11y-autofix: save the file before applying a fix — unsaved changes could shift where the violation actually is.',
    );
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `a11y-autofix: fixing ${ruleId}…` },
    async () => {
      const componentPath = document.uri.fsPath;

      const located = await findViolation(componentPath, ruleId, range);
      if (!located) {
        void vscode.window.showErrorMessage(
          `a11y-autofix: couldn't re-locate the "${ruleId}" violation — the file may have changed since the last scan. Try "a11y-autofix: Rescan this file".`,
        );
        return;
      }

      const resolved = await resolveFix(located.context, located.violation).catch(
        (error: unknown) => {
          void vscode.window.showErrorMessage(`a11y-autofix: ${(error as Error).message}`);
          return null;
        },
      );
      if (!resolved) return;

      if (resolved.verification.status !== 'verified') {
        const stillFlagged = resolved.verification.remainingViolations
          .map((violation: AxeViolation) => violation.id)
          .join(', ');
        void vscode.window.showWarningMessage(
          `a11y-autofix: the generated fix for "${ruleId}" didn't verify${stillFlagged ? ` (still flagged: ${stillFlagged})` : ''}. Nothing was changed.`,
        );
        return;
      }

      const currentSource = document.getText();
      const patchedSource = applyPatchToSource(currentSource, resolved.patch);
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(currentSource.length),
      );

      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, fullRange, patchedSource);
      const applied = await vscode.workspace.applyEdit(edit);

      if (applied) {
        void vscode.window.showInformationMessage(
          `a11y-autofix: fixed "${ruleId}" (confidence: ${resolved.patch.confidence}). Save the file to clear the diagnostic.`,
        );
      } else {
        void vscode.window.showErrorMessage('a11y-autofix: VS Code rejected the edit.');
      }
    },
  );
}
