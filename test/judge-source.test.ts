import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordBaseline } from "../src/baseline.js";
import { loadConfig } from "../src/config.js";
import { copyTree, removeTree } from "../src/files.js";
import { copyJudgeInputs, judgePrompt } from "../src/judge.js";
import { prepareRun } from "../src/prepare.js";
import { hiddenFrom } from "../src/leaks.js";
import { readJson } from "../src/json.js";
import type { SkillCatalogEntry } from "../src/skills.js";

test("factorial arms reuse one candidate while the judge receives untouched source", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-judge-source-"));
  try {
    await mkdir(join(root, "project"));
    await mkdir(join(root, "candidate"));
    await writeFile(join(root, "project", "claim.md"), "Original verified claim.\n");
    await writeFile(join(root, "project", ".gitignore"), "scratch/\n");
    await writeFile(join(root, "candidate", "SKILL.md"), "---\nname: candidate\ndescription: Test guidance.\n---\nImprove the output.\n");
    await writeFile(join(root, "rubric.md"), "Compare against the original source.\n");
    await writeFile(join(root, "experiment.yaml"), [
      "name: factorial-source",
      "arms:",
      "  - {label: low-control}",
      "  - {label: low-candidate, candidate: {path: ./candidate}}",
      "  - {label: high-control, producer: {effort: high}}",
      "  - {label: high-candidate, candidate: {path: ./candidate}, producer: {effort: high}}",
      "source: {path: ./project, include: ['claim.md', '.gitignore']}",
      "task: improve the claim",
      "producer: {agent: claude, effort: low}",
      "skills: {environment: clean, root: ./no-skills}",
      "subagents: {root: ./no-agents}",
      "judge: {agent: claude, rubric: ./rubric.md}",
    ].join("\n"));
    const run = await prepareRun(await loadConfig(join(root, "experiment.yaml")), {
      runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive"),
    });
    const ids = Object.keys(run.assignment.arms);
    assert.equal(ids.length, 4);
    for (const id of ids) {
      const catalog = await readJson<SkillCatalogEntry[]>(join(run.runDir, "frozen", id, "context", "skill-catalog.json"));
      assert.equal(catalog.some((entry) => entry.name === "candidate"), run.assignment.arms[id]!.endsWith("candidate"));
      const source = join(run.tempDir, id, "source");
      await copyTree(join(run.runDir, "frozen", "source"), source);
      await writeFile(join(source, "setup-cache.txt"), "setup-only");
      await recordBaseline(run, id);
      await writeFile(join(source, "claim.md"), "Every producer made the same mistaken claim.\n");
      await mkdir(join(source, "scratch"));
      await writeFile(join(source, "scratch", "ignored.txt"), "ignored");
    }
    const judgeDir = join(root, "judge");
    const input = join(judgeDir, "input");
    const mapping = Object.fromEntries(ids.map((id, index) => [String.fromCharCode(65 + index), id]));
    const withheld = await copyJudgeInputs(run, input, mapping);
    assert.equal(withheld.length, 4);
    assert.equal(await readFile(join(input, "source", "claim.md"), "utf8"), "Original verified claim.\n");
    assert.equal(await stat(join(input, "source", "setup-cache.txt")).catch(() => null), null);
    for (const letter of Object.keys(mapping)) {
      assert.match(await readFile(join(input, letter, "claim.md"), "utf8"), /same mistaken claim/);
      assert.equal(await stat(join(input, letter, "setup-cache.txt")).catch(() => null), null);
      assert.equal(await stat(join(input, letter, "scratch")).catch(() => null), null);
    }
    const prompt = judgePrompt(run, judgeDir, Object.keys(mapping));
    assert.ok(prompt.includes(join(input, "source")));
    assert.match(prompt, /not another competing output/);
  } finally {
    await removeTree(root);
  }
});

test("shared candidate ownership never exposes another candidate or unowned material", () => {
  const material = {
    identities: [
      { label: "shared", value: "shared-skill", kind: "identifier" as const, arm: "low" },
      { label: "shared", value: "shared-skill", kind: "identifier" as const, arm: "high" },
      { label: "other", value: "other-skill", kind: "identifier" as const, arm: "other" },
      { label: "private", value: "private-path", kind: "path" as const },
    ],
    hashes: [{ value: "shared", arm: "low" }, { value: "shared", arm: "high" }, { value: "other", arm: "other" }, { value: "rubric", arm: "low" }, { value: "rubric" }],
  };
  assert.deepEqual(hiddenFrom(material, "low").identities.map((item) => item.value), ["other-skill", "private-path"]);
  assert.deepEqual([...hiddenFrom(material, "low").hashes], ["other", "rubric"]);
  assert.deepEqual([...hiddenFrom(material, "control").hashes], ["shared", "other", "rubric"]);
  assert.deepEqual(hiddenFrom(material, null).identities, material.identities);
});
