import assert from "node:assert/strict";
import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { listSkillDirectories } from "../src/files.js";
import { readJson } from "../src/json.js";
import { prepareRun } from "../src/prepare.js";
import { skillLoader, snapshotSkills, type SkillCatalogEntry } from "../src/skills.js";
import { subagentLoader, type SubagentCatalogEntry } from "../src/subagents.js";
import type { ExperimentConfig, ForbiddenIdentity, PathsConfig, ResolvedRun } from "../src/types.js";
import { sharedFolders, sharedYaml, withSharedContext, withUserConfig } from "./support/context.js";
import { tempDirectory } from "./support/files.js";
import { prepareFixture } from "./support/run.js";

test("preparation freezes one source and per-arm contexts, and only the candidate's arm sees it", async (t) => {
  const { run } = await prepareFixture(t);
  const arms = Object.entries(run.assignment.arms);
  assert.deepEqual(arms.map(([, label]) => label).sort(), ["with-candidate-skill", "without-candidate-skill"]);
  const source = await readFile(join(run.runDir, "frozen", "source", "index.js"), "utf8");
  assert.match(source, /hi/);
  await assert.rejects(readFile(join(run.runDir, "frozen", "source", "rubric.md")), /ENOENT/);
  for (const [producerId, label] of arms) {
    const catalog = await readJson<SkillCatalogEntry[]>(join(run.runDir, "frozen", producerId, "context", "skill-catalog.json"));
    assert.equal(catalog.some((skill) => skill.candidate), label === "with-candidate-skill");
  }
});

test("a skill linked into the skills root is frozen from its target; links that would loop or repeat are skipped", async (t) => {
  const root = await tempDirectory(t);
  const skillsRoot = join(root, "skills");
  const skill = async (dir: string, name: string) => {
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n`);
    await writeFile(join(dir, "scripts", "run.js"), `// ${name}\n`);
  };
  await skill(join(skillsRoot, "real"), "real");
  await skill(join(root, "elsewhere", "linked"), "linked");
  await symlink(join(root, "elsewhere", "linked"), join(skillsRoot, "linked"));
  await symlink(join(skillsRoot, "real"), join(skillsRoot, "alias"));
  await writeFile(join(root, "SKILL.md"), "---\nname: loop\ndescription: loop\n---\n");
  await symlink(root, join(skillsRoot, "loop"));
  await symlink(join(root, "missing"), join(skillsRoot, "dangling"));
  assert.deepEqual(await listSkillDirectories(skillsRoot), ["linked", "real"]);

  const config = {
    name: "linked", arms: [{ label: "a" }], source: { path: root, include: [] }, task: "t", producer: { agent: "claude", timeoutMs: 1000 },
    skills: { environment: "realistic", root: skillsRoot, shared: [], sharedInClean: false, excludeCategories: [], exclude: [] },
    subagents: { root: join(root, "no-agents"), exclude: [] }, nodeModules: null, sandbox: false, judge: null, archive: false, cleanup: "manual",
  } satisfies ExperimentConfig;
  const context = join(root, "context");
  const catalog = await snapshotSkills(config, context, config.arms[0]!);
  assert.deepEqual(catalog.map((entry) => entry.name).sort(), ["linked", "real"]);
  assert.equal(await readFile(join(context, "skills", "linked", "scripts", "run.js"), "utf8"), "// linked\n");
  assert.equal((await lstat(join(context, "skills", "linked"))).isSymbolicLink(), false, "the copy is real files, not the link");
});

test("subagents freeze like skills: shared baseline, dependency .md only for the candidate's arm", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const candidate = join(root, "candidate-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: candidate-skill\ndescription: test candidate\n---\n");
  const agentsRoot = join(root, "agents");
  await mkdir(agentsRoot, { recursive: true });
  await writeFile(join(agentsRoot, "shared-critic.md"), "---\nname: shared-critic\ndescription: baseline reviewer\ntools: Read, Bash\n---\n\nReview things.\n");
  await writeFile(join(agentsRoot, "manager.md"), "---\nname: manager\ndescription: excluded\n---\n\nManage.\n");
  const candidateCritic = join(root, "candidate-critic.md");
  await writeFile(candidateCritic, "---\nname: candidate-critic\ndescription: reviewer for one arm only\n---\n\nJudge harshly.\n");
  const skillsRoot = join(root, "skills");
  await mkdir(skillsRoot, { recursive: true });
  const guidance = await withSharedContext(root);
  const source = join(root, "project");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.js"), "console.log('hi');\n");
  const rubric = join(root, "rubric.md");
  await writeFile(rubric, "1. quality\n");
  const config: ExperimentConfig = {
    name: "fixture",
    arms: [
      { label: "without-candidate-skill" },
      { label: "with-candidate-skill", candidate: { path: candidate, dependencies: [candidateCritic] } },
    ],
    source: { path: source, include: ["**/*"] },
    task: "improve",
    producer: { agent: "claude", timeoutMs: 1000 },
    skills: { environment: "realistic", root: skillsRoot, shared: sharedFolders(guidance), sharedInClean: true, excludeCategories: [], exclude: [] },
    subagents: { root: agentsRoot, exclude: ["manager"] },
    nodeModules: null,
    sandbox: true,
    judge: { agent: "claude", timeoutMs: 1000, rubric },
    archive: true,
    cleanup: "manual",
  };
  const run = await prepareRun(config, paths);
  for (const [producerId, label] of Object.entries(run.assignment.arms)) {
    const catalog = await readJson<SubagentCatalogEntry[]>(
      join(run.runDir, "frozen", producerId, "context", "subagent-catalog.json"),
    );
    const own = label === "with-candidate-skill";
    assert.deepEqual(catalog.map((entry) => entry.name), own ? ["candidate-critic", "shared-critic"] : ["shared-critic"]);
    assert.equal(catalog.some((entry) => entry.candidate), own);
  }
});

test("a candidate can replace a baseline skill: the other arms keep the baseline", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const skillsRoot = join(root, "skills");
  const guidance = await withSharedContext(root);
  await mkdir(join(skillsRoot, "footer"), { recursive: true });
  await writeFile(join(skillsRoot, "footer", "SKILL.md"), "---\nname: footer\ndescription: shared footer\n---\n\n# Footer\n\nOriginal wording.\n");
  await writeFile(join(skillsRoot, "footer", "reference.md"), "unchanged between variants\n");
  await mkdir(join(skillsRoot, "other"), { recursive: true });
  await writeFile(join(skillsRoot, "other", "SKILL.md"), "---\nname: other\ndescription: another skill\n---\n\nUse footer when done.\n");
  const candidate = join(root, "footer-variant");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: footer\ndescription: shared footer\n---\n\n# Footer\n\nRevised wording.\n");
  await writeFile(join(candidate, "reference.md"), "unchanged between variants\n");
  const source = join(root, "project");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "index.js"), "console.log('hi');\n");
  const rubric = join(root, "rubric.md");
  await writeFile(rubric, "1. quality\n");
  const config: ExperimentConfig = {
    name: "fixture",
    arms: [
      { label: "footer-baseline" },
      { label: "footer-variant", candidate: { path: candidate, replaces: "footer", dependencies: [] } },
    ],
    source: { path: source, include: ["**/*"] },
    task: "improve",
    producer: { agent: "claude", timeoutMs: 1000 },
    skills: { environment: "realistic", root: skillsRoot, shared: sharedFolders(guidance), sharedInClean: true, excludeCategories: [], exclude: [] },
    subagents: { root: join(root, "no-agents"), exclude: [] },
    nodeModules: null,
    sandbox: true,
    judge: { agent: "claude", timeoutMs: 1000, rubric },
    archive: true,
    cleanup: "manual",
  };
  const run = await prepareRun(config, paths);
  for (const [producerId, label] of Object.entries(run.assignment.arms)) {
    const contextDir = join(run.runDir, "frozen", producerId, "context");
    const catalog = await readJson<SkillCatalogEntry[]>(join(contextDir, "skill-catalog.json"));
    assert.deepEqual(catalog.map((skill) => skill.name), ["footer", "other"]);
    assert.equal(catalog.find((skill) => skill.name === "footer")?.candidate, label === "footer-variant");
    const footer = await readFile(join(contextDir, "skills", "footer", "SKILL.md"), "utf8");
    assert.match(footer, label === "footer-variant" ? /Revised/ : /Original/);
  }
  const { identities } = await readJson<{ identities: ForbiddenIdentity[] }>(join(run.runDir, "audit", "forbidden-material.json"));
  assert.equal(identities.some((entry) => entry.kind === "identifier"), false);
});

for (const environment of ["clean", "realistic"]) {
  test(`explicit replacements override only their own exclusions in ${environment} mode`, async (t) => {
    const root = await tempDirectory(t);
    await withSharedContext(root);
    for (const name of ["create-skill", "create-critic", "crucible", "ordinary", "hidden"]) {
      const category = ["create-skill", "create-critic"].includes(name) ? "\ncategory: authoring-tools" : "";
      await mkdir(join(root, "skills", name), { recursive: true });
      await writeFile(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: authoring${category}\n---\nOriginal wording.\n`);
    }
    await mkdir(join(root, "variant"));
    await writeFile(join(root, "variant", "SKILL.md"), "---\nname: create-skill\ndescription: authoring\n---\nRevised wording.\n");
    await mkdir(join(root, "project"));
    await writeFile(join(root, "project", "input.txt"), "Task input.\n");
    await writeFile(join(root, "rubric.md"), "Quality.\n");
    await writeFile(join(root, "experiment.yaml"), [
      "name: excluded replacement",
      "arms: [{label: baseline}, {label: variant, candidate: {path: ./variant, replaces: create-skill}}]",
      "source: {path: ./project, include: ['input.txt']}",
      "task: write a definition",
      "producer: {agent: codex}",
      `skills: {environment: ${environment}, root: ./skills, shared: [./crafts, ./styles], excludeCategories: [authoring-tools], exclude: [hidden, crucible]}`,
      "subagents: {root: ./no-agents}",
      "judge: {agent: codex, rubric: ./rubric.md}",
    ].join("\n"));
    const config = await loadConfig(join(root, "experiment.yaml"));
    assert.ok(config.skills.exclude.includes("crucible"));
    const run = await prepareRun(config, { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") });
    // Categories are resolved to the names actually withheld, and recorded.
    const resolved = await readJson<ExperimentConfig>(join(run.runDir, "resolved-config.json"));
    for (const name of ["create-skill", "create-critic", "crucible", "hidden"]) assert.ok(resolved.skills.exclude.includes(name), name);
    assert.equal(resolved.skills.exclude.includes("ordinary"), false);
    for (const [producerId, label] of Object.entries(run.assignment.arms)) {
      const context = join(run.runDir, "frozen", producerId, "context");
      const catalog = await readJson<SkillCatalogEntry[]>(join(context, "skill-catalog.json"));
      assert.deepEqual(catalog.map((skill) => skill.name), environment === "clean" ? ["create-skill"] : ["create-skill", "ordinary"]);
      const content = await readFile(join(context, "skills", "create-skill", "SKILL.md"), "utf8");
      assert.match(content, label === "variant" ? /Revised wording/ : /Original wording/);
      for (const excluded of ["create-critic", "crucible", "hidden"]) {
        assert.equal(await stat(join(context, "skills", excluded)).catch(() => null), null);
      }
    }
  });
}

test("a replaced skill must exist in the baseline and match the candidate's name", async (t) => {
  const dir = await tempDirectory(t);
  await mkdir(join(dir, "skills", "footer"), { recursive: true });
  await writeFile(join(dir, "skills", "footer", "SKILL.md"), "---\nname: footer\ndescription: d\n---\n");
  await withSharedContext(dir);
  await mkdir(join(dir, "variant"), { recursive: true });
  await writeFile(join(dir, "variant", "SKILL.md"), "---\nname: header\ndescription: d\n---\n");
  await writeFile(join(dir, "rubric.md"), "1. quality\n");
  const write = (replaces: string) => writeFile(join(dir, "experiment.yaml"), [
    "name: t",
    `arms: [{}, {candidate: {path: ./variant, replaces: ${replaces}}}]`,
    "source: {path: ., include: ['rubric.md']}",
    "task: do it",
    "producer: {agent: claude}",
    "skills: {root: ./skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  const paths: PathsConfig = { runRoot: join(dir, "runs"), tempRoot: join(dir, "temp"), archiveRoot: join(dir, "archive") };
  await write("footer");
  await assert.rejects(prepareRun(await loadConfig(join(dir, "experiment.yaml")), paths), /candidate is named header/);
  await write("missing");
  await assert.rejects(prepareRun(await loadConfig(join(dir, "experiment.yaml")), paths), /No baseline skill named missing/);
});

test("a configured shared folder that is missing stops preparation, and skills.shared names the folders", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await mkdir(join(root, "staged", "skills", "footer"), { recursive: true });
  await writeFile(join(root, "staged", "skills", "footer", "SKILL.md"), "---\nname: footer\ndescription: d\n---\n\nRead the code craft first.\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  const guidance = await withSharedContext(join(root, "guidance"));
  const write = (shared: string) => writeFile(join(root, "experiment.yaml"), [
    "name: t",
    "arms: [{label: a}, {label: b, producer: {model: larger}}]",
    "source: {path: ./project, include: ['**/*']}",
    "task: do it",
    "producer: {agent: claude}",
    `skills: {root: ./staged/skills${shared}}`,
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));

  await write("");
  const missing = await withUserConfig(root, "skills: {shared: [./staged/crafts]}", () => loadConfig(join(root, "experiment.yaml")));
  await assert.rejects(prepareRun(missing, paths), /shared folder does not exist: .*staged\/crafts/);

  await write(", shared: ~/one");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /skills.shared must list the shared folders/);
  await write(`, shared: [${join(guidance, "crafts")}, ${join(root, "other", "crafts")}]`);
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /both named crafts/);

  await write(`, shared: ${sharedYaml(guidance)}`);
  const run = await prepareRun(await loadConfig(join(root, "experiment.yaml")), paths);
  for (const producerId of Object.keys(run.assignment.arms)) {
    const shared = await readFile(join(run.runDir, "frozen", producerId, "context", "shared", "crafts", "crafts.md"), "utf8");
    assert.match(shared, /shared crafts/);
  }
});

test("clean mode snapshots nothing shared unless the experiment asks, and a craft dependency reaches one arm", async (t) => {
  const root = await tempDirectory(t);
  const guidance = await withSharedContext(join(root, "guidance"));
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: a candidate for one arm\n---\n\n# Tone\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  const write = (arms: string, skills: string) => writeFile(join(root, "experiment.yaml"), [
    "name: clean shared",
    `arms: ${arms}`,
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    `skills: ${skills}`,
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  const prepare = async (arms: string, skills: string) => {
    const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
    await write(arms, skills);
    const config = await withUserConfig(root, `skills: {shared: ${sharedYaml(guidance)}}`, () => loadConfig(join(root, "experiment.yaml")));
    return prepareRun(config, paths);
  };
  const sharedDirOf = (run: ResolvedRun, label: string) =>
    join(run.runDir, "frozen", Object.entries(run.assignment.arms).find(([, name]) => name === label)![0], "context", "shared");

  // Clean by default: no crafts, no styles, and preparation does not ask for them.
  const bare = await prepare("[{}, {candidate: {path: ./tone-skill}}]", "{environment: clean, root: ./no-skills}");
  assert.equal(bare.config.skills.sharedInClean, false);
  for (const label of ["without-tone-skill", "with-tone-skill"]) {
    await assert.rejects(stat(sharedDirOf(bare, label)), /ENOENT/);
  }

  // Refused: skills.shared: false gives no arm the configured folders, realistic ones included.
  await write("[{}, {candidate: {path: ./tone-skill}}]", "{environment: realistic, root: ./no-skills, shared: false}");
  const none = await withUserConfig(root, `skills: {shared: ${sharedYaml(guidance)}}`, () => loadConfig(join(root, "experiment.yaml")));
  assert.deepEqual(none.skills.shared, []);

  // Specified: an explicit skills.shared is the opt-in, and every arm gets it.
  const opted = await prepare("[{}, {candidate: {path: ./tone-skill}}]", `{environment: clean, root: ./no-skills, shared: ${sharedYaml(guidance)}}`);
  for (const label of ["without-tone-skill", "with-tone-skill"]) {
    assert.match(await readFile(join(sharedDirOf(opted, label), "crafts", "crafts.md"), "utf8"), /shared crafts/);
  }

  // Implied: a craft named as a candidate dependency reaches that arm alone,
  // under the same shared/ layout the frozen skills point at.
  const implied = await prepare(
    `[{}, {candidate: {path: ./tone-skill, dependencies: ['${join(guidance, "crafts", "crafts.md")}']}}]`,
    "{environment: clean, root: ./no-skills}",
  );
  assert.match(await readFile(join(sharedDirOf(implied, "with-tone-skill"), "crafts", "crafts.md"), "utf8"), /shared crafts/);
  await assert.rejects(stat(sharedDirOf(implied, "without-tone-skill")), /ENOENT/);

  // A craft that skills.shared already hands everyone is not one arm's material.
  await assert.rejects(prepare(
    `[{}, {candidate: {path: ./tone-skill, dependencies: ['${join(guidance, "crafts", "crafts.md")}']}}]`,
    `{environment: clean, root: ./no-skills, shared: ${sharedYaml(guidance)}}`,
  ), /its shared folders .* already hold/);

  // The producer is only told about the redirect when it has a snapshot.
  const catalog: SkillCatalogEntry[] = [{ name: "tone-skill", description: "d", path: "skills/tone-skill/SKILL.md", candidate: true }];
  assert.match(skillLoader(catalog, "/ctx", [join(homedir(), "guidance", "crafts")]), /refers to ~\/guidance\/crafts, use \/ctx\/shared\/crafts instead/);
  assert.doesNotMatch(skillLoader(catalog, "/ctx", []), /shared\/crafts/);
});

test("skill and subagent prompts do not label the available material as a treatment", () => {
  const skill = { name: "draw", description: "Draw SVGs", path: "skills/draw/SKILL.md", candidate: true };
  const reviewer = { name: "reviewer", description: "Review the work", path: "subagents/reviewer.md", candidate: true };
  const prompt = skillLoader([skill], "/workspace/.context", []);
  assert.match(prompt, /Support files, when present/);
  assert.doesNotMatch(prompt, /candidate|treatment|control|baseline/i);
  assert.equal(prompt, skillLoader([{ ...skill, candidate: false }], "/workspace/.context", []));
  for (const agent of ["claude", "codex", "cursor"] as const) {
    const loader = subagentLoader([reviewer], agent, "/workspace/.context");
    assert.doesNotMatch(loader, /candidate|treatment|control|baseline/i);
    assert.equal(loader, subagentLoader([{ ...reviewer, candidate: false }], agent, "/workspace/.context"));
  }
});

test("arms may mix environments: each gets its own baseline, and a clean arm may name what realistic arms already have", async (t) => {
  const root = await tempDirectory(t);
  const guidance = await withSharedContext(join(root, "guidance"));
  const helper = join(guidance, "skills", "helper");
  await mkdir(helper, { recursive: true });
  await writeFile(join(helper, "SKILL.md"), "---\nname: helper\ndescription: an ordinary skill\n---\n\n# Helper\n");
  await mkdir(join(guidance, "agents"), { recursive: true });
  await writeFile(join(guidance, "agents", "critic.md"), "---\nname: critic\ndescription: reviews\n---\nReview it.\n");
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: a candidate\n---\n\n# Tone\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const prepare = async (arms: string) => {
    await writeFile(join(root, "experiment.yaml"), [
      "name: mixed environments",
      `arms: ${arms}`,
      "source: {path: ./project, include: ['*']}",
      "task: do it",
      "producer: {agent: claude}",
      "skills: {environment: realistic, root: ./guidance/skills, excludeCategories: []}",
      "subagents: {root: ./guidance/agents}",
      "judge: {agent: claude, rubric: ./rubric.md}",
    ].join("\n"));
    const config = await withUserConfig(root, `skills: {shared: ${sharedYaml(guidance)}}`, () => loadConfig(join(root, "experiment.yaml")));
    return prepareRun(config, paths);
  };
  const dependencies = [join(guidance, "crafts", "crafts.md"), helper, join(guidance, "agents", "critic.md")];
  const run = await prepare(`[{candidate: {path: ./tone-skill}}, {environment: clean, candidate: {path: ./tone-skill, dependencies: ${JSON.stringify(dependencies)}}}]`);
  assert.deepEqual(run.config.arms.map((arm) => arm.label), ["with-tone-skill", "with-tone-skill-clean"]);
  const contextOf = (label: string) =>
    join(run.runDir, "frozen", Object.entries(run.assignment.arms).find(([, name]) => name === label)![0], "context");
  const names = async (label: string, file: string) => (await readJson<Array<{ name: string }>>(join(contextOf(label), file))).map((entry) => entry.name);

  // The realistic arm keeps its whole baseline, the craft and critic the clean arm also named included.
  assert.deepEqual(await names("with-tone-skill", "skill-catalog.json"), ["helper", "tone-skill"]);
  assert.deepEqual(await names("with-tone-skill", "subagent-catalog.json"), ["critic"]);
  assert.match(await readFile(join(contextOf("with-tone-skill"), "shared", "crafts", "crafts.md"), "utf8"), /shared crafts/);
  assert.match(await readFile(join(contextOf("with-tone-skill"), "shared", "styles", "styles.md"), "utf8"), /shared styles/);
  // The clean arm gets only its candidate and what it named.
  assert.deepEqual(await names("with-tone-skill-clean", "skill-catalog.json"), ["tone-skill"]);
  assert.deepEqual(await names("with-tone-skill-clean", "subagent-catalog.json"), ["critic"]);
  assert.match(await readFile(join(contextOf("with-tone-skill-clean"), "shared", "crafts", "crafts.md"), "utf8"), /shared crafts/);
  await assert.rejects(stat(join(contextOf("with-tone-skill-clean"), "shared", "styles")), /ENOENT/);
  assert.match(await readFile(join(contextOf("with-tone-skill-clean"), "dependencies", "helper", "SKILL.md"), "utf8"), /# Helper/);

  // A realistic arm naming its own baseline is still refused.
  await assert.rejects(prepare(`[{environment: clean}, {candidate: {path: ./tone-skill, dependencies: ['${helper}']}}]`), /ordinary skill helper/);
  // A frozen historical arm keeps the environment it ran in.
  await assert.rejects(prepare("[{}, {environment: clean, reuse: {run: ab-00000000, arm: x}}]"), /reuse cannot be combined with candidate, producer, environment, task, or inputs/);
  await assert.rejects(prepare("[{}, {environment: sterile}]"), /arms\[1\]\.environment must be realistic or clean/);
});

test("the shared sweep drops shared files naming a candidate and leaves an arm's own style pack alone", async (t) => {
  const root = await tempDirectory(t);
  const guidance = await withSharedContext(join(root, "guidance"));
  // A shared craft that names the candidate: every arm loses it, whichever arm
  // the candidate belongs to.
  await mkdir(join(guidance, "crafts", "deep"), { recursive: true });
  await writeFile(join(guidance, "crafts", "deep", "tone.md"), "Follow tone-skill when writing copy.\n");
  // A style pack of the candidate's own, outside the shared root.
  const pack = join(root, "packs", "styles", "hazel");
  await mkdir(pack, { recursive: true });
  await writeFile(join(pack, "STYLE.md"), "hazel palette\n");
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: a candidate for one arm\n---\n\n# Tone\n");
  const skillsRoot = join(root, "skills", "note-taking");
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(join(skillsRoot, "SKILL.md"), "---\nname: note-taking\ndescription: an ordinary baseline skill\n---\n\n# Notes\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  // The arm carrying the dependency is the first one, whose snapshot the sweep
  // used to scan and delete from.
  await writeFile(join(root, "experiment.yaml"), [
    "name: shared sweep",
    `arms: [{candidate: {path: ./tone-skill, dependencies: ['${join(pack)}']}}, {}]`,
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    `skills: {environment: realistic, root: ./skills, shared: ${sharedYaml(guidance)}}`,
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const run = await prepareRun(await loadConfig(join(root, "experiment.yaml")), paths);
  const sharedDirOf = (label: string) =>
    join(run.runDir, "frozen", Object.entries(run.assignment.arms).find(([, name]) => name === label)![0], "context", "shared");

  // The dependency survives on its own arm and reaches no other.
  assert.equal(await readFile(join(sharedDirOf("with-tone-skill"), "styles", "hazel", "STYLE.md"), "utf8"), "hazel palette\n");
  await assert.rejects(stat(join(sharedDirOf("without-tone-skill"), "styles", "hazel")), /ENOENT/);
  // The genuinely shared craft that named the candidate is gone from both, and
  // so is the directory it emptied.
  for (const label of ["with-tone-skill", "without-tone-skill"]) {
    await assert.rejects(stat(join(sharedDirOf(label), "crafts", "deep")), /ENOENT/);
    assert.match(await readFile(join(sharedDirOf(label), "crafts", "crafts.md"), "utf8"), /shared crafts/);
  }
  assert.deepEqual(await readJson<string[]>(join(run.runDir, "audit", "omitted-shared-files.json")), [join("crafts", "deep", "tone.md")]);
});

test("replicate arms with the same candidate do not leak into each other", async (t) => {
  const root = await tempDirectory(t);
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: the candidate both replicates carry\n---\n\n# Tone\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  await writeFile(join(root, "experiment.yaml"), [
    "name: replicates",
    "arms: [{label: first, candidate: {path: ./tone-skill}}, {label: second, candidate: {path: ./tone-skill}}]",
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  const run = await prepareRun(await loadConfig(join(root, "experiment.yaml")), paths);
  for (const [producerId] of Object.entries(run.assignment.arms)) {
    const skill = join(run.runDir, "frozen", producerId, "context", "skills", "tone-skill", "SKILL.md");
    assert.match(await readFile(skill, "utf8"), /name: tone-skill/);
  }
});
