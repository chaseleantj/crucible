import { adapterFor, type Usage } from "./adapters.js";
import type { AgentIdentity, ArmCost, TokenCounts } from "./types.js";

export interface CostRecord {
  wallTimeMs: number;
  usage?: Usage | null;
}

/**
 * What one arm spent: its own usage numbers kept as reported, plus the same
 * counts under one set of names. This is the only place tokens are derived
 * from an agent's usage. The runner reports tokens rather than dollars,
 * because a price table goes stale the moment a provider changes its rates.
 */
export function armCost(identity: AgentIdentity, record: CostRecord | undefined): ArmCost | null {
  if (!record) return null;
  const usage = record.usage ?? null;
  return { wallTimeMs: record.wallTimeMs, usage, tokens: adapterFor(identity.agent).normalizeUsage(usage) };
}

/** One arm's time and tokens in a line, naming whatever is missing. */
export function describeCost(cost: ArmCost | null): string {
  if (!cost) return "unavailable";
  return [
    `${Math.round(cost.wallTimeMs / 1000)}s`,
    cost.tokens ? describeTokens(cost.tokens) : "tokens unavailable",
  ].join("; ");
}

export function describeTokens(tokens: TokenCounts): string {
  return `${compact(tokens.input)} in, ${compact(tokens.output)} out, ${compact(tokens.cacheRead)} cache read, ${compact(tokens.cacheWrite)} cache write`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
