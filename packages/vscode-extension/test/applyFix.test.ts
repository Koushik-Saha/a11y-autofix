import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectViolations, gatherContext, resolveFix, applyPatchToSource } = vi.hoisted(() => ({
  detectViolations: vi.fn(),
  gatherContext: vi.fn(),
  resolveFix: vi.fn(),
  applyPatchToSource: vi.fn(),
}));

vi.mock('a11y-autofix', () => ({
  detectViolations,
  gatherContext,
  resolveFix,
  applyPatchToSource,
}));

import * as vscode from 'vscode';

import { applyFix } from '../src/applyFix';
import { resetVscodeMock, window, workspace } from './vscode-mock';

function violation(id = 'image-alt'): Record<string, unknown> {
  return {
    id,
    impact: 'critical',
    description: 'Ensure <img> elements have alternative text',
    help: 'Images must have alternative text',
    helpUrl: 'https://example.com',
    nodes: [],
  };
}

function context(startLine = 8, startColumn = 5): Record<string, unknown> {
  return { element: { location: { startLine, startColumn, endLine: 8, endColumn: 30 } } };
}

function fakeDocument(
  opts: { isDirty?: boolean; text?: string; fsPath?: string } = {},
): vscode.TextDocument {
  const text = opts.text ?? '<img src="x.png" />';
  return {
    uri: { fsPath: opts.fsPath ?? '/repo/Avatar.tsx' },
    isDirty: opts.isDirty ?? false,
    getText: () => text,
    positionAt: (offset: number) => new vscode.Position(0, offset),
  } as unknown as vscode.TextDocument;
}

const range = new vscode.Range(new vscode.Position(7, 4), new vscode.Position(7, 29));

describe('applyFix', () => {
  beforeEach(() => {
    resetVscodeMock();
    detectViolations.mockReset();
    gatherContext.mockReset();
    resolveFix.mockReset();
    applyPatchToSource.mockReset();
  });

  it('refuses to run when the document is dirty', async () => {
    const document = fakeDocument({ isDirty: true });

    await applyFix(document, range, 'image-alt');

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('save the file'),
    );
    expect(detectViolations).not.toHaveBeenCalled();
  });

  it('reports "could not re-locate" when no candidate matches the diagnostic position', async () => {
    detectViolations.mockResolvedValue({ violations: [violation('image-alt')] });
    gatherContext.mockResolvedValue(context(99, 1));

    await applyFix(fakeDocument(), range, 'image-alt');

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("couldn't re-locate"),
    );
    expect(resolveFix).not.toHaveBeenCalled();
  });

  it('disambiguates multiple same-rule violations by exact start position', async () => {
    detectViolations.mockResolvedValue({
      violations: [violation('image-alt'), violation('image-alt')],
    });
    gatherContext.mockResolvedValueOnce(context(1, 1)).mockResolvedValueOnce(context(8, 5)); // matches `range` (0-indexed 7,4)
    resolveFix.mockResolvedValue({
      patch: { confidence: 'high' },
      verification: { status: 'verified' },
    });
    applyPatchToSource.mockReturnValue('<img src="x.png" alt="" />');

    await applyFix(fakeDocument(), range, 'image-alt');

    expect(resolveFix).toHaveBeenCalledTimes(1);
    expect(resolveFix).toHaveBeenCalledWith(context(8, 5), violation('image-alt'));
  });

  it('applies the patched source via WorkspaceEdit when verification succeeds', async () => {
    detectViolations.mockResolvedValue({ violations: [violation('image-alt')] });
    gatherContext.mockResolvedValue(context(8, 5));
    resolveFix.mockResolvedValue({
      patch: { confidence: 'high' },
      verification: { status: 'verified' },
    });
    applyPatchToSource.mockReturnValue('<img src="x.png" alt="patched" />');

    await applyFix(fakeDocument(), range, 'image-alt');

    expect(workspace.applyEdit).toHaveBeenCalledTimes(1);
    const edit = workspace.applyEdit.mock.calls[0]![0];
    expect(edit.replacements[0].text).toBe('<img src="x.png" alt="patched" />');
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('confidence: high'),
    );
  });

  it('does not touch the workspace when verification fails', async () => {
    detectViolations.mockResolvedValue({ violations: [violation('image-alt')] });
    gatherContext.mockResolvedValue(context(8, 5));
    resolveFix.mockResolvedValue({
      patch: { confidence: 'low' },
      verification: { status: 'unverified', remainingViolations: [violation('image-alt')] },
    });

    await applyFix(fakeDocument(), range, 'image-alt');

    expect(workspace.applyEdit).not.toHaveBeenCalled();
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("didn't verify"),
    );
  });

  it('reports an error and applies nothing when resolveFix throws', async () => {
    detectViolations.mockResolvedValue({ violations: [violation('image-alt')] });
    gatherContext.mockResolvedValue(context(8, 5));
    resolveFix.mockRejectedValue(new Error('Claude API error'));

    await applyFix(fakeDocument(), range, 'image-alt');

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Claude API error'),
    );
    expect(workspace.applyEdit).not.toHaveBeenCalled();
  });
});
