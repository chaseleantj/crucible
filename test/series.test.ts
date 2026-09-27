import assert from "node:assert/strict";
import test from "node:test";
import { renderSeries, renderSeriesIndex, resultCell } from "../src/series.js";
import type { AgentIdentity, RunResult, UnjudgedResult } from "../src/types.js";

const identity: AgentIdentity = { agent: "claude", model: "claude-haiku-4-5-20251001", effort: null };

test("a series counts an unjudged run as produced and leaves it out of the tally", () => {
  const judged = fixtureResult("ab-00000001", { winner: "fancy", totals: { plain: 6, fancy: 8 } });
  const unjudged = fixtureResult("ab-00000002", null);
  const rendered = renderSeries([judged, unjudged].map((result) => ({
    runId: result.runId, name: result.name, series: "skip-judge", view: null as never, result,
  })), "skip-judge");
  assert.match(rendered, /2 \(1 not judged\) runs: plain 0 · fancy 1\./);
  assert.match(rendered, /Mean total: plain 6.00 · fancy 8.00/);
  assert.match(rendered, /ab-00000002\s+2026-09-03\s+not judged\s+—\s+—\s+—/);
  assert.equal(resultCell(unjudged), "not judged");
  assert.equal(resultCell(judged), "fancy 6.00–8.00 80%");
});

test("a series with nothing judged says so instead of showing an empty tally", () => {
  const runs = [fixtureResult("ab-00000003", null), fixtureResult("ab-00000004", null)].map((result) => ({
    runId: result.runId, name: result.name, series: "skip-judge", view: null as never, result,
  }));
  const rendered = renderSeries(runs, "skip-judge");
  assert.match(rendered, /2 \(2 not judged\) runs: no judged run\. Mean total: no judged run\./);
  // The index is a table, so the same absence reads as a dash there.
  const index = renderSeriesIndex(runs);
  assert.match(index, /skip-judge\s+2 \(2 not judged\)\s+—\s+—/);
});

function fixtureResult(runId: string, verdict: { winner: string; totals: Record<string, number> } | null): RunResult {
  const produced: UnjudgedResult = {
    runId, name: "no judge", series: "skip-judge", task: "build something",
    reportedAt: "2026-09-03T00:00:00.000Z", environment: "clean",
    arms: [{ label: "plain", candidate: null, replaces: null }, { label: "fancy", candidate: null, replaces: null }],
    producers: { plain: identity, fancy: identity }, cost: { plain: null, fancy: null },
    warnings: [], shots: null, judged: false,
  };
  if (!verdict) return produced;
  return {
    ...produced, judged: true, judgeAgent: identity, winner: verdict.winner, confidence: 0.8,
    totals: verdict.totals, margin: 2, scores: [{ criterion: "quality", weight: 1, scores: verdict.totals }],
    referenceGuess: { arm: null, confidence: 0, correct: null }, summary: "",
  };
}

test("a series tallies its runs by label", () => {
  const result = (runId: string, winner: string, mono: number, refero: number): RunResult => ({
    runId, name: "t", series: "s", task: "", reportedAt: "2026-09-03T00:00:00.000Z", environment: "realistic",
    arms: [{ label: "mono", candidate: null, replaces: null }, { label: "refero", candidate: null, replaces: null }],
    producers: { mono: identity, refero: identity }, judgeAgent: identity,
    winner, confidence: 0.8, totals: { mono, refero }, margin: Math.abs(Number((refero - mono).toFixed(2))), scores: [],
    referenceGuess: { arm: null, confidence: 0, correct: null }, summary: "", cost: { mono: null, refero: null }, warnings: [], shots: null,
  });
  const view = { state: "reported" as const, createdAt: "", updatedAt: "", producers: {} };
  const runs = [
    { runId: "ab-00000001", name: "t", series: "s", view: { ...view, runId: "ab-00000001" }, result: result("ab-00000001", "refero", 7.28, 8.03) },
    { runId: "ab-00000002", name: "t", series: "s", view: { ...view, runId: "ab-00000002" }, result: result("ab-00000002", "mono", 8.5, 7.1) },
    { runId: "ab-00000003", name: "t", series: "other", view: { ...view, runId: "ab-00000003" }, result: null },
  ];
  const rendered = renderSeries(runs, "s");
  assert.match(rendered, /mono 1 · refero 1/);
  assert.match(rendered, /Mean total: mono 7.89 · refero 7.56/);
  assert.equal(resultCell(runs[1]!.result), "mono 8.50–7.10 80%");
  assert.equal(resultCell(null), "");
});
