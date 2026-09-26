import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { copyTree } from "../src/files.js";
import { DeleteError, copiedRunIssues, deleteEach, deleteEntries, entryIssues, readArchive, resultIssues, scanExperiments, storeRoots } from "../src/store.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function judged(runId: string, series: string | null, winner: string, totals: Record<string, number>, reportedAt: string) {
  const labels = Object.keys(totals);
  return {
    runId, name: `Question ${series ?? runId}`, series, task: "Write a page.", reportedAt, environment: "clean",
    arms: labels.map((label) => ({ label, candidate: null, replaces: null })),
    producers: Object.fromEntries(labels.map((label) => [label, { agent: "claude", model: null, effort: null }])),
    cost: {}, warnings: [], shots: null,
    judgeAgent: { agent: "claude", model: null, effort: null }, winner, confidence: 0.7, totals, margin: 1,
    scores: [{ criterion: "clarity", weight: 1, scores: totals }],
    referenceGuess: { arm: null, confidence: 0.5, correct: null }, summary: "One was clearer.",
  };
}

async function archive(root: string, name: string, result: unknown, outputs: Record<string, Record<string, string | Buffer>> = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "README.md"), `# ${name}\n\nThe ${name} run.\n`);
  await writeFile(join(dir, "report.html"), "<p>report</p>");
  if (result !== undefined) await writeFile(join(dir, "result.json"), JSON.stringify(result));
  for (const [label, files] of Object.entries(outputs)) {
    for (const [file, content] of Object.entries(files)) {
      await mkdir(join(dir, "outputs", label, file, ".."), { recursive: true });
      await writeFile(join(dir, "outputs", label, file), content);
    }
  }
  return dir;
}

async function runRecord(root: string, runId: string, state: string, producer: Record<string, unknown>, judge?: Record<string, unknown>) {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(dir, "state.json"), JSON.stringify({ runId, state, createdAt: now, updatedAt: now, producers: { p1: producer }, ...(judge ? { judge } : {}) }));
  await writeFile(join(dir, "resolved-config.json"), JSON.stringify({
    name: `Run ${runId}`, arms: [{ label: "a" }], producer: { timeoutMs: 60_000 }, judge: { timeoutMs: 60_000 },
  }));
  return dir;
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "crucible-store-"));
  const archiveRoot = join(base, "archive");
  const runsRoot = join(base, "runs");
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(archiveRoot, "README.md"), "# Archive\n\nEvery **finished** run.\n");
  await archive(archiveRoot, "first", judged("ab-00000001", "pages", "a", { a: 8, b: 6 }, "2026-01-01T00:00:00Z"),
    { a: { "index.html": "<p>a</p>", "preview.png": PNG }, b: { "answer.md": "a", "notes.md": "n" } });
  await archive(archiveRoot, "second", judged("ab-00000002", "pages", "b", { a: 7, b: 9 }, "2026-02-01T00:00:00Z"));
  await archive(archiveRoot, "third", judged("ab-00000003", "pages", "a", { a: 9, b: 5 }, "2026-03-01T00:00:00Z"));
  await archive(archiveRoot, "unjudged", { ...judged("ab-00000004", null, "a", { a: 1 }, "2026-04-01T00:00:00Z"), judged: false });
  await archive(archiveRoot, "legacy", { legacy: true });
  await archive(archiveRoot, "broken", { runId: "ab-00000005" });
  await runRecord(runsRoot, "ab-00000001", "reported", { state: "complete", toolCalls: 3 });
  await runRecord(runsRoot, "ab-00000006", "running", {
    state: "running", toolCalls: 1, pid: process.pid, startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
  });
  await runRecord(runsRoot, "ab-00000007", "failed", { state: "failed", toolCalls: 0, error: "boom" });
  await runRecord(runsRoot, "ab-00000008", "some-old-state", { state: "complete", toolCalls: 0 });
  return { base, archiveRoot, runsRoot };
}

test("a series whose judged runs pick different winners is split; the higher mean still leads", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "crucible-store-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const archiveRoot = join(base, "archive");
  await archive(archiveRoot, "first", judged("ab-00000011", "split", "a", { a: 9, b: 6 }, "2026-01-01T00:00:00Z"));
  await archive(archiveRoot, "second", judged("ab-00000012", "split", "b", { a: 7, b: 8 }, "2026-02-01T00:00:00Z"));
  const [question] = scanExperiments({ archiveRoot, runsRoot: join(base, "runs") }).questions;
  assert.deepEqual(question!.tally, { a: 1, b: 1, tie: 0 });
  assert.equal(question!.winner, "a");
  assert.equal(question!.split, true);
});

test("a series of one-arm runs counts no wins and goes to the higher mean total", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "crucible-store-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const archiveRoot = join(base, "archive");
  const solo = (runId: string, label: string, total: number, at: string) => ({ ...judged(runId, "solo", label, { [label]: total }, at), margin: null, referenceGuess: null });
  await archive(archiveRoot, "claude", solo("ab-00000021", "claude", 8.9, "2026-01-01T00:00:00Z"));
  await archive(archiveRoot, "codex", solo("ab-00000022", "codex", 9.4, "2026-02-01T00:00:00Z"));
  await archive(archiveRoot, "cursor", solo("ab-00000023", "cursor", 9.1, "2026-03-01T00:00:00Z"));
  const [question] = scanExperiments({ archiveRoot, runsRoot: join(base, "runs") }).questions;
  assert.deepEqual(question!.arms, ["cursor", "codex", "claude"], "every run's arm stays in the question, newest first");
  assert.deepEqual(question!.tally, { cursor: 0, codex: 0, claude: 0, tie: 0 });
  assert.equal(question!.winner, "codex");
  assert.equal(question!.split, false);
  await archive(archiveRoot, "codex-again", solo("ab-00000024", "codex", 8.9, "2026-04-01T00:00:00Z"));
  await archive(archiveRoot, "cursor-again", solo("ab-00000025", "cursor", 9.2, "2026-05-01T00:00:00Z"));
  const [even] = scanExperiments({ archiveRoot, runsRoot: join(base, "runs") }).questions;
  assert.equal(even!.winner, "tie", "an even mean total is a tie");
});

test("scanExperiments groups archived runs into questions and splits live runs", async (t) => {
  const { base, archiveRoot, runsRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const scan = scanExperiments({ archiveRoot, runsRoot });
  assert.equal(scan.root, archiveRoot);
  assert.equal(scan.blurb, "Every finished run.");

  assert.deepEqual(scan.questions.map((question) => question.title), ["Question ab-00000004", "Question pages"]);
  const pages = scan.questions[1]!;
  assert.deepEqual(pages.runs.map((run) => run.name), ["third", "second", "first"]);
  assert.deepEqual(pages.tally, { a: 2, b: 1, tie: 0 });
  assert.deepEqual(pages.meanTotals, { a: 8, b: 6.67 });
  assert.equal(pages.winner, "a");
  assert.equal(pages.split, false, "two wins of three is a majority");
  assert.equal(scan.questions[0]!.winner, null, "an unjudged question has no verdict");

  const first = pages.runs[2]!;
  assert.equal(first.cover, join(archiveRoot, "first", "outputs", "a", "preview.png"));
  assert.equal(first.outputs.a, join(archiveRoot, "first", "outputs", "a", "index.html"));
  assert.equal(first.outputs.b, join(archiveRoot, "first", "outputs", "b", "answer.md"), "notes lose to any other document");

  assert.deepEqual(scan.reportsOnly.map((test) => test.name).sort(), ["broken", "legacy"]);
  assert.ok(scan.reportsOnly.find((test) => test.name === "broken")!.issues.includes("result.json has invalid name"));

  // The archived run's record is already a result; the rest are live.
  assert.deepEqual(scan.live.inFlight.map((run) => run.runId), ["ab-00000006"]);
  assert.equal(scan.live.inFlight[0]!.producers[0]!.health, "working");
  assert.equal(scan.live.inFlight[0]!.deletable, false);
  assert.deepEqual(scan.live.unfinished.map((run) => [run.runId, run.phase]).sort(), [["ab-00000007", "failed"], ["ab-00000008", "failed"]]);
});

test("readArchive rejects captures that leave the archive", async (t) => {
  const { base, archiveRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = judged("ab-00000009", null, "a", { a: 5, b: 4 }, "2026-05-01T00:00:00Z");
  const dir = await archive(archiveRoot, "escaping", { ...result, shots: { arms: { a: [{ page: "index.html", desktop: "../../x.png", phone: null }] } } });
  const read = readArchive(dir);
  assert.equal(read.result?.runId, "ab-00000009");
  assert.deepEqual(read.issues, ["a desktop: missing, unsupported, or outside this archive: ../../x.png"]);
});

test("readArchive lists every HTML page an arm produced, the captured one first", async (t) => {
  const { base, archiveRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = judged("ab-00000010", null, "a", { a: 5, b: 4 }, "2026-05-01T00:00:00Z");
  const shots = { arms: { a: [{ page: "Slide 4", artifact: "talk.html#/4", desktop: null, phone: null }] } };
  const dir = await archive(archiveRoot, "pages", { ...result, shots }, {
    a: { "index.html": "<p>", "talk.html": "<p>", "docs/guide.htm": "<p>", "notes.md": "#", "node_modules/x/index.html": "<p>", ".cache/y.html": "<p>" },
    b: { "answer.md": "#" },
  });
  await symlink(join(base, "outside.html"), join(dir, "outputs", "a", "linked.html"));
  await writeFile(join(base, "outside.html"), "<p>");
  const read = readArchive(dir);
  assert.equal(read.outputs.a, join(dir, "outputs", "a", "talk.html"), "a captured artifact names the output, fragment and all");
  assert.deepEqual(read.pages, { a: ["talk.html", "docs/guide.htm", "index.html"], b: [] });
});

test("readArchive opens an SVG arm as its output and a live page", async (t) => {
  const { base, archiveRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = judged("ab-00000011", null, "a", { a: 5, b: 4 }, "2026-05-01T00:00:00Z");
  const shots = { arms: { a: [{ page: "Icon", artifact: "cup.svg", desktop: null, phone: null }] } };
  const dir = await archive(archiveRoot, "svg", { ...result, shots }, {
    a: { "cup.svg": "<svg/>", "notes.md": "#" },
    b: { "icon.svg": "<svg/>" },
  });
  const read = readArchive(dir);
  assert.equal(read.outputs.a, join(dir, "outputs", "a", "cup.svg"), "a captured SVG is the output");
  assert.equal(read.outputs.b, join(dir, "outputs", "b", "icon.svg"), "an uncaptured SVG still beats nothing");
  assert.deepEqual(read.pages, { a: ["cup.svg"], b: ["icon.svg"] });
});

test("resultIssues accepts a one-arm run without a reference guess", () => {
  const result = { ...judged("ab-0000000a", null, "a", { a: 5 }, "2026-05-01T00:00:00Z"), margin: null, referenceGuess: null };
  assert.deepEqual(resultIssues(result), []);
  assert.deepEqual(resultIssues([]), ["result.json must contain an object"]);
});

test("entryIssues and copiedRunIssues require a screenshot for visual output", async (t) => {
  const { base, archiveRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.deepEqual(entryIssues(join(archiveRoot, "first")), []);
  const dir = await archive(archiveRoot, "unpictured", judged("ab-0000000b", null, "a", { a: 5, b: 4 }, "2026-05-01T00:00:00Z"),
    { a: { "index.html": "<p>a</p>" } });
  await writeFile(join(dir, "stray.txt"), "x");
  assert.deepEqual(entryIssues(dir), [
    "Unexpected entry: stray.txt",
    "Visual output a requires a representative screenshot in result.json shots.arms or dependencies/shots/a/",
  ]);
  assert.deepEqual(copiedRunIssues(dir, "copies/unpictured"), [
    "Visual output a of copies/unpictured requires a representative screenshot in result.json shots.arms or dependencies/shots/a/",
  ]);
  assert.deepEqual(entryIssues(join(archiveRoot, "missing")), ["Entry is not a directory"]);
});

test("entryIssues accepts a visual arm whose every capture says why it has no picture", async (t) => {
  const { base, archiveRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const broken = (error: string) => ({ page: "Initial view", artifact: "index.html", desktop: null, phone: null, error });
  const result = (shots: unknown[]) => ({ ...judged("ab-0000000c", null, "a", { a: 1 }, "2026-05-01T00:00:00Z"), margin: null, referenceGuess: null, shots: { arms: { a: shots } } });
  const explained = await archive(archiveRoot, "broken", result([broken("THREE.OrbitControls is not a constructor"), broken("Same error")]),
    { a: { "index.html": "<p>a</p>" } });
  assert.deepEqual(entryIssues(explained), []);
  const partly = await archive(archiveRoot, "partly", result([broken("Blank"), { page: "After drag", artifact: "index.html", desktop: null, phone: null }]),
    { a: { "index.html": "<p>a</p>" } });
  assert.deepEqual(entryIssues(partly), ["Visual output a requires a representative screenshot in result.json shots.arms or dependencies/shots/a/"]);
});

test("entryIssues, copiedRunIssues, and copyTree ignore macOS metadata", async (t) => {
  const { base, archiveRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(archiveRoot, "first");
  await mkdir(join(dir, "outputs", "a"), { recursive: true });
  for (const junk of [".DS_Store", "outputs/.DS_Store", "outputs/a/.DS_Store", "outputs/a/._index.png", "._README.md"]) {
    await writeFile(join(dir, junk), "x");
  }
  assert.deepEqual(entryIssues(dir), []);
  assert.deepEqual(copiedRunIssues(dir), []);
  const copy = join(base, "copy");
  await copyTree(dir, copy);
  assert.equal(existsSync(join(copy, "outputs", "a", ".DS_Store")), false);
  assert.equal(existsSync(join(copy, "outputs", "a", "._index.png")), false);
  assert.equal(existsSync(join(copy, "result.json")), true);
});

test("deleteEntries removes an archive with its run record and refuses anything else", async (t) => {
  const { base, archiveRoot, runsRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = { archiveRoot, runsRoot };
  const refused = (paths: string[], reason: DeleteError["reason"]) =>
    assert.throws(() => deleteEntries(roots, paths), (error: unknown) => error instanceof DeleteError && error.reason === reason);

  refused([], "invalid");
  refused(["relative/path"], "invalid");
  refused([archiveRoot], "unavailable");
  refused([join(runsRoot, "ab-00000006")], "active");
  refused([base], "unavailable");

  const linked = join(base, "elsewhere");
  await mkdir(linked);
  await writeFile(join(linked, "result.json"), "{}");
  await symlink(linked, join(archiveRoot, "linked"));
  refused([join(archiveRoot, "linked")], "link");
  assert.ok(existsSync(join(linked, "result.json")));

  const deleted = deleteEntries(roots, [join(archiveRoot, "first")]);
  assert.deepEqual(deleted, [join(archiveRoot, "first"), join(runsRoot, "ab-00000001")]);
  assert.ok(!existsSync(join(archiveRoot, "first")) && !existsSync(join(runsRoot, "ab-00000001")));
  assert.deepEqual(deleteEntries(roots, [join(runsRoot, "ab-00000007")]), [join(runsRoot, "ab-00000007")]);
});

test("deleteEntries refuses an archive whose run still has an agent at work", async (t) => {
  const { base, archiveRoot, runsRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = await archive(archiveRoot, "busy", judged("ab-00000006", null, "a", { a: 5, b: 4 }, "2026-05-01T00:00:00Z"));
  assert.throws(() => deleteEntries({ archiveRoot, runsRoot }, [dir]), (error: unknown) => error instanceof DeleteError && error.reason === "active");
  assert.ok(existsSync(dir));
});

test("deleteEach deletes each selection whole or not at all, reads the store once, and a dry run removes nothing", async (t) => {
  const { base, archiveRoot, runsRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = { archiveRoot, runsRoot };
  const busy = await archive(archiveRoot, "busy", judged("ab-00000006", null, "a", { a: 5, b: 4 }, "2026-05-01T00:00:00Z"));
  const first = join(archiveRoot, "first");
  const second = join(archiveRoot, "second");
  // Two archived copies of one run share its record; the second finds it gone and goes ahead.
  const copy = await archive(archiveRoot, "first-copy", judged("ab-00000001", "pages", "a", { a: 8, b: 6 }, "2026-01-02T00:00:00Z"));
  const selections = [[first], [busy, second], [join(base, "nowhere")], [copy]];

  const planned = deleteEach(roots, selections, { dryRun: true });
  assert.deepEqual(planned[0], { deleted: [first, join(runsRoot, "ab-00000001")] });
  assert.ok("error" in planned[1]! && planned[1].error.reason === "active", "one busy run keeps its whole selection");
  assert.ok("error" in planned[2]! && planned[2].error.reason === "unavailable");
  assert.ok(existsSync(first) && existsSync(join(runsRoot, "ab-00000001")));

  const outcomes = deleteEach(roots, selections);
  assert.deepEqual(outcomes.map((outcome) => ("error" in outcome ? outcome.error.reason : "deleted")), ["deleted", "active", "unavailable", "deleted"]);
  assert.deepEqual(outcomes[3], { deleted: [copy] });
  assert.ok(!existsSync(first) && !existsSync(copy) && existsSync(busy) && existsSync(second));
});

test("storeRoots resolves the roots as the CLI does: environment, then config file, then defaults", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "crucible-roots-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const config = join(base, "config.yaml");
  await writeFile(config, "archiveRoot: ./results\nrunsRoot: /tmp/crucible-roots-runs\n");
  assert.deepEqual(storeRoots({ CRUCIBLE_CONFIG: config }), { archiveRoot: join(base, "results"), runsRoot: "/tmp/crucible-roots-runs" });
  assert.deepEqual(storeRoots({ CRUCIBLE_CONFIG: config, CRUCIBLE_ARCHIVE_ROOT: "/tmp/crucible-roots-archive" }),
    { archiveRoot: "/tmp/crucible-roots-archive", runsRoot: "/tmp/crucible-roots-runs" });
  assert.deepEqual(storeRoots({ CRUCIBLE_CONFIG: join(base, "missing.yaml") }),
    { archiveRoot: join(homedir(), ".crucible", "archive"), runsRoot: join(homedir(), ".crucible", "runs") });
});

test("a run is in flight only while an agent is really at work, and deletable otherwise", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "crucible-live-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const archiveRoot = join(base, "archive");
  const runsRoot = join(base, "runs");
  const dead = spawnSync("/usr/bin/true").pid;
  const now = new Date().toISOString();
  const running = (pid: number) => ({ state: "running", toolCalls: 0, pid, startedAt: now, lastActivityAt: now });
  const complete = { state: "complete", toolCalls: 0 };
  await runRecord(runsRoot, "ab-prepared", "prepared", { state: "ready", toolCalls: 0 });
  await runRecord(runsRoot, "ab-starting", "running", { state: "ready", toolCalls: 0 });
  await runRecord(runsRoot, "ab-crashed", "running", running(dead));
  await runRecord(runsRoot, "ab-judge-crashed", "produced", complete, running(dead));
  await runRecord(runsRoot, "ab-judge-failed-early", "produced", complete, { state: "ready", toolCalls: 0 });
  await runRecord(runsRoot, "ab-judging", "produced", complete, running(process.pid));

  const { live } = scanExperiments({ archiveRoot, runsRoot });
  const phases = (runs: typeof live.inFlight) => Object.fromEntries(runs.map((run) => [run.runId, [run.phase, run.deletable]]));
  assert.deepEqual(phases(live.inFlight), { "ab-starting": ["producing", false], "ab-judging": ["judging", false] });
  assert.deepEqual(phases(live.unfinished), {
    "ab-prepared": ["prepared, not started", true],
    "ab-crashed": ["interrupted", true],
    "ab-judge-crashed": ["produced, not judged", true],
    "ab-judge-failed-early": ["produced, not judged", true],
  });
  const roots = { archiveRoot, runsRoot };
  assert.deepEqual(deleteEntries(roots, [join(runsRoot, "ab-prepared"), join(runsRoot, "ab-judge-crashed")]),
    [join(runsRoot, "ab-prepared"), join(runsRoot, "ab-judge-crashed")]);
  assert.throws(() => deleteEntries(roots, [join(runsRoot, "ab-judging")]), (error: unknown) => error instanceof DeleteError && error.reason === "active");
});

test("each question has a key of its own: its series or run ID, told apart only on collision", async (t) => {
  const { base, archiveRoot, runsRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const keys = () => scanExperiments({ archiveRoot, runsRoot }).questions.map((question) => question.key).sort();
  assert.deepEqual(keys(), ["ab-00000004", "pages"]);
  await archive(archiveRoot, "copy", { ...judged("ab-00000004", null, "a", { a: 1 }, "2026-04-01T00:00:00Z"), judged: false });
  await archive(archiveRoot, "named-like-a-series", judged("pages", null, "a", { a: 2, b: 1 }, "2026-06-01T00:00:00Z"));
  assert.deepEqual(keys(), ["ab-00000004@copy", "ab-00000004@unjudged", "pages", "pages@named-like-a-series"]);
});

test("deleteEntries resolves its roots once, so a relative runs root still finds its records", async (t) => {
  const { base, archiveRoot, runsRoot } = await fixture();
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = { archiveRoot: relative(process.cwd(), archiveRoot), runsRoot: relative(process.cwd(), runsRoot) };
  assert.deepEqual(deleteEntries(roots, [join(runsRoot, "ab-00000007")]), [join(runsRoot, "ab-00000007")]);
  assert.deepEqual(deleteEntries(roots, [join(archiveRoot, "first")]), [join(archiveRoot, "first"), join(runsRoot, "ab-00000001")]);
});
