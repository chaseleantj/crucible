import { execFile } from "node:child_process";
import { mkdir, stat, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { authProblem, binaryNames, resolveBinary } from "./adapters.js";
import { executeAgent, processMatches, runSetup, terminateProcessGroup, type AgentExecutionResult } from "./agent.js";
import { auditRun } from "./audit.js";
import { armChanges, recordBaseline } from "./baseline.js";
import { armFor, producerFor } from "./config.js";
import { UserError, errorMessage } from "./errors.js";
import { collectProjectInstructions, copyTree, makeReadOnly, removeTree } from "./files.js";
import { agentAtWork } from "./health.js";
import { readJson, writeJson } from "./json.js";
import { runSandboxProbes } from "./sandbox.js";
import { skillLoader, type SkillCatalogEntry } from "./skills.js";
import { subagentLoader, type SubagentCatalogEntry } from "./subagents.js";
import { appendRunEvent, readRunState, resetProducer, setRunState, trackAgent, updateJudge, updateProducer } from "./state.js";
import type { AgentName, ProducerStatus, ResolvedRun, StartCheck } from "./types.js";

const execFileAsync = promisify(execFile);

export async function startRun(run: ResolvedRun): Promise<void> {
  const view = await readRunState(run.runDir);
  if (view.state === "running") {
    throw new UserError(`Run is already marked running. Follow it with: crucible status ${run.runId} --watch, or stop it first: crucible stop ${run.runId}`);
  }
  if (view.state !== "prepared" && view.state !== "failed" && view.state !== "stopped") {
    throw new UserError(`Run already has complete outputs; current state is ${view.state}`);
  }

  const pending = Object.entries(view.producers)
    .filter(([, producer]) => producer.state !== "complete")
    .map(([producerId]) => producerId);
  // Every producer finished but the run never reached "produced": the audit
  // failed after them. Only that step is left to redo.
  if (pending.length === 0) return finishRun(run);

  for (const producerId of pending) {
    await materializeWorkspace(run, producerId);
    await resetProducer(run.runDir, producerId);
  }
  const checks = await runStartChecks(run, pending.filter((id) => !armFor(run.config, run.assignment.arms[id]!).reuse));
  await writeJson(join(run.runDir, "checks.json"), { checkedAt: new Date().toISOString(), checks });
  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    throw new UserError(`Start checks failed:\n${failed.map((check) => `- ${check.name}${check.detail ? `: ${check.detail}` : ""}`).join("\n")}`);
  }

  await setRunState(run.runDir, "running");
  const results = await Promise.all(pending.map(async (producerId) => ({ producerId, error: await runProducer(run, producerId) })));
  const failures = results.filter((result) => result.error);
  if (failures.length > 0) {
    await setRunState(run.runDir, "failed");
    throw new UserError([
      "One or more producers failed:",
      ...failures.map((failure) => `- ${failure.producerId}: ${failure.error}`),
      `Relaunch the failed arms with: crucible start ${run.runId}`,
    ].join("\n"));
  }
  await finishRun(run);
}

/** What happens once every producer is complete: the audit, and the state that lets the judge begin. */
async function finishRun(run: ResolvedRun): Promise<void> {
  const audit = await auditRun(run);
  await setRunState(run.runDir, "produced");
  if (audit.warnings.length > 0) {
    process.stderr.write(`Audit recorded ${audit.warnings.length} warning(s); they will appear in the report.\n`);
  }
}

/**
 * A producer workspace is always built the same way, from the pristine copies
 * frozen at prepare time. Relaunching a failed arm is therefore just building
 * it again — there is no separate retry path.
 */
async function materializeWorkspace(run: ResolvedRun, producerId: string): Promise<void> {
  const producerDir = join(run.tempDir, producerId);
  await removeTree(producerDir);
  await mkdir(join(producerDir, ".runtime", "tmp"), { recursive: true, mode: 0o700 });
  await copyTree(join(run.runDir, "frozen", "source"), join(producerDir, "source"));
  await copyTree(join(run.runDir, "frozen", producerId, "context"), join(producerDir, ".context"));
  await makeReadOnly(join(producerDir, ".context"));
  await linkSharedPackages(run.config.nodeModules, producerDir);
}

/**
 * A frozen skill's scripts import packages by bare name and resolve them by
 * walking up from their own location, the way they do where the skills live.
 * Linking the configured node_modules at the top of the workspace keeps that
 * walk working. The judge's packages are linked by linkJudgePackages instead.
 */
export async function linkSharedPackages(nodeModules: string | null, workspaceDir: string): Promise<void> {
  if (!nodeModules || !(await stat(nodeModules).catch(() => null))?.isDirectory()) return;
  await symlink(nodeModules, join(workspaceDir, "node_modules"));
}

async function runStartChecks(run: ResolvedRun, pending: string[]): Promise<StartCheck[]> {
  const checks: StartCheck[] = [];
  if (pending.length === 0) return checks;
  const producers = pending
    .map((producerId) => armFor(run.config, run.assignment.arms[producerId]!))
    .filter((arm) => !arm.reuse)
    .map((arm) => producerFor(run.config.producer, arm).agent);
  checks.push(...await agentChecks(new Set([...producers, ...(run.config.judge ? [run.config.judge.agent] : [])])));
  if (run.config.sandbox) {
    for (const producerId of pending) checks.push(...await runSandboxProbes(run, producerId));
  } else {
    checks.push({ name: "sandbox", passed: true, detail: "disabled by experiment config" });
  }
  return checks;
}

/** Each agent's CLI answers --version and has a credential to run with. */
export async function agentChecks(agents: Iterable<AgentName>): Promise<StartCheck[]> {
  const checks: StartCheck[] = [];
  for (const agent of agents) {
    try {
      const binary = await resolveBinary(binaryNames(agent));
      const { stdout, stderr } = await execFileAsync(binary, ["--version"], { timeout: 10_000 });
      checks.push({ name: `${agent} CLI`, passed: true, detail: `${binary}: ${(stdout || stderr).trim()}` });
    } catch (error) {
      checks.push({ name: `${agent} CLI`, passed: false, detail: errorMessage(error) });
    }
    const problem = await authProblem(agent);
    checks.push({ name: `${agent} auth`, passed: !problem, ...(problem ? { detail: problem } : {}) });
  }
  return checks;
}

/** Runs one producer to completion and returns the failure cause, or null on success. */
async function runProducer(run: ResolvedRun, producerId: string): Promise<string | null> {
  const producerDir = join(run.tempDir, producerId);
  // The producer and its setup commands start in the project, the way a real
  // session does, so relative paths and hooks behave as they would there.
  const sourceDir = join(producerDir, "source");
  const runtimeDir = join(producerDir, ".runtime");
  const logDir = join(run.runDir, "producers", producerId);
  const arm = armFor(run.config, run.assignment.arms[producerId]!);
  if (arm.reuse) {
    await recordBaseline(run, producerId);
    await removeTree(sourceDir);
    await copyTree(join(run.runDir, "frozen", producerId, "output"), sourceDir);
    await mkdir(logDir, { recursive: true });
    const now = new Date().toISOString();
    await updateProducer(run.runDir, producerId, { state: "complete", completedAt: now, lastActivityAt: now });
    await appendRunEvent(run.runDir, { time: now, producer: producerId, kind: "output.reused", summary: `${arm.reuse.run}/${arm.reuse.arm}; no producer launched` });
    return null;
  }
  const config = producerFor(run.config.producer, arm);
  const fail = async (message: string) => {
    const completedAt = new Date().toISOString();
    await updateProducer(run.runDir, producerId, { state: "failed", completedAt, lastActivityAt: completedAt, error: message });
    await appendRunEvent(run.runDir, { time: completedAt, producer: producerId, kind: "agent.failed", summary: message });
    return message;
  };

  // The setup command runs before the producer and outside its clock, so an
  // arm whose tool cannot be built never starts.
  const setupFailure = await runSetup({ run, id: producerId, directory: producerDir, cwd: sourceDir, runtimeDir, logDir, config });
  if (setupFailure) return fail(setupFailure);
  await recordBaseline(run, producerId);

  let result;
  try {
    result = await executeAgent({
      run,
      id: producerId,
      directory: producerDir,
      cwd: sourceDir,
      runtimeDir,
      logDir,
      prompt: await producerPrompt(run, producerId),
      config,
      ...trackAgent(run.runDir, producerId, (patch) => updateProducer(run.runDir, producerId, patch)),
    });
  } catch (error) {
    return fail(errorMessage(error));
  }

  const outcome = completionOutcome(result, result.timedOut && await changedSource(run, producerId));
  await updateProducer(run.runDir, producerId, {
    state: outcome.state,
    completedAt: result.completedAt,
    lastActivityAt: result.completedAt,
    toolCalls: result.toolCalls,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    ...(outcome.timedOut ? { timedOut: true } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  });
  await appendRunEvent(run.runDir, {
    time: result.completedAt,
    producer: producerId,
    kind: outcome.state === "complete" ? "agent.completed" : "agent.failed",
    ...(outcome.timedOut ? { summary: "timeout; output kept as-is" } : outcome.error ? { summary: outcome.error } : {}),
  });
  await writeJson(join(run.runDir, "cost", `${producerId}.json`), {
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    wallTimeMs: Date.parse(result.completedAt) - Date.parse(result.startedAt),
    usage: result.usage,
  });
  return outcome.error ?? null;
}

// A timeout is a safety net, not a verdict: if the producer changed the source,
// the arm counts as complete with that output and the report flags it. A
// producer that timed out without touching the source has nothing to judge,
// so it fails and `crucible start` can relaunch it.
export function completionOutcome(
  result: Pick<AgentExecutionResult, "succeeded" | "timedOut" | "strayProcesses" | "terminalEvent" | "terminalSummary" | "exitCode" | "signal">,
  changedSource: boolean,
): { state: "complete" | "failed"; timedOut?: boolean; error?: string } {
  if (result.succeeded) return { state: "complete" };
  if (result.timedOut && changedSource) return { state: "complete", timedOut: true };
  // The agent's own last words ("Not logged in", an API error) name the cause
  // far better than the exit code alone.
  const lastWords = result.terminalSummary ? `: ${result.terminalSummary}` : "";
  const error = result.timedOut
    ? "Producer timed out without changing the source"
    : result.strayProcesses
      ? "Producer left child processes running"
      : !result.terminalEvent
        ? `Producer exited without a terminal event${lastWords}`
        : `Producer exited with ${result.exitCode ?? result.signal ?? "unknown status"}${lastWords}`;
  return { state: "failed", error };
}

async function changedSource(run: ResolvedRun, producerId: string): Promise<boolean> {
  return (await armChanges(run, producerId)).length > 0;
}

async function producerPrompt(run: ResolvedRun, producerId: string): Promise<string> {
  const producerDir = join(run.tempDir, producerId);
  const catalog = await readJson<SkillCatalogEntry[]>(join(producerDir, ".context", "skill-catalog.json"));
  const subagents = await readJson<SubagentCatalogEntry[]>(join(producerDir, ".context", "subagent-catalog.json")).catch(() => []);
  // Read from the workspace, not the frozen copy, so a setup command that
  // installs a tool's section into CLAUDE.md is honoured the way it would be
  // in a real project.
  const projectInstructions = await collectProjectInstructions(join(producerDir, "source"));
  const sections = [
    run.config.task,
    "",
    `You start in ${join(producerDir, "source")}. Work only inside it; do not modify files outside that directory.`,
    "",
    "Project instructions:",
    projectInstructions || "No project instructions were selected.",
    "",
    skillLoader(catalog, join(producerDir, ".context"), await sharedSnapshots(run, producerDir)),
  ];
  const { agent } = producerFor(run.config.producer, armFor(run.config, run.assignment.arms[producerId]!));
  const subagentSection = subagentLoader(subagents, agent, join(producerDir, ".context"));
  if (subagentSection) sections.push("", subagentSection);
  return sections.join("\n");
}

/**
 * The shared folders this arm holds a copy of, whole or through its own
 * candidate's dependency; a clean arm usually has none.
 */
async function sharedSnapshots(run: ResolvedRun, producerDir: string): Promise<string[]> {
  const held: string[] = [];
  for (const folder of run.config.skills.shared) {
    if ((await stat(join(producerDir, ".context", "shared", basename(folder))).catch(() => null))?.isDirectory()) held.push(folder);
  }
  return held;
}

/**
 * Stop every agent the record says is at work, producers and judge alike.
 * One whose process already died with its runner is marked stopped all the
 * same, so the run can be started, judged, or deleted again.
 */
export async function stopRun(run: ResolvedRun): Promise<void> {
  const view = await readRunState(run.runDir);
  const producers = Object.entries(view.producers).filter(([, producer]) => agentAtWork(producer, view.state));
  for (const [producerId, producer] of producers) await stopAgent(producer, (patch) => updateProducer(run.runDir, producerId, patch));
  const judge = view.judge && agentAtWork(view.judge, view.state) ? view.judge : null;
  if (judge) await stopAgent(judge, (patch) => updateJudge(run.runDir, patch));
  if (producers.length === 0 && !judge && view.state !== "running") throw new UserError("No running producers or judge were found");
  // A run still marked running with no producer at work was left behind by a
  // crash after they finished; marking it stopped lets `crucible start` resume.
  // Stopping only the judge leaves the outputs ready for another `crucible judge`.
  if (producers.length > 0 || view.state === "running") await setRunState(run.runDir, "stopped");
}

async function stopAgent(agent: ProducerStatus, update: (patch: Partial<ProducerStatus>) => Promise<unknown>): Promise<void> {
  if (agent.pid && await processMatches(agent.pid, agent.processStartedAt)) await terminateProcessGroup(agent.pid);
  await update({ state: "stopped", completedAt: new Date().toISOString(), error: "Stopped by user" });
}
