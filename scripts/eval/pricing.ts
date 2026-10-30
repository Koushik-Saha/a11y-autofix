/**
 * Per-model prices for the eval's cost estimates, in USD per million
 * tokens. Anthropic first-party API list prices as of 2026-10-06; check
 * https://platform.claude.com/docs/en/about-claude/pricing before relying
 * on them. A model missing here gets no cost estimate (reported as
 * "unknown"), never a guessed one.
 */

import type { GenerationUsage } from '../../src/generate';

export const PRICING_AS_OF = '2026-10-06';

export interface ModelPricing {
  input: number;
  output: number;
  /** 5-minute cache writes (1.25× input). */
  cacheWrite: number;
  /** Cache reads, as published per model. */
  cacheRead: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

/** Cost of one model call in USD, or null when the model's price isn't known. */
export function callCost(usage: GenerationUsage): number | null {
  const price = PRICING[usage.model];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheCreationInputTokens * price.cacheWrite +
      usage.cacheReadInputTokens * price.cacheRead) /
    1_000_000
  );
}
