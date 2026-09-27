import { spawn, execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { adapterFor, armEnvironment, guestConfiguration, prepareRuntimeDirectories, scrubbedEnvironment } from "./adapters.js";
import { UserError } from "./errors.js";
import { writeJson } from "./json.js";
import type { HarborSession } from "./harbor.js";
import type { NormalizedEvent, ProducerConfig, ResolvedRun } from "./types.js";

const execFileAsync = promisify(execFile);

export interface AgentExecutionOptions {
  run: ResolvedRun;
  id: string;
  directory: string;
  cwd: string;
  runtimeDir: string;
  logDir: string;
  prompt: string;
  config: ProducerConfig;
  session: HarborSession;
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

export type SetupOptions = Omit<AgentExecutionOptions, "prompt" | "onEvent" | "onStarted">;

/** Setup and the agent share one guest. Setup time is excluded from agent cost. */
export async function runSetup(options: SetupOptions): Promise<string | null> {
  const commands = options.config.setup ?? [];
  if (commands.length === 0) return null;
  await mkdir(options.logDir, { recursive: true, mode: 0o700 });
  const sections: string[] = [];
  let failure: string | null = null;
  for (const setup of commands) {
    try {
      const result = await options.session.execute({
        command: "/bin/sh", args: ["-c", setup],
        cwd: guestPath(options.directory, options.cwd),
        env: guestEnvironment(armEnvironment(scrubbedEnvironment("/workspace/.runtime"), options.config.env), options.directory),
        timeoutMs: options.config.timeoutMs,
      });
      sections.push(`$ ${setup}\n${result.stdout}${result.stderr}`);
      if (result.code !== 0 || result.timedOut) failure = `Setup command ${result.timedOut ? "timed out" : `failed with ${result.code}`}: ${setup}`;
    } catch (error) {
      failure = `Setup command failed: ${setup}: ${error instanceof Error ? error.message : error}`;
      sections.push(`$ ${setup}\n${failure}`);
    }
    if (failure) break;
  }
  await writeFile(join(options.logDir, "setup.log"), sections.join("\n"), { mode: 0o600 });
  return failure;
}

export function guestPath(directory: string, path: string): string {
  const local = relative(directory, path);
  if (local === ".." || local.startsWith("../") || local.startsWith("/")) throw new UserError(`Path is outside the guest workspace: ${path}`);
  return join("/workspace", local);
}

function guestEnvironment(environment: NodeJS.ProcessEnv, directory: string): Record<string, string> {
  return guestConfiguration(Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)), { producerDir: directory });
}

/** Keep native CLI events and usage; Harbor owns command execution and process cleanup. */
export async function executeAgent(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const adapter = adapterFor(options.config.agent);
  const context = { producerDir: options.directory };
  await prepareRuntimeDirectories(options.runtimeDir);
  await mkdir(options.logDir, { recursive: true, mode: 0o700 });
  const config = { ...options.config, ...(options.config.mcpServers ? { mcpServers: guestConfiguration(options.config.mcpServers, context) } : {}) };
  const command = await adapter.prepare({
    ...context, cwd: options.cwd, runtimeDir: options.runtimeDir, prompt: options.prompt, config,
    forwardPort: (port) => options.session.forwardPort(port),
    listCursorModels: async (env) => {
      await options.session.upload(options.runtimeDir, "/workspace/.runtime");
      const result = await options.session.execute({ command: "cursor-agent", args: ["--list-models"], cwd: "/workspace", env: guestEnvironment(env, options.directory), timeoutMs: 30_000 });
      await writeJson(join(options.logDir, "model-discovery.json"), result);
      if (result.code !== 0 || result.timedOut) throw new UserError(`Could not list Cursor models in guest${result.timedOut ? " (timed out)" : ""}: ${result.stderr}. See model-discovery.json in the agent logs.`);
      return result.stdout;
    },
  });
  try {
    await options.session.upload(options.runtimeDir, "/workspace/.runtime");
    await writeFile(join(options.logDir, "prompt.txt"), options.prompt, { mode: 0o600 });
    const args = guestConfiguration(command.args, context);
    const cwd = guestPath(options.directory, command.cwd);
    await writeJson(join(options.logDir, "launch.json"), {
      adapter: adapter.name, binary: command.binary, cwd,
      args: args.map((argument) => argument.startsWith("mcp_servers.") ? `${argument.split("=")[0]}=<private MCP configuration>` : argument.length > 500 ? `<prompt:${argument.length} chars>` : argument),
      runtime: "harbor", ...(config.env ? { environment: Object.keys(config.env) } : {}),
    });
    const startedAt = new Date().toISOString();
    const pid = options.session.pid;
    const processStartedAt = await processStartTime(pid);
    await options.onStarted?.({ pid, ...(processStartedAt ? { processStartedAt } : {}), startedAt });
    let toolCalls = 0;
    let terminalEvent = false;
    let terminalSummary: string | undefined;
    let mcpFailed = false;
    let pending = "";
    const stdoutPath = join(options.logDir, "stdout.jsonl");
    const recordLine = async (line: string) => {
      await appendFile(stdoutPath, `${line}\n`, { mode: 0o600 });
      for (const event of adapter.parseEvent(line, options.id)) {
        if (event.kind === "tool.started") toolCalls++;
        if (event.kind === "agent.completed") terminalEvent = true;
        if (event.kind.startsWith("agent.") && event.summary) terminalSummary = event.summary;
        if (event.kind === "mcp.failed" && !mcpFailed) {
          mcpFailed = true;
          terminalSummary = event.summary;
          // The worker handles cancellation and tears down this guest.
          try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        await options.onEvent?.(event);
      }
    };
    const exit = await options.session.execute({
      command: command.binary, args, cwd,
      env: guestEnvironment(armEnvironment(command.env, config.env), options.directory),
      stdin: command.stdin, timeoutMs: config.timeoutMs,
      onStdout: async (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) await recordLine(line);
      },
      onStderr: async (chunk) => { await appendFile(join(options.logDir, "stderr.log"), chunk, { mode: 0o600 }); },
    }).catch((error: unknown) => {
      if (mcpFailed) throw new UserError(terminalSummary ?? "An assigned MCP server did not connect");
      throw error;
    });
    if (pending) await recordLine(pending);
    const completedAt = new Date().toISOString();
    return {
      succeeded: exit.code === 0 && !exit.timedOut && terminalEvent && !mcpFailed,
      pid, startedAt, completedAt, exitCode: exit.code, signal: null,
      timedOut: exit.timedOut, terminalEvent, ...(terminalSummary ? { terminalSummary } : {}),
      strayProcesses: false, toolCalls,
      usage: adapter.collectUsage(await readFile(stdoutPath, "utf8").catch(() => "")),
    };
  } finally {
    await command.release?.();
  }
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
