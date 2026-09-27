import { watch } from "node:fs";
import { join } from "node:path";
import { armChanges } from "./baseline.js";
import { agentHealth, elapsedMs, runActive } from "./health.js";
import { readRunState } from "./state.js";
import type { ProducerStatus, ResolvedRun } from "./types.js";

export async function renderStatus(run: ResolvedRun): Promise<string> {
  const view = await readRunState(run.runDir);
  const budget = run.config.producer.timeoutMs;
  const rows = await Promise.all(Object.entries(view.producers).map(async ([id, producer]) => {
    const changed = await changedFiles(run, id);
    const budgetCell = producer.startedAt ? `${duration(elapsedMs(producer))} / ${duration(budget)}` : "—";
    return [id, liveStatus(producer, budget), budgetCell, since(producer.lastActivityAt), String(producer.toolCalls), String(changed)];
  }));
  // A run with no judge never grows a judge row; one that has a judge grows it
  // with the first `crucible judge`.
  if (view.judge && run.config.judge) {
    const judgeBudget = run.config.judge.timeoutMs;
    const budgetCell = view.judge.startedAt ? `${duration(elapsedMs(view.judge))} / ${duration(judgeBudget)}` : "—";
    rows.push(["judge", liveStatus(view.judge, judgeBudget), budgetCell, since(view.judge.lastActivityAt), String(view.judge.toolCalls), "—"]);
  }
  const errors = [...Object.entries(view.producers), ...(view.judge ? [["judge", view.judge] as const] : [])]
    .filter(([, agent]) => agent.error)
    .map(([id, agent]) => `${id}: ${agent.error}`);
  const interrupted = view.state === "running" && !runActive(view)
    ? [`No agent is at work: the runner was interrupted. Mark the run stopped with crucible stop ${run.runId}, then start it again.`]
    : [];
  return [
    `${run.runId}  ${view.state}`,
    table(["agent", "state", "elapsed / budget", "last activity", "tools", "changed"], rows),
    ...(errors.length > 0 ? [errors.join("\n")] : []),
    ...interrupted,
  ].join("\n\n");
}

export async function statusJson(run: ResolvedRun): Promise<string> {
  const view = await readRunState(run.runDir);
  const budget = run.config.producer.timeoutMs;
  const producers = Object.fromEntries(await Promise.all(Object.entries(view.producers).map(async ([id, producer]) => [id, {
    ...progress(producer, budget),
    changedFiles: await changedFiles(run, id),
  }])));
  const judge = view.judge && run.config.judge ? progress(view.judge, run.config.judge.timeoutMs) : undefined;
  return JSON.stringify({ runId: run.runId, state: view.state, producers, ...(judge ? { judge } : {}) }, null, 2);
}

export async function watchStatus(run: ResolvedRun): Promise<void> {
  const print = async () => {
    process.stdout.write(`\u001b[2J\u001b[H${await renderStatus(run)}\n`);
  };
  const finished = async () => !runActive(await readRunState(run.runDir));
  await print();
  if (await finished()) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(join(run.runDir, "state.json"), { persistent: true }, () => {
      void print().then(async () => {
        if (await finished()) finish();
      }).catch(reject);
    });
    const timer = setInterval(() => {
      void print().then(async () => {
        if (await finished()) finish();
      }).catch(reject);
    }, 2_000);
    const finish = () => { clearInterval(timer); watcher.close(); resolve(); };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function progress(agent: ProducerStatus, timeoutMs: number) {
  return {
    state: liveStatus(agent, timeoutMs),
    elapsedSeconds: agent.startedAt ? Math.floor(elapsedMs(agent) / 1000) : null,
    timeoutSeconds: Math.floor(timeoutMs / 1000),
    silentSeconds: agent.lastActivityAt ? Math.floor((Date.now() - Date.parse(agent.lastActivityAt)) / 1000) : null,
    toolCalls: agent.toolCalls,
    ...(agent.error ? { error: agent.error } : {}),
  };
}

function liveStatus(producer: ProducerStatus, timeoutMs: number): string {
  if (producer.state === "complete" && producer.timedOut) return "complete (timed out)";
  if (producer.state !== "running") return producer.state;
  const health = agentHealth(producer, timeoutMs);
  if (health === "preparing") return "waiting / preparing";
  return health === "working" ? "running" : health === "process missing" ? "stalled (process missing)" : health;
}

async function changedFiles(run: ResolvedRun, id: string): Promise<number> {
  try {
    return (await armChanges(run, id)).length;
  } catch {
    return 0;
  }
}

function since(value: string | undefined): string {
  return value ? `${duration(Date.now() - Date.parse(value))} ago` : "—";
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  return [headers, ...rows].map((row) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd()).join("\n");
}
