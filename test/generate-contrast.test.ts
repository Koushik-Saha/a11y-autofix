import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Anthropic client is mocked so the exact prompt generate/ builds can
// be inspected, and so "not auto-fixable" can be shown to never reach the
// API at all.
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
import type { AxeViolation } from '../src/detect';
import { NotAutoFixableError, generateFix } from '../src/generate';
import {
  contrastRatio,
  findBackgroundImage,
  parseContrastSummary,
  suggestTextColor,
} from '../src/generate/contrast';

const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

// Exactly what axe-core reports for LowContrastText.tsx in browser mode
// (see test/browser-detect.test.ts) — inlined so these tests need no browser.
const CONTRAST_SUMMARY =
  'Fix any of the following:\n  Element has insufficient color contrast of 1.6 (foreground color: #cccccc, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1';

const contrastViolation: AxeViolation = {
  filePath: fixture('LowContrastText.tsx'),
  id: 'color-contrast',
  impact: 'serious',
  description:
    'Ensure the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds',
  help: 'Elements must meet minimum color contrast ratio thresholds',
  helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
  nodes: [
    {
      target: ['p'],
      html: '<p style="color: rgb(204, 204, 204); background-color: rgb(255, 255, 255);">This text has very low contrast against its background.</p>',
      failureSummary: CONTRAST_SUMMARY,
    },
  ],
};

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function promptSent(): string {
  const request = parse.mock.calls[0]?.[0] as { messages: { content: string }[] };
  return request.messages[0]!.content;
}

beforeEach(() => {
  parse.mockReset();
  AnthropicMock.mockClear();
  parse.mockResolvedValue({
    parsed_output: { newSnippet: "<p style={{ color: '#767676', backgroundColor: '#ffffff' }}>" },
    stop_reason: 'end_turn',
  });
});

describe('contrast math', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#cccccc', '#ffffff')).toBeCloseTo(1.61, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it("parses axe-core's color-contrast failure summary", () => {
    expect(parseContrastSummary(CONTRAST_SUMMARY)).toEqual({
      foreground: '#cccccc',
      background: '#ffffff',
      ratio: 1.6,
      expectedRatio: 4.5,
    });
    expect(
      parseContrastSummary(
        'Element has insufficient color contrast of 2.1 between the foreground and shadow color (foreground color: #ffffff, text-shadow color: #eeeeee, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1',
      ),
    ).toBeNull();
    expect(parseContrastSummary(undefined)).toBeNull();
  });

  it('darkens light-gray text on white only as far as needed (#cccccc -> #767676)', () => {
    expect(suggestTextColor('#cccccc', '#ffffff', 4.5)).toEqual({ color: '#767676', ratio: 4.54 });
  });

  it('lightens text on a dark background', () => {
    const suggestion = suggestTextColor('#555555', '#222222', 4.5);
    expect(suggestion).not.toBeNull();
    expect(parseInt(suggestion!.color.slice(1, 3), 16)).toBeGreaterThan(0x55);
    expect(contrastRatio(suggestion!.color, '#222222')).toBeGreaterThan(4.5);
  });

  it('keeps the hue of a brand color', () => {
    const brand = '#6fa8dc';
    const suggestion = suggestTextColor(brand, '#ffffff', 4.5)!;
    expect(contrastRatio(suggestion.color, '#ffffff')).toBeGreaterThan(4.5);
    expect(Math.abs(hue(suggestion.color) - hue(brand))).toBeLessThan(2);
  });

  it('returns null when no text color can reach the ratio on that background', () => {
    // Black on #777777 is ~4.7:1 and white ~4.5:1 — nothing reaches 7:1.
    expect(suggestTextColor('#888888', '#777777', 7)).toBeNull();
  });
});

describe('generateFix for color-contrast', () => {
  let context: FixContext;

  beforeEach(async () => {
    context = await gatherContext({
      violation: contrastViolation,
      componentPath: fixture('LowContrastText.tsx'),
    });
  });

  it('tells the model the exact minimal text color and forbids touching anything else', async () => {
    const patch = await generateFix({ context });

    const prompt = promptSent();
    expect(prompt).toContain('Color-contrast rules');
    expect(prompt).toContain('text #cccccc on background #ffffff = 1.6:1');
    expect(prompt).toContain('Use exactly this text color: #767676 (4.54:1 on #ffffff)');
    expect(prompt).toContain(
      'Do not change the background color, any background image, the font (family, size, weight, style), letter spacing, or the text content',
    );
    expect(patch.newSnippet).toContain('#767676');
    expect(patch.oldSnippet).toBe(context.element.code);
    expect(patch.position).toEqual({
      start: context.element.location.startOffset,
      end: context.element.location.endOffset,
    });
  });

  it("passes axe-core's measurement of a rejected color back on retry", async () => {
    await generateFix({
      context,
      previousAttempt: {
        newSnippet: "<p style={{ color: '#999999', backgroundColor: '#ffffff' }}>",
        remainingViolations: [
          {
            ...contrastViolation,
            nodes: [
              {
                target: ['p'],
                html: '<p>',
                failureSummary: CONTRAST_SUMMARY.replace('1.6', '2.84').replace(
                  '#cccccc',
                  '#999999',
                ),
              },
            ],
          },
        ],
        newViolations: [],
      },
    });

    expect(promptSent()).toContain('axe-core detail: Fix any of the following:');
    expect(promptSent()).toContain('contrast of 2.84 (foreground color: #999999');
  });

  it('reports text over a gradient as not auto-fixable, without calling the model', async () => {
    const onGradient: FixContext = {
      ...context,
      parent: {
        ...context.element,
        code: "<div style={{ backgroundImage: 'linear-gradient(#fff, #eee)' }}>…</div>",
      },
    };

    await expect(generateFix({ context: onGradient })).rejects.toBeInstanceOf(NotAutoFixableError);
    await expect(generateFix({ context: onGradient })).rejects.toThrow(
      /background image or gradient/,
    );
    expect(AnthropicMock).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it('reports text over a background image as not auto-fixable', async () => {
    const onImage: FixContext = {
      ...context,
      element: {
        ...context.element,
        code: '<p style="color: #ccc; background: url(/hero.jpg) center">Hi</p>',
      },
    };

    expect(findBackgroundImage(onImage)).not.toBeNull();
    await expect(generateFix({ context: onImage })).rejects.toBeInstanceOf(NotAutoFixableError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('reports an unreachable ratio as not auto-fixable rather than changing the background', async () => {
    const impossible: FixContext = {
      ...context,
      violation: {
        ...contrastViolation,
        nodes: [
          {
            ...contrastViolation.nodes[0]!,
            failureSummary: CONTRAST_SUMMARY.replace('#cccccc', '#888888')
              .replace('#ffffff', '#777777')
              .replace('4.5:1', '7:1'),
          },
        ],
      },
    };

    await expect(generateFix({ context: impossible })).rejects.toThrow(
      /no text color reaches the required 7:1/,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it('leaves the prompt for other rules unchanged', async () => {
    const { detectViolations } = await import('../src/detect');
    const { violations } = await detectViolations({ componentPath: fixture('MissingAlt.tsx') });
    const altContext = await gatherContext({
      violation: violations[0]!,
      componentPath: fixture('MissingAlt.tsx'),
    });

    await generateFix({ context: altContext });

    expect(promptSent()).not.toContain('Color-contrast rules');
  });
});
