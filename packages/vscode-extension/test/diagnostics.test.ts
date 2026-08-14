import { beforeEach, describe, expect, it, vi } from 'vitest';

const { detectViolations, gatherContext } = vi.hoisted(() => ({
  detectViolations: vi.fn(),
  gatherContext: vi.fn(),
}));

vi.mock('a11y-autofix', () => ({ detectViolations, gatherContext }));

import * as vscode from 'vscode';

import { isSupportedDocument, scanDocument } from '../src/diagnostics';
import { resetVscodeMock, setConfigValue } from './vscode-mock';

function fakeDocument(fsPath: string): vscode.TextDocument {
  return { uri: { fsPath } } as unknown as vscode.TextDocument;
}

function violation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'image-alt',
    impact: 'critical',
    description: 'Ensure <img> elements have alternative text',
    help: 'Images must have alternative text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/image-alt',
    nodes: [],
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    element: {
      location: { startLine: 8, startColumn: 5, endLine: 8, endColumn: 30 },
    },
    ...overrides,
  };
}

describe('isSupportedDocument', () => {
  it('accepts .tsx, .jsx, and .vue', () => {
    expect(isSupportedDocument(fakeDocument('/repo/Avatar.tsx'))).toBe(true);
    expect(isSupportedDocument(fakeDocument('/repo/Avatar.jsx'))).toBe(true);
    expect(isSupportedDocument(fakeDocument('/repo/Avatar.vue'))).toBe(true);
  });

  it('rejects other extensions and extensionless paths', () => {
    expect(isSupportedDocument(fakeDocument('/repo/Avatar.ts'))).toBe(false);
    expect(isSupportedDocument(fakeDocument('/repo/README'))).toBe(false);
  });
});

describe('scanDocument', () => {
  beforeEach(() => {
    resetVscodeMock();
    detectViolations.mockReset();
    gatherContext.mockReset();
  });

  it('returns nothing for an unsupported document without calling detectViolations', async () => {
    const diagnostics = await scanDocument(fakeDocument('/repo/index.ts'));
    expect(diagnostics).toEqual([]);
    expect(detectViolations).not.toHaveBeenCalled();
  });

  it('converts each violation into a 0-indexed Diagnostic with source and code set', async () => {
    detectViolations.mockResolvedValue({ violations: [violation()] });
    gatherContext.mockResolvedValue(context());

    const [diagnostic] = await scanDocument(fakeDocument('/repo/Avatar.tsx'));

    expect(diagnostic).toBeDefined();
    expect(diagnostic!.range.start).toEqual({ line: 7, character: 4 });
    expect(diagnostic!.range.end).toEqual({ line: 7, character: 29 });
    expect(diagnostic!.message).toBe('Images must have alternative text (image-alt)');
    expect(diagnostic!.source).toBe('a11y-autofix');
    expect(diagnostic!.code).toMatchObject({ value: 'image-alt' });
    expect(diagnostic!.severity).toBe(vscode.DiagnosticSeverity.Error);
  });

  it('maps non-critical/serious impact to a Warning severity', async () => {
    detectViolations.mockResolvedValue({ violations: [violation({ impact: 'minor' })] });
    gatherContext.mockResolvedValue(context());

    const [diagnostic] = await scanDocument(fakeDocument('/repo/Avatar.tsx'));

    expect(diagnostic!.severity).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it('returns an empty list when detectViolations throws (e.g. mid-edit syntax error)', async () => {
    detectViolations.mockRejectedValue(new Error('parse error'));

    const diagnostics = await scanDocument(fakeDocument('/repo/Avatar.tsx'));

    expect(diagnostics).toEqual([]);
  });

  it('skips a violation whose element cannot be located, keeping the rest', async () => {
    detectViolations.mockResolvedValue({
      violations: [violation({ id: 'image-alt' }), violation({ id: 'link-name' })],
    });
    gatherContext
      .mockRejectedValueOnce(new Error('element not found'))
      .mockResolvedValueOnce(context());

    const diagnostics = await scanDocument(fakeDocument('/repo/Avatar.tsx'));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toMatchObject({ value: 'link-name' });
  });

  it('omits violations whose rule id is in a11yAutofix.disabledRules', async () => {
    detectViolations.mockResolvedValue({
      violations: [violation({ id: 'image-alt' }), violation({ id: 'link-name' })],
    });
    gatherContext.mockResolvedValue(context());
    setConfigValue('a11yAutofix.disabledRules', ['image-alt']);

    const diagnostics = await scanDocument(fakeDocument('/repo/Avatar.tsx'));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toMatchObject({ value: 'link-name' });
    // gatherContext is skipped entirely for a disabled rule, not just
    // filtered afterward — it's the more expensive of the two calls.
    expect(gatherContext).toHaveBeenCalledTimes(1);
  });

  it('shows every violation when disabledRules is unset (the default)', async () => {
    detectViolations.mockResolvedValue({
      violations: [violation({ id: 'image-alt' }), violation({ id: 'link-name' })],
    });
    gatherContext.mockResolvedValue(context());

    const diagnostics = await scanDocument(fakeDocument('/repo/Avatar.tsx'));

    expect(diagnostics).toHaveLength(2);
  });
});
