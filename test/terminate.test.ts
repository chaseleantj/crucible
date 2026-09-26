import assert from "node:assert/strict";
import test from "node:test";
import { terminateProcessGroup } from "../src/agent.js";

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`kill ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = "kill";
  return error;
}

test("terminating a group we may not signal reports stray processes instead of throwing", async () => {
  // A sandboxed agent's group is visible but not ours to signal: kill returns
  // EPERM. That used to escape terminateProcessGroup and take the CLI down
  // whenever a producer or judge hit its timeout.
  const signals: Array<NodeJS.Signals | 0> = [];
  await terminateProcessGroup(4242, 10, (_target, signal) => {
    signals.push(signal);
    throw errno("EPERM");
  });
  assert.deepEqual(signals.slice(0, 1), ["SIGTERM"]);
  assert.equal(signals.at(-1), "SIGKILL");
});

test("terminating a group that is already gone stops after the first signal", async () => {
  const signals: Array<NodeJS.Signals | 0> = [];
  await terminateProcessGroup(4242, 5_000, (_target, signal) => {
    signals.push(signal);
    throw errno("ESRCH");
  });
  assert.deepEqual(signals, ["SIGTERM", 0]);
});

test("an unexpected kill failure still surfaces", async () => {
  await assert.rejects(
    terminateProcessGroup(4242, 10, () => { throw errno("EINVAL"); }),
    /EINVAL/,
  );
});
