import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runSetup, type SetupOptions } from "../src/agent.js";
import { recordBaseline, withholdNonArmFiles } from "../src/baseline.js";
import { copyTree } from "../src/files.js";
import { statusJson } from "../src/status.js";
import { prepareFixture } from "./support/run.js";

/** Execute setup locally only in this test double; production always delegates to Harbor. */
function localSetupSession(directory: string): SetupOptions["session"] {
  return {
    execute: async (request: Parameters<SetupOptions["session"]["execute"]>[0]) => {
      assert.equal(request.cwd, "/workspace/source");
      const result = spawnSync(request.command, request.args, {
        cwd: join(directory, "source"), env: request.env, encoding: "utf8", timeout: request.timeoutMs,
      });
      return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: result.error?.message.includes("ETIMEDOUT") ?? false };
    },
  } as SetupOptions["session"];
}

test("setup runs in the project, the shared command first, and a non-zero exit fails the arm", async (t) => {
  const { run } = await prepareFixture(t);
  const producerId = Object.keys(run.assignment.arms)[0]!;
  const producerDir = join(run.tempDir, producerId);
  await copyTree(join(run.runDir, "frozen", "source"), join(producerDir, "source"));
  const logDir = join(run.runDir, "producers", producerId);
  const setup = (commands: string[]) => runSetup({
    run,
    session: localSetupSession(producerDir),
    id: producerId,
    directory: producerDir,
    cwd: join(producerDir, "source"),
    runtimeDir: join(producerDir, ".runtime"),
    logDir,
    config: { agent: "claude", timeoutMs: 10_000, setup: commands },
  });

  // The shared command comes first, the arm's own second, and both are in the log.
  // The paths are relative, so they only land if setup ran inside source/.
  assert.equal(await setup(["echo shared > deps.txt", "echo built > graph.txt && echo done"]), null);
  assert.match(await readFile(join(producerDir, "source", "deps.txt"), "utf8"), /shared/);
  assert.match(await readFile(join(producerDir, "source", "graph.txt"), "utf8"), /built/);
  const log = await readFile(join(logDir, "setup.log"), "utf8");
  assert.match(log, /\$ echo shared > deps.txt/);
  assert.match(log, /\$ echo built > graph.txt && echo done\ndone/);
  // The first failure stops the rest, and the log names the command that failed.
  assert.match(await setup(["exit 3", "echo never > never.txt"]) ?? "", /Setup command failed with 3: exit 3/);
  assert.equal(await readFile(join(logDir, "setup.log"), "utf8"), "$ exit 3\n");
  await assert.rejects(stat(join(producerDir, "source", "never.txt")), /ENOENT/);
  assert.equal(await setup([]), null);
});

test("an arm's changes are measured from after its setup, and the judge sees the project as it was frozen", async (t) => {
  const { run, root } = await prepareFixture(t);
  const [first, second] = Object.keys(run.assignment.arms) as [string, string];
  for (const producerId of [first, second]) {
    const producerDir = join(run.tempDir, producerId);
    await copyTree(join(run.runDir, "frozen", "source"), join(producerDir, "source"));
    // The tool's own installation: a file of its own, and its section in CLAUDE.md.
    assert.equal(await runSetup({
      run,
    session: localSetupSession(producerDir),
      id: producerId,
      directory: producerDir,
      cwd: join(producerDir, "source"),
      runtimeDir: join(producerDir, ".runtime"),
      logDir: join(run.runDir, "producers", producerId),
      config: {
        agent: "claude",
        timeoutMs: 10_000,
        setup: ["mkdir -p graphify-out .claude && echo graph > graphify-out/graph.txt && echo '{}' > .claude/settings.json && echo '# Graphify' >> CLAUDE.md"],
      },
    }), null);
    await recordBaseline(run, producerId);
    // What the arm itself did, and what the tool wrote into its own folder while the arm worked.
    await writeFile(join(producerDir, "source", "page.html"), "<h1>arm</h1>\n");
    await writeFile(join(producerDir, "source", "graphify-out", "stamp"), "1\n");
  }

  // Only the arm's own file counts as its work.
  const status = JSON.parse(await statusJson(run)) as { producers: Record<string, { changedFiles: number }> };
  for (const producerId of [first, second]) assert.equal(status.producers[producerId]!.changedFiles, 1);

  // The judge's copy keeps the arm's work and loses the tool's installation.
  const copy = join(root, "judge-input", "A");
  await copyTree(join(run.tempDir, first, "source"), copy);
  assert.equal(await withholdNonArmFiles(run.runDir, first, copy), 2);
  assert.equal(await readFile(join(copy, "page.html"), "utf8"), "<h1>arm</h1>\n");
  // The tool's folder goes whole, stamp included, and its agent configuration was never copied.
  await assert.rejects(stat(join(copy, "graphify-out")), /ENOENT/);
  await assert.rejects(stat(join(copy, ".claude")), /ENOENT/);
  await assert.rejects(stat(join(copy, "CLAUDE.md")), /ENOENT/);
});
