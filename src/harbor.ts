import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { RUNNER_ROOT } from "./paths.js";
import type { StartCheck } from "./types.js";

const RUNTIME = join(RUNNER_ROOT, "runtime");
const PYTHON = join(homedir(), ".local", "share", "crucible", "harbor", "venv", "bin", "python");
const CLOSE_TIMEOUT_MS = 60_000;

export interface HarborOptions {
  workspace: string;
  cpus: number;
  memoryMb: number;
  maxConcurrent: number;
  signal?: AbortSignal;
  onStarted?: (process: { pid: number }) => void | Promise<void>;
}

export interface HarborCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
}

export interface HarborResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  onStdout?: HarborCommand["onStdout"];
  onStderr?: HarborCommand["onStderr"];
  callbacks: Promise<void>;
  callbackError?: Error;
}

export class HarborSession {
  readonly pid: number;
  readonly workspace = "/workspace";
  hostAddress = "";
  name = "";
  metadata: Record<string, unknown> = {};
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private diagnostic = "";
  private exitFailure?: Error;

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    if (!process.pid) {
      process.once("error", () => {});
      throw new Error("Could not start Harbor runtime worker");
    }
    this.pid = process.pid;
    createInterface({ input: process.stdout }).on("line", (line) => this.receive(line));
    process.stderr.on("data", (chunk: Buffer) => {
      this.diagnostic = (this.diagnostic + chunk.toString()).slice(-4000);
    });
    process.stdin.on("error", (error: Error) => this.fail(error));
    this.exited = new Promise((resolve) => {
      process.once("error", (error) => { this.fail(error); resolve(); });
      process.once("close", (code) => {
        this.closed = true;
        const error = new Error(`Harbor worker exited (${code ?? "signal"})${this.diagnostic ? `: ${this.diagnostic}` : ""}`);
        if (code !== 0) this.exitFailure = error;
        this.fail(error);
        resolve();
      });
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private receive(line: string): void {
    let message: { id: number; result?: unknown; error?: string; event?: string; data?: string };
    try { message = JSON.parse(line) as typeof message; }
    catch { this.fail(new Error("Harbor worker returned an invalid protocol message")); this.process.kill("SIGTERM"); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.event) {
      const callback = message.event === "stdout" ? pending.onStdout : pending.onStderr;
      if (callback && message.data) pending.callbacks = pending.callbacks.then(() => callback(message.data!)).catch((error: unknown) => {
        pending.callbackError = error instanceof Error ? error : new Error(String(error));
      });
      return;
    }
    this.pending.delete(message.id);
    void pending.callbacks.then(() => {
      if (pending.callbackError) pending.reject(pending.callbackError);
      else if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }, (error: unknown) => pending.reject(error instanceof Error ? error : new Error(String(error))));
  }

  async request<T>(op: string, values: Record<string, unknown>, callbacks: Pick<HarborCommand, "onStdout" | "onStderr"> = {}): Promise<T> {
    if (this.closed || this.closing) throw new Error("Harbor session is closed");
    const id = ++this.sequence;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, callbacks: Promise.resolve(), ...callbacks });
    });
    this.process.stdin.write(JSON.stringify({ id, op, ...values }) + "\n", (error) => {
      if (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
    });
    return await result as T;
  }

  async execute(options: HarborCommand): Promise<HarborResult> {
    const { onStdout, onStderr, signal, ...command } = options;
    const cancel = () => { this.process.kill("SIGTERM"); };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await this.request<HarborResult>("execute", command, {
        ...(onStdout ? { onStdout } : {}), ...(onStderr ? { onStderr } : {}),
      });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async upload(localPath: string, guestPath: string): Promise<void> {
    await this.request("upload", { source: localPath, destination: guestPath });
  }

  async forwardPort(hostPort: number): Promise<number> {
    return (await this.request<{ port: number }>("forward", { port: hostPort })).port;
  }

  async collect(relativePath = "."): Promise<void> {
    await this.request("collect", { relative: relativePath });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.closed) this.process.stdin.end();
      const timeout = setTimeout(() => this.process.kill("SIGKILL"), CLOSE_TIMEOUT_MS);
      try {
        await this.exited;
        if (this.exitFailure) throw this.exitFailure;
      }
      finally { clearTimeout(timeout); }
    })();
    return this.closing;
  }
}

export async function harborChecks(): Promise<StartCheck[]> {
  const checks: StartCheck[] = [];
  const check = async (name: string, command: string, args: string[]) => {
    try {
      await promisify(execFile)(command, args, { timeout: 15_000 });
      checks.push({ name, passed: true });
    } catch {
      checks.push({ name, passed: false, detail: "Run npm run setup:runtime after installing Apple container and starting its service." });
    }
  };
  const commit = readFileSync(join(RUNTIME, "requirements.txt"), "utf8").match(/@([a-f0-9]{40})$/m)?.[1];
  if (!commit) throw new Error("Harbor dependency pin is missing");
  await check("Harbor Python runtime", PYTHON, ["-c", "import importlib.metadata,json,sys; from harbor.environments.apple_container import AppleContainerEnvironment; assert json.loads(importlib.metadata.distribution('harbor').read_text('direct_url.json'))['vcs_info']['commit_id'] == sys.argv[1]", commit]);
  await check("Apple container service", "container", ["list", "--format", "json"]);
  const image = JSON.parse(readFileSync(join(RUNTIME, "image.json"), "utf8")) as { name: string };
  await check("Crucible guest image", "container", ["image", "inspect", image.name]);
  return checks;
}

export async function openHarbor(options: HarborOptions): Promise<HarborSession> {
  if (!existsSync(PYTHON)) throw new Error("Harbor runtime is not installed. Run bash runtime/setup.sh first.");
  options.signal?.throwIfAborted();
  // Provider credentials never enter this host worker's environment or the guest image.
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), PYTHONUNBUFFERED: "1" };
  const processHandle = spawn(PYTHON, ["-B", join(RUNTIME, "worker.py")], { env: environment, stdio: "pipe", detached: true });
  const session = new HarborSession(processHandle);
  const cancel = () => { processHandle.kill("SIGTERM"); };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    await options.onStarted?.({ pid: session.pid });
    options.signal?.throwIfAborted();
    const { signal: _signal, onStarted: _onStarted, ...request } = options;
    const ready = await session.request<{ workspace: string; hostAddress: string; name: string; metadata?: Record<string, unknown> }>("start", request);
    session.hostAddress = ready.hostAddress;
    session.name = ready.name;
    session.metadata = ready.metadata ?? {};
    return session;
  } catch (error) {
    await session.close();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}
