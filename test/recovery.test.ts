import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { collectAgentOutput } from "../src/recovery.js";
import { tempDirectory } from "./support/files.js";

test("failed output and diagnosis survive workspace removal and later recoveries", async (t) => {
  const root = await tempDirectory(t);
  const directory = join(root, "workspace");
  const logs = join(root, "logs");
  const memory = { limitBytes: 512, peakBytes: 513, oomKilled: true };
  const session = { collect: async (path: string) => {
    assert.equal(path, "source");
    await mkdir(join(directory, "source"), { recursive: true });
    await writeFile(join(directory, "source", "partial.html"), "unfinished scene");
    await rm(join(directory, "source", "preview.html"), { force: true });
    await symlink("partial.html", join(directory, "source", "preview.html"));
  } };
  await collectAgentOutput(session, directory, logs, "source", { error: "out of memory", memory });
  await collectAgentOutput(session, directory, logs, "source", { error: "second failure", memory });
  await rm(directory, { recursive: true });
  const recoveries = await readdir(logs);
  assert.equal(recoveries.length, 2);
  for (const recovery of recoveries) {
    assert.equal(await readFile(join(logs, recovery, "output", "partial.html"), "utf8"), "unfinished scene");
    assert.equal(await readFile(join(logs, recovery, "output", "preview.html"), "utf8"), "unfinished scene");
    const failure = JSON.parse(await readFile(join(logs, recovery, "failure.json"), "utf8"));
    assert.equal(failure.collected, true);
    assert.deepEqual(failure.memory, memory);
  }
});

test("recovery retains the diagnosis when VM collection fails", async (t) => {
  const root = await tempDirectory(t);
  const session = { collect: async () => { throw new Error("VM unavailable"); } };
  const logs = join(root, "logs");
  await assert.rejects(collectAgentOutput(session, root, logs, "source", { error: "out of memory" }), /out of memory; partial output collection failed: VM unavailable/);
  const [recovery] = await readdir(logs);
  assert.deepEqual(JSON.parse(await readFile(join(logs, recovery!, "failure.json"), "utf8")), { error: "out of memory", collected: false, collectionError: "VM unavailable" });
});

test("judge recovery excludes runtime configuration and frozen inputs", async (t) => {
  const root = await tempDirectory(t);
  const directory = join(root, "judge");
  for (const path of [".runtime", ".context", "input", "shots"]) {
    await mkdir(join(directory, path), { recursive: true });
    await writeFile(join(directory, path, "file"), "content");
  }
  await writeFile(join(directory, "verdict.md"), "partial verdict");
  const logs = join(root, "logs");
  await collectAgentOutput({ collect: async () => {} }, directory, logs, ".", { error: "out of memory" });
  const [recovery] = await readdir(logs);
  assert.deepEqual((await readdir(join(logs, recovery!, "output"))).sort(), ["shots", "verdict.md"]);
});
