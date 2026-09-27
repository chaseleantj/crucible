import assert from "node:assert/strict";
import test from "node:test";
import { adapterFor } from "../src/adapters.js";
import { createRunState, readRunState, resetJudge, resetProducer, setRunState, trackAgent, updateJudge, updateProducer } from "../src/state.js";
import { statusJson } from "../src/status.js";
import { tempDirectory } from "./support/files.js";
import { prepareFixture } from "./support/run.js";

test("late worker callbacks cannot overwrite a stopped producer, judge or run", async (t) => {
  const directory = await tempDirectory(t, "crucible-stopped-state-");
  await createRunState(directory, "ab-test", ["p-test"]);
  await setRunState(directory, "running");
  await resetJudge(directory);
  await updateProducer(directory, "p-test", { state: "stopped" });
  await updateJudge(directory, { state: "stopped" });
  await setRunState(directory, "stopped");
  await Promise.all([
    updateProducer(directory, "p-test", { state: "complete" }),
    updateJudge(directory, { state: "failed" }),
    setRunState(directory, "produced", "running"),
  ]);
  const stopped = await readRunState(directory);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.producers["p-test"]?.state, "stopped");
  assert.equal(stopped.judge?.state, "stopped");
  await resetProducer(directory, "p-test");
  await resetJudge(directory);
  await setRunState(directory, "running");
  await updateProducer(directory, "p-test", { state: "running" });
  assert.equal((await readRunState(directory)).producers["p-test"]?.state, "running", "explicit retry resets cancellation");
});

test("the judge's progress is tracked in state.json like a producer's, and a rerun starts its row afresh", async (t) => {
  const { run } = await prepareFixture(t);
  await resetJudge(run.runDir);
  const hooks = trackAgent(run.runDir, "j-test", (patch) => updateJudge(run.runDir, patch));
  await hooks.onStarted({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" });
  await hooks.onEvent({ time: "2026-01-01T00:00:01.000Z", producer: "j-test", kind: "tool.started", summary: "Read" });
  await hooks.onEvent({ time: "2026-01-01T00:00:02.000Z", producer: "j-test", kind: "agent.completed" });

  const judge = (await readRunState(run.runDir)).judge!;
  assert.equal(judge.state, "running");
  assert.equal(judge.pid, process.pid);
  assert.equal(judge.toolCalls, 1);
  assert.equal(judge.lastActivityAt, "2026-01-01T00:00:02.000Z");
  const status = JSON.parse(await statusJson(run)) as { judge: { state: string; toolCalls: number; timeoutSeconds: number } };
  assert.equal(status.judge.toolCalls, 1);
  assert.equal(status.judge.timeoutSeconds, run.config.judge!.timeoutMs / 1000);

  // The next `crucible judge` does not inherit this attempt's clock or count.
  await resetJudge(run.runDir);
  assert.deepEqual((await readRunState(run.runDir)).judge, { state: "ready", toolCalls: 0 });
});

test("Codex item lifecycle counts commands and edits once without counting messages or updates", async (t) => {
  const { run } = await prepareFixture(t);
  await resetJudge(run.runDir);
  const hooks = trackAgent(run.runDir, "j-test", (patch) => updateJudge(run.runDir, patch));
  const adapter = adapterFor("codex");
  // Codex CLI 0.153.4 event shapes captured from the presentation trial.
  const lines = [
    { type: "thread.started", thread_id: "thread-test" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Inspecting source" } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "pwd", aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.updated", item: { id: "item_1", type: "command_execution", command: "pwd", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "pwd", aggregated_output: "/tmp/source", exit_code: 0, status: "completed" } },
    { type: "item.started", item: { id: "item_2", type: "file_change", changes: [], status: "in_progress" } },
    { type: "item.completed", item: { id: "item_2", type: "file_change", changes: [], status: "completed" } },
    { type: "item.started", item: { id: "item_3", type: "command_execution", command: "false", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_3", type: "command_execution", command: "false", exit_code: 1, status: "failed" } },
    { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
  ];
  const events = lines.flatMap((line) => adapter.parseEvent(JSON.stringify(line), "j-test"));
  assert.equal(events.filter((event) => event.kind === "tool.started").length, 3);
  assert.equal(events.filter((event) => event.kind === "tool.finished").length, 3);
  assert.equal(events.filter((event) => event.kind === "agent.started").length, 2);
  assert.equal(events.find((event) => event.kind === "tool.started")?.nativeId, "item_1");
  assert.equal(events.at(-1)?.kind, "agent.completed");
  for (const event of events) await hooks.onEvent(event);
  assert.equal((await readRunState(run.runDir)).judge?.toolCalls, 3);
  assert.equal(JSON.parse(await statusJson(run)).judge.toolCalls, 3);
});
