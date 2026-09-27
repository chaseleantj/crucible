import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { archiveRun } from "../src/archive.js";
import { auditRun } from "../src/audit.js";
import { captureRun } from "../src/capture.js";
import { loadConfig } from "../src/config.js";
import { readJson } from "../src/json.js";
import { judgeRun } from "../src/judge.js";
import { prepareRun } from "../src/prepare.js";
import { reportRun } from "../src/report.js";
import { updateProducer } from "../src/state.js";
import type { RunResult } from "../src/types.js";
import { chromiumMissing } from "./support/browser.js";
import { tempDirectory } from "./support/files.js";
import { prepareUnjudged } from "./support/unjudged.js";

test("judge: none needs no rubric, and a missing judge block is an omission, not a choice", async (t) => {
  const root = await tempDirectory(t, "crucible-no-judge-");
  const base = [
    "name: t",
    "arms: [{}, {producer: {model: large}}]",
    "source: {path: ., include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
  ];
  const write = (judge: string[]) => writeFile(join(root, "experiment.yaml"), [...base, ...judge].join("\n"));
  await write(["judge: none"]);
  assert.equal((await loadConfig(join(root, "experiment.yaml"))).judge, null);
  await write([]);
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /judge must be a judge block with a rubric, or "none"/);
  await write(["judge: {agent: claude}"]);
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /judge.rubric must be a non-empty string/);
});

test("a run whose arms differ in environment and agent says so per arm", async (t) => {
  const { run } = await prepareUnjudged(t,
    { "NOTES.md": "# Notes\n" },
    "[{label: plain}, {label: codex, environment: realistic, producer: {agent: codex, model: gpt-6-sol}}]",
  );
  await captureRun(run);
  await reportRun(run);
  const result = await readJson<RunResult>(join(run.runDir, "result.json"));
  assert.equal(result.environment, "mixed");
  assert.deepEqual(result.arms.map((arm) => [arm.label, arm.environment]), [["plain", "clean"], ["codex", "realistic"]]);
  assert.deepEqual(Object.values(result.producers).map((producer) => producer.agent), ["claude", "codex"]);
  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /Skill environment \(plain\): clean/);
  assert.match(markdown, /Skill environment \(codex\): realistic/);
  assert.match(markdown, /Producer \(codex\): codex \/ gpt-6-sol/);
});

test("crucible judge refuses a run that has no judge", async (t) => {
  const { run } = await prepareUnjudged(t, { "NOTES.md": "# Notes\n" });
  await assert.rejects(judgeRun(run), /has no judge/);
});

test("an unjudged run is sealed with judged: false, keeps its costs, and archives", { skip: chromiumMissing() }, async (t) => {
  const { run, paths } = await prepareUnjudged(t, { "NOTES.md": "# What I did\n" });
  const index = await captureRun(run);
  assert.equal(index.capturedBy, "runner");
  assert.equal(index.skipped, undefined);
  assert.equal(index.arms.plain?.[0]?.rendered, "markdown");
  assert.deepEqual(index.omitted.plain, []);

  await reportRun(run);
  const result = await readJson<RunResult>(join(run.runDir, "result.json"));
  assert.equal(result.judged, false);
  for (const absent of ["winner", "scores", "totals", "margin", "confidence", "referenceGuess", "judgeAgent"]) {
    assert.equal(absent in result, false, `${absent} should not be in an unjudged result`);
  }
  assert.deepEqual(result.arms.map((arm) => arm.label), ["plain", "fancy"]);
  assert.deepEqual(Object.keys(result.cost), ["plain", "fancy"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.shots?.capturedBy, "runner");

  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /This run was not judged/);
  assert.match(markdown, /Judge: none/);
  assert.doesNotMatch(markdown, /\| Criterion \|/);
  assert.doesNotMatch(markdown, /Judge verdict/);
  assert.match(markdown, /## Time and tokens/);
  const html = await readFile(join(run.runDir, "report.html"), "utf8");
  assert.match(html, /Not judged/);
  assert.doesNotMatch(html, /<h2>Scores<\/h2>/);
  assert.doesNotMatch(html, /Judge's verdict/);

  const destination = await archiveRun(run, paths.archiveRoot);
  assert.deepEqual((await readdir(destination)).sort(), ["README.md", "dependencies", "outputs", "report.html", "result.json"]);
  const readme = await readFile(join(destination, "README.md"), "utf8");
  assert.match(readme, /Not judged: plain, fancy produced without a verdict/);
  assert.match(readme, /nothing ranks them\. report\.html shows what each made and cost\./);
  assert.doesNotMatch(readme, /full comparison/);
  assert.equal(await readFile(join(destination, "outputs", "plain", "NOTES.md"), "utf8"), "# What I did\n");
});

test("a reuse arm needs a judge to compare against", async (t) => {
  const root = await tempDirectory(t, "crucible-no-judge-");
  await writeFile(join(root, "experiment.yaml"), [
    "name: t",
    "arms: [{label: fresh}, {label: frozen, reuse: {run: ab-12345678, arm: previous}}]",
    "source: {path: ., include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    "judge: none",
  ].join("\n"));
  await assert.rejects(
    loadConfig(join(root, "experiment.yaml")),
    /frozen reuses ab-12345678, which needs a judge to compare against/,
  );
});

test("a reuse arm naming an unjudged run is refused by name", async (t) => {
  // A finished run with judge: none is exactly the historical run that has no
  // judged input to reuse, so it is the one to point an arm at.
  const { run: historical, paths, root } = await prepareUnjudged(t, { "NOTES.md": "# Take\n" });
  await captureRun(historical);
  await reportRun(historical);
  for (const producerId of Object.keys(historical.assignment.arms)) {
    await updateProducer(historical.runDir, producerId, { state: "complete" });
  }

  await writeFile(join(root, "reuse.md"), "1. quality\n");
  await writeFile(join(root, "reuse.yaml"), [
    "name: reuse the unjudged",
    `arms: [{label: fresh}, {label: frozen, reuse: {run: ${historical.runId}, arm: plain}}]`,
    "source: {path: ./project, include: ['*']}",
    "task: build something",
    "producer: {agent: claude}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./reuse.md}",
  ].join("\n"));
  await assert.rejects(
    prepareRun(await loadConfig(join(root, "reuse.yaml")), paths),
    new RegExp(`frozen: reuse requires a successfully judged run, and ${historical.runId} was not judged`),
  );
});

test("one arm with no judge is prepared, captured, reported, and archived", async (t) => {
  const { run, paths } = await prepareUnjudged(t, { "NOTES.md": "# Alone\n" }, "[{label: solo}]");
  assert.equal(run.config.judge, null);
  assert.deepEqual(run.config.arms.map((arm) => arm.label), ["solo"]);
  assert.equal(Object.keys(run.assignment.arms).length, 1);
  // Clean mode with no judge freezes neither a rubric nor shared crafts and styles.
  assert.deepEqual(run.config.skills.shared, []);
  await assert.rejects(stat(join(run.runDir, "rubric.md")), /ENOENT/);

  const index = await captureRun(run);
  assert.deepEqual(Object.keys(index.arms), ["solo"]);
  assert.deepEqual(index.omitted.solo, []);

  await reportRun(run);
  const result = await readJson<RunResult>(join(run.runDir, "result.json"));
  assert.equal(result.judged, false);
  assert.equal("margin" in result, false);
  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /This run was not judged/);
  assert.doesNotMatch(markdown, /One arm ran alone/);
  assert.match(markdown, /Shared material: none/);
  assert.match(await readFile(join(run.runDir, "report.html"), "utf8"), /Not judged/);

  const destination = await archiveRun(run, paths.archiveRoot);
  assert.match(await readFile(join(destination, "README.md"), "utf8"), /Not judged: solo produced without a verdict/);
  assert.equal(await readFile(join(destination, "outputs", "solo", "NOTES.md"), "utf8"), "# Alone\n");
});

test("replicate arms with no judge report and archive under their own labels", async (t) => {
  const { run, paths } = await prepareUnjudged(t, { "NOTES.md": "# Take\n" }, "[{label: take-one}, {label: take-two}]");
  const labels = ["take-one", "take-two"];
  assert.deepEqual(run.config.arms.map((arm) => arm.label), labels);
  // A replicate is two producers with the same settings, so each needs its own workspace.
  assert.deepEqual(Object.values(run.assignment.arms).sort(), labels);

  // Two arms that vary the same thing still get their own workspace, and the
  // audit must find nothing crossing between them.
  const workspaces = Object.keys(run.assignment.arms).map((producerId) => join(run.tempDir, producerId, "source"));
  assert.equal(new Set(workspaces).size, 2);
  const audit = await auditRun(run);
  assert.deepEqual(audit.warnings, []);
  assert.deepEqual(labels.map((label) => audit.leakFindings[label]), [[], []]);
  assert.deepEqual(Object.values(audit.contextChanges), [[], []]);

  await captureRun(run);
  await reportRun(run);
  const result = await readJson<RunResult>(join(run.runDir, "result.json"));
  assert.equal(result.judged, false);
  assert.deepEqual(result.arms.map((arm) => arm.label), labels);
  assert.deepEqual(Object.keys(result.cost), labels);
  assert.deepEqual(Object.keys(result.shots!.arms), labels);

  const destination = await archiveRun(run, paths.archiveRoot);
  assert.deepEqual((await readdir(join(destination, "outputs"))).sort(), labels);
  for (const label of labels) {
    assert.equal(await readFile(join(destination, "outputs", label, "NOTES.md"), "utf8"), "# Take\n");
  }
  assert.match(await readFile(join(destination, "README.md"), "utf8"), /Not judged: take-one, take-two produced without a verdict/);
});
