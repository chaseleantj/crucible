import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { loadConfig } from "../../src/config.js";
import { copyTree } from "../../src/files.js";
import { writeJson } from "../../src/json.js";
import { prepareRun } from "../../src/prepare.js";
import { setRunState } from "../../src/state.js";
import type { PathsConfig, ResolvedRun } from "../../src/types.js";
import { tempDirectory } from "./files.js";
import { materializeOutputs } from "./run.js";

/** A prepared run whose experiment asks for no judge; two arms unless the caller names its own. */
export async function prepareUnjudged(
  t: TestContext,
  outputs: Record<string, string> | ((label: string) => Record<string, string>),
  arms = "[{label: plain}, {label: fancy, producer: {effort: high}}]",
): Promise<{ run: ResolvedRun; paths: PathsConfig; root: string }> {
  const root = await tempDirectory(t, "crucible-no-judge-");
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  // What an arm that asks for realistic mode reads: an empty skills root beside crafts and styles.
  for (const name of ["no-skills", "crafts", "styles"]) await mkdir(join(root, name));
  await writeFile(join(root, "experiment.yaml"), [
    "name: no judge",
    "series: skip-judge",
    `arms: ${arms}`,
    "source: {path: ./project, include: ['*']}",
    "task: build something",
    "producer: {agent: claude}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: none",
  ].join("\n"));
  const run = await prepareRun(await loadConfig(join(root, "experiment.yaml")), paths);
  await materializeOutputs(run, outputs);
  for (const producerId of Object.keys(run.assignment.arms)) {
    // What `crucible start` materializes, so an audit sees the frozen context.
    await copyTree(join(run.runDir, "frozen", producerId, "context"), join(run.tempDir, producerId, ".context"));
    await mkdir(join(run.runDir, "producers", producerId), { recursive: true });
  }
  await writeJson(join(run.runDir, "audit", "report.json"), {
    runId: run.runId, auditedAt: "2026-09-04T00:00:00.000Z", contextChanges: {}, leakFindings: {}, warnings: [],
  });
  await setRunState(run.runDir, "produced");
  return { run, paths, root };
}
