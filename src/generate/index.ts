/**
 * generate/ — sends a FixContext to the Claude API and returns a proposed
 * Patch for the single JSX element located by context/. Output is
 * unverified until verify/ re-runs axe-core against the patched component.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { AxeViolation } from '../detect';
import type { FixContext, ResolvedSourceContext, SourceRange } from '../context';

import {
  buildContrastSection,
  findBackgroundImage,
  parseContrastSummary,
  suggestTextColor,
} from './contrast';
import type { ContrastMeasurement, ContrastSuggestion } from './contrast';

/**
 * Thrown before any model call when a violation can't be fixed safely by
 * editing the element — e.g. low contrast over a background image or
 * gradient. scan/ reports these as `status: 'errored'` with
 * `reason: 'not-auto-fixable'`: unresolved, but deliberately not guessed.
 */
export class NotAutoFixableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAutoFixableError';
  }
}

export interface Patch {
  filePath: string;
  violationId: string;
  /** The element's exact source text when scanned. With `position`, a check that the file hasn't changed; without it, how the element is found. */
  oldSnippet: string;
  newSnippet: string;
  /**
   * Where `oldSnippet` sat in the file when it was scanned: character
   * offsets from context/'s AST (`element.location.startOffset` /
   * `endOffset`). verify/'s `applyPatchToSource` replaces exactly this
   * range, so a file with two identical offending elements can have each
   * fixed separately. Optional only for patches from before it existed
   * (e.g. a saved `--json` result), which fall back to requiring
   * `oldSnippet` to occur exactly once.
   */
  position?: SourceRange;
}

/**
 * A rejected prior attempt, fed back into a retry so the model can address
 * *why* it was rejected instead of just being asked the same question
 * again — see scan.ts's `resolveViolation`, the only caller that ever sets
 * this.
 */
export interface PreviousAttempt {
  newSnippet: string;
  remainingViolations: AxeViolation[];
  newViolations: AxeViolation[];
}

/** Token usage of one model call, as the API reported it. */
export interface GenerationUsage {
  /** The model that served the call (the response's `model`). */
  model: string;
  inputTokens: number;
  /** Includes thinking tokens: output is billed as one total. */
  outputTokens: number;
  /** The part of `outputTokens` spent on reasoning, when the API reports it. */
  thinkingTokens: number | null;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface GenerateFixOptions {
  context: FixContext;
  /** When set, this call is a retry of a previously-rejected attempt. */
  previousAttempt?: PreviousAttempt;
  /**
   * Read the API key from this environment variable instead of the SDK's
   * default `ANTHROPIC_API_KEY`. If it isn't set, this throws rather than
   * falling back to `ANTHROPIC_API_KEY`.
   */
  apiKeyEnv?: string;
  /**
   * Called once per model call with its token usage — for cost
   * accounting (e.g. the eval harness in scripts/eval/). Purely
   * observational.
   */
  onUsage?: (usage: GenerationUsage, context: FixContext) => void;
}

/**
 * The model is asked for exactly one thing: a replacement for the element
 * it's shown. It is never asked to reproduce the original — `oldSnippet` on
 * the returned Patch comes straight from context/'s AST-derived
 * `element.code`, which is already exact. Asking the model to echo it back
 * would just add a chance of transcription drift for no benefit.
 */
const PatchSuggestionSchema = z.object({
  newSnippet: z
    .string()
    .describe(
      'The corrected JSX for the offending element only, as a drop-in replacement for it. Do not include the parent, siblings, or any other code.',
    ),
});

const SYSTEM_PROMPT = `You fix a single WCAG accessibility violation in a React JSX element.

You are shown the exact JSX element that failed an axe-core rule, its immediate parent, its sibling elements, and (when available) the component's prop types — all for context only.

Return only a replacement for that one element. It must be a drop-in substitute: same tag, same children unless the fix requires changing them, and every prop or event handler unrelated to the violation left untouched. Do not touch the parent, the siblings, or anything else in the file. Do not reformat, rename, or refactor code that isn't part of the fix.

When the fix needs new text — alt text, an aria-label, a form label — write something specific and meaningful based on the surrounding context, not a generic placeholder like "image" or "TODO".

When values resolved from source or event handler implementations are provided, use them to write specific alt text and labels (what the image shows, what the control does), but do not mention them in the fix itself — no file paths, variable names, or code.

For a link, or a button that is not icon-only, prefer adding real visible text as the element's child content over adding an aria-label. An aria-label-only link or button passes axe-core but shows sighted users nothing. An aria-label (or aria-labelledby) is acceptable for a genuinely icon-only control, such as a button whose only content is an icon.

Some rules flag an element because of how it relates to another element — for example landmark-unique, where two landmarks share the same accessible name. For these relational rules, fixing only the flagged element is sufficient and expected: change it so the conflict is resolved on its own (e.g. give it a name that differs from the sibling's). Do not change the sibling, and do not write a replacement that assumes the sibling will also change.

If you are shown a previous attempt that was rejected, produce a genuinely different fix that addresses why it was rejected — do not repeat it.`;

/**
 * context/'s statically resolved prop values and handler bodies, labeled
 * so the model can tell them apart from the element's own code.
 */
function buildResolvedSection(resolved: ResolvedSourceContext): string {
  const lines: string[] = [];
  if (resolved.values.length > 0) {
    lines.push(
      '',
      'Values resolved from source (static analysis of this file and its local imports; context only, not part of the element):',
      ...resolved.values.map((value) => {
        const partly = value.complete ? '' : ' (partly dynamic: ${…} parts are unknown)';
        return `- ${value.prop}={${value.expression}} resolves to ${JSON.stringify(value.value)}${partly}, from ${value.from.join(' ← ')}`;
      }),
    );
  }
  if (resolved.handlers.length > 0) {
    lines.push(
      '',
      'Event handler implementations (resolved from source; context only, do not modify):',
      ...resolved.handlers.map((handler) =>
        [
          `${handler.prop}={${handler.expression}} is ${handler.from}${handler.truncated ? ', shown truncated' : ''}:`,
          '```ts',
          handler.code,
          '```',
        ].join('\n'),
      ),
    );
  }
  return lines.join('\n');
}

function buildRetrySection(previousAttempt: PreviousAttempt): string {
  const reasons = [
    ...previousAttempt.remainingViolations.map((violation) => {
      const reason = `still flagged: ${violation.id} (${violation.help})`;
      // For contrast, axe's measurement of the rejected color is what tells
      // the model how much further to go.
      const detail =
        violation.id === 'color-contrast' ? violation.nodes[0]?.failureSummary : undefined;
      return detail ? `${reason} — axe-core detail: ${detail}` : reason;
    }),
    ...previousAttempt.newViolations.map(
      (violation) => `introduced a new violation: ${violation.id} (${violation.help})`,
    ),
  ];

  return [
    '',
    'This is a retry. Your previous attempt was rejected:',
    '```jsx',
    previousAttempt.newSnippet,
    '```',
    reasons.length > 0
      ? `Why it was rejected:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`
      : null,
    '',
    'Produce a different fix that actually resolves the original violation without introducing a new one.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

interface ContrastPlan {
  measurement: ContrastMeasurement | null;
  suggestion: ContrastSuggestion | null;
}

/**
 * For a color-contrast violation: refuses (NotAutoFixableError) when a
 * background image/gradient is involved or no text color can reach the
 * ratio, otherwise works out the minimal text color to suggest. Null for
 * every other rule.
 */
function planContrastFix(context: FixContext): ContrastPlan | null {
  if (context.violation.id !== 'color-contrast') return null;

  const backgroundImage = findBackgroundImage(context);
  if (backgroundImage) {
    throw new NotAutoFixableError(
      `Not auto-fixable: this low-contrast text sits on a background image or gradient ("${backgroundImage}"), so there is no single background color to fix the text color against. Check it manually.`,
    );
  }

  const measurement = parseContrastSummary(context.violation.nodes[0]?.failureSummary);
  if (!measurement) return { measurement: null, suggestion: null };

  const suggestion = suggestTextColor(
    measurement.foreground,
    measurement.background,
    measurement.expectedRatio,
  );
  if (!suggestion) {
    throw new NotAutoFixableError(
      `Not auto-fixable: no text color reaches the required ${measurement.expectedRatio}:1 against ${measurement.background} without changing the background. Check it manually.`,
    );
  }
  return { measurement, suggestion };
}

function buildUserPrompt(
  context: FixContext,
  previousAttempt: PreviousAttempt | undefined,
  contrastPlan: ContrastPlan | null,
): string {
  const { violation, element, parent, siblings, propTypes, resolved } = context;
  const violationNode = violation.nodes[0];

  const sections = [
    `Violation: ${violation.id} (impact: ${violation.impact ?? 'unknown'})`,
    `Rule: ${violation.help}`,
    `Description: ${violation.description}`,
    violationNode?.failureSummary ? `axe-core detail: ${violationNode.failureSummary}` : null,
    '',
    'Offending JSX element (this is "oldSnippet" — replace only this):',
    '```jsx',
    element.code,
    '```',
    parent
      ? `\nImmediate parent element (context only, do not modify):\n\`\`\`jsx\n${parent.code}\n\`\`\``
      : null,
    siblings.length > 0
      ? `\nSibling elements (context only, do not modify):\n${siblings
          .map((sibling) => `\`\`\`jsx\n${sibling.code}\n\`\`\``)
          .join('\n')}`
      : null,
    propTypes ? `\nComponent prop types (context only):\n\`\`\`ts\n${propTypes}\n\`\`\`` : null,
    resolved ? buildResolvedSection(resolved) : null,
    contrastPlan ? buildContrastSection(contrastPlan.measurement, contrastPlan.suggestion) : null,
    previousAttempt ? buildRetrySection(previousAttempt) : null,
  ];

  return sections.filter((section): section is string => section !== null).join('\n');
}

export async function generateFix(options: GenerateFixOptions): Promise<Patch> {
  const { context, previousAttempt, apiKeyEnv, onUsage } = options;

  // Before creating the client: a not-auto-fixable violation never costs
  // a model call.
  const contrastPlan = planContrastFix(context);

  let client: Anthropic;
  if (apiKeyEnv) {
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `No Anthropic API key: the environment variable ${apiKeyEnv} (set by apiKeyEnv) is not set.`,
      );
    }
    client = new Anthropic({ apiKey });
  } else {
    client = new Anthropic();
  }
  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(context, previousAttempt, contrastPlan) }],
    output_config: { format: zodOutputFormat(PatchSuggestionSchema) },
  });

  onUsage?.(
    {
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? null,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    },
    context,
  );

  if (!response.parsed_output) {
    throw new Error(
      `Claude did not return a parsable patch for violation "${context.violation.id}" (stop_reason: ${response.stop_reason})`,
    );
  }

  return {
    filePath: context.componentPath,
    violationId: context.violation.id,
    oldSnippet: context.element.code,
    newSnippet: response.parsed_output.newSnippet,
    position: {
      start: context.element.location.startOffset,
      end: context.element.location.endOffset,
    },
  };
}
