import { describeTokens } from "./cost.js";
import type { ListedRun } from "./run.js";
import { table } from "./status.js";
import type { JudgedResult, RunResult, TokenCounts } from "./types.js";
import { isJudged } from "./verdict.js";

const MISSING = "—";
const UNJUDGED = "not judged";
const NONE_JUDGED = "no judged run";

/** One cell summing up a reported run: winner, every total, judge confidence. */
export function resultCell(result: RunResult | null): string {
  if (!result) return "";
  if (!isJudged(result)) return UNJUDGED;
  const totals = result.arms.map((arm) => total(result, arm.label)).join("–");
  return `${result.winner} ${totals} ${percent(result.confidence)}`;
}

/**
 * Every series with reported runs, and how its arms stand. A run with no
 * judgment produced outputs but ranked nothing, so it is counted and then left
 * out of the tally and the means.
 */
export function renderSeriesIndex(runs: ListedRun[]): string {
  const bySeries = new Map<string, RunResult[]>();
  for (const run of runs) {
    if (!run.series || !run.result) continue;
    bySeries.set(run.series, [...(bySeries.get(run.series) ?? []), run.result]);
  }
  if (bySeries.size === 0) return "No series has a reported run yet. Set `series:` in an experiment file to group repeated runs.";
  return table(["series", "runs", "tally", "mean total"], [...bySeries.entries()].map(([name, results]) => {
    const judged = results.filter(isJudged);
    return [name, runCount(results.length, judged.length), tally(judged, MISSING), meanTotals(judged, MISSING)];
  }));
}

/** The runs of one series, oldest first, with the tally underneath. */
export function renderSeries(runs: ListedRun[], series: string): string {
  const results = runs.filter((run) => run.series === series && run.result).map((run) => run.result!);
  if (results.length === 0) return `No reported run has series "${series}".`;
  const judged = results.filter(isJudged);
  const labels = armLabels(results);
  const rows = results.map((result) => [
    result.runId,
    result.reportedAt.slice(0, 10),
    isJudged(result) ? result.winner : UNJUDGED,
    ...labels.map((label) => total(result, label)),
    isJudged(result) ? percent(result.confidence) : MISSING,
  ]);
  return [
    table(["run", "date", "winner", ...labels, "confidence"], rows),
    "",
    `${runCount(results.length, judged.length)} run${results.length === 1 ? "" : "s"}: ${tally(judged, NONE_JUDGED)}. Mean total: ${meanTotals(judged, NONE_JUDGED)}.`,
    "",
    "Mean tokens per run:",
    ...labels.map((label) => `  ${label}: ${meanTokens(results, label)}`),
    "",
    "Totals compare only within a series, where the rubric and task are the same.",
  ].join("\n");
}

/** How many runs a series holds, saying how many of them ranked anything when some did not. */
function runCount(total: number, judged: number): string {
  return judged === total ? String(total) : `${total} (${total - judged} not judged)`;
}

/** The arms of a series, in the run order of its first result, plus any a later run added. */
function armLabels(results: RunResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.arms.map((arm) => arm.label)))];
}

/** Wins per arm, or `empty` when no run in the series was judged. */
function tally(results: JudgedResult[], empty: string): string {
  if (results.length === 0) return empty;
  const ties = results.filter((result) => result.winner === "tie").length;
  const wins = armLabels(results).map((label) => `${label} ${results.filter((result) => result.winner === label).length}`);
  return [...wins, ...(ties > 0 ? [`tie ${ties}`] : [])].join(" · ");
}

function meanTotals(results: JudgedResult[], empty: string): string {
  if (results.length === 0) return empty;
  return armLabels(results).map((label) => {
    const scored = results.filter((result) => result.totals[label] !== undefined);
    if (scored.length === 0) return `${label} ${MISSING}`;
    const mean = scored.reduce((sum, result) => sum + result.totals[label]!, 0) / scored.length;
    return `${label} ${mean.toFixed(2)}`;
  }).join(" · ");
}

/** What one arm spent per run on average, across the runs whose agent reported it. */
function meanTokens(results: RunResult[], label: string): string {
  const counted = results.map((result) => result.cost[label]?.tokens).filter((tokens): tokens is TokenCounts => tokens !== undefined && tokens !== null);
  if (counted.length === 0) return "tokens unavailable";
  const mean = (of: (tokens: TokenCounts) => number) => Math.round(counted.reduce((sum, tokens) => sum + of(tokens), 0) / counted.length);
  return describeTokens({
    input: mean((tokens) => tokens.input),
    output: mean((tokens) => tokens.output),
    cacheRead: mean((tokens) => tokens.cacheRead),
    cacheWrite: mean((tokens) => tokens.cacheWrite),
  });
}

function total(result: RunResult, label: string): string {
  return isJudged(result) ? result.totals[label]?.toFixed(2) ?? MISSING : MISSING;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
