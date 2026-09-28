import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { recordBaseline } from "../../src/baseline.js";
import { copyTree } from "../../src/files.js";
import { prepareRun } from "../../src/prepare.js";
import type { AgentIdentity, ExperimentConfig, PathsConfig, ResolvedRun } from "../../src/types.js";
import { tempDirectory } from "./files.js";

export const identity: AgentIdentity = { agent: "claude", model: "claude-haiku-4-5-20251001", effort: null };

export async function prepareFixture(t: TestContext): Promise<{ run: ResolvedRun; paths: PathsConfig; root: string }> {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const candidate = join(root, "candidate-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: candidate-skill\ndescription: test candidate\n---\n\n# Candidate skill\n");
  const source = join(root, "project");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.js"), "console.log('hi');\n");
  await writeFile(join(source, "rubric.md"), "should be excluded\n");
  await writeFile(join(source, ".gitignore"), "dist/\n*.log\n!kept.log\n");
  const rubric = join(root, "rubric.md");
  await writeFile(rubric, "1. quality\n");
  const config: ExperimentConfig = {
    name: "fixture",
    arms: [
      { label: "without-candidate-skill" },
      { label: "with-candidate-skill", candidate: { path: candidate, dependencies: [] } },
    ],
    source: { path: source, include: ["**/*"] },
    task: "improve",
    producer: { agent: "claude", timeoutMs: 1000 },
    skills: { environment: "clean", root: join(root, "no-skills"), shared: [], sharedInClean: false, excludeCategories: [], exclude: [] },
    subagents: { root: join(root, "no-agents"), exclude: [] },
    nodeModules: null,
    sandbox: true,
    judge: { agent: "claude", timeoutMs: 1000, rubric },
    archive: true,
    cleanup: "manual",
  };
  const run = await prepareRun(config, paths);
  return { run, paths, root };
}

/** Materialize producer outputs after recording the untouched source baseline. */
export async function materializeOutputs(run: ResolvedRun, files: Record<string, string> | ((label: string) => Record<string, string>)): Promise<void> {
  for (const [producerId, label] of Object.entries(run.assignment.arms)) {
    const source = join(run.tempDir, producerId, "source");
    await copyTree(join(run.runDir, "frozen", "source"), source);
    await recordBaseline(run, producerId);
    for (const [path, content] of Object.entries(typeof files === "function" ? files(label) : files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), content);
    }
  }
}
