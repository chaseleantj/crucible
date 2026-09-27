import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { archiveRun } from "../src/archive.js";
import { auditRun } from "../src/audit.js";
import { recordBaseline } from "../src/baseline.js";
import { captureRun } from "../src/capture.js";
import { loadConfig } from "../src/config.js";
import { copyTree, removeTree } from "../src/files.js";
import { readJson, writeJson } from "../src/json.js";
import { judgeRun } from "../src/judge.js";
import { playwrightBrowsersPath } from "../src/paths.js";
import { prepareRun } from "../src/prepare.js";
import { reportRun } from "../src/report.js";
import { renderSeries, renderSeriesIndex, resultCell } from "../src/series.js";
import { setRunState, updateProducer } from "../src/state.js";
import type { AgentIdentity, PathsConfig, ResolvedRun, RunResult, UnjudgedResult } from "../src/types.js";

const identity: AgentIdentity = { agent: "claude", model: "claude-haiku-4-5-20251001", effort: null };

/** A prepared run whose experiment asks for no judge; two arms unless the caller names its own. */
async function prepareUnjudged(
  outputs: Record<string, string> | ((label: string) => Record<string, string>),
  arms = "[{label: plain}, {label: fancy, producer: {effort: high}}]",
): Promise<{ run: ResolvedRun; paths: PathsConfig; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "crucible-no-judge-"));
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  // What an arm that asks for realistic mode reads: an empty skills root beside crafts and styles.
  for (const name of ["no-skills", "crafts", "styles"]) await mkdir(join(root, name));
  await writeFile(join(root, "experiment.yaml"), [
    "name: no judge",
    "series: skip-judge",
    `arms: ${arms}`,
    "source: {path: ./project, include: ['*']}",
    "task: build something",
    "producer: {agent: claude}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: none",
  ].join("\n"));
  const run = await prepareRun(await loadConfig(join(root, "experiment.yaml")), paths);
  for (const [producerId, label] of Object.entries(run.assignment.arms)) {
    const source = join(run.tempDir, producerId, "source");
    await copyTree(join(run.runDir, "frozen", "source"), source);
    // What `crucible start` materializes, so an audit sees the frozen context.
    await copyTree(join(run.runDir, "frozen", producerId, "context"), join(run.tempDir, producerId, ".context"));
    await recordBaseline(run, producerId);
    await mkdir(join(run.runDir, "producers", producerId), { recursive: true });
    for (const [path, content] of Object.entries(typeof outputs === "function" ? outputs(label) : outputs)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), content);
    }
  }
  await writeJson(join(run.runDir, "audit", "report.json"), {
    runId: run.runId, auditedAt: "2026-09-04T00:00:00.000Z", contextChanges: {}, leakFindings: {}, warnings: [],
  });
  await setRunState(run.runDir, "produced");
  return { run, paths, root };
}

test("judge: none needs no rubric, and a missing judge block is an omission, not a choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-no-judge-"));
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
  await removeTree(root);
});

test("a run whose arms differ in environment and agent says so per arm", async () => {
  const { run, root } = await prepareUnjudged(
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
  await removeTree(root);
});

test("crucible judge refuses a run that has no judge", async () => {
  const { run, root } = await prepareUnjudged({ "NOTES.md": "# Notes\n" });
  await assert.rejects(judgeRun(run), /has no judge/);
  await removeTree(root);
});

test("an unjudged run is sealed with judged: false, keeps its costs, and archives", { skip: chromiumMissing() }, async () => {
  const { run, paths, root } = await prepareUnjudged({ "NOTES.md": "# What I did\n" });
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
  await removeTree(root);
});

test("the runner's capture pictures each arm's changed pages", { skip: chromiumMissing() }, async () => {
  const { run, root } = await prepareUnjudged({
    "index.html": "<!doctype html><title>Arm</title><h1>An arm's page</h1>\n",
    "about.html": "<!doctype html><title>About</title><p>Second page</p>\n",
    "NOTES.txt": "Notes\n",
  });
  const index = await captureRun(run);
  assert.equal(index.skipped, undefined);
  assert.equal(index.capturedBy, "runner");
  for (const label of ["plain", "fancy"]) {
    const shots = index.arms[label]!;
    assert.deepEqual(shots.map((shot) => shot.page), ["about.html", "index.html"]);
    const page = shots.find((shot) => shot.page === "index.html")!;
    assert.equal(page.artifact, "index.html");
    assert.equal(page.desktop, `shots/${label}/02-index-desktop.png`);
    assert.equal(page.phone, `shots/${label}/02-index-phone.png`);
    assert.equal(page.error, undefined);
    assert.ok((await readFile(join(run.runDir, page.desktop!))).length > 0);
    assert.deepEqual(index.omitted[label], ["NOTES.txt"]);
  }
  await removeTree(root);
});

test("SVG and Markdown get captures and remain archived beyond the four-page capture limit", { skip: chromiumMissing() }, async (t) => {
  const outputs = {
    "01-icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="30" fill="teal"/></svg>',
    "02-notes.md": "# Useful notes\n\n| Check | Result |\n| --- | --- |\n| Build | Passed |\n",
    "03-guide.markdown": "# A guide\n\nReadable prose.",
    "04-more.md": "# More\n",
    "05-last.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="orange"/></svg>',
  };
  const { run, paths, root } = await prepareUnjudged(outputs, "[{label: solo}]");
  t.after(() => removeTree(root));
  const index = await captureRun(run);
  assert.equal(index.skipped, undefined);
  assert.equal(index.arms.solo?.length, 4);
  assert.deepEqual(index.omitted.solo, ["05-last.svg"]);
  for (const shot of index.arms.solo!) {
    assert.equal(shot.error, undefined);
    assert.ok(shot.desktop && shot.phone);
    assert.ok((await readFile(join(run.runDir, shot.desktop))).length > 1000);
    if (/\.md|\.markdown/.test(shot.page)) assert.equal(shot.rendered, "markdown");
  }
  await reportRun(run);
  const destination = await archiveRun(run, paths.archiveRoot);
  for (const [file, source] of Object.entries(outputs)) {
    assert.equal(await readFile(join(destination, "outputs", "solo", file), "utf8"), source);
  }
});

test("a reuse arm needs a judge to compare against", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-no-judge-"));
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
  await removeTree(root);
});

test("a reuse arm naming an unjudged run is refused by name", async () => {
  // A finished run with judge: none is exactly the historical run that has no
  // judged input to reuse, so it is the one to point an arm at.
  const { run: historical, paths, root } = await prepareUnjudged({ "NOTES.md": "# Take\n" });
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
  await removeTree(root);
});

test("one arm with no judge is prepared, captured, reported, and archived", async () => {
  const { run, paths, root } = await prepareUnjudged({ "NOTES.md": "# Alone\n" }, "[{label: solo}]");
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
  await removeTree(root);
});

test("replicate arms with no judge report and archive under their own labels", async () => {
  const { run, paths, root } = await prepareUnjudged({ "NOTES.md": "# Take\n" }, "[{label: take-one}, {label: take-two}]");
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
  await removeTree(root);
});

test("a series counts an unjudged run as produced and leaves it out of the tally", () => {
  const judged = fixtureResult("ab-00000001", { winner: "fancy", totals: { plain: 6, fancy: 8 } });
  const unjudged = fixtureResult("ab-00000002", null);
  const rendered = renderSeries([judged, unjudged].map((result) => ({
    runId: result.runId, name: result.name, series: "skip-judge", view: null as never, result,
  })), "skip-judge");
  assert.match(rendered, /2 \(1 not judged\) runs: plain 0 · fancy 1\./);
  assert.match(rendered, /Mean total: plain 6.00 · fancy 8.00/);
  assert.match(rendered, /ab-00000002\s+2026-09-03\s+not judged\s+—\s+—\s+—/);
  assert.equal(resultCell(unjudged), "not judged");
  assert.equal(resultCell(judged), "fancy 6.00–8.00 80%");
});

test("a series with nothing judged says so instead of showing an empty tally", () => {
  const runs = [fixtureResult("ab-00000003", null), fixtureResult("ab-00000004", null)].map((result) => ({
    runId: result.runId, name: result.name, series: "skip-judge", view: null as never, result,
  }));
  const rendered = renderSeries(runs, "skip-judge");
  assert.match(rendered, /2 \(2 not judged\) runs: no judged run\. Mean total: no judged run\./);
  // The index is a table, so the same absence reads as a dash there.
  const index = renderSeriesIndex(runs);
  assert.match(index, /skip-judge\s+2 \(2 not judged\)\s+—\s+—/);
});

test("a capture pictures the arm that changed a page and says the other changed none", { skip: chromiumMissing() }, async () => {
  const { run, root } = await prepareUnjudged((label) => (label === "plain"
    ? { "NOTES.txt": "Notes only\n" }
    : { "index.html": "<!doctype html><title>Fancy</title><h1>A page</h1>\n" }));
  const index = await captureRun(run);
  assert.equal(index.skipped, undefined);
  assert.deepEqual(index.arms.fancy!.map((shot) => shot.page), ["index.html"]);
  assert.deepEqual(index.arms.plain, []);
  assert.deepEqual(index.omitted.plain, ["NOTES.txt"]);
  assert.deepEqual(index.omitted.fancy, []);

  await reportRun(run);
  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /fancy, `index.html`/);
  assert.match(markdown, /plain: nothing pictured/);
  await removeTree(root);
});

function fixtureResult(runId: string, verdict: { winner: string; totals: Record<string, number> } | null): RunResult {
  const produced: UnjudgedResult = {
    runId, name: "no judge", series: "skip-judge", task: "build something",
    reportedAt: "2026-09-03T00:00:00.000Z", environment: "clean",
    arms: [{ label: "plain", candidate: null, replaces: null }, { label: "fancy", candidate: null, replaces: null }],
    producers: { plain: identity, fancy: identity }, cost: { plain: null, fancy: null },
    warnings: [], shots: null, judged: false,
  };
  if (!verdict) return produced;
  return {
    ...produced, judged: true, judgeAgent: identity, winner: verdict.winner, confidence: 0.8,
    totals: verdict.totals, margin: 2, scores: [{ criterion: "quality", weight: 1, scores: verdict.totals }],
    referenceGuess: { arm: null, confidence: 0, correct: null }, summary: "",
  };
}

/** The capture needs the browser Playwright installs; without it the test says so instead of failing. */
function chromiumMissing(): string | false {
  try {
    const path = playwrightBrowsersPath();
    return readdirSync(path).some((entry) => entry.startsWith("chromium"))
      ? false
      : `no Chromium under ${path}; run npm run setup:browsers`;
  } catch {
    return "Playwright's browser cache is unavailable; run npm run setup:browsers";
  }
}
