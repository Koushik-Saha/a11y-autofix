/**
 * generate/ — sends a FixContext to the Claude API and returns a proposed
 * Patch for the single JSX element located by context/. Output is
 * unverified until verify/ re-runs axe-core against the patched component.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { FixContext } from '../context';

export interface Patch {
  filePath: string;
  violationId: string;
  oldSnippet: string;
  newSnippet: string;
}

export interface GenerateFixOptions {
  context: FixContext;
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

When the fix needs new text — alt text, an aria-label, a form label — write something specific and meaningful based on the surrounding context, not a generic placeholder like "image" or "TODO".`;

function buildUserPrompt(context: FixContext): string {
  const { violation, element, parent, siblings, propTypes } = context;
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
  ];

  return sections.filter((section): section is string => section !== null).join('\n');
}

export async function generateFix(options: GenerateFixOptions): Promise<Patch> {
  const { context } = options;

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(context) }],
    output_config: { format: zodOutputFormat(PatchSuggestionSchema) },
  });

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
  };
}
