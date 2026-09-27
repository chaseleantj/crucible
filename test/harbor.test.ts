import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { HarborSession } from "../src/harbor.js";

test("Harbor drains asynchronous native-event handlers before command completion", async () => {
  const child = spawn(process.execPath, ["-e", `
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const {id} = JSON.parse(line);
      console.log(JSON.stringify({id,event:'stdout',data:'first'}));
      console.log(JSON.stringify({id,event:'stdout',data:'second'}));
      console.log(JSON.stringify({id,result:{code:0,stdout:'firstsecond',stderr:'',timedOut:false}}));
    });
  `], { stdio: "pipe" });
  const session = new HarborSession(child);
  const observed: string[] = [];
  try {
    const result = await session.execute({ command: "ignored", onStdout: async (chunk) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed.push(chunk);
    } });
    assert.deepEqual(observed, ["first", "second"]);
    assert.equal(result.stdout, "firstsecond");
  } finally { await session.close(); }
});

test("Harbor process failure rejects pending commands without an unhandled stdin error", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(7))"], { stdio: "pipe" });
  const session = new HarborSession(child);
  await assert.rejects(session.execute({ command: "ignored" }), /exited \(7\)/);
  await assert.rejects(session.close(), /exited \(7\)/);
});

test("Harbor abort terminates the worker and rejects the active command", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: "pipe" });
  const session = new HarborSession(child);
  const abort = new AbortController();
  const execution = session.execute({ command: "ignored", signal: abort.signal });
  abort.abort();
  await assert.rejects(execution, /Harbor worker exited/);
  await assert.rejects(session.close(), /Harbor worker exited/);
});
