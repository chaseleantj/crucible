import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { adapterFor, armEnvironment, prepareRuntimeDirectories, scrubbedEnvironment } from "./adapters.js";
import { UserError } from "./errors.js";
import { writeJson } from "./json.js";
import { sandboxWrap } from "./sandbox.js";
import type { NormalizedEvent, ProducerConfig, ResolvedRun } from "./types.js";

const execFileAsync = promisify(execFile);
/** A build in a setup command can be talkative; its log should not fail the arm. */
const SETUP_OUTPUT_LIMIT = 8 * 1024 * 1024;

export interface AgentExecutionOptions {
  run: ResolvedRun;
  id: string;
  directory: string;
  /** Where the agent starts, inside the workspace. */
  cwd: string;
  runtimeDir: string;
  logDir: string;
  prompt: string;
  config: ProducerConfig;
  frozenDirs?: string[];
  onStarted?: (details: { pid: number; processStartedAt?: string; startedAt: string }) => Promise<void>;
  onEvent?: (event: NormalizedEvent) => Promise<void>;
}

export interface AgentExecutionResult {
  succeeded: boolean;
  pid: number;
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  terminalEvent: boolean;
  terminalSummary?: string;
  strayProcesses: boolean;
  toolCalls: number;
  usage: Record<string, number | null> | null;
}

export interface SetupOptions {
  run: ResolvedRun;
  id: string;
  directory: string;
  /** Where the commands run, inside the workspace. */
  cwd: string;
  runtimeDir: string;
  logDir: string;
  config: ProducerConfig;
}

/**
 * The arm's setup commands, run in the project before the producer starts,
 * so a tool can install whatever it needs there: the shared one first, then
 * the arm's own. Each gets the arm's environment and the same sandbox profile as
 * the producer, and they share one setup.log, each under the command that
 * wrote it. Returns the failure cause, or null when there is nothing to run or
 * they all succeeded; the first failure stops the rest. The producer's clock
 * starts afterwards.
 */
export async function runSetup(options: SetupOptions): Promise<string | null> {
  const commands = options.config.setup ?? [];
  if (commands.length === 0) return null;
  await prepareRuntimeDirectories(options.runtimeDir);
  await mkdir(options.logDir, { recursive: true, mode: 0o700 });
  const sections: string[] = [];
  let failure: string | null = null;
  for (const setup of commands) {
    const launch = options.run.config.sandbox
      ? await sandboxWrap(options.run, options.id, "/bin/sh", ["-c", setup], [join(options.directory, ".context")], [])
      : { command: "/bin/sh", args: ["-c", setup] };
    let output: string;
    try {
      const { stdout, stderr } = await execFileAsync(launch.command, launch.args, {
        cwd: options.cwd,
        env: armEnvironment(scrubbedEnvironment(options.runtimeDir, options.config.agent), options.config.env),
        maxBuffer: SETUP_OUTPUT_LIMIT,
        timeout: options.config.timeoutMs,
      });
      output = stdout + stderr;
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number | string };
      output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
      failure = `Setup command failed with ${failed.code ?? "no exit code"}: ${setup}`;
    }
    sections.push(`$ ${setup}\n${output}`);
    if (failure) break;
  }
  await writeFile(join(options.logDir, "setup.log"), sections.join("\n"), { mode: 0o600 });
  return failure;
}

export async function executeAgent(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const adapter = adapterFor(options.config.agent);
  const command = await adapter.prepare({
    producerDir: options.directory,
    cwd: options.cwd,
    runtimeDir: options.runtimeDir,
    prompt: options.prompt,
    config: options.config,
  });
  const frozenDirs = options.frozenDirs ?? [join(options.directory, ".context")];
  const launch = options.run.config.sandbox
    ? await sandboxWrap(options.run, options.id, command.binary, command.args, frozenDirs, command.extraWriteRoots ?? [])
    : { command: command.binary, args: command.args, profilePath: undefined };

  await mkdir(options.logDir, { recursive: true, mode: 0o700 });
  await writeFile(join(options.logDir, "prompt.txt"), options.prompt, { mode: 0o600 });
  await writeJson(join(options.logDir, "launch.json"), {
    adapter: adapter.name,
    binary: command.binary,
    cwd: command.cwd,
    args: command.args.map((argument) => argument.startsWith("mcp_servers.") ? `${argument.split("=")[0]}=<private MCP configuration>` : argument.length > 500 ? `<prompt:${argument.length} chars>` : argument),
    sandboxProfile: launch.profilePath ?? "off",
    // Names only: one of these values could be a token.
    ...(options.config.env ? { environment: Object.keys(options.config.env) } : {}),
  });

  const startedAt = new Date().toISOString();
  const child = spawn(launch.command, launch.args, {
    cwd: command.cwd,
    env: armEnvironment(command.env, options.config.env),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.pid || !child.stdin || !child.stdout || !child.stderr) throw new UserError(`Could not start agent ${options.id}`);
  try {
    // caffeinate waits on the agent's pid, so the assertion lasts exactly as
    // long as the run, however long that turns out to be.
    await holdSystemAwake(child.pid);
  } catch (error) {
    await terminateProcessGroup(child.pid);
    throw new UserError(`Could not keep the system awake for agent ${options.id}: ${error instanceof Error ? error.message : error}`);
  }
  // An agent that exits before it reads the whole prompt closes this pipe.
  // The exit code already tells us that; a write error adds nothing.
  child.stdin.on("error", () => {});
  child.stdin.end(command.stdin);
  const processStartedAt = await processStartTime(child.pid);
  await options.onStarted?.({ pid: child.pid, ...(processStartedAt ? { processStartedAt } : {}), startedAt });

  let terminationTask: Promise<void> | undefined;
  let toolCalls = 0;
  let terminalEvent = false;
  let terminalSummary: string | undefined;
  let mcpFailed = false;
  const stdoutPath = join(options.logDir, "stdout.jsonl");
  const outputTask = (async () => {
    let pending = "";
    for await (const chunk of child.stdout!) {
      pending += chunk.toString();
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) await recordLine(line);
    }
    if (pending) await recordLine(pending);

    async function recordLine(line: string): Promise<void> {
      await appendFile(stdoutPath, `${line}\n`, { mode: 0o600 });
      for (const event of adapter.parseEvent(line, options.id)) {
        if (event.kind === "tool.started") toolCalls += 1;
        if (event.kind === "agent.completed") terminalEvent = true;
        if (event.kind.startsWith("agent.") && event.summary) terminalSummary = event.summary;
        if (event.kind === "mcp.failed" && !mcpFailed) {
          // Stop now rather than let the arm work without its assigned tools.
          mcpFailed = true;
          terminalSummary = event.summary;
          terminationTask = terminateProcessGroup(child.pid!);
        }
        await options.onEvent?.(event);
      }
    }
  })();
  const stderrStream = createWriteStream(join(options.logDir, "stderr.log"), { mode: 0o600 });
  child.stderr.pipe(stderrStream);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminationTask = terminateProcessGroup(child.pid!);
  }, options.config.timeoutMs);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
  clearTimeout(timeout);
  if (terminationTask) await terminationTask;
  let strayProcesses = false;
  if (!timedOut && !await waitForProcessGroupExit(child.pid, 1_000)) {
    strayProcesses = true;
    await terminateProcessGroup(child.pid);
  }
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([
    outputTask.finally(() => { if (drainTimer) clearTimeout(drainTimer); }),
    new Promise<void>((resolve) => {
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        resolve();
      }, 2_000);
    }),
  ]);
  await finished(stderrStream);
  const completedAt = new Date().toISOString();
  const usage = adapter.collectUsage(await readFile(stdoutPath, "utf8").catch(() => ""));
  return {
    succeeded: exit.code === 0 && !timedOut && terminalEvent && !strayProcesses && !mcpFailed,
    pid: child.pid,
    startedAt,
    completedAt,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    terminalEvent,
    ...(terminalSummary ? { terminalSummary } : {}),
    strayProcesses,
    toolCalls,
    usage,
  };
}

export async function holdSystemAwake(pid: number, platform = process.platform): Promise<void> {
  if (platform !== "darwin") return;
  const assertion = spawn("/usr/bin/caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    assertion.once("spawn", resolve);
    assertion.once("error", reject);
  });
  assertion.unref();
}

export type SignalProbe = (target: number, signal: NodeJS.Signals | 0) => void;

const sendSignal: SignalProbe = (target, signal) => { process.kill(target, signal); };

export async function terminateProcessGroup(
  processGroupId: number,
  graceMs = 5_000,
  signal: SignalProbe = sendSignal,
): Promise<void> {
  killProcessGroup(processGroupId, "SIGTERM", signal);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId, signal)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  killProcessGroup(processGroupId, "SIGKILL", signal);
}

export async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function processMatches(pid: number, startedAt: string | undefined): Promise<boolean> {
  if (!startedAt) return false;
  return (await processStartTime(pid)) === startedAt;
}

export function processExists(pid: number, probe = (target: number) => process.kill(target, 0)): boolean {
  try {
    probe(pid);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

function killProcessGroup(processGroupId: number, signal: NodeJS.Signals, send: SignalProbe = sendSignal): void {
  try {
    send(-processGroupId, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: already gone. EPERM: alive but not ours to signal - leave it to the
    // stray-process report rather than taking the run down over cleanup.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processGroupExists(processGroupId);
}

function processGroupExists(processGroupId: number, send: SignalProbe = sendSignal): boolean {
  try {
    send(-processGroupId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}
