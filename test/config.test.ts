import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, parseDuration, producerFor } from "../src/config.js";
import { readJson } from "../src/json.js";
import { prepareRun } from "../src/prepare.js";
import { type SkillCatalogEntry } from "../src/skills.js";
import type { ForbiddenIdentity, PathsConfig } from "../src/types.js";
import { tempDirectory } from "./support/files.js";

test("duration parsing is explicit", () => {
  assert.equal(parseDuration("90m"), 5_400_000);
  assert.throws(() => parseDuration("90"), /must use/);
});

test("experiment files reject unknown fields, and name what the arms list replaced", async (t) => {
  const dir = await tempDirectory(t);
  const write = (producer: string, extra = "") => writeFile(join(dir, "experiment.yaml"), [
    "name: t",
    "arms: [{}, {producer: {model: large}}]",
    "source: {path: ., include: ['*']}",
    "task: do it",
    `producer: ${producer}`,
    "judge: {agent: claude, rubric: ./rubric.md}",
    extra,
  ].join("\n"));
  await write("{agent: claude}", "network: {default: deny}");
  await assert.rejects(loadConfig(join(dir, "experiment.yaml")), /Unknown experiment field: network/);
  await write("{agent: claude}", "candidate: {path: ./skill}");
  await assert.rejects(loadConfig(join(dir, "experiment.yaml")), /candidate was replaced by arms/);
  await write("{agent: claude, control: {model: a}, treatment: {model: b}}");
  await assert.rejects(loadConfig(join(dir, "experiment.yaml")), /producer.control and producer.treatment were replaced by arms/);
});

test("legacy sandbox false is rejected without a host fallback", async (t) => {
  const dir = await tempDirectory(t);
  const base = [
    "name: t",
    "arms: [{}, {candidate: {path: ./skill}}]",
    "source: {path: ., include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ];
  await mkdir(join(dir, "skill"));
  await writeFile(join(dir, "rubric.md"), "quality\n");
  await writeFile(join(dir, "on.yaml"), base.join("\n"));
  await writeFile(join(dir, "off.yaml"), [...base, "sandbox: false"].join("\n"));
  assert.equal((await loadConfig(join(dir, "on.yaml"))).sandbox, true);
  await assert.rejects(loadConfig(join(dir, "off.yaml")), /no host execution fallback/);
});

test("arms can differ in producer model instead of a candidate skill", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  const write = (arms: string, producer = "{agent: claude, effort: high}") => writeFile(join(root, "experiment.yaml"), [
    "name: t",
    `arms: ${arms}`,
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    `producer: ${producer}`,
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  await write("[]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /at least 1 entry/);
  await write(`[${Array.from({ length: 11 }, (_, index) => `{label: a${index}}`).join(", ")}]`);
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /at most 10 entries/);
  await write(`[${Array.from({ length: 10 }, (_, index) => `{label: a${index}}`).join(", ")}]`);
  const tenArmRun = await prepareRun(await loadConfig(join(root, "experiment.yaml")), paths);
  assert.deepEqual(Object.values(tenArmRun.assignment.arms).sort(), Array.from({ length: 10 }, (_, index) => `a${index}`));
  // A replicate of the same settings is allowed, but its label cannot be guessed.
  await write("[{producer: {model: a}}, {producer: {model: a}}]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /deliberate replicate: give each one its own label/);
  await write("[{label: first, producer: {model: a}}, {label: second, producer: {model: a}}]");
  assert.deepEqual((await loadConfig(join(root, "experiment.yaml"))).arms.map((arm) => arm.label), ["first", "second"]);
  await write("[{producer: {model: small}}, {producer: {model: large}}]");
  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.candidate), [undefined, undefined]);
  assert.deepEqual(producerFor(config.producer, config.arms[0]!), { agent: "claude", effort: "high", model: "small", timeoutMs: 7_200_000 });
  assert.equal(producerFor(config.producer, config.arms[1]!).model, "large");
  const run = await prepareRun(config, paths);
  for (const producerId of Object.keys(run.assignment.arms)) {
    const catalog = await readJson<SkillCatalogEntry[]>(join(run.runDir, "frozen", producerId, "context", "skill-catalog.json"));
    assert.deepEqual(catalog, []);
  }
  const { identities } = await readJson<{ identities: ForbiddenIdentity[] }>(join(run.runDir, "audit", "forbidden-material.json"));
  assert.deepEqual(identities.map((entry) => entry.label), ["orchestrator path"]);
});

test("an arm can hook in a tool with settings, env, and a setup command", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  await writeFile(join(root, "rtk-hooks.json"), JSON.stringify({ hooks: { PreToolUse: [] } }));
  const write = (arms: string, producer = "{agent: claude, env: {PATH: '/opt/homebrew/bin:$PATH'}}", judge = "{agent: claude, rubric: ./rubric.md}") =>
    writeFile(join(root, "experiment.yaml"), [
      "name: t",
      `arms: ${arms}`,
      "source: {path: ./project, include: ['*']}",
      "task: do it",
      `producer: ${producer}`,
      "skills: {environment: clean, root: ./no-skills}",
      "subagents: {root: ./no-agents}",
      `judge: ${judge}`,
    ].join("\n"));

  await write("[{}, {producer: {settings: ./rtk-hooks.json, env: {RTK_MODE: 'on'}, setup: 'echo built'}}]");
  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.label), ["baseline", "rtk-hooks"]);
  const baseline = producerFor(config.producer, config.arms[0]!);
  const hooked = producerFor(config.producer, config.arms[1]!);
  assert.deepEqual(baseline.env, { PATH: "/opt/homebrew/bin:$PATH" });
  assert.equal(baseline.settings, undefined);
  // The shared block's variables and the arm's own both survive the merge.
  assert.deepEqual(hooked.env, { PATH: "/opt/homebrew/bin:$PATH", RTK_MODE: "on" });
  assert.equal(hooked.settings, join(root, "rtk-hooks.json"));
  assert.deepEqual(hooked.setup, ["echo built"]);

  // Only a claude producer can apply a settings file.
  await write("[{}, {producer: {settings: ./rtk-hooks.json}}]", "{agent: codex}");
  await assert.rejects(prepareRun(await loadConfig(join(root, "experiment.yaml")), paths), /only a claude producer can apply/);
  // The scrubbed home owns the isolation variables; PATH is the one exception.
  await write("[{}, {producer: {env: {HOME: /elsewhere}}}]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /may not set HOME/);
  // Arms that differ only in these fields are two arms; identical ones are a replicate that must be labelled.
  await write("[{producer: {setup: 'echo built'}}, {producer: {setup: 'echo built'}}]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /deliberate replicate/);
  await write("[{producer: {env: {RTK_MODE: 'on'}}}, {producer: {env: {RTK_MODE: 'off'}}}]");
  // Two arms named after the same variable have to be labelled by hand.
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /both fall back to the label "rtk-mode"/);
  // The judge is never hooked up: it may only name its agent, model, effort, and timeout.
  await write("[{}, {producer: {effort: low}}]", "{agent: claude}", "{agent: claude, rubric: ./rubric.md, settings: ./rtk-hooks.json}");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /judge may only set/);
});

test("arm labels default to what each arm varied and can be overridden", async (t) => {
  const dir = await tempDirectory(t);
  await mkdir(join(dir, "footer"));
  await mkdir(join(dir, "elsewhere", "footer"), { recursive: true });
  await writeFile(join(dir, "rubric.md"), "quality\n");
  const base = ["source: {path: ., include: ['*']}", "task: do it", "producer: {agent: claude}", "judge: {agent: claude, rubric: ./rubric.md}"];
  const labelsOf = async (name: string) => (await loadConfig(join(dir, name))).arms.map((arm) => arm.label);
  const write = (name: string, ...lines: string[]) => writeFile(join(dir, name), ["name: t", ...lines, ...base].join("\n"));
  await write("candidate.yaml", "arms: [{}, {candidate: {path: ./footer}}]");
  await write("replaces.yaml", "arms: [{}, {candidate: {path: ./footer, replaces: footer}}]");
  await write("models.yaml", "arms: [{producer: {model: haiku}}, {producer: {model: sonnet, effort: high}}]");
  await write("three.yaml", "arms: [{}, {candidate: {path: ./footer}}, {producer: {effort: low}}]");
  await write("named.yaml", "series: footers", "arms: [{label: Footer Current}, {label: footer-revised, candidate: {path: ./footer}}]");
  await write("same.yaml", "arms: [{label: x}, {label: x, candidate: {path: ./footer}}]");
  await write("collide.yaml", "arms: [{candidate: {path: ./footer}}, {candidate: {path: ./elsewhere/footer}}]");
  assert.deepEqual(await labelsOf("candidate.yaml"), ["without-footer", "with-footer"]);
  assert.deepEqual(await labelsOf("replaces.yaml"), ["without-footer", "footer-variant"]);
  assert.deepEqual(await labelsOf("models.yaml"), ["haiku", "sonnet-high"]);
  assert.deepEqual(await labelsOf("three.yaml"), ["without-footer", "with-footer", "low"]);
  const named = await loadConfig(join(dir, "named.yaml"));
  assert.deepEqual(named.arms.map((arm) => arm.label), ["footer-current", "footer-revised"]);
  assert.equal(named.series, "footers");
  await assert.rejects(loadConfig(join(dir, "same.yaml")), /both labelled "x"/);
  await assert.rejects(loadConfig(join(dir, "collide.yaml")), /both fall back to the label "with-footer"/);
});

test("arms may run different agents: labels, per-arm checks, and the agent each arm launches", async (t) => {
  const root = await tempDirectory(t);
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  await writeFile(join(root, "settings.json"), "{}\n");
  const load = async (arms: string) => {
    await writeFile(join(root, "experiment.yaml"), [
      "name: harnesses",
      `arms: ${arms}`,
      "source: {path: ./project, include: ['*']}",
      "task: do it",
      "producer: {agent: claude, model: claude-opus-5-5, effort: high}",
      "skills: {environment: clean, root: ./no-skills}",
      "subagents: {root: ./no-agents}",
      "judge: {agent: claude, rubric: ./rubric.md}",
    ].join("\n"));
    return loadConfig(join(root, "experiment.yaml"));
  };
  const config = await load("[{label: opus}, {producer: {agent: codex, model: gpt-6-sol, effort: high}}]");
  assert.deepEqual(config.arms.map((arm) => arm.label), ["opus", "codex-gpt-6-sol-high"]);
  assert.deepEqual(config.arms.map((arm) => producerFor(config.producer, arm).agent), ["claude", "codex"]);
  assert.equal(producerFor(config.producer, config.arms[1]!).model, "gpt-6-sol");

  await assert.rejects(load("[{}, {producer: {agent: gemini}}]"), /arms\[1\]\.producer\.agent must be one of/);
  await assert.rejects(load("[{}, {producer: {agent: cursor, mcpServers: {tool: {command: /bin/true}}}}]"), /mcpServers supports claude and codex/);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await assert.rejects(
    prepareRun(await load("[{producer: {settings: ./settings.json}}, {producer: {agent: codex, settings: ./settings.json}}]"), paths),
    /codex runs with producer.settings, which only a claude producer can apply/,
  );
});
