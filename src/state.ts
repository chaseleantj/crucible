import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentExecutionOptions } from "./agent.js";
import { readJson, writeJson } from "./json.js";
import type { NormalizedEvent, ProducerStatus, RunState, RunView } from "./types.js";

const VIEW_FILE = "state.json";
const EVENT_FILE = "events.jsonl";
const writeQueues = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
/** How often a busy agent's row is rewritten; agent.* events always write. */
const HEARTBEAT_INTERVAL_MS = 1_000;

export function initialProducerStatus(): ProducerStatus {
  return { state: "ready", toolCalls: 0 };
}

export async function createRunState(runDir: string, runId: string, producerIds: string[]): Promise<RunView> {
  const now = new Date().toISOString();
  const producers = Object.fromEntries(producerIds.map((id) => [id, initialProducerStatus()]));
  const view: RunView = { runId, state: "prepared", createdAt: now, updatedAt: now, producers };
  await writeJson(join(runDir, VIEW_FILE), view);
  await appendRunEvent(runDir, { time: now, kind: "run.prepared" });
  return view;
}

export async function readRunState(runDir: string): Promise<RunView> {
  return readJson<RunView>(join(runDir, VIEW_FILE));
}

export async function setRunState(runDir: string, state: RunState): Promise<RunView> {
  return withRunLock(runDir, async () => {
    const view = await readRunState(runDir);
    view.state = state;
    view.updatedAt = new Date().toISOString();
    await writeJson(join(runDir, VIEW_FILE), view);
    await appendRunEvent(runDir, { time: view.updatedAt, kind: `run.${state}` });
    return view;
  });
}

export async function resetProducer(runDir: string, producerId: string): Promise<RunView> {
  return withRunLock(runDir, async () => {
    const view = await readRunState(runDir);
    if (!view.producers[producerId]) throw new Error(`Unknown producer: ${producerId}`);
    view.producers[producerId] = initialProducerStatus();
    view.updatedAt = new Date().toISOString();
    await writeJson(join(runDir, VIEW_FILE), view);
    return view;
  });
}

export async function updateProducer(runDir: string, producerId: string, update: Partial<ProducerStatus>): Promise<RunView> {
  return withRunLock(runDir, async () => {
    const view = await readRunState(runDir);
    const current = view.producers[producerId];
    if (!current) throw new Error(`Unknown producer: ${producerId}`);
    view.producers[producerId] = { ...current, ...update };
    view.updatedAt = new Date().toISOString();
    await writeJson(join(runDir, VIEW_FILE), view);
    return view;
  });
}

/** Starts the judge's row afresh: a rerun should not inherit the last attempt's clock. */
export async function resetJudge(runDir: string): Promise<RunView> {
  return withRunLock(runDir, async () => {
    const view = await readRunState(runDir);
    view.judge = initialProducerStatus();
    view.updatedAt = new Date().toISOString();
    await writeJson(join(runDir, VIEW_FILE), view);
    return view;
  });
}

export async function updateJudge(runDir: string, update: Partial<ProducerStatus>): Promise<RunView> {
  return withRunLock(runDir, async () => {
    const view = await readRunState(runDir);
    view.judge = { ...(view.judge ?? initialProducerStatus()), ...update };
    view.updatedAt = new Date().toISOString();
    await writeJson(join(runDir, VIEW_FILE), view);
    return view;
  });
}

/**
 * The hooks that keep one agent's row current while it runs: the process on
 * start, then its last activity and tool-call count as events arrive, at most
 * once a second. Every event is appended to the run's log as well.
 */
export function trackAgent(
  runDir: string,
  agentId: string,
  update: (patch: Partial<ProducerStatus>) => Promise<unknown>,
): Pick<Required<AgentExecutionOptions>, "onStarted" | "onEvent"> {
  let toolCalls = 0;
  let lastStateUpdate = 0;
  return {
    onStarted: async ({ pid, processStartedAt, startedAt }) => {
      await update({ state: "running", pid, ...(processStartedAt ? { processStartedAt } : {}), startedAt, lastActivityAt: startedAt });
      await appendRunEvent(runDir, { time: startedAt, producer: agentId, kind: "agent.started" });
    },
    onEvent: async (event) => {
      if (event.kind === "tool.started") toolCalls += 1;
      await appendRunEvent(runDir, event);
      const now = Date.now();
      if (now - lastStateUpdate >= HEARTBEAT_INTERVAL_MS || event.kind.startsWith("agent.")) {
        lastStateUpdate = now;
        await update({ lastActivityAt: event.time, toolCalls });
      }
    },
  };
}

export async function appendRunEvent(runDir: string, event: NormalizedEvent): Promise<void> {
  const path = join(runDir, EVENT_FILE);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

async function withRunLock<T>(runDir: string, action: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(runDir) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => next);
  writeQueues.set(runDir, queued);
  await previous;
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireFileLock(runDir);
    return await action();
  } finally {
    await releaseFileLock?.();
    release();
    if (writeQueues.get(runDir) === queued) writeQueues.delete(runDir);
  }
}

async function acquireFileLock(runDir: string): Promise<() => Promise<void>> {
  const path = join(runDir, ".state.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      return () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const details = await stat(path);
        if (Date.now() - details.mtimeMs > STALE_LOCK_MS) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for run state lock: ${runDir}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function readRunEvents(runDir: string): Promise<NormalizedEvent[]> {
  try {
    const content = await readFile(join(runDir, EVENT_FILE), "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as NormalizedEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
