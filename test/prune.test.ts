import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathsConfig } from "../src/paths.js";
import { pruneCandidates, pruneRun } from "../src/prune.js";
import type { PathsConfig, RunState } from "../src/types.js";

async function roots(): Promise<PathsConfig> {
  const base = await mkdtemp(join(tmpdir(), "crucible-prune-"));
  return pathsConfig({
    CRUCIBLE_RUNS_ROOT: join(base, "runs"),
    CRUCIBLE_TEMP_ROOT: join(base, "temp"),
    CRUCIBLE_ARCHIVE_ROOT: join(base, "archive"),
  });
}

interface FakeRun {
  runId: string;
  state: RunState;
  ageDays?: number;
  archived?: boolean;
}

async function writeRun(paths: PathsConfig, { runId, state, ageDays = 0, archived = false }: FakeRun): Promise<void> {
  const runDir = join(paths.runRoot, runId);
  const tempDir = join(paths.tempRoot, runId);
  const createdAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  await mkdir(runDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({ runId, tempDir }));
  await writeFile(join(runDir, "resolved-config.json"), JSON.stringify({ name: `Experiment ${runId}`, arms: [{}, {}] }));
  await writeFile(join(runDir, "state.json"), JSON.stringify({ runId, state, createdAt, updatedAt: createdAt, producers: {} }));
  await writeFile(join(tempDir, "workspace.txt"), "x".repeat(1024));
  if (!archived) return;
  const entry = join(paths.archiveRoot, runId);
  await mkdir(entry, { recursive: true });
  await writeFile(join(entry, "result.json"), JSON.stringify({ runId }));
}

test("prune takes archived finished runs and leaves everything else alone", async () => {
  const paths = await roots();
  await writeRun(paths, { runId: "ab-00000001", state: "reported", archived: true });
  await writeRun(paths, { runId: "ab-00000002", state: "reported" });
  await writeRun(paths, { runId: "ab-00000003", state: "running", archived: true });
  await writeRun(paths, { runId: "ab-00000004", state: "prepared" });

  const candidates = await pruneCandidates(undefined, paths);
  assert.deepEqual(candidates.map((candidate) => candidate.runId), ["ab-00000001"]);
  assert.equal(candidates[0]!.archived, true);
  assert.ok(candidates[0]!.bytes >= 1024, `${candidates[0]!.bytes} bytes counted`);

  // A dry run only reads: nothing is removed until pruneRun is called.
  for (const runId of ["ab-00000001", "ab-00000002", "ab-00000003", "ab-00000004"]) {
    assert.ok(existsSync(join(paths.runRoot, runId)), `${runId} still present`);
    assert.ok(existsSync(join(paths.tempRoot, runId)), `${runId} workspace still present`);
  }

  await pruneRun(candidates[0]!);
  assert.equal(existsSync(join(paths.runRoot, "ab-00000001")), false);
  assert.equal(existsSync(join(paths.tempRoot, "ab-00000001")), false);
  assert.ok(existsSync(join(paths.archiveRoot, "ab-00000001")), "the archive is never touched");
  for (const runId of ["ab-00000002", "ab-00000003", "ab-00000004"]) {
    assert.ok(existsSync(join(paths.runRoot, runId)), `${runId} kept`);
  }
});

test("--older-than also takes finished unarchived runs past the cutoff", async () => {
  const paths = await roots();
  await writeRun(paths, { runId: "ab-00000005", state: "judged", ageDays: 40 });
  await writeRun(paths, { runId: "ab-00000006", state: "reported", ageDays: 3 });
  await writeRun(paths, { runId: "ab-00000007", state: "failed", ageDays: 40 });

  assert.deepEqual((await pruneCandidates(30, paths)).map((candidate) => candidate.runId), ["ab-00000005"]);
});

test("prune leaves a finished run alone while its judge is at work again", async () => {
  const paths = await roots();
  await writeRun(paths, { runId: "ab-00000008", state: "judged", archived: true });
  const stateFile = join(paths.runRoot, "ab-00000008", "state.json");
  const view = JSON.parse(await readFile(stateFile, "utf8"));
  view.judge = { state: "running", toolCalls: 0, pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(stateFile, JSON.stringify(view));
  assert.deepEqual(await pruneCandidates(undefined, paths), []);
});
