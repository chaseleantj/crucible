import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { rootCertificates } from "node:tls";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { secondsLeft, standInToken, startBroker, tokenClaims } from "./credentials.js";
import { UserError } from "./errors.js";
import { SUBAGENT_PLUGIN, type SubagentCatalogEntry } from "./subagents.js";
import type { AgentName, NormalizedEvent, ProducerConfig, TokenCounts } from "./types.js";

const execFileAsync = promisify(execFile);

export interface AdapterContext {
  producerDir: string;
  /** Where the agent starts: a producer starts in the project, the judge in its package. */
  cwd: string;
  runtimeDir: string;
  prompt: string;
  config: ProducerConfig;
  /** Make a host broker reachable at guest loopback without exposing its secret. */
  forwardPort?: (port: number) => Promise<number>;
  listCursorModels?: (env: NodeJS.ProcessEnv) => Promise<string>;
}

export interface AdapterCommand {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  /** Stops what the command needed while it ran, such as its credential broker. */
  release?: () => Promise<void>;
}

export interface AgentAdapter {
  name: AgentName;
  prepare(context: AdapterContext): Promise<AdapterCommand>;
  parseEvent(line: string, producerId: string): NormalizedEvent[];
  /** The agent's own usage, read from everything it wrote to stdout, or null when it reported none. */
  collectUsage(stdout: string): Usage | null;
  /** The agent's own usage keys read as one set of counts, or null when it reported none. */
  normalizeUsage(usage: Usage | null): TokenCounts | null;
}

export type Usage = Record<string, number | null>;

export const AUTH_ENVIRONMENT: Record<AgentName, Set<string>> = {
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "AWS_PROFILE",
    "AWS_REGION",
  ]),
  codex: new Set(["OPENAI_API_KEY"]),
  cursor: new Set(["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_API_ENDPOINT"]),
};

/** Agent configuration cannot replace the broker's authentication or routing. */
export const BROKER_ENVIRONMENT_VARIABLES = new Set([
  ...Object.values(AUTH_ENVIRONMENT).flatMap((names) => [...names]),
  "OPENAI_BASE_URL", "CODEX_HOME", "CODEX_CA_CERTIFICATE", "CURSOR_DATA_DIR", "CURSOR_CONFIG_DIR",
]);

/**
 * No shell exports a Claude token any more, so fall back to the login keychain
 * when the environment has nothing. Looked up once per process, and the value
 * only ever reaches the environment handed to a producer.
 */
type TokenReader = () => Promise<string | undefined>;

const readClaudeKeychain: TokenReader = () => keychainSecret("CLAUDE_CODE_OAUTH_TOKEN").catch(() => undefined);

let claudeTokenReader: TokenReader = readClaudeKeychain;
let claudeKeychainLookup: Promise<string | undefined> | undefined;

function claudeKeychainToken(): Promise<string | undefined> {
  claudeKeychainLookup ??= claudeTokenReader();
  return claudeKeychainLookup;
}

/** Replaces the keychain lookup so tests never touch the real login keychain. */
export function setClaudeTokenReader(reader: TokenReader = readClaudeKeychain): void {
  claudeTokenReader = reader;
  claudeKeychainLookup = undefined;
}

function claudeEnvironmentCredential(): boolean {
  return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].some((name) => !!process.env[name]);
}

export function adapterFor(name: AgentName): AgentAdapter {
  if (name === "claude") return claudeAdapter;
  if (name === "codex") return codexAdapter;
  return cursorAdapter;
}

/** The scrubbed home's own directories, each named by the variable that points at it. */
const ISOLATION_DIRECTORIES = { HOME: "home", TMPDIR: "tmp", XDG_CACHE_HOME: "cache", XDG_CONFIG_HOME: "config" };

/** The variables the scrubbed home owns, which an arm's own environment may not take over. */
export const ISOLATION_VARIABLES = Object.keys(ISOLATION_DIRECTORIES);

/**
 * A scrubbed home is what keeps a producer from finding the live skills,
 * instructions, and session state of this machine. It carries no credential:
 * each adapter adds a stand-in and the address of its credential broker, so
 * setup commands and anything else an arm runs never see a real one.
 */
export function scrubbedEnvironment(runtimeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(ISOLATION_DIRECTORIES).map(([name, directory]) => [name, join(runtimeDir, directory)])),
    // Browser and Node packages are installed in the pinned Linux image.
    PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright",
    NODE_PATH: "/usr/local/lib/node_modules",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    SHELL: "/bin/bash",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (value && name.startsWith("LC_")) env[name] = value;
  }
  return env;
}

/** Where a broker notes the requests it refused, by method and path only. */
const brokerLog = (runtimeDir: string) => join(runtimeDir, "credential-broker.log");

/**
 * A login token the CLI refreshes itself has to outlast the agent: the broker
 * reads the current one on every request, but only the user's own CLI can
 * renew it.
 */
function requireLasting(token: string, timeoutMs: number, renew: string): void {
  const left = secondsLeft(token);
  if (left !== null && left < timeoutMs / 1000 + 300) {
    throw new UserError(`${renew} Its login token ${left <= 0 ? "has expired" : `expires in ${Math.max(1, Math.round(left / 60))} minutes`}, before this agent's timeout.`);
  }
}

/** Anthropic API paths Claude Code needs; anything else through the broker is refused. */
const CLAUDE_PATHS = ["/v1/messages", "/v1/models", "/api/hello"];

/**
 * Claude's credential stays in this process. The agent gets a stand-in in the
 * variable the real credential would use, and ANTHROPIC_BASE_URL pointing at
 * a broker that swaps it back. Bedrock and Vertex sign each request with the
 * cloud credentials themselves; those modes require a separate broker and are refused.
 */
async function claudeAccess(env: NodeJS.ProcessEnv, runtimeDir: string, context: AdapterContext): Promise<(() => Promise<void>) | undefined> {
  if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) {
    throw new UserError("Harbor runs do not support Bedrock or Vertex credentials. Use an Anthropic API key or Claude login through the credential broker.");
  }
  const variable = process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : process.env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : "CLAUDE_CODE_OAUTH_TOKEN";
  const secret = process.env[variable] ?? await claudeKeychainToken();
  if (!secret) throw new UserError("No Claude credential in the environment or the login keychain. Store CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in the keychain, or export it or an API key.");
  const broker = await guestBroker(context, {
    upstream: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    allow: CLAUDE_PATHS,
    secret: async () => secret,
    logFile: brokerLog(runtimeDir),
  });
  env[variable] = broker.standIn;
  env.ANTHROPIC_BASE_URL = broker.url;
  return broker.close;
}

/**
 * One arm's extra variables on top of the scrubbed environment. A value may
 * name other variables, `$PATH` or `${HOME}` style, which are read from the
 * scrubbed environment so `PATH: /opt/homebrew/bin:$PATH` works; nothing else
 * is interpolated.
 */
export function armEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  if (!extra) return base;
  const expand = (value: string) => value.replaceAll(/\$(?:\{(\w+)\}|(\w+))/g, (_, braced: string | undefined, bare: string | undefined) => base[braced ?? bare!] ?? "");
  return { ...base, ...Object.fromEntries(Object.entries(extra).map(([name, value]) => [name, expand(value)])) };
}

function authFile(agent: "codex" | "cursor"): string {
  return join(homedir(), `.${agent}`, "auth.json");
}

/**
 * Credentials reach an agent through the environment or a copied auth file.
 * When they are missing the CLI exits within a second saying only "not logged
 * in", so check up front and name the missing piece instead.
 */
export async function authProblem(agent: AgentName): Promise<string | null> {
  if (agent === "claude") {
    if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return "Harbor runs require an Anthropic API key or Claude login; Bedrock/Vertex credentials are not brokered.";
    if (claudeEnvironmentCredential() || await claudeKeychainToken()) return null;
    return "No Claude credential in the environment or the login keychain. Store CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in the keychain, or export it or an API key.";
  }
  if (agent === "codex") {
    if (process.env.OPENAI_API_KEY || await readable(authFile("codex"))) return null;
    return "No ~/.codex/auth.json and OPENAI_API_KEY is not set. Run `codex login`.";
  }
  if (await readable(authFile("cursor"))) return null;
  const secrets = await cursorSecrets();
  if (secrets.accessToken) return null;
  return "Harbor Cursor runs require a Cursor login. Run `agent login`; bare CURSOR_API_KEY exchange is not supported by the broker.";
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** The frozen subagent catalog in the producer context; empty when the run froze none. */
async function frozenSubagents(producerDir: string): Promise<SubagentCatalogEntry[]> {
  try {
    return JSON.parse(await readFile(join(producerDir, ".context", "subagent-catalog.json"), "utf8")) as SubagentCatalogEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Claude and Cursor register frozen subagents through a session plugin directory rather
 * than --agents JSON, so definitions remain files inside the guest.
 * The definitions are the frozen files themselves, so a critic reaches the
 * producer word for word. Returns the plugin path, or null with no subagents.
 */
export async function writeSubagentPlugin(producerDir: string, runtimeDir: string, catalog: SubagentCatalogEntry[], agent: "claude" | "cursor"): Promise<string | null> {
  if (catalog.length === 0) return null;
  const plugin = join(runtimeDir, "subagents");
  await mkdir(join(plugin, `.${agent}-plugin`), { recursive: true, mode: 0o700 });
  await mkdir(join(plugin, "agents"), { recursive: true, mode: 0o700 });
  await writeFile(join(plugin, `.${agent}-plugin`, "plugin.json"), `${JSON.stringify({ name: SUBAGENT_PLUGIN })}\n`, { mode: 0o600 });
  for (const entry of catalog) {
    await writeFile(join(plugin, "agents", basename(entry.path)), await readFile(join(producerDir, ".context", entry.path)), { mode: 0o600 });
  }
  return plugin;
}

/** Translate only this capsule's paths. Other macOS paths cannot exist in Linux. */
export function guestConfiguration<T>(value: T, context: Pick<AdapterContext, "producerDir">): T {
  const map = (item: unknown): unknown => {
    if (typeof item === "string") {
      const mapped = item.replaceAll(context.producerDir, "/workspace");
      if (/\/(?:Users|Volumes|Applications)\/|\/opt\/homebrew\//.test(mapped)) {
        throw new UserError(`Host-only path in agent configuration: ${mapped}. Copy this input into the experiment or install the tool with setup inside the Linux guest.`);
      }
      return mapped;
    }
    if (Array.isArray(item)) return item.map(map);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, map(child)]));
    return item;
  };
  return map(value) as T;
}

async function guestBroker(context: AdapterContext, options: Parameters<typeof startBroker>[0]) {
  const broker = await startBroker({ ...options, ...(context.forwardPort ? { bindHost: "0.0.0.0" } : {}) });
  try {
    if (context.forwardPort) {
      const url = new URL(broker.url);
      url.port = String(await context.forwardPort(Number(url.port)));
      broker.url = url.origin;
    }
    return broker;
  } catch (error) {
    await broker.close();
    throw error;
  }
}

const claudeAdapter: AgentAdapter = {
  name: "claude",
  async prepare(context) {
    const binary = "claude";
    const subagents = await frozenSubagents(context.producerDir);
    await prepareRuntimeDirectories(context.runtimeDir);
    // The arm's own settings file replaces the empty default whole: a hook set
    // is a statement about one arm, not something to merge with another's.
    // `--setting-sources ""` still keeps this machine's own settings out.
    // Model and effort ride in the same file: on argv they would name the arm
    // to any sibling that lists processes.
    const settings = context.config.settings ? guestConfiguration(JSON.parse(await readFile(context.config.settings, "utf8")), context) as Record<string, unknown> : {};
    const settingsEnvironment = settings.env;
    if (settingsEnvironment && typeof settingsEnvironment === "object") {
      const reserved = Object.keys(settingsEnvironment).filter((name) => BROKER_ENVIRONMENT_VARIABLES.has(name) || ISOLATION_VARIABLES.includes(name));
      if (reserved.length) throw new UserError(`Claude settings.env may not override runtime-owned variables: ${reserved.join(", ")}. Configure provider authentication on the host.`);
    }
    if (context.config.model) settings.model = context.config.model;
    if (context.config.effort) settings.effortLevel = context.config.effort;
    const settingsPath = join(context.runtimeDir, "claude-settings.json");
    await writeFile(settingsPath, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
    const plugin = await writeSubagentPlugin(context.producerDir, context.runtimeDir, subagents, "claude");
    // Explicit servers only, written to a private file rather than the command
    // line: a server's env may hold a token, and argv is visible to `ps`.
    // `--strict-mcp-config` keeps this machine's own MCP configuration out.
    const mcpConfigPath = join(context.runtimeDir, "claude-mcp.json");
    await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: claudeMcpServers(context.config) })}\n`, { mode: 0o600 });
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      // Unattended runs must deny unresolved prompts, not wait for a human.
      "--permission-prompts",
      "none",
      "--tools",
      subagents.length > 0 ? "Bash,Read,Write,Edit,Glob,Grep,Task" : "Bash,Read,Write,Edit,Glob,Grep",
      "--settings",
      settingsPath,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
      "--disable-slash-commands",
      "--no-session-persistence",
      "--no-chrome",
    ];
    if (plugin) args.push("--plugin-dir", plugin);
    const env = scrubbedEnvironment(context.runtimeDir);
    // Claude Code otherwise keeps its scratch in /tmp/claude-<uid>, which may
    // already exist, another session's, and so be closed to the agent.
    env.CLAUDE_CODE_TMPDIR = env.TMPDIR;
    const release = await claudeAccess(env, context.runtimeDir, context);
    return {
      binary,
      args,
      cwd: context.cwd,
      env,
      stdin: context.prompt,
      ...(release ? { release } : {}),
    };
  },
  parseEvent: parseClaudeEvent,
  collectUsage: sumClaudeUsage,
  normalizeUsage: (usage) => reports(usage, ["input_tokens", "output_tokens"])
    ? {
      input: count(usage, "input_tokens"),
      output: count(usage, "output_tokens"),
      cacheRead: count(usage, "cache_read_input_tokens"),
      cacheWrite: count(usage, "cache_creation_input_tokens"),
    }
    : null,
};

/** The CLI's own `mcpServers` shape: type stdio, with command, args, and env as given. */
export function claudeMcpServers(config: ProducerConfig): Record<string, { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }> {
  return Object.fromEntries(Object.entries(config.mcpServers ?? {}).map(([name, server]) => [name, {
    type: "stdio" as const,
    command: server.command,
    ...(server.args ? { args: server.args } : {}),
    ...(server.env ? { env: server.env } : {}),
  }]));
}

/**
 * The init event lists every configured MCP server with its status. An
 * assigned server that did not connect fails the arm: a producer that quietly
 * ran without its tools would be a different experiment.
 */
function claudeMcpFailures(value: Record<string, unknown>, producerId: string): NormalizedEvent[] {
  if (value.type !== "system" || value.subtype !== "init" || !Array.isArray(value.mcp_servers)) return [];
  return (value.mcp_servers as Record<string, unknown>[])
    .filter((server) => server.status !== "connected")
    .map((server) => ({
      time: new Date().toISOString(),
      producer: producerId,
      kind: "mcp.failed",
      summary: `MCP server ${String(server.name)} did not connect (status: ${String(server.status)})`,
    }));
}

/**
 * Claude's stream-json has no typed tool events: tool calls arrive as
 * tool_use content blocks inside assistant messages (one block per call
 * when they run in parallel), and results as tool_result blocks.
 */
function parseClaudeEvent(line: string, producerId: string): NormalizedEvent[] {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return parseStructuredEvent(line, producerId);
  }
  const mcpFailures = claudeMcpFailures(value, producerId);
  if (mcpFailures.length > 0) return [...mcpFailures, ...parseStructuredEvent(line, producerId)];
  const message = value.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if ((value.type !== "assistant" && value.type !== "user") || !Array.isArray(content)) {
    return parseStructuredEvent(line, producerId);
  }
  const events: NormalizedEvent[] = [];
  for (const block of content as Record<string, unknown>[]) {
    if (block.type !== "tool_use" && block.type !== "tool_result") continue;
    events.push({
      time: new Date().toISOString(),
      producer: producerId,
      kind: block.type === "tool_use" ? "tool.started" : "tool.finished",
      ...(typeof block.name === "string" ? { summary: block.name } : {}),
      ...(typeof block.id === "string" ? { nativeId: block.id }
        : typeof block.tool_use_id === "string" ? { nativeId: block.tool_use_id } : {}),
    });
  }
  return events.length > 0 ? events : parseStructuredEvent(line, producerId);
}

/** CLI overrides are TOML, not JSON objects. Quote inline table keys and strings; CLI dotted path names are literal. */
export function codexMcpArguments(config: ProducerConfig): string[] {
  const inlineTable = (entries: Record<string, string>) => `{ ${Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")} }`;
  return Object.entries(config.mcpServers ?? {}).flatMap(([name, server]) => {
    const fields = [`command = ${JSON.stringify(server.command)}`, "startup_timeout_sec = 60", "required = true"];
    if (server.args) fields.push(`args = ${JSON.stringify(server.args)}`);
    if (server.env) fields.push(`env = ${inlineTable(server.env)}`);
    return ["-c", `mcp_servers.${name}={ ${fields.join(", ")} }`];
  });
}

const codexAdapter: AgentAdapter = {
  name: "codex",
  async prepare(context) {
    const subagents = await frozenSubagents(context.producerDir);
    const binary = "codex";
    await prepareRuntimeDirectories(context.runtimeDir);
    const codexHome = join(context.runtimeDir, "codex-home");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const env = scrubbedEnvironment(context.runtimeDir);
    env.CODEX_HOME = codexHome;
    const access = await codexAccess(env, codexHome, context);
    const args = [
      "exec",
      "-C",
      context.cwd,
      // Linux sandboxing and automatic review run inside Harbor's guest boundary.
      "--approve-for-me",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--strict-config",
      "--json",
    ];
    if (context.config.model) args.push("--model", context.config.model);
    if (context.config.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(context.config.effort)}`);
    if (subagents.length > 0) args.push("--enable", "multi_agent");
    args.push(...codexMcpArguments(context.config));
    args.push(...access.args);
    args.push("-");
    return { binary, args, cwd: context.cwd, env, stdin: context.prompt, release: access.release };
  },
  parseEvent: parseCodexEvent,
  // Codex counts cached tokens inside input_tokens and reasoning tokens inside
  // output_tokens, so both are parts of those totals, not extras to add.
  collectUsage: latestUsage,
  normalizeUsage: (usage) => reports(usage, ["input_tokens", "output_tokens"])
    ? {
      input: Math.max(count(usage, "input_tokens") - count(usage, "cached_input_tokens"), 0),
      output: count(usage, "output_tokens"),
      cacheRead: count(usage, "cached_input_tokens"),
      cacheWrite: count(usage, "cache_write_input_tokens"),
    }
    : null,
};

interface CodexLogin {
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string; access_token?: string; account_id?: string };
}

async function readCodexLogin(): Promise<CodexLogin | null> {
  try {
    return JSON.parse(await readFile(authFile("codex"), "utf8")) as CodexLogin;
  } catch {
    return null;
  }
}

/**
 * Codex's credential stays in this process. An API key is swapped at a broker
 * that OPENAI_BASE_URL points at. A ChatGPT login is swapped at a broker that
 * chatgpt_base_url points at, and the agent's own auth.json holds only
 * unsigned stand-in tokens with the claims Codex reads (plan, account,
 * expiry) and no refresh token, so the real login is never copied and never
 * refreshed from inside a run.
 */
async function codexAccess(env: NodeJS.ProcessEnv, codexHome: string, context: AdapterContext): Promise<{ args: string[]; release: () => Promise<void> }> {
  const login = await readCodexLogin();
  const apiKey = process.env.OPENAI_API_KEY ?? login?.OPENAI_API_KEY ?? undefined;
  // Codex refuses a backend that is not HTTPS, so its broker serves HTTPS
  // under an authority Codex alone is told to trust, next to the public roots
  // its other requests need.
  const trustBroker = async (authority: string | undefined) => {
    const bundle = join(codexHome, "broker-ca.pem");
    await writeFile(bundle, [authority ?? "", ...rootCertificates].join("\n"), { mode: 0o600 });
    env.CODEX_CA_CERTIFICATE = bundle;
  };
  if (apiKey) {
    const broker = await guestBroker(context, { upstream: "https://api.openai.com", allow: ["/v1/responses", "/v1/models"], secret: async () => apiKey, logFile: brokerLog(context.runtimeDir), tls: true });
    await trustBroker(broker.certificateAuthority);
    env.OPENAI_API_KEY = broker.standIn;
    env.OPENAI_BASE_URL = `${broker.url}/v1`;
    return { args: [], release: broker.close };
  }
  const tokens = login?.tokens;
  if (!tokens?.access_token || !tokens.id_token) throw new UserError("No ~/.codex/auth.json and OPENAI_API_KEY is not set. Run `codex login`.");
  requireLasting(tokens.access_token, context.config.timeoutMs, "Run any codex command so it refreshes its login, then start again.");
  const broker = await guestBroker(context, {
    upstream: "https://chatgpt.com",
    // The Responses stream, and the account routing Codex checks before it.
    allow: ["/backend-api/codex/", "/backend-api/wham/"],
    secret: async () => {
      const current = (await readCodexLogin())?.tokens?.access_token;
      if (!current) throw new Error("~/.codex/auth.json no longer holds a login");
      return current;
    },
    logFile: brokerLog(context.runtimeDir),
    tls: true,
  });
  await trustBroker(broker.certificateAuthority);
  // Far enough ahead that Codex never tries to refresh the stand-in.
  const exp = Math.floor(Date.now() / 1000) + 30 * 86_400;
  const claims = (token: string, keep: string[]) => Object.fromEntries(Object.entries(tokenClaims(token) ?? {}).filter(([name]) => keep.includes(name)));
  const identity = ["https://api.openai.com/auth", "https://api.openai.com/profile", "email", "sub", "aud", "iss", "client_id", "scp"];
  await writeFile(join(codexHome, "auth.json"), `${JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: standInToken({ ...claims(tokens.id_token, identity), exp }, "unsigned"),
      access_token: standInToken({ ...claims(tokens.access_token, identity), exp }, broker.standIn),
      refresh_token: "held-by-crucible",
      ...(tokens.account_id ? { account_id: tokens.account_id } : {}),
    },
    last_refresh: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return { args: ["-c", `chatgpt_base_url=${JSON.stringify(`${broker.url}/backend-api/`)}`], release: broker.close };
}

const cursorAdapter: AgentAdapter = {
  name: "cursor",
  async prepare(context) {
    const subagents = await frozenSubagents(context.producerDir);
    const binary = "cursor-agent";
    await prepareRuntimeDirectories(context.runtimeDir);
    const cursorHome = join(context.runtimeDir, "home", ".cursor");
    await mkdir(cursorHome, { recursive: true, mode: 0o700 });
    await writeFile(join(cursorHome, "cli-config.json"), "{}\n", { mode: 0o600 });
    const env = scrubbedEnvironment(context.runtimeDir);
    const access = await cursorAccess(env, cursorHome, context);
    try {
      const args = [
        "-p",
        "--auto-review",
        // Trust the fresh project inside the disposable guest.
        "--trust",
        // Harbor owns isolation.
        "--sandbox",
        "disabled",
        "--workspace",
        context.cwd,
        "--output-format",
        "stream-json",
      ];
      // Cursor plugin agents inherit the parent model and ignore Claude-specific
      // model aliases and tool lists in the frozen frontmatter.
      const plugin = await writeSubagentPlugin(context.producerDir, context.runtimeDir, subagents, "cursor");
      if (plugin) args.push("--plugin-dir", plugin);
      const scratch = join(context.runtimeDir, "cursor");
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      env.CURSOR_DATA_DIR = scratch;
      env.CURSOR_CONFIG_DIR = scratch;
      // Read credentials from $HOME/.cursor/auth.json rather than the login
      // keychain, so the scrubbed home fully owns what the producer can see.
      env.AGENT_CLI_CREDENTIAL_STORE = "file";
      const model = context.config.model;
      if (context.config.effort && !model) throw new UserError("Cursor effort requires an explicit model");
      if (model) args.push("--model", await resolveCursorModel(model, context.config.effort, context, env));
      return { binary, args, cwd: context.cwd, env, stdin: context.prompt, ...(access ? { release: access } : {}) };
    } catch (error) {
      await access?.();
      throw error;
    }
  },
  parseEvent: parseStructuredEvent,
  collectUsage: latestUsage,
  normalizeUsage: (usage) => reports(usage, ["inputTokens", "outputTokens"])
    ? {
      input: count(usage, "inputTokens"),
      output: count(usage, "outputTokens"),
      cacheRead: count(usage, "cacheReadTokens"),
      cacheWrite: count(usage, "cacheWriteTokens"),
    }
    : null,
};

function count(usage: Usage | null, key: string): number {
  const value = usage?.[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Claude's stream-json carries each API call's usage on its assistant
 * messages, repeated on every content block of the same message, and the
 * final result event does not add the calls' input-side counts up. Those are
 * summed once per message id, which is what the API billed and comes out the
 * same whether or not a proxy sits in between. Output tokens are the one
 * count a message reports before it has finished streaming, so they come
 * from the result events, added up: a headless run can print more than one.
 */
function sumClaudeUsage(stdout: string): Usage | null {
  const perMessage = new Map<string, Usage>();
  let result: Usage | null = null;
  let output: number | null = null;
  for (const line of stdout.split("\n")) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (value.type === "result") {
      const usage = numericUsage(value.usage);
      if (usage) result = usage;
      if (typeof usage?.output_tokens === "number") output = (output ?? 0) + usage.output_tokens;
    }
    if (value.type !== "assistant") continue;
    const message = value.message as Record<string, unknown> | undefined;
    if (typeof message?.id !== "string") continue;
    const usage = numericUsage(message.usage);
    if (usage) perMessage.set(message.id, usage);
  }
  if (perMessage.size === 0) return result && output !== null ? { ...result, output_tokens: output } : result;
  const total: Usage = {};
  for (const usage of perMessage.values()) {
    for (const [key, count] of Object.entries(usage)) total[key] = (total[key] ?? 0) + (count ?? 0);
  }
  if (output !== null) total.output_tokens = output;
  return total;
}

/** The last usage object an agent printed: Codex and Cursor report running totals, so the last one is the whole run. */
function latestUsage(stdout: string): Usage | null {
  let latest: Usage | null = null;
  for (const line of stdout.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const usage = numericUsage(value.usage);
      if (usage) latest = usage;
    } catch {
      // Non-JSON text is valid for adapters that emit progress lines.
    }
  }
  return latest;
}

function numericUsage(value: unknown): Usage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => typeof item === "number" || item === null)) as Usage;
}

function reports(usage: Usage | null, keys: string[]): boolean {
  return keys.some((key) => typeof usage?.[key] === "number");
}

export async function prepareRuntimeDirectories(runtimeDir: string): Promise<void> {
  for (const directory of Object.values(ISOLATION_DIRECTORIES)) {
    await mkdir(join(runtimeDir, directory), { recursive: true, mode: 0o700 });
  }
}

async function resolveCursorModel(model: string, effort: string | undefined, context: AdapterContext, env: NodeJS.ProcessEnv): Promise<string> {
  if (!effort) return model;
  if (model.includes("[")) throw new UserError("Set Cursor effort either in producer.effort or in the model override, not both");
  if (!context.listCursorModels) throw new UserError("Cursor effort requires model discovery inside the Harbor guest");
  const stdout = await context.listCursorModels(env);
  const listed = new Set(stdout.split(/\r?\n/).flatMap((line) => /^([a-z0-9][a-z0-9.+\-_]*)\s+-/i.exec(line)?.[1] ?? []));
  const requested = model.endsWith(`-${effort}`) ? model : `${model}-${effort}`;
  if (listed.has(requested)) return requested;
  throw new UserError(`Cannot use Cursor model ${requested}. Guest discovery returned ${listed.size} model identifiers; the requested model and effort must appear together. Inspect model-discovery.json in the agent logs and set producer.model to an id reported by the guest's agent --list-models.`);
}

/** The access token of this machine's Cursor login: its auth.json, else the login keychain. */
async function cursorAccessToken(): Promise<string | undefined> {
  try {
    const login = JSON.parse(await readFile(authFile("cursor"), "utf8")) as { accessToken?: string };
    if (login.accessToken) return login.accessToken;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return (await cursorSecrets()).accessToken;
}

/** Cursor's API services, which carry the login; anything else through the broker is refused. */
const CURSOR_PATHS = ["/aiserver.v1.", "/agent.v1."];

/**
 * Where Cursor's agent service lives. The server names it in its config, and
 * the CLI dials it directly unless its endpoint is a localhost address, which
 * is why the broker is given to Cursor as localhost.
 */
const CURSOR_AGENT_HOST = "https://agentn.global.api5.cursor.sh";

/**
 * A Cursor login stays in this process: the agent's auth.json holds an
 * unsigned stand-in token and no refresh token, and CURSOR_API_ENDPOINT points
 * at a broker that swaps it for the current real one. A bare CURSOR_API_KEY,
 * with no login is refused: its exchange is not implemented by the broker.
 */
async function cursorAccess(env: NodeJS.ProcessEnv, cursorHome: string, context: AdapterContext): Promise<(() => Promise<void>) | undefined> {
  const token = await cursorAccessToken();
  if (!token) {
    throw new UserError("Harbor Cursor runs require a Cursor login (run `agent login`). Bare CURSOR_API_KEY exchange is not supported by the credential broker.");
  }
  requireLasting(token, context.config.timeoutMs, "Run any cursor-agent command so it refreshes its login, then start again.");
  const broker = await guestBroker(context, {
    upstream: process.env.CURSOR_API_ENDPOINT ?? "https://api2.cursor.sh",
    routes: [{ prefix: "/agent.v1.", upstream: CURSOR_AGENT_HOST }],
    allow: CURSOR_PATHS,
    secret: async () => {
      const current = await cursorAccessToken();
      if (!current) throw new Error("the Cursor login is gone");
      return current;
    },
    logFile: brokerLog(context.runtimeDir),
  });
  const exp = Math.floor(Date.now() / 1000) + 30 * 86_400;
  const claims = Object.fromEntries(Object.entries(tokenClaims(token) ?? {}).filter(([name]) => ["sub", "aud", "iss", "scope", "type"].includes(name)));
  const standIn = standInToken({ ...claims, exp }, broker.standIn);
  await writeFile(join(cursorHome, "auth.json"), `${JSON.stringify({ accessToken: standIn, refreshToken: "held-by-crucible" })}\n`, { mode: 0o600 });
  // Linux CLI builds can use a different file credential location. The native
  // token variable carries only the same broker capability, never the login.
  env.CURSOR_AUTH_TOKEN = standIn;
  env.CURSOR_API_ENDPOINT = broker.url.replace("127.0.0.1", "localhost");
  return broker.close;
}

async function cursorSecrets(): Promise<{ accessToken: string | undefined; refreshToken: string | undefined; apiKey: string | undefined }> {
  return {
    accessToken: await keychainSecret("cursor-access-token", "cursor-user"),
    refreshToken: await keychainSecret("cursor-refresh-token", "cursor-user"),
    apiKey: await keychainSecret("cursor-api-key", "cursor-user") ?? process.env.CURSOR_API_KEY,
  };
}

async function keychainSecret(service: string, account?: string): Promise<string | undefined> {
  const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  try {
    const { stdout } = await execFileAsync("/usr/bin/security", args, { timeout: 5_000 });
    const value = stdout.trim();
    return value || undefined;
  } catch (error) {
    const failure = error as { status?: number; code?: string | number };
    if (failure.status === 44 || failure.code === 44) return undefined;
    throw error;
  }
}



function parseCodexEvent(line: string, producerId: string): NormalizedEvent[] {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return parseStructuredEvent(line, producerId);
  }
  const item = value.item as Record<string, unknown> | undefined;
  if (!item || !String(value.type).startsWith("item.")) return parseStructuredEvent(line, producerId);
  const tool = ["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"].includes(String(item.type));
  const kind = tool && value.type === "item.started" ? "tool.started"
    : tool && value.type === "item.completed" ? "tool.finished"
    : item.type === "agent_message" || item.type === "reasoning" ? "message.delta"
    : "native.event";
  const nativeId = stringValue(item.id);
  const summary = item.type === "collab_tool_call" ? collabSummary(item)
    : stringValue(item.command) ?? stringValue(item.tool) ?? stringValue(item.text) ?? stringValue(item.type);
  return [{
    time: new Date().toISOString(),
    producer: producerId,
    kind,
    ...(nativeId ? { nativeId } : {}),
    ...(summary ? { summary: summary.slice(0, 300) } : {}),
  }];
}

/**
 * Codex multi-agent tool calls (spawn_agent, wait, send_input, close_agent)
 * are the transcript's only sign that a producer delegated a review. The event
 * keeps who was addressed and what state they reported; when Codex emits a
 * wait without any receiver, the record says so plainly instead of a bare
 * "wait" that reads like evidence of a child. Codex 0.153.4 exec --json emits
 * no item at all for the spawn itself, and an ephemeral home persists no
 * thread or spawn-edge rows, so the runner has nothing further to draw on.
 */
function collabSummary(item: Record<string, unknown>): string {
  const tool = stringValue(item.tool) ?? "collab";
  const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter((id): id is string => typeof id === "string") : [];
  const states = item.agents_states && typeof item.agents_states === "object" && !Array.isArray(item.agents_states)
    ? Object.entries(item.agents_states as Record<string, unknown>).map(([id, state]) => `${id}=${typeof state === "string" ? state : JSON.stringify(state)}`)
    : [];
  const parts = [`collab ${tool}`];
  parts.push(receivers.length > 0 ? `receivers ${receivers.join(", ")}` : "no receivers");
  if (states.length > 0) parts.push(`states ${states.join(", ")}`);
  const prompt = stringValue(item.prompt);
  if (prompt) parts.push(`prompt ${prompt.replace(/\s+/g, " ").trim()}`);
  return parts.join("; ");
}

function parseStructuredEvent(line: string, producerId: string): NormalizedEvent[] {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ time: new Date().toISOString(), producer: producerId, kind: "message.delta", summary: line.slice(0, 200) }];
  }
  const type = stringValue(value.type) ?? stringValue(value.kind) ?? "native.event";
  const subtype = stringValue(value.subtype);
  const kind = normalizeKind(type, subtype);
  const nativeId = stringValue(value.call_id);
  const summary = eventSummary(value);
  const usage = usageFrom(value);
  return [{
    time: new Date().toISOString(),
    producer: producerId,
    kind,
    ...(nativeId ? { nativeId } : {}),
    ...(summary ? { summary } : {}),
    ...(usage ? { usage } : {}),
  }];
}

function normalizeKind(type: string, subtype: string | undefined): string {
  const joined = `${type}.${subtype ?? ""}`.toLocaleLowerCase();
  if (joined.includes("tool") && joined.includes("start")) return "tool.started";
  if (joined.includes("tool") && (joined.includes("complete") || joined.includes("finish"))) return "tool.finished";
  if (joined.includes("result") && joined.includes("success")) return "agent.completed";
  if (joined.includes("turn") && (joined.includes("complete") || joined.includes("finish"))) return "agent.completed";
  if (type.toLocaleLowerCase() === "result" && !joined.includes("error")) return "agent.completed";
  if (joined.includes("error") || joined.includes("failed")) return "agent.failed";
  if (joined.includes("init") || joined.includes("started")) return "agent.started";
  if (joined.includes("assistant") || joined.includes("message")) return "message.delta";
  return "native.event";
}

function eventSummary(value: Record<string, unknown>): string | undefined {
  for (const key of ["summary", "result", "message", "text"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate.slice(0, 300);
  }
  return undefined;
}

function usageFrom(value: Record<string, unknown>): Record<string, number | null> | undefined {
  const usage = value.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  return Object.fromEntries(Object.entries(usage as Record<string, unknown>).filter(([, item]) => typeof item === "number" || item === null)) as Record<string, number | null>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
