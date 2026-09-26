import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { UserError } from "./errors.js";
import { playwrightBrowsersPath } from "./paths.js";
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
}

export interface AdapterCommand {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  extraWriteRoots?: string[];
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
  cursor: new Set(["CURSOR_API_KEY", "CURSOR_API_ENDPOINT"]),
};

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

/** Variables the CLI needs forwarded but that do not log anyone in on their own. */
const CLAUDE_ROUTING_VARIABLES = new Set(["ANTHROPIC_BASE_URL"]);

function claudeEnvironmentCredential(): boolean {
  return [...AUTH_ENVIRONMENT.claude].some((name) => !CLAUDE_ROUTING_VARIABLES.has(name) && process.env[name]);
}

export function adapterFor(name: AgentName): AgentAdapter {
  if (name === "claude") return claudeAdapter;
  if (name === "codex") return codexAdapter;
  return cursorAdapter;
}

export function binaryNames(agent: AgentName): string[] {
  return agent === "cursor" ? ["agent", "cursor-agent"] : [agent];
}

export async function resolveBinary(names: string[]): Promise<string> {
  const pathEntries = (process.env.PATH ?? "").split(":");
  for (const name of names) {
    if (name.includes("/")) {
      try {
        await access(name, constants.X_OK);
        return await realpath(name);
      } catch {
        continue;
      }
    }
    for (const directory of pathEntries) {
      const path = join(directory, name);
      try {
        await access(path, constants.X_OK);
        return await realpath(path);
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  throw new UserError(`Required agent CLI not found: ${names.join(" or ")}`);
}

/** The scrubbed home's own directories, each named by the variable that points at it. */
const ISOLATION_DIRECTORIES = { HOME: "home", TMPDIR: "tmp", XDG_CACHE_HOME: "cache", XDG_CONFIG_HOME: "config" };

/** The variables the scrubbed home owns, which an arm's own environment may not take over. */
export const ISOLATION_VARIABLES = Object.keys(ISOLATION_DIRECTORIES);

/**
 * A scrubbed home is what keeps a producer from finding the live skills,
 * instructions, and session state of this machine. Provider credentials are
 * the one thing deliberately passed back through the environment.
 */
export function scrubbedEnvironment(runtimeDir: string, agent: AgentName): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(ISOLATION_DIRECTORIES).map(([name, directory]) => [name, join(runtimeDir, directory)])),
    // The scrubbed home hides Playwright's browser build from any
    // screenshot tool. Point them back at the real one.
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SHELL: process.env.SHELL ?? "/bin/sh",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
  };
  for (const [name, value] of Object.entries(process.env)) {
    const providerCredential = AUTH_ENVIRONMENT[agent].has(name) || (agent === "claude" && name.startsWith("AWS_"));
    if (value && (providerCredential || name.startsWith("LC_"))) env[name] = value;
  }
  return env;
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
    if (claudeEnvironmentCredential() || await claudeKeychainToken()) return null;
    return "No Claude credential in the environment or the login keychain. Store CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) in the keychain, or export it or an API key.";
  }
  if (agent === "codex") {
    if (process.env.OPENAI_API_KEY || await readable(authFile("codex"))) return null;
    return "No ~/.codex/auth.json and OPENAI_API_KEY is not set. Run `codex login`.";
  }
  if (await readable(authFile("cursor"))) return null;
  const secrets = await cursorSecrets();
  if (secrets.accessToken || secrets.apiKey) return null;
  return "No Cursor login found. Run `agent login` or set CURSOR_API_KEY.";
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
  } catch {
    return [];
  }
}

/**
 * Claude and Cursor register frozen subagents through a session plugin directory rather
 * than --agents JSON: Seatbelt hides sibling filesystems but not the process
 * table, so anything on argv reads back through `ps` from another arm.
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

const claudeAdapter: AgentAdapter = {
  name: "claude",
  async prepare(context) {
    const binary = await resolveBinary(["claude"]);
    const subagents = await frozenSubagents(context.producerDir);
    await prepareRuntimeDirectories(context.runtimeDir);
    // The arm's own settings file replaces the empty default whole: a hook set
    // is a statement about one arm, not something to merge with another's.
    // `--setting-sources ""` still keeps this machine's own settings out.
    // Model and effort ride in the same file: on argv they would name the arm
    // to any sibling that lists processes.
    const settings = context.config.settings ? JSON.parse(await readFile(context.config.settings, "utf8")) as Record<string, unknown> : {};
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
      // The runner owns isolation; the CLI's own permission prompts would
      // otherwise silently deny every file write in headless mode. Restricted
      // mode refuses this permission mode, so the tool list stands alone.
      "--permission-mode",
      "bypassPermissions",
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
    const env = scrubbedEnvironment(context.runtimeDir, "claude");
    if (!claudeEnvironmentCredential()) {
      const token = await claudeKeychainToken();
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
    return {
      binary,
      args,
      cwd: context.cwd,
      env,
      stdin: context.prompt,
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
    const binary = await resolveBinary(["codex"]);
    await prepareRuntimeDirectories(context.runtimeDir);
    const codexHome = join(context.runtimeDir, "codex-home");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await copyIfPresent(authFile("codex"), join(codexHome, "auth.json"));
    const args = [
      "exec",
      "-C",
      context.cwd,
      // The runner owns isolation. Codex must not apply its own sandbox:
      // macOS refuses nested Seatbelt profiles (exit 71).
      "--dangerously-bypass-approvals-and-sandbox",
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
    args.push("-");
    const env = scrubbedEnvironment(context.runtimeDir, "codex");
    env.CODEX_HOME = codexHome;
    return { binary, args, cwd: context.cwd, env, stdin: context.prompt };
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

const cursorAdapter: AgentAdapter = {
  name: "cursor",
  async prepare(context) {
    const subagents = await frozenSubagents(context.producerDir);
    const binary = await resolveBinary(binaryNames("cursor"));
    await prepareRuntimeDirectories(context.runtimeDir);
    const cursorHome = join(context.runtimeDir, "home", ".cursor");
    await mkdir(cursorHome, { recursive: true, mode: 0o700 });
    await copyIfPresent(join(homedir(), ".cursor", "agent-cli-state.json"), join(cursorHome, "agent-cli-state.json"));
    await writeFile(join(cursorHome, "cli-config.json"), "{}\n", { mode: 0o600 });
    await installCursorAuth(cursorHome);
    const args = [
      "-p",
      "--force",
      // The runner owns isolation. Cursor's own sandbox maps the workspace
      // under /tmp/.cursor, which the write containment denies.
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
    const model = context.config.model;
    if (context.config.effort && !model) throw new UserError("Cursor effort requires an explicit model");
    if (model) args.push("--model", await resolveCursorModel(binary, model, context.config.effort));
    const scratch = await cursorScratchDir(context.producerDir);
    const env = scrubbedEnvironment(context.runtimeDir, "cursor");
    env.CURSOR_DATA_DIR = scratch;
    env.CURSOR_CONFIG_DIR = scratch;
    // Read credentials from $HOME/.cursor/auth.json rather than the login
    // keychain, so the scrubbed home fully owns what the producer can see.
    env.AGENT_CLI_CREDENTIAL_STORE = "file";
    return { binary, args, cwd: context.cwd, env, stdin: context.prompt, extraWriteRoots: [scratch] };
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

async function copyIfPresent(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function resolveCursorModel(binary: string, model: string, effort: string | undefined): Promise<string> {
  if (!effort) return model;
  if (model.includes("[")) throw new UserError("Set Cursor effort either in producer.effort or in the model override, not both");
  const listed = await listCursorModelIds(binary);
  const hyphen = `${model}-${effort}`;
  if (listed.has(hyphen)) return hyphen;
  if (listed.has(model)) return model;
  throw new UserError(`Cannot use Cursor model ${hyphen}. Run cursor-agent --list-models and set producer.model to a listed id.`);
}

async function listCursorModelIds(binary: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(binary, ["--list-models"], { timeout: 15_000 });
  const ids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9.+\-_]*)\s+-/i.exec(line);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

async function installCursorAuth(cursorHome: string): Promise<void> {
  const destination = join(cursorHome, "auth.json");
  try {
    await copyFile(authFile("cursor"), destination);
    await chmod(destination, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { accessToken, refreshToken, apiKey } = await cursorSecrets();
  if (!accessToken && !apiKey) {
    throw new UserError("Cursor login not found. Run `agent login` or set CURSOR_API_KEY.");
  }
  await writeFile(destination, `${JSON.stringify({
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(apiKey ? { apiKey } : {}),
  })}\n`, { mode: 0o600 });
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

async function cursorScratchDir(producerDir: string): Promise<string> {
  // Cursor maps project state under ~/.cursor/projects, then falls back to
  // /tmp/.cursor when that path is longer than 84 characters. Capsule homes
  // always exceed that, so give each producer a short private directory.
  const path = join("/tmp", `crucible-${basename(producerDir)}`);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realpath(path);
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
