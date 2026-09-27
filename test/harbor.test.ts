import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarborSession } from "../src/harbor.js";
import { loadConfig, runtimeFor } from "../src/config.js";
import { prepareRun } from "../src/prepare.js";
import { tempDirectory } from "./support/files.js";

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

test("guest runtime defaults are explicit and legacy host execution is rejected", async (t) => {
  const root = await tempDirectory(t, "crucible-runtime-config-");
  const load = async (override: Record<string, unknown> = {}) => {
    const path = join(root, "experiment.json");
    await writeFile(path, JSON.stringify({
      name: "runtime test", source: { path: ".", include: ["*"] }, task: "Draw an SVG",
      producer: { agent: "claude" }, judge: "none", arms: [{}], ...override,
    }));
    return loadConfig(path);
  };
  const paths = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  assert.deepEqual(runtimeFor(await load()), { concurrency: 2, cpus: 2, memoryMb: 4096 });
  assert.deepEqual(runtimeFor(await load({ runtime: { concurrency: 1, memoryMb: 2048 } })), { concurrency: 1, cpus: 2, memoryMb: 2048 });
  await assert.rejects(load({ sandbox: false }), /no host execution fallback/);
  await assert.rejects(load({ runtime: { cpus: 0 } }), /positive integer/);
  await assert.rejects(load({ runtime: { concurrency: 1.5 } }), /positive integer/);
  await assert.rejects(load({ runtime: { backend: "host" } }), /runtime may only set/);
  await assert.rejects(load({ arms: [{ reuse: { run: "ab-12345678", arm: "old" }, task: "changed" }] }), /cannot be combined/);
  await assert.rejects(prepareRun({ ...await load(), nodeModules: "/host/node_modules" }, paths), /install dependencies with producer.setup/);
});
