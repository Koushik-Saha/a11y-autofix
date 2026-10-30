import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the network call and the terminal prompt are mocked. context/,
// generate/ (prompt, schema choice, composing the insertion), verify/
// (real renders and axe-core), scan/ and cli/ all run for real.
const { parse, AnthropicMock } = vi.hoisted(() => {
  const parse = vi.fn();
  const AnthropicMock = vi.fn(function () {
    return { messages: { parse } };
  });
  return { parse, AnthropicMock };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));
vi.mock('../src/cli/interactive', () => ({ createInteractiveHandler: vi.fn() }));

import { runScan } from '../src/cli';
import { createInteractiveHandler } from '../src/cli/interactive';
import { gatherContext } from '../src/context';
import type { FixContext } from '../src/context';
import { detectViolations } from '../src/detect';
import type { AxeViolation } from '../src/detect';
import { generateFix } from '../src/generate';
import type { Patch } from '../src/generate';
import { scan } from '../src/scan';
import { InvalidPatchError, verifyFix } from '../src/verify';

import { listFixtures } from '../scripts/eval/harness';

import { chromiumAvailable } from './helpers/chromium';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string) => path.join(FIXTURES, name);
const NEW_FIXTURES = [
  'LabelInsertNoId.tsx',
  'LabelInsertWithId.tsx',
  'LabelInsertDuplicateId.tsx',
  'VueLabelInsert.vue',
];

interface SentRequest {
  messages: { content: string }[];
  output_config: { format: { schema: { properties: Record<string, unknown> } } };
}
const sent = (call = -1) => parse.mock.calls.at(call)![0] as SentRequest;
const schemaFields = (request: SentRequest) =>
  Object.keys(request.output_config.format.schema.properties).sort();
const INSERTION_FIELDS = [
  'fallbackReason',
  'insertPosition',
  'insertedSnippet',
  'kind',
  'newSnippet',
];

function reply(parsed: Record<string, unknown>) {
  return {
    parsed_output: parsed,
    stop_reason: 'end_turn',
    model: 'claude-opus-5',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}
const insert = (newSnippet: string, insertedSnippet: string, insertPosition = 'before') =>
  reply({ kind: 'insert', newSnippet, insertPosition, insertedSnippet, fallbackReason: null });
const replace = (newSnippet: string, fallbackReason: string | null = null) =>
  reply({
    kind: 'replace',
    newSnippet,
    insertPosition: null,
    insertedSnippet: null,
    fallbackReason,
  });

async function contextFor(file: string, ruleId = 'label'): Promise<FixContext> {
  const { violations } = await detectViolations({ componentPath: file });
  const violation = violations.find((v) => v.id === ruleId);
  if (!violation) throw new Error(`no ${ruleId} violation in ${file}`);
  return gatherContext({ violation, componentPath: file });
}

beforeEach(() => {
  parse.mockReset();
  AnthropicMock.mockClear();
});

describe('context/: what a label fix needs', () => {
  it('states that a bare input has no id', async () => {
    expect((await contextFor(fixture('LabelInsertNoId.tsx'))).labelTarget).toEqual({
      id: { kind: 'none' },
      idsInFile: [],
      forAttribute: 'htmlFor',
      canInsertSibling: true,
    });
  });

  it("supplies an existing id (and locates an element axe targets by '#id')", async () => {
    const context = await contextFor(fixture('LabelInsertWithId.tsx'));
    expect(context.violation.nodes[0]!.target).toEqual(['#newsletter-email']);
    expect(context.labelTarget?.id).toEqual({ kind: 'static', value: 'newsletter-email' });
    expect(context.element.code).toBe('<input id="newsletter-email" type="email" name="email" />');
  });

  it('lists ids already used in the file, and uses `for` in Vue', async () => {
    expect(
      (await contextFor(fixture('LabelInsertDuplicateId.tsx'))).labelTarget?.idsInFile,
    ).toEqual(['email']);
    expect((await contextFor(fixture('VueLabelInsert.vue'))).labelTarget).toMatchObject({
      forAttribute: 'for',
      id: { kind: 'none' },
    });
  });

  it('is added for label violations only', async () => {
    expect('labelTarget' in (await contextFor(fixture('MissingAlt.tsx'), 'image-alt'))).toBe(false);
  });

  describe('on scratch components', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(__dirname, 'tmp-insert-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    async function labelTargetOf(body: string) {
      const file = path.join(dir, 'Form.tsx');
      writeFileSync(
        file,
        `export default function Form({ show, fieldId }: { show: boolean; fieldId: string }) {\n  return ${body};\n}\n`,
      );
      return (await contextFor(file)).labelTarget;
    }

    it('reports a dynamic id as an expression', async () => {
      expect((await labelTargetOf('<form><input id={fieldId} /></form>'))?.id).toEqual({
        kind: 'dynamic',
        expression: 'fieldId',
      });
    });

    it('says a sibling cannot be inserted inside an expression or at the root', async () => {
      expect((await labelTargetOf('<form>{true && <input />}</form>'))?.canInsertSibling).toBe(
        false,
      );
      expect((await labelTargetOf('<input />'))?.canInsertSibling).toBe(false);
    });
  });
});

describe('generate/: insertion offered only for allowlisted rules', () => {
  it('offers insertion for label, with the id facts and the preference for a real <label>', async () => {
    parse.mockResolvedValue(
      replace('<input aria-label="Email" type="email" name="email" />', 'test'),
    );

    await generateFix({ context: await contextFor(fixture('LabelInsertDuplicateId.tsx')) });

    expect(schemaFields(sent())).toEqual(INSERTION_FIELDS);
    const prompt = sent().messages[0]!.content;
    expect(prompt).toContain('- The input: it has no id.');
    expect(prompt).toContain(
      '- Ids already used by other elements in this file (a new id must not repeat one): "email".',
    );
    expect(prompt).toContain(
      '- Preferred fix: insert a real <label> element before the input, with htmlFor set to a new id',
    );
    expect(prompt).toContain('the fix is two parts: add a new, unique id to the input');
  });

  it('the system prompt limits insertion to label and bypass', async () => {
    parse.mockResolvedValue(replace('<input aria-label="Email" />', 'test'));
    await generateFix({ context: await contextFor(fixture('LabelInsertNoId.tsx')) });
    const system = (parse.mock.calls[0]![0] as { system: string }).system;

    expect(system).toContain(
      'The one exception is insertion, allowed only for the rules label and bypass',
    );
    expect(system).toContain(
      'For every other rule insertion is not allowed, and replacement remains the default.',
    );
  });

  it('composes an insertion: new element, newline and indentation, then the anchor', async () => {
    parse.mockResolvedValue(
      insert(
        '<input id="newsletter-email" type="email" name="email" />',
        '<label htmlFor="newsletter-email">Email address</label>',
      ),
    );
    const context = await contextFor(fixture('LabelInsertNoId.tsx'));

    const patch = await generateFix({ context });

    expect(patch).toEqual({
      filePath: context.componentPath,
      violationId: 'label',
      kind: 'insert',
      oldSnippet: '<input type="email" name="email" />',
      newSnippet:
        '<label htmlFor="newsletter-email">Email address</label>\n      <input id="newsletter-email" type="email" name="email" />',
      position: {
        start: context.element.location.startOffset,
        end: context.element.location.endOffset,
      },
      insertion: {
        anchor: {
          start: context.element.location.startOffset,
          end: context.element.location.endOffset,
        },
        position: 'before',
        snippet: '<label htmlFor="newsletter-email">Email address</label>',
        anchorSnippet: '<input id="newsletter-email" type="email" name="email" />',
      },
    });
  });

  it('marks a label replacement as the fallback, with the reason', async () => {
    parse.mockResolvedValue(
      replace(
        '<input aria-label="Email" type="email" name="email" />',
        'the visual design has no room',
      ),
    );

    const patch = await generateFix({ context: await contextFor(fixture('LabelInsertNoId.tsx')) });

    expect(patch).toMatchObject({
      kind: 'replace',
      fallback: { preferred: 'insert', reason: 'the visual design has no room' },
    });
    expect(patch.insertion).toBeUndefined();
  });

  it('offers only a replacement where a sibling cannot go, and records why', async () => {
    const dir = mkdtempSync(path.join(__dirname, 'tmp-insert-'));
    try {
      const file = path.join(dir, 'Form.tsx');
      writeFileSync(
        file,
        'export default function Form({ show }: { show: boolean }) {\n  return <form>{true && <input />}</form>;\n}\n',
      );
      parse.mockResolvedValue(reply({ newSnippet: '<input aria-label="Email" />' }));

      const patch = await generateFix({ context: await contextFor(file) });

      expect(schemaFields(sent())).toEqual(['newSnippet']);
      expect(patch.kind).toBe('replace');
      expect(patch.fallback?.reason).toContain("a <label> can't be inserted next to this element");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('regression: every existing fixture still gets the replacement-only request and a plain replace patch', async () => {
    const existing = listFixtures(FIXTURES).filter((name) => !NEW_FIXTURES.includes(name));
    let checked = 0;
    for (const name of existing) {
      const componentPath = path.join(FIXTURES, name);
      const { violations } = await detectViolations({ componentPath });
      for (const violation of violations) {
        const context = await gatherContext({ violation, componentPath });
        parse.mockResolvedValue(replace(context.element.code, 'regression test'));
        const patch = await generateFix({ context });
        expect([name, violation.id, patch.kind, patch.insertion]).toEqual([
          name,
          violation.id,
          'replace',
          undefined,
        ]);
        if (violation.id === 'label') {
          // The rule this change targets: insertion now offered.
          expect(schemaFields(sent())).toEqual(INSERTION_FIELDS);
        } else {
          // Every other rule: the request schema is exactly as before.
          expect([name, violation.id, schemaFields(sent()), patch.fallback]).toEqual([
            name,
            violation.id,
            ['newSnippet'],
            undefined,
          ]);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('verify/: insertions checked with the same rigor', () => {
  it('a bare <input> gets a verified, first-try, real-<label> fix', async () => {
    parse.mockResolvedValue(
      insert(
        '<input id="newsletter-email" type="email" name="email" />',
        '<label htmlFor="newsletter-email">Email address</label>',
      ),
    );

    const [entry] = (await scan(fixture('LabelInsertNoId.tsx'))).violations;

    if (entry?.status !== 'verified') throw new Error(JSON.stringify(entry));
    expect(entry.patch).toMatchObject({ kind: 'insert', confidence: 'high' });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('an input that already has an id: only the label is inserted', async () => {
    const input = '<input id="newsletter-email" type="email" name="email" />';
    parse.mockResolvedValue(
      insert(input, '<label htmlFor="newsletter-email">Email address</label>'),
    );

    const [entry] = (await scan(fixture('LabelInsertWithId.tsx'))).violations;

    expect(entry).toMatchObject({
      status: 'verified',
      patch: { kind: 'insert', insertion: { anchorSnippet: input } },
    });
  });

  it('works in Vue templates, with `for`', async () => {
    parse.mockResolvedValue(
      insert(
        '<input id="newsletter-email" type="email" name="email" />',
        '<label for="newsletter-email">Email address</label>',
      ),
    );

    const [entry] = (await scan(fixture('VueLabelInsert.vue'))).violations;

    expect(entry).toMatchObject({ status: 'verified', patch: { kind: 'insert' } });
  });

  it('rejects the naive insertion that duplicates an id, then falls back to aria-label', async () => {
    parse
      .mockResolvedValueOnce(
        insert(
          '<input id="email" type="email" name="email" />',
          '<label htmlFor="email">Email address</label>',
        ),
      )
      .mockResolvedValueOnce(
        reply({ newSnippet: '<input aria-label="Email address" type="email" name="email" />' }),
      );

    const [entry] = (await scan(fixture('LabelInsertDuplicateId.tsx'))).violations;

    // The retry was told why and offered only a replacement.
    expect(schemaFields(sent(1))).toEqual(['newSnippet']);
    expect(sent(1).messages[0]!.content).toContain(
      "A <label> can't be used for this attempt: the inserted element did not verify (introduced: duplicate-id-aria).",
    );
    if (entry?.status !== 'verified') throw new Error(JSON.stringify(entry));
    expect(entry.patch).toMatchObject({
      kind: 'replace',
      confidence: 'medium',
      newSnippet: '<input aria-label="Email address" type="email" name="email" />',
      fallback: {
        preferred: 'insert',
        reason: 'the inserted element did not verify (introduced: duplicate-id-aria)',
      },
    });
  });

  async function verifyInsertion(file: string, anchorSnippet: string, inserted: string) {
    parse.mockResolvedValue(insert(anchorSnippet, inserted));
    const context = await contextFor(fixture(file));
    const patch = await generateFix({ context });
    return verifyFix({ patch, originalViolation: context.violation });
  }

  it('the duplicate-id insertion on its own: unverified, with duplicate-id-aria as the new violation', async () => {
    const result = await verifyInsertion(
      'LabelInsertDuplicateId.tsx',
      '<input id="email" type="email" name="email" />',
      '<label htmlFor="email">Email address</label>',
    );

    expect(result.status).toBe('unverified');
    expect(result.newViolations.map((v) => v.id)).toEqual(['duplicate-id-aria']);
    // axe-core reports the first element carrying the duplicated id.
    expect(result.newViolations[0]!.nodes.map((n) => n.html)).toEqual([
      '<p id="email">We never share your email address.</p>',
    ]);
  });

  it.runIf(chromiumAvailable)(
    'in browser mode too: the good insertion verifies, the duplicate-id one does not',
    async () => {
      const check = async (file: string, anchor: string, label: string) => {
        parse.mockResolvedValue(insert(anchor, label));
        const context = await contextFor(fixture(file));
        const patch = await generateFix({ context });
        return verifyFix({ patch, originalViolation: context.violation, browser: true });
      };

      const good = await check(
        'LabelInsertNoId.tsx',
        '<input id="newsletter-email" type="email" name="email" />',
        '<label htmlFor="newsletter-email">Email address</label>',
      );
      const duplicate = await check(
        'LabelInsertDuplicateId.tsx',
        '<input id="email" type="email" name="email" />',
        '<label htmlFor="email">Email address</label>',
      );

      expect(good.status).toBe('verified');
      expect(duplicate.status).toBe('unverified');
      expect(duplicate.newViolations.map((v) => v.id)).toEqual(['duplicate-id-aria']);
    },
  );

  it('a label that points at the wrong id breaks the association: still flagged', async () => {
    const result = await verifyInsertion(
      'LabelInsertNoId.tsx',
      '<input id="newsletter-email" type="email" name="email" />',
      '<label htmlFor="newsletter">Email address</label>',
    );

    expect(result.status).toBe('unverified');
    expect(result.remainingViolations.map((v) => v.id)).toEqual(['label']);
  });

  describe('malformed or disallowed insertions are refused outright', () => {
    async function validInsertion(): Promise<{ patch: Patch; violation: AxeViolation }> {
      parse.mockResolvedValue(
        insert(
          '<input id="newsletter-email" type="email" name="email" />',
          '<label htmlFor="newsletter-email">Email</label>',
        ),
      );
      const context = await contextFor(fixture('LabelInsertNoId.tsx'));
      return { patch: await generateFix({ context }), violation: context.violation };
    }

    it.each([
      [
        'a rule that only allows replacement',
        (p: Patch) => ({ ...p, violationId: 'image-alt' }),
        "insertion isn't allowed for this rule",
      ],
      [
        'an element the rule does not allow',
        (p: Patch) => ({
          ...p,
          insertion: { ...p.insertion!, snippet: '<span>Email</span>' },
          newSnippet: p.newSnippet.replace(
            '<label htmlFor="newsletter-email">Email</label>',
            '<span>Email</span>',
          ),
        }),
        'it inserts <span>',
      ],
      [
        'a newSnippet that is not the composed parts',
        (p: Patch) => ({ ...p, newSnippet: `${p.newSnippet}\n<p>extra</p>` }),
        'is not the inserted element and the anchor',
      ],
      [
        'an anchor turned into a different element',
        (p: Patch) => ({ ...p, insertion: { ...p.insertion!, anchorSnippet: '<textarea />' } }),
        'changes the flagged element into a different element',
      ],
      [
        'an anchor that is not the patched range',
        (p: Patch) => ({ ...p, insertion: { ...p.insertion!, anchor: { start: 0, end: 5 } } }),
        'its anchor is not the patched element',
      ],
    ])('%s', async (_label, doctor, message) => {
      const { patch, violation } = await validInsertion();

      const attempt = verifyFix({ patch: doctor(patch), originalViolation: violation });

      await expect(attempt).rejects.toThrow(InvalidPatchError);
      await expect(
        verifyFix({ patch: doctor(patch), originalViolation: violation }),
      ).rejects.toThrow(message);
    });
  });
});

describe('cli/: --write and the corrections log record the kind', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(__dirname, 'tmp-insert-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  const copy = (name: string) => {
    const target = path.join(dir, name);
    copyFileSync(fixture(name), target);
    return target;
  };
  const labelInsertion = () =>
    parse.mockResolvedValue(
      insert(
        '<input id="newsletter-email" type="email" name="email" />',
        '<label htmlFor="newsletter-email">Email address</label>',
      ),
    );

  it('--write applies the insertion and says what was added', async () => {
    const file = copy('LabelInsertNoId.tsx');
    labelInsertion();

    const summary = await runScan(file, { write: true, projectRoot: dir });

    expect(summary).toMatchObject({ verified: 1 });
    expect(readFileSync(file, 'utf8')).toContain(
      '      <h2>Newsletter</h2>\n      <label htmlFor="newsletter-email">Email address</label>\n      <input id="newsletter-email" type="email" name="email" />\n      <button type="submit">Subscribe</button>',
    );
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('[verified] fix applied to disk (confidence: high)');
    expect(output).toContain('    kind: insert — added a new <label> before the flagged element');
  });

  it('--json carries the kind and the insertion details', async () => {
    labelInsertion();

    await runScan(copy('LabelInsertNoId.tsx'), { json: true, projectRoot: dir });

    const json = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
    expect(json.violations[0].patch).toMatchObject({
      kind: 'insert',
      insertion: { position: 'before' },
    });
  });

  it('the corrections log records an insertion as kind "insert"', async () => {
    labelInsertion();
    vi.mocked(createInteractiveHandler).mockReturnValue({
      onVerifiedFix: async () => ({ action: 'reject' }),
      close: () => {},
    });

    const file = copy('LabelInsertNoId.tsx');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await runScan(file, { interactive: true, logCorrections: true, projectRoot: dir });
    } finally {
      process.chdir(cwd);
    }

    const entry = JSON.parse(
      readFileSync(path.join(dir, '.a11y-autofix', 'corrections.log'), 'utf8').trim(),
    );
    expect(entry).toMatchObject({ violationId: 'label', action: 'rejected', kind: 'insert' });
    expect(entry.suggested).toContain('<label htmlFor="newsletter-email">');
  });

  it('an interactive edit of an insertion becomes a plain replacement of the same range', async () => {
    labelInsertion();
    const edited = '<label>Email address <input type="email" name="email" /></label>';

    const [entry] = (
      await scan(copy('LabelInsertNoId.tsx'), {
        onVerifiedFix: async () => ({ action: 'edit', newSnippet: edited }),
      })
    ).violations;

    expect(entry).toMatchObject({
      status: 'verified',
      patch: { kind: 'replace', newSnippet: edited },
    });
    expect(entry?.status === 'verified' && entry.patch.insertion).toBeUndefined();
  });
});
