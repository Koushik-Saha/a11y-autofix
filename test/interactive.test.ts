import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createInteractiveHandler } from '../src/cli/interactive';
import type { VerifiedFixPromptContext } from '../src/scan';

function makeInput(lines: string[]): Readable {
  // A Readable that ends (push(null)) causes readline to close itself as
  // soon as the stream drains — even if multiple question() calls are
  // still queued to run against already-buffered lines. Keeping the
  // stream open (never ending it) avoids that race; handler.close() tears
  // down the readline interface explicitly at the end of each test.
  //
  // Lines are pushed one per tick (not all synchronously up front) so
  // each is delivered as its own 'line' event, matching how a real typing
  // user's input arrives — pushing everything in one synchronous burst
  // let readline's internal question() queueing drop later lines.
  const stream = new Readable({ read() {} });
  let index = 0;
  const pushNext = (): void => {
    if (index >= lines.length) return;
    stream.push(`${lines[index]}\n`);
    index += 1;
    setImmediate(pushNext);
  };
  setImmediate(pushNext);
  return stream;
}

function makeOutput(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function baseContext(overrides: Partial<VerifiedFixPromptContext> = {}): VerifiedFixPromptContext {
  return {
    filePath: '/repo/src/components/Avatar.tsx',
    startLine: 8,
    violation: {
      id: 'image-alt',
      impact: 'critical',
      description: 'Ensure <img> elements have alternative text',
      help: 'Images must have alternative text',
      helpUrl: 'https://example.com',
      nodes: [],
    },
    patch: {
      filePath: '/repo/src/components/Avatar.tsx',
      violationId: 'image-alt',
      oldSnippet: '<img src={avatarUrl} />',
      newSnippet: '<img src={avatarUrl} alt="User avatar" />',
      confidence: 'high',
    },
    ...overrides,
  };
}

describe('createInteractiveHandler', () => {
  it('returns accept for "y" and prints the file, rule, and diff', async () => {
    const { stream: input } = { stream: makeInput(['y']) };
    const { stream: output, text } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    const decision = await handler.onVerifiedFix(baseContext());
    handler.close();

    expect(decision).toEqual({ action: 'accept' });
    expect(text()).toContain('src/components/Avatar.tsx:8');
    expect(text()).toContain('image-alt');
    expect(text()).toContain('-<img src={avatarUrl} />');
    expect(text()).toContain('+<img src={avatarUrl} alt="User avatar" />');
  });

  it('returns reject for "n"', async () => {
    const input = makeInput(['n']);
    const { stream: output } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    const decision = await handler.onVerifiedFix(baseContext());
    handler.close();

    expect(decision).toEqual({ action: 'reject' });
  });

  it('accepts full words "yes"/"no" as well as single letters', async () => {
    const input = makeInput(['yes']);
    const { stream: output } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    const decision = await handler.onVerifiedFix(baseContext());
    handler.close();

    expect(decision).toEqual({ action: 'accept' });
  });

  it('re-prompts on an invalid answer instead of guessing', async () => {
    const input = makeInput(['banana', 'y']);
    const { stream: output, text } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    const decision = await handler.onVerifiedFix(baseContext());
    handler.close();

    expect(decision).toEqual({ action: 'accept' });
    expect(text()).toContain('Please answer y, n, e, or q.');
  });

  it('collects a multi-line edit terminated by a lone "."', async () => {
    const input = makeInput(['e', '<img src={avatarUrl} alt="A team photo" />', '.']);
    const { stream: output } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    const decision = await handler.onVerifiedFix(baseContext());
    handler.close();

    expect(decision).toEqual({
      action: 'edit',
      newSnippet: '<img src={avatarUrl} alt="A team photo" />',
    });
  });

  it('joins multiple edited lines with newlines', async () => {
    const input = makeInput(['edit', '<div>', '  <span>x</span>', '</div>', '.']);
    const { stream: output } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    const decision = await handler.onVerifiedFix(baseContext());
    handler.close();

    expect(decision).toEqual({
      action: 'edit',
      newSnippet: '<div>\n  <span>x</span>\n</div>',
    });
  });

  it('shows why a previous edit was rejected when editRejected is set', async () => {
    const input = makeInput(['n']);
    const { stream: output, text } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    await handler.onVerifiedFix(
      baseContext({
        editRejected: {
          remainingViolations: [
            {
              id: 'image-alt',
              impact: 'critical',
              description: 'x',
              help: 'Images must have alternative text',
              helpUrl: '',
              nodes: [],
            },
          ],
          newViolations: [],
        },
      }),
    );
    handler.close();

    expect(text()).toContain('Your edit did not resolve it');
    expect(text()).toContain('still flagged: image-alt');
  });

  it('quits: once "q" is answered, every later call returns reject without prompting again', async () => {
    const input = makeInput(['q']);
    const { stream: output, text } = makeOutput();
    const handler = createInteractiveHandler({ input, output, projectRoot: '/repo' });

    const first = await handler.onVerifiedFix(baseContext());
    const textAfterQuit = text();
    const second = await handler.onVerifiedFix(baseContext({ startLine: 20 }));
    handler.close();

    expect(first).toEqual({ action: 'reject' });
    expect(second).toEqual({ action: 'reject' });
    // Nothing new was printed for the second (post-quit) call.
    expect(text()).toBe(textAfterQuit);
  });
});
