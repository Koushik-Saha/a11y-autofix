/**
 * extension.ts — activation entry point. Wires the diagnostics scanner
 * (diagnostics.ts), the quick-fix provider (codeActions.ts), and the fix
 * command (applyFix.ts) together; owns nothing about detection, fixing,
 * or verification itself.
 */

import * as vscode from 'vscode';

import { applyFix } from './applyFix';
import { A11yAutofixCodeActionProvider } from './codeActions';
import { DIAGNOSTIC_SOURCE, isSupportedDocument, scanDocument } from './diagnostics';

const DOCUMENT_SELECTOR: vscode.DocumentFilter[] = [
  { language: 'javascriptreact' },
  { language: 'typescriptreact' },
  { language: 'vue' },
];

/**
 * The core library's `generateFix` reads its Anthropic API key the same
 * way the Anthropic SDK always does — `process.env.ANTHROPIC_API_KEY` —
 * so the only way for the `a11yAutofix.anthropicApiKey` setting to reach
 * it is to set that env var ourselves. Diagnostics never call generateFix,
 * so scanning works with no key set at all; this only matters once a fix
 * is actually requested.
 */
function syncApiKeySetting(): void {
  const configured = vscode.workspace
    .getConfiguration('a11yAutofix')
    .get<string>('anthropicApiKey', '');
  if (configured) {
    process.env.ANTHROPIC_API_KEY = configured;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  context.subscriptions.push(diagnosticCollection);

  syncApiKeySetting();

  async function rescan(document: vscode.TextDocument): Promise<void> {
    if (!isSupportedDocument(document)) return;
    const diagnostics = await scanDocument(document);
    diagnosticCollection.set(document.uri, diagnostics);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => void rescan(document)),
    vscode.workspace.onDidSaveTextDocument((document) => void rescan(document)),
    vscode.workspace.onDidCloseTextDocument((document) =>
      diagnosticCollection.delete(document.uri),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('a11yAutofix.anthropicApiKey')) syncApiKeySetting();
      // Rescan so a rule newly added to/removed from disabledRules takes
      // effect immediately, rather than waiting for the next open/save.
      if (event.affectsConfiguration('a11yAutofix.disabledRules')) {
        for (const document of vscode.workspace.textDocuments) {
          void rescan(document);
        }
      }
    }),
    vscode.languages.registerCodeActionsProvider(
      DOCUMENT_SELECTOR,
      new A11yAutofixCodeActionProvider(),
      {
        providedCodeActionKinds: A11yAutofixCodeActionProvider.providedCodeActionKinds,
      },
    ),
    vscode.commands.registerCommand(
      'a11y-autofix.fix',
      async (uri: vscode.Uri, range: vscode.Range, ruleId: string) => {
        const document = await vscode.workspace.openTextDocument(uri);
        await applyFix(document, range, ruleId);
      },
    ),
    vscode.commands.registerCommand('a11y-autofix.rescan', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document) await rescan(document);
    }),
  );

  for (const document of vscode.workspace.textDocuments) {
    void rescan(document);
  }
}

export function deactivate(): void {
  // Nothing to tear down beyond what context.subscriptions already disposes.
}
