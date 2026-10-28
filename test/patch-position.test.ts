import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only generateFix needs live Claude credentials. It's replaced with a fix
// that adds alt text and — like the real one — records the element's
// position from context/. detect/, context/, verify/ and scan/ run for real.
vi.mock('../src/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate')>()),
  generateFix: vi.fn(),
}));

import { gatherContext } from '../src/context';
import type { FixContext } from '../src/context';
import { detectViolations } from '../src/detect';
import type { AxeViolation } from '../src/detect';
import { generateFix } from '../src/generate';
import type { Patch } from '../src/generate';
import { scan } from '../src/scan';
import type { ScanViolationFixed, ScanViolationResult } from '../src/scan';
import { StalePatchError, applyPatchToSource, verifyFix } from '../src/verify';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

const addAlt = (code: string) => code.replace('<img ', '<img alt="Product photo" ');

function positionedPatch(context: FixContext, newSnippet: string): Patch {
  return {
    filePath: context.componentPath,
    violationId: context.violation.id,
    oldSnippet: context.element.code,
    newSnippet,
    position: {
      start: context.element.location.startOffset,
      end: context.element.location.endOffset,
    },
  };
}

function mockAltFix(): void {
  vi.mocked(generateFix).mockImplementation(async ({ context }) =>
    positionedPatch(context, addAlt(context.element.code)),
  );
}

function fixed(results: ScanViolationResult[]): ScanViolationFixed[] {
  return results.map((entry) => {
    if (entry.status === 'errored') throw new Error(`unexpected errored entry: ${entry.error}`);
    return entry;
  });
}

let tempDir: string;

beforeEach(() => {
  vi.mocked(generateFix).mockReset();
  // Inside the repo so esbuild can resolve react from node_modules.
  tempDir = mkdtempSync(path.join(__dirname, 'tmp-position-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** A writable copy of a fixture, so tests can edit or --write it. */
function copyFixture(name: string): string {
  const copy = path.join(tempDir, name);
  copyFileSync(fixture(name), copy);
  return copy;
}

describe('applyPatchToSource', () => {
  const source = 'a <img /> b <img /> c';
  const second = { start: 12, end: 19 };

  it('replaces the occurrence at the recorded position, not the first match', () => {
    const patch: Patch = {
      filePath: 'X.tsx',
      violationId: 'image-alt',
      oldSnippet: '<img />',
      newSnippet: '<img alt="x" />',
      position: second,
    };
    expect(applyPatchToSource(source, patch)).toBe('a <img /> b <img alt="x" /> c');
  });

  it('refuses a position whose text no longer matches oldSnippet', () => {
    const patch: Patch = {
      filePath: 'src/Gallery.tsx',
      violationId: 'image-alt',
      oldSnippet: '<img />',
      newSnippet: '<img alt="x" />',
      position: second,
    };
    const edited = `// a new first line\n${source}`;

    expect(() => applyPatchToSource(edited, patch)).toThrow(StalePatchError);
    expect(() => applyPatchToSource(edited, patch)).toThrow(
      'Cannot apply the "image-alt" fix to src/Gallery.tsx: file changed since scan — "<img />" is no longer where it was when scanned. Re-run scan to get a fresh fix.',
    );
  });

  it('refuses a position past the end of a file that got shorter', () => {
    const patch: Patch = {
      filePath: 'X.tsx',
      violationId: 'image-alt',
      oldSnippet: '<img />',
      newSnippet: '<img alt="x" />',
      position: second,
    };
    expect(() => applyPatchToSource('a <img />', patch)).toThrow(/file changed since scan/);
  });

  it('inserts newSnippet literally, even when it contains "$&"-style sequences', () => {
    const newSnippet = '<img alt="$& $1 $$" />';
    const base = { filePath: 'X.tsx', violationId: 'image-alt', oldSnippet: '<img />', newSnippet };
    expect(applyPatchToSource('a <img /> b', { ...base, position: { start: 2, end: 9 } })).toBe(
      `a ${newSnippet} b`,
    );
    expect(applyPatchToSource('a <img /> b', base)).toBe(`a ${newSnippet} b`);
  });

  describe('a patch without a position (from before positions were recorded)', () => {
    const legacy: Patch = {
      filePath: 'X.tsx',
      violationId: 'image-alt',
      oldSnippet: '<img />',
      newSnippet: '<img alt="x" />',
    };

    it('still applies when oldSnippet occurs exactly once', () => {
      expect(applyPatchToSource('a <img /> b', legacy)).toBe('a <img alt="x" /> b');
    });

    it('still refuses to guess between several occurrences', () => {
      expect(() => applyPatchToSource(source, legacy)).toThrow(
        'expected its oldSnippet to appear exactly once in the source, found 2 (in X.tsx)',
      );
    });
  });
});

describe.each([
  { label: 'React siblings', name: 'DuplicateMissingAlt.tsx', lines: [11, 12] },
  {
    label: 'React, inside identical parents',
    name: 'DuplicateMissingAltInCards.tsx',
    lines: [11, 14],
  },
  { label: 'Vue siblings', name: 'VueDuplicateMissingAlt.vue', lines: [7, 8] },
])('two identical offending elements ($label)', ({ name, lines }) => {
  async function detectImageAlt(componentPath: string): Promise<AxeViolation> {
    const { violations } = await detectViolations({ componentPath });
    const violation = violations.find((v) => v.id === 'image-alt');
    if (!violation) throw new Error(`expected an image-alt violation in ${componentPath}`);
    return violation;
  }

  it('scanning produces one violation, patch and verified fix per element', async () => {
    mockAltFix();
    const componentPath = fixture(name);
    const sourceBefore = readFileSync(componentPath, 'utf8');

    expect((await detectImageAlt(componentPath)).nodes).toHaveLength(2);

    const entries = fixed((await scan(componentPath)).violations);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.status)).toEqual(['verified', 'verified']);
    expect(entries.map((entry) => entry.violation.nodes.length)).toEqual([1, 1]);
    expect(entries.map((entry) => entry.context.element.location.startLine)).toEqual(lines);
    expect(entries.every((entry) => entry.verification.remainingViolations.length === 0)).toBe(
      true,
    );

    // Same text, different places.
    const [first, second] = entries.map((entry) => entry.patch);
    expect(first?.oldSnippet).toBe(second?.oldSnippet);
    expect(first?.position?.start).toBeLessThan(second?.position?.start ?? 0);

    // Each patch, applied on its own, touches only its own element.
    for (const [index, entry] of entries.entries()) {
      const patchedLines = applyPatchToSource(sourceBefore, entry.patch).split('\n');
      const originalLines = sourceBefore.split('\n');
      const changed = patchedLines
        .map((line, lineIndex) => (line === originalLines[lineIndex] ? null : lineIndex + 1))
        .filter((line) => line !== null);
      expect(changed).toEqual([lines[index]]);
    }

    expect(readFileSync(componentPath, 'utf8')).toBe(sourceBefore);
  });

  it('with write, applies both fixes and leaves no image-alt violation', async () => {
    mockAltFix();
    const componentPath = copyFixture(name);

    const entries = fixed((await scan(componentPath, { write: true })).violations);

    expect(entries.map((entry) => [entry.status, entry.applied])).toEqual([
      ['verified', true],
      ['verified', true],
    ]);
    const written = readFileSync(componentPath, 'utf8');
    expect(written.match(/alt="Product photo"/g)).toHaveLength(2);
    const { violations } = await detectViolations({ componentPath });
    expect(violations).toEqual([]);
  });

  it('holds a patch responsible only for its own element', async () => {
    const componentPath = fixture(name);
    const violation = await detectImageAlt(componentPath);
    const [firstNode] = violation.nodes;
    const target = { ...violation, nodes: [firstNode!] };
    const context = await gatherContext({ violation: target, componentPath });

    // Fixing the first element verifies even though the second still fails.
    const fixedFirst = await verifyFix({
      patch: positionedPatch(context, addAlt(context.element.code)),
      originalViolation: target,
    });
    expect(fixedFirst.status).toBe('verified');

    // A patch that doesn't fix the first element is reported against that
    // element alone, not the identical one it didn't touch.
    const ineffective = await verifyFix({
      patch: positionedPatch(context, context.element.code.replace('<img ', '<img data-x="1" ')),
      originalViolation: target,
    });
    expect(ineffective.status).toBe('unverified');
    expect(ineffective.remainingViolations).toHaveLength(1);
    expect(ineffective.remainingViolations[0]?.nodes).toHaveLength(1);
    expect(ineffective.remainingViolations[0]?.nodes[0]?.html).toContain('data-x="1"');
  });

  it('a patch without a position still refuses the ambiguous match', async () => {
    const componentPath = fixture(name);
    const violation = await detectImageAlt(componentPath);
    const context = await gatherContext({ violation, componentPath });
    const { position: _position, ...legacy } = positionedPatch(
      context,
      addAlt(context.element.code),
    );

    await expect(verifyFix({ patch: legacy, originalViolation: violation })).rejects.toThrow(
      /exactly once in the source, found 2/,
    );
  });
});

describe('one JSX element rendered several times by .map()', () => {
  it('stays a single violation with a single patch', async () => {
    mockAltFix();

    const entries = fixed((await scan(fixture('MappedMissingAlt.tsx'))).violations);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.violation.nodes).toHaveLength(3);
    expect(entries[0]?.status).toBe('verified');
    expect(vi.mocked(generateFix)).toHaveBeenCalledTimes(1);
  });
});

describe('the file changes between scan and apply', () => {
  const STALE = /file changed since scan .*Re-run scan to get a fresh fix\./;

  it('applyPatchToSource and verifyFix fail with a clear re-run error', async () => {
    mockAltFix();
    const componentPath = copyFixture('DuplicateMissingAlt.tsx');
    const [entry] = fixed((await scan(componentPath)).violations);

    // Someone edits the file above the elements after the scan.
    const edited = readFileSync(componentPath, 'utf8').replace(
      '    <div>\n',
      '    <div>\n      <h1>Gallery</h1>\n',
    );
    writeFileSync(componentPath, edited, 'utf8');

    expect(() => applyPatchToSource(edited, entry!.patch)).toThrow(StalePatchError);
    expect(() => applyPatchToSource(edited, entry!.patch)).toThrow(STALE);
    await expect(
      verifyFix({ patch: entry!.patch, originalViolation: entry!.violation }),
    ).rejects.toThrow(STALE);
    // Nothing was patched — in particular not the other, identical <img>.
    expect(readFileSync(componentPath, 'utf8')).toBe(edited);
  });

  it('the write step reports the stale fix instead of patching the wrong element', async () => {
    mockAltFix();
    const componentPath = copyFixture('DuplicateMissingAlt.tsx');
    let edited = '';

    const result = await scan(componentPath, {
      write: true,
      // Simulates an edit landing while the user reviews the first fix.
      onVerifiedFix: async () => {
        if (!edited) {
          edited = readFileSync(componentPath, 'utf8').replace(
            '    <div>\n',
            '    <div>\n      <h1>Gallery</h1>\n',
          );
          writeFileSync(componentPath, edited, 'utf8');
        }
        return { action: 'accept' };
      },
    });

    // The first fix's position no longer holds its element; the second
    // element's axe selector came from the old render, so it's not
    // re-located in the edited file either.
    expect(result.violations.map((entry) => entry.status)).toEqual(['errored', 'errored']);
    for (const entry of result.violations) {
      expect(entry.status === 'errored' && entry.error).toMatch(STALE);
    }
    expect(readFileSync(componentPath, 'utf8')).toBe(edited);
  });
});
