import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { archiveRun, localReferences } from "../src/archive.js";
import { armChanges, recordBaseline, withholdNonArmFiles } from "../src/baseline.js";
import { entryIssues } from "../src/check.js";
import { copyTree, removeTree } from "../src/files.js";
import { readJson, writeJson } from "../src/json.js";
import { cleanRun } from "../src/report.js";
import { setRunState } from "../src/state.js";
import type { JudgedResult, ResolvedRun, RunResult } from "../src/types.js";
import { judgedResult } from "./support/results.js";
import { identity, materializeOutputs, prepareFixture } from "./support/run.js";

function fixtureResult(run: ResolvedRun, totals: Record<string, number>): RunResult {
  const labels = run.config.arms.map((arm) => arm.label);
  return judgedResult({
    runId: run.runId, name: run.config.name, task: run.config.task,
    reportedAt: "2026-09-03T00:00:00.000Z", environment: run.config.skills.environment,
    arms: run.config.arms.map((arm) => ({ label: arm.label, candidate: arm.candidate?.path ?? null, replaces: arm.candidate?.replaces ?? null })),
    producers: Object.fromEntries(labels.map((label) => [label, identity])), judgeAgent: identity,
    winner: labels[1]!, confidence: 0.8, totals, margin: Number((totals[labels[1]!]! - totals[labels[0]!]!).toFixed(2)),
    scores: [{ criterion: "quality", weight: 1, scores: totals }],
    referenceGuess: { arm: null, confidence: 0, correct: null }, summary: "",
    cost: Object.fromEntries(labels.map((label) => [label, null])),
  });
}

async function withArchiveCaptures(run: ResolvedRun, result: RunResult, page = "index.html"): Promise<RunResult> {
  result.shots ??= { capturedAt: result.reportedAt, arms: {}, omitted: {} };
  for (const { label } of result.arms) {
    const captures = result.shots.arms[label] ??= [{ page, desktop: null, phone: null }];
    const capture = captures[0]!;
    if (capture.desktop || capture.phone) continue;
    capture.desktop = `shots/${label}/desktop.png`;
    await mkdir(join(run.runDir, "shots", label), { recursive: true });
    await writeFile(join(run.runDir, capture.desktop), "fixture capture");
  }
  return result;
}

test("archiving a run already in the archive refreshes it in place, keeping what a reader added", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, { "index.html": "<h1>hi</h1>\n" });
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 }), "index.html"));
  await writeFile(join(run.runDir, "report.md"), "# fixture\n");
  await writeFile(join(run.runDir, "report.html"), "<h1>fixture</h1>\n");
  await mkdir(join(run.runDir, "judge", "agent"), { recursive: true });
  await writeFile(join(run.runDir, "judge", "agent", "stdout.jsonl"), '{"type":"turn.started"}\n');
  await setRunState(run.runDir, "reported");

  const destination = await archiveRun(run, paths.archiveRoot);
  const readmePath = join(destination, "README.md");
  const first = await readFile(readmePath, "utf8");
  assert.match(first, /with-candidate-skill won by 2.00: without-candidate-skill 6.00, with-candidate-skill 8.00 weighted/);
  await assert.rejects(stat(join(destination, "transcripts")), /ENOENT/);
  assert.deepEqual((await readdir(destination)).sort(), ["README.md", "dependencies", "outputs", "report.html", "result.json"]);
  await writeFile(readmePath, first + "\nA note only a reader could write.\n");

  await mkdir(join(run.runDir, "shots"), { recursive: true });
  await writeFile(join(run.runDir, "shots", "new-index.png"), "new capture\n");
  await mkdir(join(destination, "shots"), { recursive: true });
  await writeFile(join(destination, "shots", "old-board.png"), "stale capture\n");

  const resealed = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 9 });
  resealed.shots = { capturedAt: "2026-09-03T00:00:00.000Z", arms: { "with-candidate-skill": [{ page: "index.html", desktop: "shots/new-index.png", phone: null }] }, omitted: {} };
  await withArchiveCaptures(run, resealed);
  await writeJson(join(run.runDir, "result.json"), resealed);
  await writeFile(join(run.runDir, "report.html"), '<img src="shots/new-index.png">');
  await writeFile(join(run.runDir, "report.md"), "# fixture, resealed\n");
  // The outputs are gone, as they would be after crucible clean; a refresh must not need them.
  await removeTree(run.tempDir);
  await setRunState(run.runDir, "cleaned");

  assert.equal(await archiveRun(run, paths.archiveRoot), destination);
  assert.deepEqual(await readdir(paths.archiveRoot), [basename(destination)]);
  const refreshed = await readFile(readmePath, "utf8");
  assert.match(refreshed, /with-candidate-skill won by 3.00/);
  assert.match(refreshed, /A note only a reader could write\./);
  await assert.rejects(stat(join(destination, "REPORT.md")), /ENOENT/);
  assert.ok(refreshed.trim().split(/\s+/).length <= 200);
  assert.match(await readFile(join(destination, "report.html"), "utf8"), /dependencies\/shots\/new-index.png/);
  assert.equal((await readJson<JudgedResult>(join(destination, "result.json"))).totals["with-candidate-skill"], 9);
  assert.equal(await readFile(join(destination, "dependencies", "shots", "new-index.png"), "utf8"), "new capture\n");
  await assert.rejects(stat(join(destination, "shots", "old-board.png")), /ENOENT/);
});

test("a refresh keeps a reader's long notes and reports the length instead of dropping them", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, { "index.html": "<h1>hi</h1>\n" });
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 }), "index.html"));
  await writeFile(join(run.runDir, "report.html"), "<h1>fixture</h1>\n");
  await setRunState(run.runDir, "reported");
  const destination = await archiveRun(run, paths.archiveRoot);
  const readmePath = join(destination, "README.md");

  // A reader's notes that take the README past the limit.
  const notes = `Hand-written notes: ${"word ".repeat(180).trim()}.`;
  await writeFile(readmePath, `# Old entry\n\n<!-- crucible:result -->\nstale facts\n<!-- /crucible:result -->\n\n${notes}\n`);
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 9 }), "index.html"));
  const warnings: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { warnings.push(chunk); return true; }) as typeof process.stderr.write;
  try { assert.equal(await archiveRun(run, paths.archiveRoot), destination); }
  finally { process.stderr.write = write; }

  const refreshed = await readFile(readmePath, "utf8");
  assert.equal(refreshed, `# Old entry\n\n<!-- crucible:result -->\nwith-candidate-skill won by 3.00: without-candidate-skill 6.00, with-candidate-skill 9.00 weighted. Judge confidence 80%.\n<!-- /crucible:result -->\n\n${notes}\n`);
  assert.match(warnings.join(""), /Warning: README\.md has \d+ words; expected 1–200/);
  assert.deepEqual(entryIssues(destination), [warnings.join("").match(/README\.md has \d+ words; expected 1–200/)![0]]);

  // A README with no markers at all keeps its text and gains the block.
  await writeFile(readmePath, "# By hand\n\nA note.\n");
  await archiveRun(run, paths.archiveRoot);
  assert.match(await readFile(readmePath, "utf8"), /^# By hand\n\nA note\.\n\n<!-- crucible:result -->\nwith-candidate-skill won by 3\.00/);
});

test("the arm's own work is all that is counted or archived", async (t) => {
  const { run, paths, root } = await prepareFixture(t);
  const [first] = Object.keys(run.assignment.arms) as [string];
  for (const producerId of Object.keys(run.assignment.arms)) {
    const source = join(run.tempDir, producerId, "source");
    await copyTree(join(run.runDir, "frozen", "source"), source);
    // A setup step installing a tool: a folder of its own, and its line in a frozen file.
    await mkdir(join(source, "graphify-out"), { recursive: true });
    await writeFile(join(source, "graphify-out", "graph.txt"), "graph\n");
    await writeFile(join(source, "index.js"), "console.log('hi');\n// graphify\n");
    await recordBaseline(run, producerId);
    // The arm's own work, and what its build left behind.
    await writeFile(join(source, "page.html"), "<h1>arm</h1>\n");
    await mkdir(join(source, "dist", "assets"), { recursive: true });
    await writeFile(join(source, "dist", "index.html"), "<body></body>\n");
    await writeFile(join(source, "dist", "assets", "app.js"), "console.log(1);\n");
    await writeFile(join(source, "build.log"), "noise\n");
    await writeFile(join(source, "kept.log"), "kept\n");
  }

  // The changed count sees the arm's files and nothing else.
  assert.deepEqual(await armChanges(run, first), ["added: kept.log", "added: page.html"]);

  // So does the judge's copy: the build output goes whole, the negated pattern stays.
  const copy = join(root, "judge-input", "A");
  await copyTree(join(run.tempDir, first, "source"), copy);
  assert.equal(await withholdNonArmFiles(run.runDir, first, copy), 5);
  await assert.rejects(stat(join(copy, "dist")), /ENOENT/);
  await assert.rejects(stat(join(copy, "build.log")), /ENOENT/);
  assert.equal(await readFile(join(copy, "kept.log"), "utf8"), "kept\n");

  // And so does the archive, which used to copy the workspace raw.
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 }), "page.html"));
  await writeFile(join(run.runDir, "report.md"), "# fixture\n");
  await writeFile(join(run.runDir, "report.html"), "<h1>fixture</h1>\n");
  await setRunState(run.runDir, "reported");
  const output = join(await archiveRun(run, paths.archiveRoot), "outputs", run.assignment.arms[first]!);
  assert.equal(await readFile(join(output, "page.html"), "utf8"), "<h1>arm</h1>\n");
  await assert.rejects(stat(join(output, "dist")), /ENOENT/);
  await assert.rejects(stat(join(output, "graphify-out")), /ENOENT/);
  await assert.rejects(stat(join(output, "index.js")), /ENOENT/);
  await assert.rejects(stat(join(output, "kept.log")), /ENOENT/);
});

test("archives retain referenced runtime assets and discard unrelated captures and source", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, {
    "index.html": '<link rel="stylesheet" href="style.css"><script src="app.js"></script>',
    "style.css": 'body { background: url("image.svg") }',
    "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    "app.js": 'console.log("ready")',
    "scratch.png": "unused capture",
    "source.ts": "unused source",
  });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = {
    capturedAt: result.reportedAt,
    arms: Object.fromEntries(result.arms.map(({ label }) => [label, [{ page: "index.html", desktop: null, phone: null }]])),
    omitted: {},
  };
  await withArchiveCaptures(run, result, "index.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  for (const { label } of result.arms) {
    assert.deepEqual((await readdir(join(archive, "outputs", label))).sort(), ["app.js", "image.svg", "index.html", "style.css"]);
  }
  await cleanRun(run);
  assert.ok((await stat(join(run.runDir, "result.json"))).isFile());
  assert.ok((await stat(join(run.runDir, "frozen", "source"))).isDirectory());
});

test("archives follow import-map mappings to vendored modules", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, {
    "index.html": [
      '<script type="importmap">',
      '{"imports": {"three": "./vendor/three.module.js", "three/addons/": "./vendor/jsm/"}}',
      "</script>",
      '<script type="module" src="./src/main.js"></script>',
    ].join("\n"),
    "src/main.js": "import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n",
    "vendor/three.module.js": "export const Scene = 1;",
    "vendor/jsm/controls/OrbitControls.js": "import { Vector3 } from 'three';\nimport { helper } from '../utils/helper.js';\nexport class OrbitControls {}",
    "vendor/jsm/utils/helper.js": "export const helper = 1;",
    "vendor/jsm/unused/Other.js": "export const other = 1;",
  });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  await withArchiveCaptures(run, result, "index.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  for (const { label } of result.arms) {
    const output = join(archive, "outputs", label);
    assert.ok((await stat(join(output, "vendor/three.module.js"))).isFile());
    assert.ok((await stat(join(output, "vendor/jsm/controls/OrbitControls.js"))).isFile());
    assert.ok((await stat(join(output, "vendor/jsm/utils/helper.js"))).isFile());
    assert.equal(await stat(join(output, "vendor/jsm/unused/Other.js")).catch(() => null), null);
  }
});

test("archive refresh leaves the existing entry intact when a new capture is missing", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, {});
  for (const producerId of Object.keys(run.assignment.arms)) {
    const nested = join(run.tempDir, producerId, "source", "nested");
    await mkdir(nested);
    await writeFile(join(nested, "index.html"), "<h1>Final</h1>");
  }
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  await withArchiveCaptures(run, result, "nested/index.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  const before = await readFile(join(archive, "result.json"), "utf8");
  await cleanRun(run);
  await archiveRun(run, paths.archiveRoot);
  assert.equal(await readFile(join(archive, "outputs", result.arms[0]!.label, "nested/index.html"), "utf8"), "<h1>Final</h1>");
  result.shots = {
    capturedAt: result.reportedAt,
    arms: { [result.arms[0]!.label]: [{ page: "nested/index.html", desktop: "shots/missing.png", phone: null }] },
    omitted: {},
  };
  await writeJson(join(run.runDir, "result.json"), result);
  await assert.rejects(archiveRun(run, paths.archiveRoot), /ENOENT/);
  assert.equal(await readFile(join(archive, "result.json"), "utf8"), before);
  assert.deepEqual(await readdir(paths.archiveRoot), [basename(archive)]);
});

test("archives reject missing selected pages and development-server entrypoints", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, { "index.html": '<script type="module" src="/src/main.ts"></script>' });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, [{ page: "missing.html", desktop: null, phone: null }]])), omitted: {} };
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  await assert.rejects(archiveRun(run, paths.archiveRoot), /Selected final artifact is missing/);
  for (const shots of Object.values(result.shots.arms)) shots[0]!.page = "index.html";
  await writeJson(join(run.runDir, "result.json"), result);
  await assert.rejects(archiveRun(run, paths.archiveRoot), /needs a build/);
  assert.deepEqual(await readdir(paths.archiveRoot), []);
});

test("archives explicitly selected ignored builds and refreshes them after cleanup", async (t) => {
  const { run, paths } = await prepareFixture(t);
  for (const producerId of Object.keys(run.assignment.arms)) {
    await mkdir(join(run.tempDir, producerId, "source", "dist", "assets"), { recursive: true });
  }
  await materializeOutputs(run, {
    ".gitignore": "dist/\n",
    "index.html": '<script type="module" src="/src/main.ts"></script>',
    "dist/index.html": '<script type="module" src="./assets/app.js"></script>',
    "dist/assets/app.js": 'import "./chunk.js"; document.body.dataset.ready = "yes";',
    "dist/assets/chunk.js": 'console.log("ready")',
    "dist/unused.png": "unreferenced",
  });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, [
    { page: "Showcase", artifact: "index.html", desktop: null, phone: null },
  ]])), omitted: {} };
  await withArchiveCaptures(run, result, "index.html");
await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  await assert.rejects(archiveRun(run, paths.archiveRoot), /needs a build/);
  await assert.rejects(archiveRun(run, paths.archiveRoot, "../outside"), /leaves its folder/);
  await assert.rejects(archiveRun(run, paths.archiveRoot, "missing"), /Build directory is missing/);
  const archive = await archiveRun(run, paths.archiveRoot, "dist");
  for (const { label } of result.arms) {
    const output = join(archive, "outputs", label);
    assert.equal(await readFile(join(output, "index.html"), "utf8"), '<script type="module" src="./assets/app.js"></script>');
    assert.deepEqual((await readdir(join(output, "assets"))).sort(), ["app.js", "chunk.js"]);
    await assert.rejects(stat(join(output, "unused.png")), /ENOENT/);
  }
  await cleanRun(run);
  assert.equal(await archiveRun(run, paths.archiveRoot, "dist"), archive);
  assert.equal(await readFile(join(archive, "outputs", result.arms[0]!.label, "assets/chunk.js"), "utf8"), 'console.log("ready")');
});

test("archives root-relative HTML linked by a portable final page", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, {
    "explanation.html": '<a href="paper.html#finding">Read the source</a>',
    "paper.html": '<link rel="stylesheet" href="/assets/paper.css"><h1 id="finding">Source</h1>',
  });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, [
    { page: "Complete explainer", artifact: "explanation.html", desktop: null, phone: null },
  ]])), omitted: {} };
  await withArchiveCaptures(run, result, "explanation.html");
await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  for (const { label } of result.arms) {
    assert.deepEqual((await readdir(join(archive, "outputs", label))).sort(), ["explanation.html", "paper.html"]);
  }
});

test("archives preserve final code-only changes with an empty capture index", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, { "solution.py": "print(42)\n" });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, []])), omitted: {} };
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  for (const { label } of result.arms) assert.equal(await readFile(join(archive, "outputs", label, "solution.py"), "utf8"), "print(42)\n");
  await assert.rejects(stat(join(archive, "source")), /ENOENT/);
});

test("archives use actual artifacts independently of slide labels and URL fragments", async (t) => {
  const { run, root } = await prepareFixture(t);
  await materializeOutputs(run, { "deck.html": "<!doctype html><h1>A finished deck</h1>" });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = { capturedAt: new Date().toISOString(), omitted: {}, arms: Object.fromEntries(result.arms.map((arm) => [arm.label, [
    { page: "Opening slide", artifact: "deck.html", desktop: null, phone: null },
    { page: "Slide 4", artifact: "deck.html?mode=present#/4", desktop: null, phone: null },
  ]])) };
  await withArchiveCaptures(run, result, "deck.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const destination = await archiveRun(run, join(root, "archive"));
  for (const arm of result.arms) assert.deepEqual(await readdir(join(destination, "outputs", arm.label)), ["deck.html"]);
  assert.equal(await archiveRun(run, join(root, "archive")), destination);
  for (const shots of Object.values(result.shots.arms)) shots[0]!.artifact = "../outside.html";
  await writeJson(join(run.runDir, "result.json"), result);
  await assert.rejects(archiveRun(run, join(root, "archive")), /leaves its folder/);
});

test("visual archives require each arm's screenshot before publication", async (t) => {
  const { run, paths } = await prepareFixture(t);
  await materializeOutputs(run, { "index.html": "<h1>Finished scene</h1>" });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  await assert.rejects(archiveRun(run, paths.archiveRoot), /Visual output .* requires a representative screenshot/);
  assert.deepEqual(await readdir(paths.archiveRoot), []);
  await withArchiveCaptures(run, result);
  await writeJson(join(run.runDir, "result.json"), result);
  const archive = await archiveRun(run, paths.archiveRoot);
  for (const { label } of result.arms) assert.equal(await readFile(join(archive, "dependencies", "shots", label, "desktop.png"), "utf8"), "fixture capture");
});

const dandelion = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">'
  + '<style>body:after{content:"";position:fixed;inset:0}</style>  <script type="module" crossorigin src="./assets/index-8upa3DuJ.js"></script></head><body></body></html>';

test("archive reference scanning survives empty quoted strings before a script asset", () => {
  const references = localReferences(dandelion);
  assert.ok(references.includes("./assets/index-8upa3DuJ.js"), JSON.stringify(references));
  assert.ok(!references.some((reference) => reference.includes("crossorigin src=")), JSON.stringify(references));
});

test("an apostrophe in prose does not shift the pairing of double-quoted attribute values", () => {
  const references = localReferences("<p>Ada's notes</p><link rel=\"stylesheet\" href=\"style.css\"><img src=\"hero.png\" alt=\"Ada's dog\"><script src=\"app.js\"></script>");
  for (const expected of ["style.css", "hero.png", "app.js"]) assert.ok(references.includes(expected), `${expected} in ${JSON.stringify(references)}`);
});

test("module literals, CSS urls, and Markdown links are found; absolute URLs and fragments are not", () => {
  const references = localReferences([
    "import { a } from './lib/a.js';",
    'const img = new URL("./img/x.svg", import.meta.url);',
    "body { background: url(./bg.png) } a { background: url( 'tile.png' ) }",
    "[docs](notes/readme.md) [site](https://example.com) [top](#top)",
    'fetch("https://api.example.com/data"); location.hash = "#x"; src="/absolute.js"',
  ].join("\n"));
  for (const expected of ["./lib/a.js", "./img/x.svg", "./bg.png", "tile.png", "notes/readme.md"]) {
    assert.ok(references.includes(expected), `${expected} in ${JSON.stringify(references)}`);
  }
  for (const excluded of ["https://example.com", "https://api.example.com/data", "#top", "#x", "/absolute.js"]) {
    assert.ok(!references.includes(excluded), `${excluded} excluded from ${JSON.stringify(references)}`);
  }
});
