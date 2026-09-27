import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeAgent, guestPath } from "../src/agent.js";
import { executionCatalog } from "../src/runner.js";
import { adapterFor, guestConfiguration } from "../src/adapters.js";
import type { HarborCommand, HarborSession } from "../src/harbor.js";
import { createRunState, readRunState, resetJudge, resetProducer, setRunState, updateJudge, updateProducer } from "../src/state.js";
import type { NormalizedEvent, ResolvedRun } from "../src/types.js";

test("guest execution preserves split native events, usage and stdin without host paths or provider credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crucible-guest-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDir = join(directory, ".runtime");
  await mkdir(join(directory, "source"));
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "private-test-provider-key";
  t.after(() => { if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; });
  const events: NormalizedEvent[] = [];
  const uploaded: string[] = [];
  let execution: HarborCommand | undefined;
  const session = {
    pid: process.pid,
    forwardPort: async (port: number) => port,
    upload: async (_local: string, guest: string) => { uploaded.push(guest); },
    execute: async (command: HarborCommand) => {
      execution = command;
      await command.onStdout?.('{"type":"thread.started","thread_id":"test"}\n{"type":"turn.');
      await command.onStdout?.('completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10}}');
      await command.onStderr?.("native diagnostic\n");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  } as unknown as HarborSession;
  const result = await executeAgent({
    run: {} as ResolvedRun, id: "p-test", directory, cwd: join(directory, "source"), runtimeDir,
    logDir: join(directory, "logs"), prompt: "Write result.svg", config: { agent: "codex", timeoutMs: 1000 }, session,
    onEvent: async (event) => { events.push(event); },
  });
  assert.equal(result.succeeded, true);
  assert.deepEqual(result.usage, { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 });
  assert.ok(events.some((event) => event.kind === "agent.completed"));
  assert.deepEqual(uploaded, ["/workspace/.runtime"]);
  assert.equal(execution?.command, "codex");
  assert.equal(execution?.cwd, "/workspace/source");
  assert.equal(execution?.stdin, "Write result.svg");
  assert.equal(execution?.env?.CODEX_HOME, "/workspace/.runtime/codex-home");
  assert.notEqual(execution?.env?.OPENAI_API_KEY, process.env.OPENAI_API_KEY);
  assert.ok(!JSON.stringify(execution?.env).includes(directory));
  assert.match(await readFile(join(directory, "logs", "stderr.log"), "utf8"), /native diagnostic/);
  assert.ok(!(await readFile(join(directory, "logs", "launch.json"), "utf8")).includes("private-test-provider-key"));
});

test("runtime configuration maps capsule paths and rejects dependencies on the host", () => {
  assert.deepEqual(guestConfiguration({ args: ["/tmp/capsule/.runtime/tool.js"], env: { DATA: "/tmp/capsule/source" } }, { producerDir: "/tmp/capsule" }), {
    args: ["/workspace/.runtime/tool.js"], env: { DATA: "/workspace/source" },
  });
  assert.throws(() => guestConfiguration({ command: "/opt/homebrew/bin/node" }, { producerDir: "/tmp/capsule" }), /Host-only path.*setup/);
  assert.throws(() => guestPath("/tmp/capsule", "/tmp/other"), /outside/);
});

test("Cursor model discovery receives only the broker stand-in through native Linux token auth", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crucible-cursor-guest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = process.env.HOME;
  process.env.HOME = directory;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  await mkdir(join(directory, ".cursor"));
  const claims = Buffer.from(JSON.stringify({ sub: "test-user", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const login = `eyJhbGciOiJIUzI1NiJ9.${claims}.private-provider-signature`;
  await writeFile(join(directory, ".cursor", "auth.json"), JSON.stringify({ accessToken: login }));
  const runtimeDir = join(directory, ".runtime");
  let discoveryToken: string | undefined;
  const command = await adapterFor("cursor").prepare({
    producerDir: directory, cwd: directory, runtimeDir, prompt: "Draw an SVG",
    config: { agent: "cursor", model: "grok-4.7", effort: "low", timeoutMs: 1000 },
    forwardPort: async (port) => port,
    listCursorModels: async (environment) => {
      discoveryToken = environment.CURSOR_AUTH_TOKEN;
      assert.equal(environment.AGENT_CLI_CREDENTIAL_STORE, "file");
      assert.ok(discoveryToken);
      assert.notEqual(discoveryToken, login);
      assert.ok(!JSON.stringify(environment).includes("private-provider-signature"));
      return "grok-4.7-low - Grok 4.7 Low";
    },
  });
  try {
    const auth = JSON.parse(await readFile(join(runtimeDir, "home", ".cursor", "auth.json"), "utf8")) as { accessToken: string };
    assert.equal(discoveryToken, auth.accessToken);
    assert.equal(command.env.CURSOR_AUTH_TOKEN, discoveryToken);
    assert.ok(command.args.includes("grok-4.7-low"));
    assert.ok(command.args.includes("--auto-review"));
    assert.ok(!command.args.includes("--force"));
    assert.ok(!command.args.includes("--yolo"));
  } finally { await command.release?.(); }

  await t.test("missing effort variant fails without downgrade and preserves discovery evidence", async () => {
    const discovery = { code: 0, timedOut: false, stdout: "grok-4.7 - Grok 4.7\n", stderr: "provider diagnostic\n" };
    const session = {
      forwardPort: async (port: number) => port,
      upload: async () => {},
      execute: async (request: HarborCommand) => {
        assert.deepEqual(request.args, ["--list-models"], "generation must not start with the wrong effort");
        return discovery;
      },
    } as unknown as HarborSession;
    const logDir = join(directory, "logs");
    await assert.rejects(executeAgent({
      run: {} as ResolvedRun, id: "p-test", directory, cwd: directory, runtimeDir,
      logDir, prompt: "Draw an SVG", config: { agent: "cursor", model: "grok-4.7", effort: "low", timeoutMs: 1000 }, session,
    }), /Cannot use Cursor model grok-4\.7-low.*returned 1 model.*model-discovery\.json/);
    assert.deepEqual(JSON.parse(await readFile(join(logDir, "model-discovery.json"), "utf8")), discovery);
  });
});

test("late worker callbacks cannot overwrite a stopped producer, judge or run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crucible-stopped-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createRunState(directory, "ab-test", ["p-test"]);
  await setRunState(directory, "running");
  await resetJudge(directory);
  await updateProducer(directory, "p-test", { state: "stopped" });
  await updateJudge(directory, { state: "stopped" });
  await setRunState(directory, "stopped");
  await Promise.all([
    updateProducer(directory, "p-test", { state: "complete" }),
    updateJudge(directory, { state: "failed" }),
    setRunState(directory, "produced", "running"),
  ]);
  const stopped = await readRunState(directory);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.producers["p-test"]?.state, "stopped");
  assert.equal(stopped.judge?.state, "stopped");
  await resetProducer(directory, "p-test");
  await resetJudge(directory);
  await setRunState(directory, "running");
  await updateProducer(directory, "p-test", { state: "running" });
  assert.equal((await readRunState(directory)).producers["p-test"]?.state, "running", "explicit retry resets cancellation");
});


test("guest discovery catalogs retain usable definitions without treatment annotations", () => {
  const catalog = [
    { name: "reviewer", description: "Review the work", path: "subagents/reviewer.md", candidate: true },
    { name: "draw", description: "Draw SVGs", path: "skills/draw/SKILL.md", candidate: false },
  ];
  const guest = executionCatalog(catalog);
  assert.deepEqual(guest, catalog.map(({ name, description, path }) => ({ name, description, path })));
  assert.ok(!JSON.stringify(guest).includes("candidate"));
  assert.equal(catalog[0]?.candidate, true, "host provenance remains intact");
});
