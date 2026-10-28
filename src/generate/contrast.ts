/**
 * generate/contrast.ts — the color-contrast–specific part of the fix path.
 *
 * Low contrast is a design problem as much as an accessibility one, so the
 * fix must not "solve" it by swapping in arbitrary colors. Instead:
 *
 *  - The target text color is computed here, not left to the model: the
 *    existing foreground color, same hue and saturation, darkened or
 *    lightened (whichever needs the smaller change) only until it clears
 *    the ratio axe-core requires. The model is told to use exactly that
 *    value and to change nothing else.
 *  - If the text sits on a background image or gradient, there is no
 *    single background color to compute against, so the violation is
 *    reported as not auto-fixable instead of guessed.
 *
 * verify/ still re-runs axe-core (in browser mode) on whatever comes back,
 * so this narrows what the model may do; it doesn't replace verification.
 */

import type { FixContext } from '../context';

export interface ContrastMeasurement {
  foreground: string;
  background: string;
  ratio: number;
  expectedRatio: number;
}

export interface ContrastSuggestion {
  color: string;
  ratio: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Reads axe-core's color-contrast failure summary, e.g. "Element has
 * insufficient color contrast of 1.6 (foreground color: #cccccc,
 * background color: #ffffff, font size: 12.0pt (16px), font weight:
 * normal). Expected contrast ratio of 4.5:1". Returns null for any other
 * shape (e.g. the text-shadow variants), so callers fall back to
 * instructions without a precomputed color.
 */
export function parseContrastSummary(summary: string | undefined): ContrastMeasurement | null {
  if (!summary) return null;
  const ratio = summary.match(/insufficient color contrast of ([\d.]+) \(/);
  const foreground = summary.match(/foreground color: (#[0-9a-f]{3,8})\b/i);
  const background = summary.match(/background color: (#[0-9a-f]{3,8})\b/i);
  const expected = summary.match(/Expected contrast ratio of ([\d.]+):1/);
  if (!ratio?.[1] || !foreground?.[1] || !background?.[1] || !expected?.[1]) return null;
  return {
    foreground: foreground[1].toLowerCase(),
    background: background[1].toLowerCase(),
    ratio: Number(ratio[1]),
    expectedRatio: Number(expected[1]),
  };
}

function parseHex(hex: string): Rgb {
  let digits = hex.replace(/^#/, '');
  if (digits.length === 3 || digits.length === 4) {
    digits = digits
      .slice(0, 3)
      .split('')
      .map((digit) => digit + digit)
      .join('');
  }
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(digits)) {
    throw new Error(`Not a hex color: "${hex}"`);
  }
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.x contrast ratio between two hex colors (1–21). */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(parseHex(foreground));
  const b = luminance(parseHex(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hueToChannel = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    g: Math.round(hueToChannel(p, q, h) * 255),
    b: Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  };
}

// axe-core passes only when the ratio is strictly greater than the
// threshold; a small margin absorbs rounding differences between this
// math and the browser's color blending.
const RATIO_MARGIN = 0.02;
const LIGHTNESS_STEP = 0.001;

/**
 * The smallest lightness-only change to `foreground` (hue and saturation
 * kept) that clears `expectedRatio` against `background`, trying both
 * darker and lighter and keeping whichever moves less. Null if neither
 * direction can reach the ratio — that background needs a human.
 */
export function suggestTextColor(
  foreground: string,
  background: string,
  expectedRatio: number,
): ContrastSuggestion | null {
  const target = expectedRatio + RATIO_MARGIN;
  const original = rgbToHsl(parseHex(foreground));

  const search = (direction: -1 | 1): { color: string; ratio: number; delta: number } | null => {
    for (let delta = LIGHTNESS_STEP; delta <= 1; delta += LIGHTNESS_STEP) {
      const l = original.l + direction * delta;
      if (l < 0 || l > 1) break;
      const color = toHex(hslToRgb({ ...original, l }));
      const ratio = contrastRatio(color, background);
      if (ratio >= target) return { color, ratio, delta };
    }
    // Pure black/white as the last step in that direction.
    const extreme = direction === -1 ? '#000000' : '#ffffff';
    const ratio = contrastRatio(extreme, background);
    return ratio >= target ? { color: extreme, ratio, delta: 1 } : null;
  };

  const candidates = [search(-1), search(1)].filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
  );
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b.delta < a.delta ? b : a));
  return { color: best.color, ratio: Math.floor(best.ratio * 100) / 100 };
}

// Inline styles (JSX and HTML), CSS gradients, and common utility classes
// (Tailwind v3 `bg-gradient-to-*`, v4 `bg-linear-*`, arbitrary
// `bg-[url(...)]`).
const BACKGROUND_IMAGE_PATTERNS: RegExp[] = [
  /background-?image/i,
  /\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/i,
  /background[^;}\n]*\burl\s*\(/i,
  /\bbg-(?:gradient|linear|radial|conic)-/,
  /\bbg-\[url\(/,
];

/**
 * Whether the offending element or its parent (all generate/ is shown)
 * paints a background image or gradient. Text over one has no single
 * background color to compute against, so it isn't auto-fixable.
 */
export function findBackgroundImage(context: FixContext): string | null {
  const sources = [context.element.code, context.parent?.code ?? ''];
  for (const source of sources) {
    for (const pattern of BACKGROUND_IMAGE_PATTERNS) {
      const match = source.match(pattern);
      if (match) return match[0];
    }
  }
  return null;
}

export function buildContrastSection(
  measurement: ContrastMeasurement | null,
  suggestion: ContrastSuggestion | null,
): string {
  const lines = [
    '',
    'Color-contrast rules — this violation is low text contrast:',
    '- Fix it by changing only the text (foreground) color of the offending element. It must stay recognisably the same color: same hue, only darkened or lightened as far as needed to meet the required ratio.',
  ];
  if (measurement) {
    lines.push(
      `- Measured by axe-core: text ${measurement.foreground} on background ${measurement.background} = ${measurement.ratio}:1; required: more than ${measurement.expectedRatio}:1.`,
    );
  }
  if (measurement && suggestion) {
    lines.push(
      `- Use exactly this text color: ${suggestion.color} (${suggestion.ratio}:1 on ${measurement.background}). It is ${measurement.foreground} with only its lightness changed, by the smallest amount that passes.`,
    );
  } else {
    lines.push(
      '- Darken or lighten the existing text color by the smallest amount that meets the required ratio; keep its hue.',
    );
  }
  lines.push(
    "- Put the new color where this element's text color is defined today (an inline style or a color utility class). If the element doesn't set a text color itself, add a text color for it alone.",
    '- Do not change the background color, any background image, the font (family, size, weight, style), letter spacing, or the text content, and do not add or remove elements.',
  );
  return lines.join('\n');
}
