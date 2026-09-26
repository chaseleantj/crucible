import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { loadRun } from "../src/run.js";
import { loadUserConfig, userConfigPath } from "../src/user-config.js";

test("the config file is found through CRUCIBLE_CONFIG, then XDG_CONFIG_HOME, then ~/.config", () => {
  assert.equal(userConfigPath({ CRUCIBLE_CONFIG: "/x/crucible.yaml", XDG_CONFIG_HOME: "/xdg" }), "/x/crucible.yaml");
  assert.equal(userConfigPath({ XDG_CONFIG_HOME: "/xdg" }), "/xdg/crucible/config.yaml");
  assert.equal(userConfigPath({}), join(homedir(), ".config", "crucible", "config.yaml"));
});

test("with no config file every setting is a generic default", () => {
  const loaded = loadUserConfig({ CRUCIBLE_CONFIG: join(tmpdir(), "crucible-no-such-config.yaml") });
  assert.equal(loaded.exists, false);
  assert.equal(loaded.values.runsRoot, join(homedir(), ".crucible", "runs"));
  assert.equal(loaded.values.archiveRoot, join(homedir(), ".crucible", "archive"));
  assert.equal(loaded.values.skills.root, join(homedir(), ".claude", "skills"));
  assert.equal(loaded.values.subagents.root, join(homedir(), ".claude", "agents"));
  assert.deepEqual(loaded.values.skills, { root: join(homedir(), ".claude", "skills"), shared: [], excludeCategories: [], exclude: [] });
  assert.equal(loaded.values.nodeModules, null);
  assert.ok(Object.values(loaded.sources).every((source) => source === "default"));
});

test("environment variables beat the config file, which beats the defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crucible-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "config.yaml");
  await writeFile(file, [
    "runsRoot: ./runs",
    "archiveRoot: ~/kept",
    "skills: {root: ./skills, shared: [./crafts], excludeCategories: [meta], exclude: [b, a]}",
    "subagents: {exclude: [manager]}",
    "nodeModules: ./node_modules",
  ].join("\n"));
  const loaded = loadUserConfig({ CRUCIBLE_CONFIG: file, CRUCIBLE_ARCHIVE_ROOT: "/elsewhere" });
  assert.equal(loaded.values.runsRoot, join(root, "runs"));
  assert.equal(loaded.values.archiveRoot, "/elsewhere");
  assert.deepEqual(loaded.values.skills, { root: join(root, "skills"), shared: [join(root, "crafts")], excludeCategories: ["meta"], exclude: ["a", "b"] });
  assert.deepEqual(loaded.values.subagents.exclude, ["manager"]);
  assert.equal(loaded.values.nodeModules, join(root, "node_modules"));
  assert.equal(loaded.sources.runsRoot, "config file");
  assert.equal(loaded.sources.archiveRoot, "$CRUCIBLE_ARCHIVE_ROOT");
  assert.equal(loaded.sources.tempRoot, "default");
  assert.equal(loaded.sources["subagents.root"], "default");

  await writeFile(file, "skills: {roots: ./skills}\n");
  assert.throws(() => loadUserConfig({ CRUCIBLE_CONFIG: file }), /Unknown skills field: roots/);
});

test("an experiment overrides the config file, and its exclusions add to the configured ones", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crucible-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "config.yaml"), "skills: {root: ./configured, excludeCategories: [meta], exclude: [one]}\nsubagents: {exclude: [manager]}\n");
  await writeFile(join(root, "experiment.yaml"), [
    "name: t", "arms: [{}]", "source: {path: ., include: ['*']}", "task: t", "producer: {agent: claude}", "judge: none",
    "skills: {root: ./mine, excludeCategories: [], exclude: [two]}",
  ].join("\n"));
  const previous = process.env.CRUCIBLE_CONFIG;
  process.env.CRUCIBLE_CONFIG = join(root, "config.yaml");
  try {
    const config = await loadConfig(join(root, "experiment.yaml"));
    assert.equal(config.skills.root, join(root, "mine"));
    assert.deepEqual(config.skills.excludeCategories, []);
    assert.deepEqual(config.skills.exclude, ["one", "two"]);
    assert.deepEqual(config.subagents.exclude, ["manager"]);
  } finally {
    if (previous === undefined) delete process.env.CRUCIBLE_CONFIG;
    else process.env.CRUCIBLE_CONFIG = previous;
  }
});

test("a legacy run record, from before shared folders were listed, reads as one root's crafts and styles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "crucible-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "ab-0123abcd";
  const runDir = join(root, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({ runId, tempDir: join(root, "temp", runId) }));
  await writeFile(join(runDir, "assignment.json"), JSON.stringify({ seed: "00", arms: { p1: "a" } }));
  const legacy = (shared?: string) => writeFile(join(runDir, "resolved-config.json"), JSON.stringify({
    name: "old", arms: [{ label: "a" }], skills: { environment: "realistic", root: "/h/skills", ...(shared ? { shared } : {}), excludeCategories: [], exclude: [] },
  }));
  const paths = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };

  await legacy();
  let { config } = await loadRun(runId, paths);
  assert.deepEqual(config.skills.shared, ["/h/crafts", "/h/styles"]);
  assert.equal(config.skills.sharedInClean, false);
  assert.equal(config.nodeModules, "/h/node_modules");

  await legacy("/g");
  ({ config } = await loadRun(runId, paths));
  assert.deepEqual(config.skills.shared, ["/g/crafts", "/g/styles"]);
  assert.equal(config.skills.sharedInClean, true);
});
