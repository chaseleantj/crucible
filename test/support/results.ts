import type { JudgedResult } from "../../src/types.js";

export function judgedResult(overrides: Partial<JudgedResult> = {}): JudgedResult {
  const totals = overrides.totals ?? { a: 8, b: 6 };
  const labels = Object.keys(totals);
  const ranked = [...labels].sort((a, b) => totals[b]! - totals[a]!);
  return {
    runId: "ab-00000001", name: "Question", series: null, task: "Write a page.", reportedAt: "2026-01-01T00:00:00Z", environment: "clean",
    arms: labels.map((label) => ({ label, candidate: null, replaces: null })),
    producers: Object.fromEntries(labels.map((label) => [label, { agent: "claude", model: null, effort: null }])),
    cost: {}, warnings: [], shots: null,
    judgeAgent: { agent: "claude", model: null, effort: null }, winner: ranked[0]!, confidence: 0.7, totals,
    margin: ranked.length > 1 ? totals[ranked[0]!]! - totals[ranked[1]!]! : null,
    scores: [{ criterion: "clarity", weight: 1, scores: totals }],
    referenceGuess: { arm: null, confidence: 0.5, correct: null }, summary: "A was clearer.",
    ...overrides,
  };
}
