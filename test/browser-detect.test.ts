import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only generateFix needs live Claude credentials, so it's replaced with
// the fix generate/'s contrast plan asks for (#cccccc darkened to
// #767676, nothing else changed). Everything else — esbuild, Chromium,
// axe-core, context/, verify/ — runs for real. The rest of generate/
// (NotAutoFixableError, used by scan.ts) stays real.
vi.mock('../src/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate')>()),
  generateFix: vi.fn(),
}));

import { runScan } from '../src/cli';
import { gatherContext } from '../src/context';
import { detectViolations } from '../src/detect';
import type { AxeViolation } from '../src/detect';
import { generateFix } from '../src/generate';
import { scan } from '../src/scan';
import { verifyFix } from '../src/verify';

import { chromiumAvailable } from './helpers/chromium';

const fixturesDir = path.join(__dirname, 'fixtures');
const fixture = (name: string) => path.join(fixturesDir, name);

const contrastCases = [
  { label: 'React', fixtureName: 'LowContrastText.tsx' },
  { label: 'Vue', fixtureName: 'VueLowContrastText.vue' },
];

/** The minimal fix: only the text color changes, to the value generate/ suggests. */
const darkenText = (oldSnippet: string) => oldSnippet.replace('#cccccc', '#767676');

function mockGenerateFix(buildFix: (oldSnippet: string) => string): void {
  vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
    filePath: context.componentPath,
    violationId: context.violation.id,
    oldSnippet: context.element.code,
    newSnippet: buildFix(context.element.code),
  }));
}

async function findContrastViolation(componentPath: string): Promise<AxeViolation> {
  const { violations } = await detectViolations({ componentPath, browser: true });
  const violation = violations.find((v) => v.id === 'color-contrast');
  if (!violation) throw new Error(`expected a color-contrast violation in ${componentPath}`);
  return violation;
}

beforeEach(() => {
  vi.mocked(generateFix).mockReset();
});

describe.runIf(chromiumAvailable)('browser mode: detection in headless Chromium', () => {
  it.each(contrastCases)(
    'reports color-contrast for the $label low-contrast fixture',
    async ({ fixtureName }) => {
      const violation = await findContrastViolation(fixture(fixtureName));

      expect(violation.impact).toBe('serious');
      expect(violation.nodes).toHaveLength(1);
      expect(violation.nodes[0]?.target).toEqual(['p']);
      expect(violation.nodes[0]?.html).toContain('<p');
      expect(violation.nodes[0]?.failureSummary).toContain(
        'foreground color: #cccccc, background color: #ffffff',
      );
      expect(violation.nodes[0]?.failureSummary).toContain('Expected contrast ratio of 4.5:1');
    },
  );

  it('returns exactly the same violations as jsdom for every fixture, apart from color-contrast', async () => {
    const jsdom = await detectViolations({ componentPath: fixturesDir });
    const browser = await detectViolations({ componentPath: fixturesDir, browser: true });

    const withoutContrast = (violations: AxeViolation[]) =>
      violations.filter((violation) => violation.id !== 'color-contrast');

    expect(withoutContrast(browser.violations)).toEqual(jsdom.violations);
    expect(jsdom.violations.some((violation) => violation.id === 'color-contrast')).toBe(false);
    expect(
      browser.violations.filter((violation) => violation.id === 'color-contrast'),
    ).toHaveLength(contrastCases.length);
  });

  it('reports no violations for an accessible component', async () => {
    for (const name of ['AccessibleCard.tsx', 'VueAccessibleCard.vue']) {
      const { violations } = await detectViolations({
        componentPath: fixture(name),
        browser: true,
      });
      expect(violations).toEqual([]);
    }
  });

  describe('a component that fails to render', () => {
    let tempDir: string;
    beforeEach(() => {
      // Inside the repo so esbuild can resolve react from node_modules.
      tempDir = mkdtempSync(path.join(__dirname, 'tmp-browser-'));
    });
    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('rejects instead of reporting zero violations', async () => {
      const componentPath = path.join(tempDir, 'Broken.tsx');
      writeFileSync(
        componentPath,
        "export default function Broken(): never { throw new Error('boom during render'); }\n",
      );

      await expect(detectViolations({ componentPath, browser: true })).rejects.toThrow(
        /Failed to render .*Broken\.tsx in Chromium: .*boom during render/,
      );
    });
  });
});

describe.runIf(chromiumAvailable)('browser mode: fixing color-contrast', () => {
  it.each(contrastCases)(
    'verifies a minimal text-color fix for the $label fixture',
    async ({ fixtureName }) => {
      const componentPath = fixture(fixtureName);
      const violation = await findContrastViolation(componentPath);
      const context = await gatherContext({ violation, componentPath });
      expect(context.element.code).toContain('#cccccc');

      const result = await verifyFix({
        patch: {
          filePath: componentPath,
          violationId: violation.id,
          oldSnippet: context.element.code,
          newSnippet: darkenText(context.element.code),
        },
        originalViolation: violation,
        browser: true,
      });

      expect(result.status).toBe('verified');
      expect(result.remainingViolations).toEqual([]);
      expect(result.newViolations).toEqual([]);
    },
  );

  it('does not verify a color change that is still too light', async () => {
    const componentPath = fixture('LowContrastText.tsx');
    const violation = await findContrastViolation(componentPath);
    const context = await gatherContext({ violation, componentPath });

    const result = await verifyFix({
      patch: {
        filePath: componentPath,
        violationId: violation.id,
        oldSnippet: context.element.code,
        // #999999 on white is ~2.8:1 — better, but still failing.
        newSnippet: context.element.code.replace('#cccccc', '#999999'),
      },
      originalViolation: violation,
      browser: true,
    });

    expect(result.status).toBe('unverified');
    expect(result.remainingViolations.map((v) => v.id)).toEqual(['color-contrast']);
  });

  it('refuses to verify a color-contrast fix in jsdom mode, where it would always "pass"', async () => {
    const componentPath = fixture('LowContrastText.tsx');
    const violation = await findContrastViolation(componentPath);
    const context = await gatherContext({ violation, componentPath });

    await expect(
      verifyFix({
        patch: {
          filePath: componentPath,
          violationId: violation.id,
          oldSnippet: context.element.code,
          newSnippet: context.element.code.replace('#cccccc', '#cccccd'),
        },
        originalViolation: violation,
      }),
    ).rejects.toThrow(/only be verified in browser mode/);
  });

  it.each(contrastCases)(
    'scan({ browser: true }) returns a verified, high-confidence fix for the $label fixture',
    async ({ fixtureName }) => {
      mockGenerateFix(darkenText);

      const result = await scan(fixture(fixtureName), { browser: true });

      expect(result.violations).toHaveLength(1);
      const [entry] = result.violations;
      if (entry?.status !== 'verified') {
        throw new Error(`expected a verified result, got ${JSON.stringify(entry)}`);
      }
      expect(entry.violation.id).toBe('color-contrast');
      expect(entry.patch.confidence).toBe('high');
      expect(entry.patch.newSnippet).toContain('#767676');
      expect(entry.applied).toBe(false);
      expect(vi.mocked(generateFix)).toHaveBeenCalledTimes(1);
    },
  );

  it('scan() without browser mode finds nothing to fix in the same fixture', async () => {
    const result = await scan(fixture('LowContrastText.tsx'));
    expect(result.violations).toEqual([]);
    expect(vi.mocked(generateFix)).not.toHaveBeenCalled();
  });

  describe('CLI', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let previousExitCode: typeof process.exitCode;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      previousExitCode = process.exitCode;
    });
    afterEach(() => {
      logSpy.mockRestore();
      process.exitCode = previousExitCode;
    });

    it('scan --browser reports the violation and a verified fix', async () => {
      mockGenerateFix(darkenText);

      const summary = await runScan(fixture('LowContrastText.tsx'), { browser: true });

      expect(summary).toMatchObject({ violationsFound: 1, verified: 1, unverified: 0, errored: 0 });
      const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('[violation] color-contrast (serious)');
      expect(output).toContain("-<p style={{ color: '#cccccc', backgroundColor: '#ffffff' }}>");
      expect(output).toContain("+<p style={{ color: '#767676', backgroundColor: '#ffffff' }}>");
      expect(output).toContain('[verified] fix confirmed (pass --write to apply)');
    });
  });
});
