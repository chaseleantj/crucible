import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { loadConfig, runtimeFor, taskFor } from "../src/config.js";
import { removeTree } from "../src/files.js";
import { prepareRun } from "../src/prepare.js";
import { producerOf } from "../src/run.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "crucible-inputs-"));
  t.after(() => removeTree(root));
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "brief.txt"), "Draw a coffee cup.\n");
  await mkdir(join(root, "reference"));
  await writeFile(join(root, "reference", "drawing.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');
  const base = {
    name: "information test",
    source: { path: "./project", include: ["brief.txt"] },
    task: "Draw an SVG coffee cup.",
    producer: { agent: "claude" },
    skills: { environment: "clean" },
    judge: "none",
    arms: [{ label: "plain" }, { label: "picture", task: "Use .context/inputs/reference/drawing.svg to draw a cup.", inputs: { reference: "./reference" } }],
  };
  const load = async (override: Record<string, unknown> = {}) => {
    await writeFile(join(root, "experiment.yaml"), stringify({ ...base, ...override }));
    return loadConfig(join(root, "experiment.yaml"));
  };
  const paths = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  return { root, base, load, paths };
}

test("arm task and information are frozen separately without changing the shared task", async (t) => {
  const { root, load, paths } = await fixture(t);
  const config = await load();
  assert.equal(taskFor(config, config.arms[0]!), config.task);
  assert.match(taskFor(config, config.arms[1]!), /reference\/drawing.svg/);
  const run = await prepareRun(config, paths);
  const context = (label: string) => join(run.runDir, "frozen", producerOf(run.assignment, label), "context", "inputs");
  assert.equal(await stat(context("plain")).catch(() => null), null);
  const frozen = join(context("picture"), "reference", "drawing.svg");
  const original = await readFile(frozen, "utf8");
  await writeFile(join(root, "reference", "drawing.svg"), "edited after preparation");
  assert.equal(await readFile(frozen, "utf8"), original);
  assert.doesNotMatch(await readFile(join(run.runDir, "frozen", "source", "brief.txt"), "utf8"), /svg xmlns/);
});

test("a file can be supplied to several arms without reaching the arm that omits it", async (t) => {
  const { root, load, paths } = await fixture(t);
  const run = await prepareRun(await load({ arms: [
    { label: "plain" },
    { label: "first", inputs: { "reference.svg": "./reference/drawing.svg" } },
    { label: "second", inputs: { "reference.svg": "./reference/drawing.svg" } },
  ] }), paths);
  for (const label of ["first", "second"]) {
    const file = join(run.runDir, "frozen", producerOf(run.assignment, label), "context", "inputs", "reference.svg");
    assert.equal(await readFile(file, "utf8"), await readFile(join(root, "reference", "drawing.svg"), "utf8"));
  }
  assert.equal(await stat(join(run.runDir, "frozen", producerOf(run.assignment, "plain"), "context", "inputs")).catch(() => null), null);
});

test("withheld information cannot already be present in shared source", async (t) => {
  const { root, load, paths } = await fixture(t);
  await writeFile(join(root, "project", "brief.txt"), await readFile(join(root, "reference", "drawing.svg")));
  await assert.rejects(prepareRun(await load(), paths), /leak|forbidden|hash/i);
});

test("arm information rejects unsafe names, collisions, and links", async (t) => {
  const { root, load, paths } = await fixture(t);
  for (const name of ["../reference.svg", "a/b", ".", "..", "/reference", "a\\b"]) {
    await assert.rejects(load({ arms: [{ inputs: { [name]: "./reference/drawing.svg" } }] }), /simple file or directory names/);
  }
  await assert.rejects(load({ arms: [{ inputs: { "A.svg": "./reference/drawing.svg", "a.svg": "./reference/drawing.svg" } }] }), /colliding names/);
  await symlink(join(root, "project", "brief.txt"), join(root, "reference", "linked.txt"));
  await assert.rejects(prepareRun(await load(), paths), /Symlinks are not allowed in arm inputs/);
  await symlink(join(root, "reference"), join(root, "link"));
  await assert.rejects(prepareRun(await load({ arms: [{ inputs: { reference: "./link" } }] }), paths), /Symlinks are not allowed in arm inputs/);
});

test("guest runtime defaults are explicit and legacy host execution is rejected", async (t) => {
  const { load, paths } = await fixture(t);
  assert.deepEqual(runtimeFor(await load()), { concurrency: 2, cpus: 2, memoryMb: 4096 });
  assert.deepEqual(runtimeFor(await load({ runtime: { concurrency: 1, memoryMb: 2048 } })), { concurrency: 1, cpus: 2, memoryMb: 2048 });
  await assert.rejects(load({ sandbox: false }), /no host execution fallback/);
  await assert.rejects(load({ runtime: { cpus: 0 } }), /positive integer/);
  await assert.rejects(load({ runtime: { concurrency: 1.5 } }), /positive integer/);
  await assert.rejects(load({ runtime: { backend: "host" } }), /runtime may only set/);
  await assert.rejects(load({ arms: [{ reuse: { run: "ab-12345678", arm: "old" }, task: "changed" }] }), /cannot be combined/);
  await assert.rejects(prepareRun({ ...await load(), nodeModules: "/host/node_modules" }, paths), /install dependencies with producer.setup/);
});

test("Claude settings are frozen and producer environment cannot replace broker credentials", async (t) => {
  const { root, load, paths } = await fixture(t);
  await writeFile(join(root, "settings.json"), '{"env":{"LANG":"C.UTF-8"}}');
  const config = await load({ arms: [{ label: "configured", producer: { settings: "./settings.json" } }] });
  const run = await prepareRun(config, paths);
  await writeFile(join(root, "settings.json"), "{}");
  const frozen = join(run.runDir, "frozen", producerOf(run.assignment, "configured"), "context", "claude-settings.json");
  assert.deepEqual(JSON.parse(await readFile(frozen, "utf8")), { env: { LANG: "C.UTF-8" } });
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "CODEX_HOME", "CURSOR_CONFIG_DIR"]) {
    await assert.rejects(load({ producer: { agent: "claude", env: { [name]: "override" } } }), /credential broker|may not set/);
  }
  const explicitMcp = await load({ producer: { agent: "claude", mcpServers: { tool: { command: "tool", env: { OPENAI_API_KEY: "explicit-tool-key" } } } } });
  assert.equal(explicitMcp.producer.mcpServers?.tool?.env?.OPENAI_API_KEY, "explicit-tool-key");
});
