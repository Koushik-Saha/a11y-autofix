import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only generateFix needs live Claude credentials; config/, detect/,
// context/, verify/, scan/ and cli/ run for real.
vi.mock('../src/generate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/generate')>()),
  generateFix: vi.fn(),
}));

import { runScan } from '../src/cli';
import type { CliScanOptions } from '../src/cli';
import {
  CONFIG_FILE_NAME,
  ConfigError,
  DEFAULT_SETTINGS,
  loadProjectConfig,
  resolveSettings,
} from '../src/config';
import { generateFix } from '../src/generate';
import { scan } from '../src/scan';

// One element per impact level: empty-heading (minor), heading-order
// (moderate), link-name (serious), and two image-alt (critical).
const MIXED_SOURCE = `export default function Team() {
  return (
    <main>
      <h1>Team</h1>
      <img src="/team/ceo.jpg" />
      <img src="/team/cto.jpg" />
      <a href="/team"></a>
      <h4></h4>
    </main>
  );
}
`;

const FIXES: Record<string, (code: string) => string> = {
  'image-alt': (code) => code.replace('<img ', '<img alt="Team member portrait" '),
  'link-name': () => '<a href="/team">Meet the team</a>',
  'heading-order': () => '<h2></h2>',
  'empty-heading': () => '<h4>Contact</h4>',
};

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Inside the repo, so esbuild can resolve react from the scratch files.
  dir = mkdtempSync(path.join(__dirname, 'tmp-config-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(generateFix).mockReset();
  vi.mocked(generateFix).mockImplementation(async ({ context }) => ({
    filePath: context.componentPath,
    violationId: context.violation.id,
    oldSnippet: context.element.code,
    newSnippet: FIXES[context.violation.id]!(context.element.code),
    position: {
      start: context.element.location.startOffset,
      end: context.element.location.endOffset,
    },
  }));
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function write(name: string, content: string | object): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
  return filePath;
}

const printed = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((call) => call.join(' ')).join('\n');

/** runScan --json in `dir`, returning the parsed JSON it printed. */
async function scanJson(target: string, flags: CliScanOptions = {}) {
  await runScan(target, { ...flags, json: true, projectRoot: dir });
  return JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
}

describe('loadProjectConfig', () => {
  it('reads the config file', () => {
    const configPath = write(CONFIG_FILE_NAME, { severity: 'serious' });

    expect(loadProjectConfig(dir)).toEqual({
      source: 'file',
      path: configPath,
      config: { severity: 'serious' },
    });
  });

  it('reads the "a11y-autofix" key in package.json when there is no config file', () => {
    const packagePath = write('package.json', {
      name: 'app',
      'a11y-autofix': { disableRules: ['region'] },
    });

    expect(loadProjectConfig(dir)).toEqual({
      source: 'package',
      path: packagePath,
      config: { disableRules: ['region'] },
    });
  });

  it('uses the config file over the package key, without merging the two', () => {
    write('package.json', { 'a11y-autofix': { severity: 'minor', ignore: ['legacy/**'] } });
    write(CONFIG_FILE_NAME, { severity: 'critical' });

    const loaded = loadProjectConfig(dir);

    expect(loaded.source).toBe('file');
    expect(loaded.config).toEqual({ severity: 'critical' });
  });

  it('reports no config for a package.json without the key, or no files at all', () => {
    expect(loadProjectConfig(dir)).toEqual({ source: 'none', path: null, config: {} });
    write('package.json', { name: 'app' });
    expect(loadProjectConfig(dir)).toEqual({ source: 'none', path: null, config: {} });
  });
});

describe('precedence: flag > config file > package key > default', () => {
  it('resolveSettings takes each setting from the first layer that sets it', () => {
    expect(resolveSettings({}, {})).toEqual(DEFAULT_SETTINGS);
    expect(
      resolveSettings(
        { severity: 'serious', ignore: ['a/**'], browser: true },
        { severity: 'critical', browser: false },
      ),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      severity: 'critical', // flag
      browser: false, // flag (an explicit false still wins)
      ignore: ['a/**'], // config
    });
    // A flag list replaces the config's list rather than adding to it.
    expect(resolveSettings({ ignore: ['a/**'] }, { ignore: ['b/**'] }).ignore).toEqual(['b/**']);
  });

  it('runScan --json reports the source and the effective settings at each layer', async () => {
    const target = write('Team.tsx', MIXED_SOURCE);

    // Default only.
    let json = await scanJson(target);
    expect(json.config).toEqual({ source: 'none', path: null, settings: DEFAULT_SETTINGS });

    // Package key beats the default.
    write('package.json', { 'a11y-autofix': { severity: 'moderate', apiKeyEnv: 'PKG_KEY' } });
    json = await scanJson(target);
    expect(json.config.source).toBe('package');
    expect(json.config.path).toBe(path.join(dir, 'package.json'));
    expect(json.config.settings).toMatchObject({ severity: 'moderate', apiKeyEnv: 'PKG_KEY' });

    // Config file beats the package key (and isn't merged with it).
    write(CONFIG_FILE_NAME, { severity: 'serious' });
    json = await scanJson(target);
    expect(json.config.source).toBe('file');
    expect(json.config.path).toBe(path.join(dir, CONFIG_FILE_NAME));
    expect(json.config.settings).toMatchObject({
      severity: 'serious',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    });

    // A flag beats the config file.
    json = await scanJson(target, { severity: 'critical' });
    expect(json.config.source).toBe('file');
    expect(json.config.settings.severity).toBe('critical');
    expect(
      json.violations.map((entry: { violation: { id: string } }) => entry.violation.id),
    ).toEqual(['image-alt', 'image-alt']);
  });

  it('passes apiKeyEnv to generation only when config or a flag sets it', async () => {
    const target = write('Team.tsx', MIXED_SOURCE);
    const apiKeyEnvsUsed = () =>
      new Set(vi.mocked(generateFix).mock.calls.map(([options]) => options.apiKeyEnv));

    await runScan(target, { projectRoot: dir, severity: 'critical' });
    expect(apiKeyEnvsUsed()).toEqual(new Set([undefined]));

    write(CONFIG_FILE_NAME, { apiKeyEnv: 'TEAM_ANTHROPIC_KEY', severity: 'critical' });
    vi.mocked(generateFix).mockClear();
    await runScan(target, { projectRoot: dir });
    expect(apiKeyEnvsUsed()).toEqual(new Set(['TEAM_ANTHROPIC_KEY']));

    vi.mocked(generateFix).mockClear();
    await runScan(target, { projectRoot: dir, apiKeyEnv: 'ANTHROPIC_API_KEY' });
    expect(apiKeyEnvsUsed()).toEqual(new Set(['ANTHROPIC_API_KEY']));
  });
});

describe('invalid config', () => {
  it.each([
    [
      'not JSON',
      '{ "severity": "serious", }',
      /Could not parse a11y-autofix\.config\.json as JSON/,
    ],
    [
      'an unknown setting (typo)',
      { disabledRules: ['region'] },
      /- disabledRules: unknown setting/,
    ],
    [
      'an unknown severity',
      { severity: 'high' },
      /- severity: Invalid option: expected one of "minor"\|"moderate"\|"serious"\|"critical"/,
    ],
    [
      'an unknown rule id',
      { disableRules: ['region', 'image_alt'] },
      /- disableRules\[1\]: unknown axe-core rule id "image_alt"/,
    ],
    ['a wrongly typed value', { browser: 'yes' }, /- browser: Invalid input: expected boolean/],
    [
      'an invalid env var name',
      { apiKeyEnv: 'my-key' },
      /- apiKeyEnv: must be an environment variable name/,
    ],
    ['an API key itself', { apiKey: 'sk-ant-…' }, /- apiKey: API keys do not belong in config/],
  ])(
    'rejects %s with a clear error, before scanning anything',
    async (_label, content, message) => {
      write(CONFIG_FILE_NAME, content);
      const target = write('Team.tsx', MIXED_SOURCE);

      expect(() => loadProjectConfig(dir)).toThrow(ConfigError);
      expect(() => loadProjectConfig(dir)).toThrow(message);

      const summary = await runScan(target, { projectRoot: dir });
      expect(summary.filesScanned).toBe(0);
      expect(generateFix).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(printed(errorSpy)).toMatch(message);
    },
  );

  it('names the package.json key when that is where the error is', () => {
    write('package.json', { 'a11y-autofix': { severity: 'loud' } });

    expect(() => loadProjectConfig(dir)).toThrow(/^Invalid "a11y-autofix" key in package\.json:/);
  });

  it('validates flags the same way', async () => {
    const target = write('Team.tsx', MIXED_SOURCE);

    await runScan(target, { projectRoot: dir, severity: 'loud' as never });

    expect(printed(errorSpy)).toMatch(/^Invalid command-line options:\n {2}- severity:/);
    expect(process.exitCode).toBe(1);
  });

  it('prints the error as JSON with --json', async () => {
    write(CONFIG_FILE_NAME, { severity: 'high' });

    await runScan(write('Team.tsx', MIXED_SOURCE), { projectRoot: dir, json: true });

    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string).error).toMatch(
      /^Invalid a11y-autofix\.config\.json:/,
    );
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('ignore', () => {
  it('skips matching files entirely: never rendered, never fixed, listed as ignored', async () => {
    const gallery = write('Gallery.tsx', MIXED_SOURCE);
    // Would make detect throw if it were ever rendered.
    const story = write('Gallery.stories.tsx', 'export default function Broken( {');
    write(CONFIG_FILE_NAME, { ignore: ['**/*.stories.tsx'], severity: 'critical' });

    const json = await scanJson(dir);

    expect(json.filesScanned).toBe(1);
    expect(json.ignoredFiles).toEqual([story]);
    expect(json.violations.every((entry: { filePath: string }) => entry.filePath === gallery)).toBe(
      true,
    );
    expect(json.violations).toHaveLength(2);
  });

  it('without the ignore, the same directory does scan that file', async () => {
    write('Gallery.tsx', MIXED_SOURCE);
    const story = write('Gallery.stories.tsx', 'export default function Broken( {');

    await runScan(dir, { projectRoot: dir });

    // The broken file is rendered, so the scan fails.
    expect(printed(errorSpy)).toContain('Could not read path');
    expect(printed(errorSpy)).toContain(path.basename(story));
  });

  it('matches paths relative to the project root, and counts skipped files in the summary', async () => {
    write('Gallery.tsx', MIXED_SOURCE);
    write('Legacy.tsx', MIXED_SOURCE);

    const summary = await runScan(dir, {
      projectRoot: path.dirname(dir),
      ignore: [`${path.basename(dir)}/Legacy.tsx`],
      severity: 'critical',
    });

    expect(summary).toMatchObject({ filesScanned: 1, filesIgnored: 1, violationsFound: 2 });
    expect(printed(logSpy)).toContain(
      '2 violation(s) found across 1 file(s): 2 verified, 0 unverified, 0 errored. 3 suppressed by config (empty-heading ×1, heading-order ×1, link-name ×1). 1 file(s) skipped by config ignore.',
    );
  });

  it('a single-file target that matches is skipped too', async () => {
    const target = write('Gallery.tsx', MIXED_SOURCE);

    const result = await scan(target, { ignore: ['Gallery.tsx'], root: dir });

    expect(result).toMatchObject({ filesScanned: 0, violations: [], ignoredFiles: [target] });
    expect(generateFix).not.toHaveBeenCalled();
  });
});

describe('disableRules and severity suppress, and are counted', () => {
  it('disableRules: never fixed, kept per element in `suppressed`, counted in the summary', async () => {
    const target = write('Team.tsx', MIXED_SOURCE);
    write(CONFIG_FILE_NAME, { disableRules: ['image-alt', 'empty-heading'] });

    const summary = await runScan(target, { projectRoot: dir });

    expect(summary).toMatchObject({ violationsFound: 2, verified: 2, suppressed: 3 });
    expect(
      vi.mocked(generateFix).mock.calls.map(([options]) => options.context.violation.id),
    ).toEqual(['heading-order', 'link-name']);
    const output = printed(logSpy);
    expect(output).toContain(
      `Using config from ${path.relative(process.cwd(), path.join(dir, CONFIG_FILE_NAME))}`,
    );
    expect(output).toContain(
      '2 violation(s) found across 1 file(s): 2 verified, 0 unverified, 0 errored. 3 suppressed by config (empty-heading ×1, image-alt ×2).',
    );
    expect(output).not.toContain('[violation] image-alt');
  });

  it('the JSON lists each suppressed element with its reason, separate from fixed ones', async () => {
    const target = write('Team.tsx', MIXED_SOURCE);
    write(CONFIG_FILE_NAME, { disableRules: ['image-alt'], severity: 'serious' });

    const json = await scanJson(target);

    expect(
      json.violations.map((entry: { violation: { id: string }; status: string }) => [
        entry.violation.id,
        entry.status,
      ]),
    ).toEqual([['link-name', 'verified']]);
    expect(
      json.suppressed.map(
        (entry: { violation: { id: string; nodes: unknown[] }; reason: string }) => [
          entry.violation.id,
          entry.reason,
          entry.violation.nodes.length,
        ],
      ),
    ).toEqual([
      ['empty-heading', 'below-severity', 1],
      ['heading-order', 'below-severity', 1],
      // Two <img>s: two entries, the same unit `violations` uses.
      ['image-alt', 'disabled-rule', 1],
      ['image-alt', 'disabled-rule', 1],
    ]);
    expect(json.suppressed.every((entry: { filePath: string }) => entry.filePath === target)).toBe(
      true,
    );
  });

  it('severity: each level reports that level and above', async () => {
    const target = write('Team.tsx', MIXED_SOURCE);
    const counts: Record<string, [number, number]> = {};
    for (const severity of ['minor', 'moderate', 'serious', 'critical'] as const) {
      const result = await scan(target, { severity });
      counts[severity] = [result.violations.length, result.suppressed.length];
    }

    expect(counts).toEqual({
      minor: [5, 0],
      moderate: [4, 1],
      serious: [3, 2],
      critical: [2, 3],
    });
  });

  it('suppressed violations do not fail the run, and do not count as an all-clear', async () => {
    const clean = write(
      'Mostly.tsx',
      'export default function Mostly() {\n  return <main><h1>Hi</h1><h4></h4></main>;\n}\n',
    );

    const summary = await runScan(clean, {
      projectRoot: dir,
      disableRules: ['heading-order', 'empty-heading'],
    });

    expect(summary).toMatchObject({ violationsFound: 0, suppressed: 2 });
    expect(process.exitCode).not.toBe(1);
    const output = printed(logSpy);
    expect(output).not.toContain('No accessibility violations found');
    expect(output).toContain(
      `No accessibility violations to fix in ${path.relative(process.cwd(), clean)}. 2 suppressed by config (empty-heading ×1, heading-order ×1).`,
    );
  });
});
