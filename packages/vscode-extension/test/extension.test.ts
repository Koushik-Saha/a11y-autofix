import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectViolations, gatherContext } = vi.hoisted(() => ({
  detectViolations: vi.fn(async () => ({ violations: [] })),
  gatherContext: vi.fn(),
}));

vi.mock('a11y-autofix', () => ({ detectViolations, gatherContext }));

import { activate } from '../src/extension';
import { commands, languages, resetVscodeMock, workspace } from './vscode-mock';

function fakeContext(): { subscriptions: unknown[] } {
  return { subscriptions: [] };
}

/** `rescan`'s callers do `void rescan(document)`, discarding the promise, so tests can't await the listener call directly — flush the microtask/macrotask queue instead until the async work behind it has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('activate', () => {
  beforeEach(() => {
    resetVscodeMock();
    detectViolations.mockClear();
  });

  it('creates a diagnostic collection, registers the code action provider, and registers both commands', () => {
    const context = fakeContext();

    activate(context as unknown as Parameters<typeof activate>[0]);

    expect(languages.createDiagnosticCollection).toHaveBeenCalledWith('a11y-autofix');
    expect(languages.registerCodeActionsProvider).toHaveBeenCalledTimes(1);
    expect(commands.registerCommand).toHaveBeenCalledWith('a11y-autofix.fix', expect.any(Function));
    expect(commands.registerCommand).toHaveBeenCalledWith(
      'a11y-autofix.rescan',
      expect.any(Function),
    );
    expect(context.subscriptions.length).toBeGreaterThan(0);
  });

  it('scans already-open supported documents on activation', () => {
    workspace.textDocuments = [{ uri: { fsPath: '/repo/Avatar.tsx' } }];

    activate(fakeContext() as unknown as Parameters<typeof activate>[0]);

    expect(detectViolations).toHaveBeenCalledWith({ componentPath: '/repo/Avatar.tsx' });
  });

  it('rescans and updates the diagnostic collection when a document is saved', async () => {
    detectViolations.mockResolvedValue({
      violations: [
        { id: 'image-alt', impact: 'critical', help: 'x', helpUrl: 'https://x', nodes: [] },
      ],
    });
    gatherContext.mockResolvedValue({
      element: { location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 } },
    });

    activate(fakeContext() as unknown as Parameters<typeof activate>[0]);
    const collection = languages.createDiagnosticCollection.mock.results[0]!.value as {
      set: ReturnType<typeof vi.fn>;
    };
    const onSave = workspace.onDidSaveTextDocument.mock.calls[0]![0] as (doc: unknown) => void;
    const document = { uri: { fsPath: '/repo/Avatar.tsx' } };

    onSave(document);
    await flush();

    expect(collection.set).toHaveBeenCalledWith(
      document.uri,
      expect.arrayContaining([expect.anything()]),
    );
  });

  it('rescans every open document when a11yAutofix.disabledRules changes', async () => {
    workspace.textDocuments = [
      { uri: { fsPath: '/repo/A.tsx' } },
      { uri: { fsPath: '/repo/B.vue' } },
    ];

    activate(fakeContext() as unknown as Parameters<typeof activate>[0]);
    await flush();
    detectViolations.mockClear();

    const onChange = workspace.onDidChangeConfiguration.mock.calls[0]![0] as (event: {
      affectsConfiguration: (key: string) => boolean;
    }) => void;
    onChange({ affectsConfiguration: (key) => key === 'a11yAutofix.disabledRules' });
    await flush();

    expect(detectViolations).toHaveBeenCalledWith({ componentPath: '/repo/A.tsx' });
    expect(detectViolations).toHaveBeenCalledWith({ componentPath: '/repo/B.vue' });
  });

  it('does not rescan on an unrelated configuration change', async () => {
    workspace.textDocuments = [{ uri: { fsPath: '/repo/A.tsx' } }];

    activate(fakeContext() as unknown as Parameters<typeof activate>[0]);
    await flush();
    detectViolations.mockClear();

    const onChange = workspace.onDidChangeConfiguration.mock.calls[0]![0] as (event: {
      affectsConfiguration: (key: string) => boolean;
    }) => void;
    onChange({ affectsConfiguration: (key) => key === 'editor.fontSize' });
    await flush();

    expect(detectViolations).not.toHaveBeenCalled();
  });
});
