import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Anthropic client is mocked, so these tests see exactly the request
// generate/ sends and can stand in for the model's reply. Everything else
// — detect/, context/, generate/'s own prompt building, verify/, scan/ —
// runs for real.
const { parse, AnthropicMock } = vi.hoisted(() => {
  const parse = vi.fn();
  const AnthropicMock = vi.fn(function () {
    return { messages: { parse } };
  });
  return { parse, AnthropicMock };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));

import { gatherContext } from '../src/context';
import { detectViolations } from '../src/detect';
import { generateFix } from '../src/generate';
import { applyPatchToSource } from '../src/verify';
import { scan } from '../src/scan';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

interface SentRequest {
  system: string;
  output_config: { format: { schema: { properties: Record<string, unknown> } } };
}

function lastRequest(): SentRequest {
  const call = parse.mock.calls.at(-1);
  if (!call) throw new Error('the model was never called');
  return call[0] as SentRequest;
}

function modelReplies(newSnippet: string): void {
  parse.mockResolvedValue({ parsed_output: { newSnippet }, stop_reason: 'end_turn' });
}

beforeEach(() => {
  parse.mockReset();
  AnthropicMock.mockClear();
});

describe('system prompt', () => {
  async function systemPromptSent(): Promise<string> {
    const componentPath = fixture('MissingLinkName.tsx');
    const { violations } = await detectViolations({ componentPath });
    const context = await gatherContext({ violation: violations[0]!, componentPath });
    modelReplies('<a href="/articles/wcag-2026-update">Read more</a>');
    await generateFix({ context });
    return lastRequest().system;
  }

  it('tells the model to prefer visible text over aria-label for links and buttons', async () => {
    const system = await systemPromptSent();

    expect(system).toContain(
      "For a link, or a button that is not icon-only, prefer adding real visible text as the element's child content over adding an aria-label.",
    );
    expect(system).toContain(
      'An aria-label-only link or button passes axe-core but shows sighted users nothing.',
    );
    expect(system).toContain(
      'An aria-label (or aria-labelledby) is acceptable for a genuinely icon-only control',
    );
  });

  it('tells the model a relational rule is fixed on the flagged element alone', async () => {
    const system = await systemPromptSent();

    expect(system).toContain('for example landmark-unique');
    expect(system).toContain(
      'For these relational rules, fixing only the flagged element is sufficient and expected',
    );
    expect(system).toContain(
      'Do not change the sibling, and do not write a replacement that assumes the sibling will also change.',
    );
  });

  it('keeps the existing rules and the one-field output schema', async () => {
    const system = await systemPromptSent();

    expect(system).toContain('Return only a replacement for that one element.');
    expect(system).toContain(
      'Do not touch the parent, the siblings, or anything else in the file.',
    );
    expect(system).toContain('not a generic placeholder like "image" or "TODO"');
    expect(system).toContain('produce a genuinely different fix');
    expect(Object.keys(lastRequest().output_config.format.schema.properties)).toEqual([
      'newSnippet',
    ]);
  });
});

describe('link-name: the two fix shapes on the MissingLinkName fixture', () => {
  const componentPath = fixture('MissingLinkName.tsx');
  const visibleText =
    '<a href="/articles/wcag-2026-update">Read more: New accessibility guidelines released</a>';
  const ariaLabelOnly =
    '<a href="/articles/wcag-2026-update" aria-label="Read more: New accessibility guidelines released"></a>';

  it('a visible-text fix comes back through scan() verified, first try', async () => {
    modelReplies(visibleText);

    const [entry] = (await scan(componentPath)).violations;

    if (entry?.status !== 'verified') {
      throw new Error(`expected a verified result, got ${JSON.stringify(entry)}`);
    }
    expect(entry.violation.id).toBe('link-name');
    expect(entry.patch.newSnippet).toBe(visibleText);
    expect(entry.patch.confidence).toBe('high');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('an aria-label-only fix also verifies, so only the prompt can steer away from it', async () => {
    // axe-core's link-name rule only needs *an* accessible name; it can't
    // see that this link shows nothing on screen. That's why the
    // preference lives in the prompt (asserted above) and not in verify/.
    modelReplies(ariaLabelOnly);

    const [entry] = (await scan(componentPath)).violations;

    expect(entry?.status).toBe('verified');
  });
});

describe('landmark-unique: fixing only the flagged landmark', () => {
  it('verifies and leaves the sibling landmark exactly as it was', async () => {
    const componentPath = fixture('DuplicateLandmarks.tsx');
    parse.mockImplementation(async (request: { messages: { content: string }[] }) => {
      // Rename whichever <nav> was flagged, as the prompt asks.
      const flagged = /```jsx\n(<nav>[\s\S]*?<\/nav>)\n```/.exec(request.messages[0]!.content)![1]!;
      return {
        parsed_output: { newSnippet: flagged.replace('<nav>', '<nav aria-label="Help">') },
        stop_reason: 'end_turn',
      };
    });

    const [entry] = (await scan(componentPath)).violations;

    if (entry?.status !== 'verified') {
      throw new Error(`expected a verified result, got ${JSON.stringify(entry)}`);
    }
    expect(entry.violation.id).toBe('landmark-unique');
    const source = readFileSync(componentPath, 'utf8');
    const patched = applyPatchToSource(source, entry.patch);
    // Exactly one <nav> was renamed; the other is untouched.
    expect(patched.match(/<nav aria-label="Help">/g)).toHaveLength(1);
    expect(patched.match(/<nav>/g)).toHaveLength(1);
    expect(source.match(/<nav>/g)).toHaveLength(2);
  });
});

describe('apiKeyEnv', () => {
  async function linkContext() {
    const componentPath = fixture('MissingLinkName.tsx');
    const { violations } = await detectViolations({ componentPath });
    return gatherContext({ violation: violations[0]!, componentPath });
  }

  afterEach(() => {
    delete process.env.TEAM_ANTHROPIC_KEY;
  });

  it('reads the key from the named variable', async () => {
    process.env.TEAM_ANTHROPIC_KEY = 'sk-team';
    modelReplies('<a href="/articles/wcag-2026-update">Read more</a>');

    await generateFix({ context: await linkContext(), apiKeyEnv: 'TEAM_ANTHROPIC_KEY' });

    expect(AnthropicMock).toHaveBeenCalledWith({ apiKey: 'sk-team' });
  });

  it('fails clearly, without falling back to ANTHROPIC_API_KEY, when the variable is unset', async () => {
    await expect(
      generateFix({ context: await linkContext(), apiKeyEnv: 'TEAM_ANTHROPIC_KEY' }),
    ).rejects.toThrow(
      'No Anthropic API key: the environment variable TEAM_ANTHROPIC_KEY (set by apiKeyEnv) is not set.',
    );
    expect(AnthropicMock).not.toHaveBeenCalled();
  });

  it('without apiKeyEnv, leaves key lookup to the SDK as before', async () => {
    modelReplies('<a href="/articles/wcag-2026-update">Read more</a>');

    await generateFix({ context: await linkContext() });

    expect(AnthropicMock).toHaveBeenCalledWith();
  });
});
