import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { readJson, writeJson } from "../src/json.js";
import { judgePrompt } from "../src/judge.js";
import { prepareRun } from "../src/prepare.js";
import { cleanRun, reportRun } from "../src/report.js";
import { loadRun, loadRunLocation } from "../src/run.js";
import { resultCell } from "../src/series.js";
import { type SkillCatalogEntry } from "../src/skills.js";
import { setRunState } from "../src/state.js";
import type { JudgedResult, PathsConfig, Verdict } from "../src/types.js";
import { judgeLetters, parseVerdict, revealVerdict } from "../src/verdict.js";
import { tempDirectory } from "./support/files.js";
import { prepareFixture } from "./support/run.js";

test("clean removes the workspace of a run whose frozen experiment no longer loads", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await writeFile(join(run.tempDir, "scratch"), "work in progress\n");
  await writeJson(join(run.runDir, "resolved-config.json"), { name: "prepared by an older runner" });
  await assert.rejects(loadRun(run.runId, paths), /has no arms/);
  await cleanRun(await loadRunLocation(run.runId, paths));
  await assert.rejects(stat(run.tempDir), /ENOENT/);
  assert.ok((await stat(run.runDir)).isDirectory());
});

test("three arms: defaults, one candidate per arm, three letters, and the sealed result", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: a candidate for one arm\n---\n\n# Tone\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n2. clarity\n");
  await writeFile(join(root, "experiment.yaml"), [
    "name: three arms",
    "series: tone",
    "arms:",
    "  - {}",
    "  - {candidate: {path: ./tone-skill}}",
    "  - {producer: {effort: low}}",
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    "producer: {agent: claude, effort: high}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));

  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.label), ["without-tone-skill", "with-tone-skill", "low"]);
  const run = await prepareRun(config, paths);
  assert.equal(Object.keys(run.assignment.arms).length, 3);

  // Only the candidate's own arm sees it, and no other arm's context names it.
  for (const [producerId, label] of Object.entries(run.assignment.arms)) {
    const contextDir = join(run.runDir, "frozen", producerId, "context");
    const catalog = await readJson<SkillCatalogEntry[]>(join(contextDir, "skill-catalog.json"));
    assert.deepEqual(catalog.map((skill) => skill.name), label === "with-tone-skill" ? ["tone-skill"] : []);
    if (label !== "with-tone-skill") {
      await assert.rejects(stat(join(contextDir, "skills", "tone-skill")), /ENOENT/);
    }
  }

  const letters = judgeLetters(3);
  assert.deepEqual(letters, ["A", "B", "C"]);
  const verdict = parseVerdict({
    winner: "B",
    confidence: 0.7,
    scores: [
      { criterion: "quality", weight: 60, scores: { A: 5, B: 8, C: 6 } },
      { criterion: "clarity", weight: 40, scores: { A: 6, B: 7, C: 6 } },
    ],
    referenceGuess: { output: "A", confidence: 0.5 },
    summary: "The winner reads best.",
  }, letters);
  const armOf = { A: "without-tone-skill", B: "with-tone-skill", C: "low" };
  const revealed = revealVerdict(verdict, armOf, ["without-tone-skill", "with-tone-skill", "low"]);
  assert.equal(revealed.winner, "with-tone-skill");
  assert.deepEqual(revealed.totals, { "without-tone-skill": 5.4, "with-tone-skill": 7.6, low: 6 });
  assert.equal(revealed.margin, 1.6);
  assert.deepEqual(revealed.referenceGuess, { arm: "without-tone-skill", confidence: 0.5, correct: true });

  // What `crucible judge` would have left behind, so the report can be sealed.
  const producerIds = Object.keys(run.assignment.arms);
  const mapping = Object.fromEntries(letters.map((letter) => [
    letter,
    producerIds.find((id) => run.assignment.arms[id] === armOf[letter as keyof typeof armOf])!,
  ]));
  await writeJson(join(run.runDir, "judge", "mapping.json"), mapping);
  await writeFile(join(run.runDir, "judge", "verdict.md"), "# Verdict\n\nThe winner reads best.\n");
  await writeJson(join(run.runDir, "judge", "verdict.json"), verdict satisfies Verdict);
  await writeJson(join(run.runDir, "audit", "report.json"), {
    runId: run.runId, auditedAt: "2026-09-04T00:00:00.000Z", contextChanges: {}, leakFindings: {}, warnings: [],
  });
  await setRunState(run.runDir, "judged");
  await reportRun(run);

  const result = await readJson<JudgedResult>(join(run.runDir, "result.json"));
  assert.deepEqual(result.arms, [
    { label: "without-tone-skill", task: "do it", inputs: [], environment: "clean", candidate: null, replaces: null },
    { label: "with-tone-skill", task: "do it", inputs: [], environment: "clean", candidate, replaces: null },
    { label: "low", task: "do it", inputs: [], environment: "clean", candidate: null, replaces: null },
  ]);
  assert.equal(result.environment, "clean");
  assert.equal(result.series, "tone");
  assert.equal(result.winner, "with-tone-skill");
  assert.equal(result.margin, 1.6);
  assert.deepEqual(Object.keys(result.totals), ["without-tone-skill", "with-tone-skill", "low"]);
  assert.deepEqual(Object.keys(result.cost), ["without-tone-skill", "with-tone-skill", "low"]);
  assert.deepEqual(result.producers.low, { agent: "claude", model: null, effort: "low" });
  assert.deepEqual(Object.keys(result.scores[0]!.scores), ["without-tone-skill", "with-tone-skill", "low"]);
  assert.deepEqual(result.referenceGuess, { arm: "without-tone-skill", confidence: 0.5, correct: true });

  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /\| Criterion \| Weight \| without-tone-skill \| with-tone-skill \| low \|/);
  assert.match(markdown, /with-tone-skill won by 1.60/);
  assert.match(markdown, /Control arm guess: without-tone-skill at 50% \(correct\)\./);
  const html = await readFile(join(run.runDir, "report.html"), "utf8");
  assert.match(html, /<th class="num">low<\/th>/);

  // A judge that names an arm which did not score highest keeps its winner, and
  // the report says the numbers disagree.
  await writeJson(join(run.runDir, "judge", "verdict.json"), { ...verdict, winner: "A" } satisfies Verdict);
  await reportRun(run);
  const against = await readJson<JudgedResult>(join(run.runDir, "result.json"));
  assert.equal(against.winner, "without-tone-skill");
  assert.equal(against.margin, -2.2);
  assert.deepEqual(against.warnings, ["The judge named without-tone-skill the winner although with-tone-skill had the higher weighted total"]);
  assert.match(await readFile(join(run.runDir, "report.md"), "utf8"), /without-tone-skill won on the judge's call, 2.20 behind with-tone-skill/);
});

test("one arm is scored against the rubric alone: no margin, no control guess", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: the only candidate\n---\n\n# Tone\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  await writeFile(join(root, "experiment.yaml"), [
    "name: one arm",
    "arms: [{candidate: {path: ./tone-skill}}]",
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.label), ["with-tone-skill"]);
  const run = await prepareRun(config, paths);
  assert.equal(Object.keys(run.assignment.arms).length, 1);

  const letters = judgeLetters(1);
  assert.deepEqual(letters, ["A"]);
  assert.match(judgePrompt(run, join(root, "judge"), letters), /score one anonymous output/);
  assert.doesNotMatch(judgePrompt(run, join(root, "judge"), letters), /referenceGuess/);
  const verdict = parseVerdict({
    winner: "A",
    confidence: 0.6,
    scores: [{ criterion: "quality", weight: 100, scores: { A: 7 } }],
    summary: "The output meets the bar.",
  }, letters);
  assert.deepEqual(verdict.referenceGuess, { output: null, confidence: 0 });
  const revealed = revealVerdict(verdict, { A: "with-tone-skill" }, ["with-tone-skill"]);
  assert.equal(revealed.margin, null);
  assert.equal(revealed.winner, "with-tone-skill");

  const producerId = Object.keys(run.assignment.arms)[0]!;
  await writeJson(join(run.runDir, "judge", "mapping.json"), { A: producerId });
  await writeFile(join(run.runDir, "judge", "verdict.md"), "# Verdict\n\nIt meets the bar.\n");
  await writeJson(join(run.runDir, "judge", "verdict.json"), verdict satisfies Verdict);
  await writeJson(join(run.runDir, "audit", "report.json"), {
    runId: run.runId, auditedAt: "2026-09-04T00:00:00.000Z", contextChanges: {}, leakFindings: {}, warnings: [],
  });
  await setRunState(run.runDir, "judged");
  await reportRun(run);

  const result = await readJson<JudgedResult>(join(run.runDir, "result.json"));
  assert.equal(result.margin, null);
  assert.deepEqual(result.warnings, []);
  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /with-tone-skill scored 7.00: with-tone-skill 7.00 weighted/);
  assert.match(markdown, /\| Criterion \| Weight \| with-tone-skill \|/);
  assert.match(markdown, /One arm ran alone/);
  assert.match(await readFile(join(run.runDir, "report.html"), "utf8"), /One arm ran alone/);
  assert.equal(resultCell(result), "with-tone-skill 7.00 60%");
});
