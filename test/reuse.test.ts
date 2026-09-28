import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { recordBaseline } from "../src/baseline.js";
import { loadConfig } from "../src/config.js";
import { copyTree, removeTree, sha256File } from "../src/files.js";
import { readJson, writeJson } from "../src/json.js";
import { copyJudgeInputs, judgePrompt } from "../src/judge.js";
import { hiddenFrom, scanFiles } from "../src/leaks.js";
import { prepareRun } from "../src/prepare.js";
import { reportRun } from "../src/report.js";
import { recordReusableInputs } from "../src/reuse.js";
import { startRun } from "../src/runner.js";
import { readRunState, setRunState, updateJudge, updateProducer } from "../src/state.js";
import type { ForbiddenMaterial, RunResult } from "../src/types.js";
import { tempDirectory } from "./support/files.js";
import { prepareFixture } from "./support/run.js";

test("reuse config is explicit and cannot pretend to run a candidate", async (t) => {
  const dir = await tempDirectory(t, "crucible-reuse-");
  const configPath = join(dir, "experiment.yaml");
  const write = (arm: string) => writeFile(configPath, [
    "name: reuse", `arms: [{}, ${arm}]`, "source: {path: ., include: ['*']}",
    "task: improve", "producer: {agent: codex}", "judge: {agent: codex, rubric: rubric.md}",
  ].join("\n"));
  await write("{reuse: {run: ab-12345678, arm: prior}}");
  const config = await loadConfig(configPath);
  assert.deepEqual(config.arms[1], { label: "frozen-prior", reuse: { run: "ab-12345678", arm: "prior" } });
  await write("{reuse: {run: ab-12345678, arm: prior}, candidate: {path: x}}");
  await assert.rejects(loadConfig(configPath), /cannot be combined/);
  await write("{reuse: {run: ab-12345678, arm: prior}, producer: {model: x}}");
  await assert.rejects(loadConfig(configPath), /cannot be combined/);
  await write("{reuse: {run: ../outside, arm: prior}}");
  await assert.rejects(loadConfig(configPath), /must be a run ID/);
});

test("reused outputs survive historical cleanup, skip producers, and reach judging unchanged", async (t) => {
  const { run: old, paths, root } = await prepareFixture(t);
  const oldIds = Object.keys(old.assignment.arms);
  for (const [index, id] of oldIds.entries()) {
    const source = join(old.tempDir, id, "source");
    await copyTree(join(old.runDir, "frozen", "source"), source);
    await recordBaseline(old, id);
    await writeFile(join(source, "index.html"), `<canvas>${index}</canvas>`);
    await mkdir(join(source, "dist"));
    await writeFile(join(source, "dist", "ignored.html"), "ignored build");
    await updateProducer(old.runDir, id, { state: "complete" });
  }
  const judgeInput = join(old.tempDir, "judge", "input");
  const mapping = { A: oldIds[0]!, B: oldIds[1]! };
  await copyJudgeInputs(old, judgeInput, mapping);
  await recordReusableInputs(old.runDir, judgeInput, mapping);
  const materialPath = join(old.runDir, "audit", "forbidden-material.json");
  const historicalMaterial = await readJson<ForbiddenMaterial>(materialPath);
  historicalMaterial.hashes.push({ arm: old.assignment.arms[oldIds[0]!]!, value: await sha256File(join(judgeInput, "A", "index.html")) });
  await writeJson(materialPath, historicalMaterial);
  await writeJson(join(old.runDir, "audit", "report.json"), { contextChanges: {}, leakFindings: {}, warnings: [] });
  await writeJson(join(old.runDir, "judge", "package-scan.json"), { findings: [{ path: "A/index.html", identity: { label: "historical skill hash", value: "some-hash", kind: "identifier" } }] });
  await updateJudge(old.runDir, { state: "complete" });
  await setRunState(old.runDir, "judged");
  const arms = oldIds.map((id, index) => ({ label: `frozen-${index}`, reuse: { run: old.runId, arm: old.assignment.arms[id]! } }));
  const config = { ...old.config, arms };
  await setRunState(old.runDir, "produced");
  await assert.rejects(prepareRun(config, paths), /successfully judged run/);
  await setRunState(old.runDir, "judged");
  await assert.rejects(prepareRun({ ...config, task: "different" }, paths), /different task/);
  await updateProducer(old.runDir, oldIds[0]!, { timedOut: true });
  await assert.rejects(prepareRun(config, paths), /without a timeout/);
  await updateProducer(old.runDir, oldIds[0]!, { timedOut: false });
  await writeFile(join(old.tempDir, oldIds[0]!, "source", "index.html"), "changed after judging");
  const judgedHtml = await readFile(join(judgeInput, "A", "index.html"), "utf8");
  await writeFile(join(judgeInput, "A", "index.html"), "tampered judge evidence");
  await assert.rejects(prepareRun(config, paths), /historical judged input changed/);
  await writeFile(join(judgeInput, "A", "index.html"), judgedHtml);
  const run = await prepareRun(config, paths);
  const reusedA = Object.keys(run.assignment.arms).find((id) => run.assignment.arms[id] === "frozen-0")!;
  assert.equal(await readFile(join(run.runDir, "frozen", reusedA, "output", "index.html"), "utf8"), judgedHtml);
  await removeTree(old.tempDir);
  await startRun(run); // No provider CLI or auth is needed for frozen outputs.
  const state = await readRunState(run.runDir);
  assert.equal(state.state, "produced");
  assert.ok(Object.values(state.producers).every((producer) => producer.state === "complete" && producer.pid === undefined));
  const ids = Object.keys(run.assignment.arms);
  for (const id of ids) {
    assert.deepEqual(await readJson(join(run.tempDir, id, ".context", "skill-catalog.json")), []);
    assert.deepEqual(await readJson(join(run.tempDir, id, ".context", "subagent-catalog.json")), []);
    await assert.rejects(stat(join(run.runDir, "cost", `${id}.json`)), /ENOENT/);
    await assert.rejects(stat(join(run.tempDir, id, "source", "dist")), /ENOENT/);
  }
  const input = join(root, "judge-copy");
  await copyJudgeInputs(run, input, { A: ids[0]!, B: ids[1]! });
  assert.equal(await readFile(join(input, "A", "index.html"), "utf8"), await readFile(join(run.tempDir, ids[0]!, "source", "index.html"), "utf8"));
  const carried = hiddenFrom(await readJson<ForbiddenMaterial>(join(run.runDir, "audit", "forbidden-material.json")), null);
  const reuseScan = await scanFiles(join(run.tempDir, reusedA, "source"), ["index.html"], carried.identities, carried.hashes);
  assert.ok(reuseScan.some((finding) => finding.identity.label === "forbidden file hash"));
  assert.match(judgePrompt(run, join(root, "judge"), ["A", "B"]), /not an independent producer sample/);
  await writeJson(join(run.runDir, "judge", "mapping.json"), { A: ids[0], B: ids[1] });
  await writeJson(join(run.runDir, "judge", "verdict.json"), { winner: "A", confidence: 0.7, scores: [{ criterion: "quality", weight: 1, scores: { A: 8, B: 7 } }], referenceGuess: { output: null, confidence: 0 }, summary: "The winner is stronger." });
  await writeFile(join(run.runDir, "judge", "verdict.md"), "The winner is stronger.");
  await setRunState(run.runDir, "judged");
  await reportRun(run);
  const result = await readJson<RunResult>(join(run.runDir, "result.json"));
  assert.ok(result.warnings.some((warning) => warning.includes("not an independent producer sample")));
  assert.ok(result.warnings.some((warning) => warning.includes("Historical judge identity finding: index.html (historical skill hash)")));
  assert.ok(result.arms.every((arm) => arm.reuse?.run === old.runId));
  assert.ok(Object.values(result.cost).every((cost) => cost === null));
  await recordReusableInputs(run.runDir, input, { A: ids[0]!, B: ids[1]! });
  await updateJudge(run.runDir, { state: "complete" });
  await writeJson(join(run.runDir, "judge", "package-scan.json"), { findings: [] });
  await removeTree(input);
  await removeTree(run.tempDir);
  const chained = await prepareRun({ ...config, arms: run.config.arms.map((arm) => ({ label: arm.label, reuse: { run: run.runId, arm: arm.label } })) }, paths);
  assert.ok(chained.config.arms.every((arm) => arm.reuse?.run === run.runId));
});
