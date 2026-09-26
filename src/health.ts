import { processExists } from "./agent.js";
import type { ProducerStatus, RunState, RunView } from "./types.js";

/**
 * An agent that has written nothing for five minutes is quiet, and for fifteen
 * stalled; one past 80% of its budget is near its timeout. `crucible status` and
 * the store's live runs both draw the lines here.
 */
const QUIET_MS = 5 * 60_000;
const STALLED_MS = 15 * 60_000;
const NEAR_TIMEOUT_FRACTION = 0.8;

export type AgentHealth = "working" | "quiet" | "stalled" | "near timeout" | "process missing";

/**
 * The record says this agent is at work: running, or waiting to start in a
 * run that is producing. A runner killed mid-run leaves such a record behind.
 */
export function agentAtWork(agent: ProducerStatus, runState: RunState): boolean {
  return agent.state === "running" || (agent.state === "ready" && runState === "running");
}

/**
 * At work for real: the record says so, and a running agent's process still
 * exists. The one answer to whether a run can be deleted, is in flight, or
 * is judging.
 */
export function agentActive(agent: ProducerStatus, runState: RunState): boolean {
  if (!agentAtWork(agent, runState)) return false;
  return agent.state === "ready" || (agent.pid !== undefined && processExists(agent.pid));
}

/** Any producer or the judge is active; a run that is must not be deleted, pruned, or called finished. */
export function runActive(view: RunView): boolean {
  return [...Object.values(view.producers), ...(view.judge ? [view.judge] : [])].some((agent) => agentActive(agent, view.state));
}

/** How a running agent is doing: whether it is still worth waiting for. */
export function agentHealth(agent: ProducerStatus, timeoutMs: number): AgentHealth {
  if (!agent.pid || !processExists(agent.pid)) return "process missing";
  const silentFor = agent.lastActivityAt ? Date.now() - Date.parse(agent.lastActivityAt) : 0;
  if (silentFor >= STALLED_MS) return "stalled";
  if (silentFor >= QUIET_MS) return "quiet";
  if (elapsedMs(agent) >= timeoutMs * NEAR_TIMEOUT_FRACTION) return "near timeout";
  return "working";
}

/** Time since the agent started, up to its completion; 0 before it starts. */
export function elapsedMs(agent: ProducerStatus): number {
  if (!agent.startedAt) return 0;
  const end = agent.completedAt ? Date.parse(agent.completedAt) : Date.now();
  return end - Date.parse(agent.startedAt);
}
