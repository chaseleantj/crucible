import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { completionOutcome, startRun, stopRun } from "../src/runner.js";
import { readRunState, setRunState, updateJudge, updateProducer } from "../src/state.js";
import { prepareFixture } from "./support/run.js";

test("start refuses a run that is already marked running", async (t) => {
  const { run } = await prepareFixture(t);
  await setRunState(run.runDir, "running");
  await assert.rejects(startRun(run), /already marked running/);
  assert.equal((await readRunState(run.runDir)).state, "running");
});

test("stop marks agents whose runner died stopped, the judge included, instead of refusing", async (t) => {
  const { run } = await prepareFixture(t);
  const dead = spawnSync("/usr/bin/true").pid;
  const [first, second] = Object.keys(run.assignment.arms);
  const startedAt = new Date().toISOString();
  await setRunState(run.runDir, "running");
  await updateProducer(run.runDir, first!, { state: "running", pid: dead, processStartedAt: "gone", startedAt });
  await stopRun(run);
  let view = await readRunState(run.runDir);
  assert.equal(view.state, "stopped");
  assert.deepEqual([view.producers[first!]!.state, view.producers[second!]!.state], ["stopped", "stopped"], "a producer still waiting to start is stopped too");

  await setRunState(run.runDir, "produced");
  await updateJudge(run.runDir, { state: "running", pid: dead, processStartedAt: "gone", startedAt });
  await stopRun(run);
  view = await readRunState(run.runDir);
  assert.equal(view.judge?.state, "stopped");
  assert.equal(view.state, "produced", "stopping the judge leaves the outputs ready to judge again");
  await assert.rejects(stopRun(run), /No running producers or judge/);
});

test("a timed-out producer counts as complete only if it changed the source", () => {
  const failed = { succeeded: false, strayProcesses: false, terminalEvent: false, exitCode: null, signal: "SIGKILL" as const };
  assert.deepEqual(completionOutcome({ ...failed, timedOut: true }, true), { state: "complete", timedOut: true });
  const untouched = completionOutcome({ ...failed, timedOut: true }, false);
  assert.equal(untouched.state, "failed");
  assert.equal(untouched.error, "Producer timed out without changing the source");
  assert.deepEqual(completionOutcome({ succeeded: true, timedOut: false, strayProcesses: false, terminalEvent: true, exitCode: 0, signal: null }, false), { state: "complete" });
  const crash = completionOutcome({ ...failed, timedOut: false, terminalEvent: true, exitCode: 1, terminalSummary: "API error" }, false);
  assert.equal(crash.state, "failed");
  assert.equal(crash.error, "Producer exited with 1: API error");
});

test("kernel-confirmed OOM never counts as a completed or timed-out producer", () => {
  const result = {
    succeeded: true, timedOut: true, strayProcesses: false, terminalEvent: true,
    exitCode: 137, signal: null, memory: { limitBytes: 512 * 1024 ** 2, peakBytes: 513 * 1024 ** 2, oomKilled: true },
  };
  for (const changed of [false, true]) {
    const outcome = completionOutcome(result, changed);
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.timedOut, undefined);
    assert.match(outcome.error!, /out of memory.*limit 512 MiB, peak 513 MiB/);
  }
});
