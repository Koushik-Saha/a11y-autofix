import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Anthropic client is mocked so the exact prompt generate/ builds from
// a resolved context can be inspected.
const { parse, AnthropicMock } = vi.hoisted(() => {
  const parse = vi.fn();
  const AnthropicMock = vi.fn(function () {
    return { messages: { parse } };
  });
  return { parse, AnthropicMock };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));

import { gatherContext } from '../src/context';
import type { FixContext } from '../src/context';
import { RESOLVE_LIMITS } from '../src/context/adapters/resolve';
import { detectViolations } from '../src/detect';
import type { AxeViolation } from '../src/detect';
import { generateFix } from '../src/generate';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

async function contextFor(fixtureName: string, ruleId: string): Promise<FixContext> {
  const componentPath = fixture(fixtureName);
  const { violations } = await detectViolations({ componentPath });
  const violation = violations.find((v) => v.id === ruleId);
  if (!violation) throw new Error(`expected a ${ruleId} violation in ${fixtureName}`);
  return gatherContext({ violation, componentPath });
}

async function promptsSent(context: FixContext): Promise<{ system: string; user: string }> {
  parse.mockResolvedValue({ parsed_output: { newSnippet: '<img />' }, stop_reason: 'end_turn' });
  await generateFix({ context });
  const request = parse.mock.calls.at(-1)![0] as {
    system: string;
    messages: { content: string }[];
  };
  return { system: request.system, user: request.messages[0]!.content };
}

beforeEach(() => {
  parse.mockReset();
});

describe('resolved context for the fixtures', () => {
  it('(a) resolves a constant src, through a template literal and a second constant', async () => {
    const context = await contextFor('ResolvedAvatar.tsx', 'image-alt');

    expect(context.resolved).toEqual({
      values: [
        {
          prop: 'src',
          expression: 'avatarUrl',
          value: '/img/team/ceo-portrait.jpg',
          complete: true,
          from: [
            'const avatarUrl (ResolvedAvatar.tsx:6)',
            'const TEAM_IMAGES (ResolvedAvatar.tsx:5)',
          ],
        },
      ],
      handlers: [],
    });

    const { user } = await promptsSent(context);
    expect(user).toContain(
      'Values resolved from source (static analysis of this file and its local imports; context only, not part of the element):',
    );
    expect(user).toContain(
      '- src={avatarUrl} resolves to "/img/team/ceo-portrait.jpg", from const avatarUrl (ResolvedAvatar.tsx:6) ← const TEAM_IMAGES (ResolvedAvatar.tsx:5)',
    );
  });

  it('(b) includes the body of a handler defined in the same file', async () => {
    const context = await contextFor('InFileHandlerButton.tsx', 'button-name');

    expect(context.resolved?.values).toEqual([]);
    expect(context.resolved?.handlers).toEqual([
      {
        prop: 'onClick',
        expression: 'handleDelete',
        from: 'handleDelete (InFileHandlerButton.tsx:6)',
        code: "const handleDelete = () => {\n    removeTeamMember('jane-doe');\n  };",
        truncated: false,
      },
    ]);

    const { user } = await promptsSent(context);
    expect(user).toContain(
      'Event handler implementations (resolved from source; context only, do not modify):',
    );
    expect(user).toContain('onClick={handleDelete} is handleDelete (InFileHandlerButton.tsx:6):');
    expect(user).toContain("removeTeamMember('jane-doe');");
  });

  it('(c) follows a relative import to include an imported handler', async () => {
    const context = await contextFor('ImportedHandlerButton.tsx', 'button-name');

    const [handler] = context.resolved?.handlers ?? [];
    expect(handler?.from).toBe('archiveProject (lib/projectActions.ts:3)');
    expect(handler?.code).toContain('export function archiveProject(): void {');
    expect(handler?.code).toContain('Moves the project to the archive');
  });

  it('(d) an unresolvable value (a destructured prop) leaves the context as it was', async () => {
    const context = await contextFor('TypedMissingAlt.tsx', 'image-alt');

    expect('resolved' in context).toBe(false);
    expect(Object.keys(context).sort()).toEqual(
      [
        'componentPath',
        'element',
        'parent',
        'propTypes',
        'relatedFiles',
        'siblings',
        'sourceCode',
        'violation',
      ].sort(),
    );
    const { user } = await promptsSent(context);
    expect(user).not.toContain('resolved from source');
    expect(user).not.toContain('Event handler implementations');
  });

  it('Vue: resolves :src from <script setup> and @click through a local import', async () => {
    const image = await contextFor('VueResolvedCard.vue', 'image-alt');
    expect(image.resolved?.values).toEqual([
      {
        prop: ':src',
        expression: 'avatarUrl',
        value: '/img/team/ceo-portrait.jpg',
        complete: true,
        from: ['const avatarUrl (VueResolvedCard.vue:8)'],
      },
    ]);

    const button = await contextFor('VueResolvedCard.vue', 'button-name');
    expect(button.resolved?.handlers.map((handler) => [handler.prop, handler.from])).toEqual([
      ['@click', 'archiveProject (lib/projectActions.ts:3)'],
    ]);
  });

  it('tells the model how to use resolved context, in one added line', async () => {
    const { system } = await promptsSent(await contextFor('ResolvedAvatar.tsx', 'image-alt'));

    expect(system).toContain(
      'When values resolved from source or event handler implementations are provided, use them to write specific alt text and labels (what the image shows, what the control does), but do not mention them in the fix itself — no file paths, variable names, or code.',
    );
  });
});

describe('what resolution refuses, and its limits', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(__dirname, 'tmp-resolve-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** gatherContext on a scratch component, for a violation on its first `tag`. */
  async function resolvedFor(source: string, tag = 'img', files: Record<string, string> = {}) {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
    const componentPath = path.join(dir, 'Component.tsx');
    writeFileSync(componentPath, source);
    const violation: AxeViolation = {
      filePath: componentPath,
      id: tag === 'img' ? 'image-alt' : 'button-name',
      impact: 'critical',
      description: '',
      help: '',
      helpUrl: '',
      nodes: [{ target: [tag], html: `<${tag}>` }],
    };
    return (await gatherContext({ violation, componentPath })).resolved;
  }

  const component = (preamble: string, element: string, body = '') =>
    `${preamble}\nexport default function Component() {\n${body}\n  return <div>${element}</div>;\n}\n`;

  it.each([
    ['a let binding (could be reassigned)', component("let url = '/a.jpg';", '<img src={url} />')],
    ['a function call', component("const url = () => '/a.jpg';", '<img src={url()} />')],
    ['a conditional', component("const a = '/a.jpg';", '<img src={a ? a : a} />')],
    [
      'a function parameter shadowing a constant',
      `const src = '/outer.jpg';\nexport default function Component({ src }: { src: string }) {\n  return <img src={src} />;\n}\n`,
    ],
    [
      'a package import',
      component("import { logoUrl } from 'some-package';", '<img src={logoUrl} />'),
    ],
    ['a path alias', component("import { logoUrl } from '@/assets';", '<img src={logoUrl} />')],
  ])('resolves nothing for %s', async (_label, source) => {
    expect(await resolvedFor(source)).toBeUndefined();
  });

  it('never follows a relative import into node_modules', async () => {
    const files = {
      'node_modules/assets/index.ts': "export const logoUrl = '/logo.png';\n",
      'vendor/assets/index.ts': "export const logoUrl = '/logo.png';\n",
    };
    const blocked = await resolvedFor(
      component("import { logoUrl } from './node_modules/assets';", '<img src={logoUrl} />'),
      'img',
      files,
    );
    expect(blocked).toBeUndefined();

    // Control: the identical layout outside node_modules does resolve.
    const allowed = await resolvedFor(
      component("import { logoUrl } from './vendor/assets';", '<img src={logoUrl} />'),
      'img',
      files,
    );
    expect(allowed?.values[0]?.value).toBe('/logo.png');
  });

  it('keeps the static parts of a partly dynamic template literal, marked incomplete', async () => {
    const resolved = await resolvedFor(
      `const ROOT = '/img/team';\nexport default function Component({ id }: { id: string }) {\n  return <img src={\`\${ROOT}/\${id}.jpg\`} />;\n}\n`,
    );
    expect(resolved?.values).toEqual([
      expect.objectContaining({ value: '/img/team/${id}.jpg', complete: false }),
    ]);
  });

  it('resolves object-literal constants and namespace imports from local files', async () => {
    const resolved = await resolvedFor(
      component(
        "import * as images from './images';\nconst ALT = { ceo: 'Jane Doe, CEO' } as const;",
        '<img src={images.ceo} title={ALT.ceo} />',
      ),
      'img',
      { 'images.ts': "export const ceo = '/img/team/ceo.jpg';\n" },
    );
    expect(resolved?.values.map((value) => [value.prop, value.value])).toEqual([
      ['src', '/img/team/ceo.jpg'],
      ['title', 'Jane Doe, CEO'],
    ]);
  });

  it('resolves a useCallback handler', async () => {
    const resolved = await resolvedFor(
      component(
        "import { useCallback } from 'react';",
        '<button onClick={save}><svg aria-hidden="true" /></button>',
        '  const save = useCallback(() => {\n    saveDraft();\n  }, []);',
      ),
      'button',
    );
    expect(resolved?.handlers[0]?.code).toContain('saveDraft();');
  });

  it('cuts a long handler at the line cap and says so', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `  step${i}();`).join('\n');
    const resolved = await resolvedFor(
      component(
        `function handleSync() {\n${body}\n}`,
        '<button onClick={handleSync}><svg aria-hidden="true" /></button>',
      ),
      'button',
    );
    const [handler] = resolved?.handlers ?? [];
    expect(handler?.truncated).toBe(true);
    const lines = handler!.code.split('\n');
    expect(lines).toHaveLength(RESOLVE_LIMITS.maxHandlerLines + 1);
    expect(lines.at(-1)).toBe('// … 12 more lines not shown');
  });

  it('caps a long value, and drops what would exceed the total budget', async () => {
    const longLine = `  doSomethingWithAVeryLongName(${'x'.repeat(200)});`;
    const resolved = await resolvedFor(
      component(
        `const url = '/${'a'.repeat(500)}.jpg';\nfunction handleHuge() {\n${Array(25).fill(longLine).join('\n')}\n}`,
        '<img src={url} onLoad={handleHuge} />',
      ),
    );
    expect(resolved?.values[0]?.value).toHaveLength(RESOLVE_LIMITS.maxValueChars + 1);
    expect(resolved?.values[0]?.value.endsWith('…')).toBe(true);
    // ~5,700 characters of handler: over the per-element budget, so left out.
    expect(resolved?.handlers).toEqual([]);
  });
});
