import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AUTH_ENVIRONMENT, adapterFor, armEnvironment, authProblem, scrubbedEnvironment, setClaudeTokenReader, writeSubagentPlugin } from "../src/adapters.js";
import { readJson } from "../src/json.js";
import { subagentLoader } from "../src/subagents.js";
import { setEnvironment } from "./support/environment.js";
import { tempDirectory } from "./support/files.js";

// Adapter preparation resolves these executables but never runs them.
async function adapterFixture(t: test.TestContext): Promise<string> {
  const root = await tempDirectory(t);
  const agentStubs = join(root, "bin");
  await mkdir(agentStubs);
  for (const name of ["claude", "codex"]) await writeFile(join(agentStubs, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  setEnvironment(t, {
    ...Object.fromEntries([...AUTH_ENVIRONMENT.claude].map((name) => [name, undefined])),
    OPENAI_API_KEY: "crucible-test-key",
    HOME: root,
    PATH: `${agentStubs}:${process.env.PATH ?? ""}`,
  });
  setClaudeTokenReader(async () => "token");
  t.after(() => setClaudeTokenReader());
  return root;
}

test("scrubbed environment hides the home and carries no credential at all", (t) => {
  setEnvironment(t, { CRUCIBLE_TEST_SECRET: "x", ANTHROPIC_API_KEY: "key" });
  const env = scrubbedEnvironment("/tmp/rt");
  assert.equal(env.HOME, "/tmp/rt/home");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "setup commands and every other arm process get no credential");
  assert.equal(env.CRUCIBLE_TEST_SECRET, undefined);
});

test("auth check accepts a claude credential from the environment or the keychain", async (t) => {
  const names = [...AUTH_ENVIRONMENT.claude];
  setEnvironment(t, Object.fromEntries(names.map((name) => [name, undefined])));
  t.after(() => setClaudeTokenReader());
  let lookups = 0;
  const keychainHolding = (token: string | undefined) => () => {
    lookups += 1;
    return Promise.resolve(token);
  };
  setClaudeTokenReader(keychainHolding("token"));
  assert.equal(await authProblem("claude"), null);

  setClaudeTokenReader(keychainHolding(undefined));
  assert.match(await authProblem("claude") ?? "", /CLAUDE_CODE_OAUTH_TOKEN/);

  lookups = 0;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
  assert.equal(await authProblem("claude"), null);
  assert.equal(lookups, 0);
});

test("codex enables automatic review inside the guest and does not load user config", async (t) => {
  const runtimeDir = await adapterFixture(t);
  const command = await adapterFor("codex").prepare({
    producerDir: runtimeDir,
    cwd: join(runtimeDir, "source"),
    runtimeDir,
    prompt: "p",
    config: { agent: "codex", timeoutMs: 1000 },
  });
  t.after(() => command.release?.());
  assert.ok(command.args.includes("--approve-for-me"));
  assert.ok(!command.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!command.args.includes('approval_policy="never"'));
  assert.ok(command.args.includes("--ignore-user-config"));
  assert.equal(command.env.CODEX_HOME, join(runtimeDir, "codex-home"));
  assert.notEqual(command.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY);
});

test("claude argv names nothing about the arm: subagents ride in a plugin dir, model and effort in the settings file", async (t) => {
  const producerDir = await adapterFixture(t);
  const contextDir = join(producerDir, ".context", "subagents");
  await mkdir(contextDir, { recursive: true });
  const definition = "---\nname: critic\ndescription: reviews\ntools: Read, Bash\n---\n\nBe harsh.\n";
  await writeFile(join(contextDir, "critic.md"), definition);
  await writeFile(
    join(producerDir, ".context", "subagent-catalog.json"),
    JSON.stringify([{ name: "critic", description: "reviews", path: "subagents/critic.md", candidate: false }]),
  );
  const command = await adapterFor("claude").prepare({
    producerDir,
    cwd: join(producerDir, "source"),
    runtimeDir: join(producerDir, ".runtime"),
    prompt: "task",
    config: { agent: "claude", timeoutMs: 1000, model: "claude-opus-4-1", effort: "xhigh" },
  });
  t.after(() => command.release?.());
  const tools = command.args[command.args.indexOf("--tools") + 1];
  assert.equal(tools, "Bash,Read,Write,Edit,Glob,Grep,Task");
  assert.equal(command.args[command.args.indexOf("--permission-mode") + 1], "auto");
  assert.equal(command.args[command.args.indexOf("--permission-prompts") + 1], "none");
  assert.ok(!command.args.includes("--dangerously-skip-permissions"));
  // A sibling arm's `ps` sees argv; none of the frozen material or arm variables may be on it.
  const argv = command.args.join(" ");
  for (const secret of ["--agents", "Be harsh", "critic", "--model", "claude-opus-4-1", "--effort", "xhigh"]) {
    assert.ok(!argv.includes(secret), `argv exposes ${secret}: ${argv}`);
  }
  const plugin = command.args[command.args.indexOf("--plugin-dir") + 1]!;
  assert.equal(plugin, join(producerDir, ".runtime", "subagents"));
  assert.deepEqual(JSON.parse(await readFile(join(plugin, ".claude-plugin", "plugin.json"), "utf8")), { name: "frozen" });
  assert.equal(await readFile(join(plugin, "agents", "critic.md"), "utf8"), definition);
  const settings = JSON.parse(await readFile(command.args[command.args.indexOf("--settings") + 1]!, "utf8"));
  assert.deepEqual(settings, { model: "claude-opus-4-1", effortLevel: "xhigh" });
  // The agent holds a stand-in and the broker's address, never the credential itself.
  assert.notEqual(command.env.CLAUDE_CODE_OAUTH_TOKEN, "token");
  assert.match(command.env.CLAUDE_CODE_OAUTH_TOKEN ?? "", /^crucible-[0-9a-f]{48}$/);
  assert.match(command.env.ANTHROPIC_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(command.env.CLAUDE_CODE_TMPDIR, command.env.TMPDIR);
  // The producer is told the name the Task tool registers the plugin agent under.
  assert.match(subagentLoader([{ name: "critic", description: "reviews", path: "subagents/critic.md", candidate: false }], "claude", contextDir), /- frozen:critic: reviews/);
});

test("Cursor registers frozen plugin reviewers with plain names and inherited settings", async (t) => {
  const producerDir = await tempDirectory(t);
  const contextDir = join(producerDir, ".context");
  await mkdir(join(contextDir, "subagents"), { recursive: true });
  const catalog = [{ name: "dummy-reviewer", description: "reviews", path: "subagents/reviewer.md", candidate: true }];
  const definition = "---\nname: dummy-reviewer\ndescription: reviews\nmodel: haiku\ntools: Read, Bash\n---\nInspect independently.\n";
  await writeFile(join(contextDir, "subagents/reviewer.md"), definition);
  const runtimeDir = join(producerDir, ".runtime");
  const plugin = await writeSubagentPlugin(producerDir, runtimeDir, catalog, "cursor");
  assert.equal(plugin, join(runtimeDir, "subagents"));
  assert.deepEqual(await readJson(join(plugin!, ".cursor-plugin/plugin.json")), { name: "frozen" });
  assert.equal(await readFile(join(plugin!, "agents/reviewer.md"), "utf8"), definition);
  const prompt = subagentLoader(catalog, "cursor", contextDir);
  assert.match(prompt, /Task tool/);
  assert.match(prompt, /- dummy-reviewer: reviews/);
  assert.match(prompt, /subagent_type/);
  assert.match(prompt, /inherits this producer's model and effort/);
  assert.ok(!prompt.includes("frozen:dummy-reviewer"));
  assert.equal(subagentLoader([], "cursor", contextDir), "");
  assert.equal(await writeSubagentPlugin(producerDir, runtimeDir, [], "cursor"), null);
});

test("Codex delegates to its frozen reviewer with fresh context and inherited settings", async (t) => {
  const producerDir = await adapterFixture(t);
  const contextDir = join(producerDir, ".context");
  await mkdir(join(contextDir, "subagents"), { recursive: true });
  const catalog = [{ name: "critic", description: "reviews", path: "subagents/critic.md", candidate: true }];
  await writeFile(join(contextDir, "subagent-catalog.json"), JSON.stringify(catalog));
  await writeFile(join(contextDir, "subagents/critic.md"), "---\nname: critic\ndescription: reviews\n---\nInspect independently.\n");
  const prompt = subagentLoader(catalog, "codex", contextDir);
  const command = await adapterFor("codex").prepare({
    producerDir, cwd: join(producerDir, "source"), runtimeDir: join(producerDir, ".runtime"), prompt,
    config: { agent: "codex", model: "gpt-6-astra", effort: "low", timeoutMs: 1000 },
  });
  t.after(() => command.release?.());
  assert.ok(command.args.includes("multi_agent"));
  assert.ok(command.args.includes("--ignore-user-config"));
  assert.match(command.stdin, /fork_context=false/);
  assert.match(command.stdin, /inherits this producer's model and effort/);
  assert.ok(command.stdin.includes(join(contextDir, "subagents/critic.md")));
  assert.ok(!command.stdin.includes("Task tool"));
  assert.equal(subagentLoader([], "codex", contextDir), "");
  assert.match(subagentLoader(catalog, "claude", contextDir), /Task tool/);
});

test("the claude adapter hands the producer the arm's own settings file", async (t) => {
  const producerDir = await adapterFixture(t);
  const settings = join(producerDir, "rtk-hooks.json");
  const hooks = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rewrite" }] }] } };
  await writeFile(settings, JSON.stringify(hooks));
  const command = await adapterFor("claude").prepare({
    producerDir,
    cwd: join(producerDir, "source"),
    runtimeDir: join(producerDir, ".runtime"),
    prompt: "task",
    config: { agent: "claude", timeoutMs: 1000, settings },
  });
  t.after(() => command.release?.());
  // The producer starts in the project, not at the top of the workspace.
  assert.equal(command.cwd, join(producerDir, "source"));
  const written = command.args[command.args.indexOf("--settings") + 1]!;
  assert.equal(written, join(producerDir, ".runtime", "claude-settings.json"));
  assert.deepEqual(JSON.parse(await readFile(written, "utf8")), hooks);
  // Nothing from the real machine comes with it.
  assert.equal(command.args[command.args.indexOf("--setting-sources") + 1], "");
});

test("extra environment variables expand against the scrubbed environment and nothing else", () => {
  const env = armEnvironment(scrubbedEnvironment("/tmp/rt"), {
    PATH: "/opt/homebrew/bin:$PATH",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
    CACHE: "${HOME}/cache",
    MISSING: "$NOT_SET/x",
  });
  assert.match(env.PATH!, /^\/opt\/homebrew\/bin:\/.+/);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8080");
  assert.equal(env.CACHE, "/tmp/rt/home/cache");
  assert.equal(env.MISSING, "/x");
  assert.equal(armEnvironment(scrubbedEnvironment("/tmp/rt"), undefined).PATH, "/usr/local/bin:/usr/bin:/bin");
});

test("each adapter reads its own usage keys into one set of counts", () => {
  assert.deepEqual(
    adapterFor("claude").normalizeUsage({ input_tokens: 72, cache_creation_input_tokens: 92706, cache_read_input_tokens: 2378120, output_tokens: 45219 }),
    { input: 72, output: 45219, cacheRead: 2378120, cacheWrite: 92706 },
  );
  // Codex counts cached input inside input_tokens and reasoning inside output_tokens.
  assert.deepEqual(
    adapterFor("codex").normalizeUsage({ input_tokens: 150086, cached_input_tokens: 128256, cache_write_input_tokens: 0, output_tokens: 4559, reasoning_output_tokens: 1617 }),
    { input: 21830, output: 4559, cacheRead: 128256, cacheWrite: 0 },
  );
  assert.deepEqual(
    adapterFor("cursor").normalizeUsage({ inputTokens: 71792, outputTokens: 32852, cacheReadTokens: 1882290, cacheWriteTokens: 0 }),
    { input: 71792, output: 32852, cacheRead: 1882290, cacheWrite: 0 },
  );
  assert.equal(adapterFor("claude").normalizeUsage(null), null);
  assert.equal(adapterFor("claude").normalizeUsage({ nothing_familiar: 5 }), null);
});

test("claude usage is summed once per API call, and its output over every result event", () => {
  const stream = [
    { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } } },
    // The same message again, one line per content block.
    { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } } },
    { type: "user", message: { content: [] } },
    { type: "assistant", message: { id: "msg_2", usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } } },
    { type: "result", usage: { input_tokens: 6, output_tokens: 40, cache_read_input_tokens: 1200, cache_creation_input_tokens: 50 } },
    // A headless run can print more than one result event.
    { type: "result", usage: { input_tokens: 6, output_tokens: 25, cache_read_input_tokens: 1200, cache_creation_input_tokens: 50 } },
  ].map((line) => JSON.stringify(line)).join("\n");
  // Input-side counts are summed per message; output is every result event added up, since a message reports it before streaming ends.
  assert.deepEqual(adapterFor("claude").collectUsage(stream), { input_tokens: 6, output_tokens: 65, cache_read_input_tokens: 2200, cache_creation_input_tokens: 50 });
  assert.equal(adapterFor("claude").collectUsage("not json\n"), null);
  // Codex and Cursor print running totals, so the last one stands.
  const totals = [{ usage: { input_tokens: 10, output_tokens: 1 } }, { usage: { input_tokens: 25, output_tokens: 3 } }].map((line) => JSON.stringify(line)).join("\n");
  assert.deepEqual(adapterFor("codex").collectUsage(totals), { input_tokens: 25, output_tokens: 3 });
});

test("Codex collaboration calls are recorded as tool calls that say who they reached", () => {
  const adapter = adapterFor("codex");
  // Shapes from crucible smoke ab-67146973 (Codex 0.153.4): the wait items carry no receiver, and no spawn item is emitted.
  const wait = { id: "item_2", type: "collab_tool_call", tool: "wait", sender_thread_id: "parent", receiver_thread_ids: [], prompt: null, agents_states: {}, status: "in_progress" };
  const spawn = { id: "item_9", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "parent", receiver_thread_ids: ["child-1"], prompt: "Review  output.html\nindependently", agents_states: { "child-1": "running" }, status: "completed" };
  const [started] = adapter.parseEvent(JSON.stringify({ type: "item.started", item: wait }), "p-test");
  const [finished] = adapter.parseEvent(JSON.stringify({ type: "item.completed", item: { ...wait, status: "completed" } }), "p-test");
  assert.equal(started?.kind, "tool.started");
  assert.equal(finished?.kind, "tool.finished");
  assert.equal(started?.summary, "collab wait; no receivers");
  const [spawned] = adapter.parseEvent(JSON.stringify({ type: "item.completed", item: spawn }), "p-test");
  assert.equal(spawned?.kind, "tool.finished");
  assert.equal(spawned?.nativeId, "item_9");
  assert.equal(spawned?.summary, "collab spawn_agent; receivers child-1; states child-1=running; prompt Review output.html independently");
});
