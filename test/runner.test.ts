import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { AUTH_ENVIRONMENT, adapterFor, armEnvironment, authProblem, scrubbedEnvironment, setClaudeTokenReader, writeSubagentPlugin } from "../src/adapters.js";
import { archiveRun } from "../src/archive.js";
import { entryIssues } from "../src/check.js";
import { armChanges, recordBaseline, withholdNonArmFiles } from "../src/baseline.js";
import { armCost, describeCost } from "../src/cost.js";
import { loadConfig, parseDuration, producerFor } from "../src/config.js";
import { copyTree, gitignoreFilter, listSkillDirectories, makeReadOnly, removeTree, sha256File } from "../src/files.js";
import { readJson, writeJson } from "../src/json.js";
import { collectForbiddenHashes, hiddenFrom, matchesIdentity, omitSkillPathEchoes, scanFiles } from "../src/leaks.js";
import { prepareRun } from "../src/prepare.js";
import { recordReusableInputs } from "../src/reuse.js";
import { RUNNER_PACKAGES, linkJudgePackages } from "../src/playwright.js";
import { hiddenFolders, nodeModulesWarning, profile, runSandboxProbes, sandboxWrap } from "../src/sandbox.js";
import { copyJudgeInputs, judgePrompt } from "../src/judge.js";
import { renderMarkdown } from "../src/html.js";
import { cleanRun, reportRun } from "../src/report.js";
import { loadRun, loadRunLocation } from "../src/run.js";
import { renderSeries, resultCell } from "../src/series.js";
import { publishShots, readShotIndex } from "../src/shots.js";
import { readRunState, resetJudge, setRunState, trackAgent, updateJudge, updateProducer } from "../src/state.js";
import { statusJson } from "../src/status.js";
import { judgeLetters, parseVerdict, revealVerdict } from "../src/verdict.js";
import { runSetup } from "../src/agent.js";
import { completionOutcome, startRun, stopRun } from "../src/runner.js";
import type { AgentIdentity, ExperimentConfig, ForbiddenIdentity, ForbiddenMaterial, JudgedResult, PathsConfig, ResolvedRun, RunResult, Verdict } from "../src/types.js";
import { skillLoader, snapshotSkills, type SkillCatalogEntry } from "../src/skills.js";
import { subagentLoader, type SubagentCatalogEntry } from "../src/subagents.js";

// The adapter tests resolve each agent CLI on PATH but never run it. Stubs at
// the end of PATH let them pass on a machine, such as CI, with no agent installed.
const agentStubs = await mkdtemp(join(tmpdir(), "crucible-agent-stubs-"));
for (const name of ["claude", "codex"]) await writeFile(join(agentStubs, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
process.env.PATH = `${process.env.PATH ?? ""}:${agentStubs}`;

const identity: AgentIdentity = { agent: "claude", model: "claude-haiku-4-5-20251001", effort: null };

test("duration parsing is explicit", () => {
  assert.equal(parseDuration("90m"), 5_400_000);
  assert.throws(() => parseDuration("90"), /must use/);
});

test("leak matching flags the distinctive identity, not raw slug terms", () => {
  const candidate: ForbiddenIdentity = { label: "candidate slug", value: "peak-canvas", kind: "identifier" };
  assert.equal(matchesIdentity("A WebGL project using three.js", candidate), false);
  assert.equal(matchesIdentity("Load peak-canvas for this work", candidate), true);
  assert.equal(matchesIdentity("not-peak-canvas-extra", candidate), false);
});

test("judge copies drop skill-folder path echoes and keep prose leaks", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const identities: ForbiddenIdentity[] = [{ label: "candidate slug", value: "peak-canvas", kind: "identifier" }];
  await mkdir(join(root, "captures"), { recursive: true });
  await writeFile(join(root, "index.html"), "<canvas></canvas>\n");
  await writeFile(join(root, "verify.mjs"), "import { helper } from '../.context/skills/peak-canvas/scripts/lib.mjs';\n");
  await writeFile(join(root, "README.md"), "This used the peak-canvas skill.\n");
  const removed = await omitSkillPathEchoes(root, identities);
  assert.deepEqual(removed, ["verify.mjs"]);
  const findings = await scanFiles(root, ["README.md", "index.html"], identities, new Set());
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.path, "README.md");
  await removeTree(root);
});

test("experiment files reject unknown fields, and name what the arms list replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const write = (producer: string, extra = "") => writeFile(join(dir, "experiment.yaml"), [
    "name: t",
    "arms: [{}, {producer: {model: large}}]",
    "source: {path: ., include: ['*']}",
    "task: do it",
    `producer: ${producer}`,
    "judge: {agent: claude, rubric: ./rubric.md}",
    extra,
  ].join("\n"));
  await write("{agent: claude}", "network: {default: deny}");
  await assert.rejects(loadConfig(join(dir, "experiment.yaml")), /Unknown experiment field: network/);
  await write("{agent: claude}", "candidate: {path: ./skill}");
  await assert.rejects(loadConfig(join(dir, "experiment.yaml")), /candidate was replaced by arms/);
  await write("{agent: claude, control: {model: a}, treatment: {model: b}}");
  await assert.rejects(loadConfig(join(dir, "experiment.yaml")), /producer.control and producer.treatment were replaced by arms/);
  await removeTree(dir);
});

test("sandbox defaults to on and can be disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const base = [
    "name: t",
    "arms: [{}, {candidate: {path: ./skill}}]",
    "source: {path: ., include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ];
  await mkdir(join(dir, "skill"));
  await writeFile(join(dir, "rubric.md"), "quality\n");
  await writeFile(join(dir, "on.yaml"), base.join("\n"));
  await writeFile(join(dir, "off.yaml"), [...base, "sandbox: false"].join("\n"));
  assert.equal((await loadConfig(join(dir, "on.yaml"))).sandbox, true);
  assert.equal((await loadConfig(join(dir, "off.yaml"))).sandbox, false);
  await removeTree(dir);
});

test("scrubbed environment hides the home and passes only the agent's credentials", () => {
  process.env.CRUCIBLE_TEST_SECRET = "x";
  process.env.ANTHROPIC_API_KEY = "key";
  const env = scrubbedEnvironment("/tmp/rt", "claude");
  assert.equal(env.HOME, "/tmp/rt/home");
  assert.equal(env.ANTHROPIC_API_KEY, "key");
  assert.equal(env.CRUCIBLE_TEST_SECRET, undefined);
  const codexEnv = scrubbedEnvironment("/tmp/rt", "codex");
  assert.equal(codexEnv.ANTHROPIC_API_KEY, undefined);
});

test("auth check accepts a claude credential from the environment or the keychain", async () => {
  const names = [...AUTH_ENVIRONMENT.claude];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  let lookups = 0;
  const keychainHolding = (token: string | undefined) => () => {
    lookups += 1;
    return Promise.resolve(token);
  };
  try {
    for (const name of names) delete process.env[name];

    setClaudeTokenReader(keychainHolding("token"));
    assert.equal(await authProblem("claude"), null);

    setClaudeTokenReader(keychainHolding(undefined));
    assert.match(await authProblem("claude") ?? "", /CLAUDE_CODE_OAUTH_TOKEN/);

    lookups = 0;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
    assert.equal(await authProblem("claude"), null);
    assert.equal(lookups, 0);
  } finally {
    setClaudeTokenReader();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("codex adapter bypasses its own sandbox and ignores user config", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const adapter = adapterFor("codex");
  let command;
  try {
    command = await adapter.prepare({
      producerDir: runtimeDir,
      cwd: join(runtimeDir, "source"),
      runtimeDir,
      prompt: "p",
      config: { agent: "codex", timeoutMs: 1000 },
    });
  } catch {
    // No codex CLI on this machine; the flag set is asserted where it exists.
    return;
  }
  assert.ok(command.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(command.args.includes("--ignore-user-config"));
  assert.equal(command.env.CODEX_HOME, join(runtimeDir, "codex-home"));
  await removeTree(runtimeDir);
});

test("the profile contains writes and hides the experiment in rule order", () => {
  const text = profile({
    workspaceDir: "/private/tmp/w/p-1",
    deniedRoots: ["/Users/u/.crucible/runs", "/Users/u/.claude/skills"],
    readableRoots: ["/Users/u/.claude/skills/node_modules"],
    frozenDirs: ["/private/tmp/w/p-1/.context"],
    extraWriteRoots: ["/tmp/crucible-p-1"],
    sharedTempDir: "/private/tmp",
    runTempDir: "/private/tmp/w",
  });
  const lines = text.split("\n");
  assert.equal(lines[1], "(allow default)");
  const denyWrites = lines.findIndex((line) => line.includes("deny file-write*") && line.includes("require-not"));
  const denySkills = lines.findIndex((line) => line.includes(".claude/skills"));
  const allowWorkspace = lines.findIndex((line) => line.includes('(allow file-read* file-write* (subpath "/private/tmp/w/p-1"))'));
  const denyFrozen = lines.findIndex((line) => line.includes(".context"));
  assert.ok(denyWrites < denySkills, "write containment comes before experiment denials");
  const allowPackages = lines.findIndex((line) => line === '(allow file-read* (subpath "/Users/u/.claude/skills/node_modules"))');
  assert.ok(denySkills < allowPackages, "node_modules is read back out of the denials");
  assert.ok(denySkills < allowWorkspace, "the workspace allowance must out-rank the temp-root denial");
  assert.ok(allowWorkspace < denyFrozen, "the frozen-context denial must out-rank the workspace allowance");
  // The shared temp directory is writable, as on any machine; the run's own temp is denied again below it.
  const allowTemp = lines.findIndex((line) => line === '(allow file-write* (subpath "/private/tmp"))');
  assert.ok(denyWrites < allowTemp && allowTemp < denySkills, "the shared temp allowance sits with the other write allowances");
});

const SHARED_NAMES = ["crafts", "styles"];

/** A crafts and a styles folder of shared guidance under `guidance`. */
async function withSharedContext(guidance: string): Promise<string> {
  for (const name of SHARED_NAMES) {
    await mkdir(join(guidance, name), { recursive: true });
    await writeFile(join(guidance, name, `${name}.md`), `shared ${name}\n`);
  }
  return guidance;
}

/** The shared folders `withSharedContext` made, as a config lists them. */
const sharedFolders = (guidance: string) => SHARED_NAMES.map((name) => join(guidance, name));
/** The same, written as a YAML flow list for an experiment file. */
const sharedYaml = (guidance: string) => `[${sharedFolders(guidance).join(", ")}]`;

/** Run `body` with a user config file holding `yaml` in place of the real one. */
async function withUserConfig<T>(root: string, yaml: string, body: () => Promise<T>): Promise<T> {
  const file = join(root, "user-config.yaml");
  await writeFile(file, yaml);
  const previous = process.env.CRUCIBLE_CONFIG;
  process.env.CRUCIBLE_CONFIG = file;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.CRUCIBLE_CONFIG;
    else process.env.CRUCIBLE_CONFIG = previous;
  }
}

async function prepareFixture(): Promise<{ run: ResolvedRun; paths: PathsConfig; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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

test("preparation freezes one source and per-arm contexts, and only the candidate's arm sees it", async () => {
  const { run, root } = await prepareFixture();
  const arms = Object.entries(run.assignment.arms);
  assert.deepEqual(arms.map(([, label]) => label).sort(), ["with-candidate-skill", "without-candidate-skill"]);
  const source = await readFile(join(run.runDir, "frozen", "source", "index.js"), "utf8");
  assert.match(source, /hi/);
  await assert.rejects(readFile(join(run.runDir, "frozen", "source", "rubric.md")), /ENOENT/);
  for (const [producerId, label] of arms) {
    const catalog = await readJson<SkillCatalogEntry[]>(join(run.runDir, "frozen", producerId, "context", "skill-catalog.json"));
    assert.equal(catalog.some((skill) => skill.candidate), label === "with-candidate-skill");
  }
  await removeTree(root);
});

test("start refuses a run that is already marked running", async () => {
  const { run, root } = await prepareFixture();
  await setRunState(run.runDir, "running");
  await assert.rejects(startRun(run), /already marked running/);
  assert.equal((await readRunState(run.runDir)).state, "running");
  await removeTree(root);
});

test("stop marks agents whose runner died stopped, the judge included, instead of refusing", async () => {
  const { run, root } = await prepareFixture();
  const dead = spawnSync("/usr/bin/true").pid;
  const [first, second] = Object.keys(run.assignment.arms);
  const startedAt = new Date().toISOString();
  await setRunState(run.runDir, "running");
  await updateProducer(run.runDir, first!, { state: "running", pid: dead, processStartedAt: "gone", startedAt });
  await stopRun(run);
  let view = await readRunState(run.runDir);
  assert.equal(view.state, "stopped");
  assert.deepEqual([view.producers[first!]!.state, view.producers[second!]!.state], ["stopped", "stopped"], "a producer still waiting to start is stopped too");

  await setRunState(run.runDir, "produced");
  await updateJudge(run.runDir, { state: "running", pid: dead, processStartedAt: "gone", startedAt });
  await stopRun(run);
  view = await readRunState(run.runDir);
  assert.equal(view.judge?.state, "stopped");
  assert.equal(view.state, "produced", "stopping the judge leaves the outputs ready to judge again");
  await assert.rejects(stopRun(run), /No running producers or judge/);
  await removeTree(root);
});

test("clean removes the workspace of a run whose frozen experiment no longer loads", async () => {
  const { run, paths, root } = await prepareFixture();
  await writeFile(join(run.tempDir, "scratch"), "work in progress\n");
  await writeJson(join(run.runDir, "resolved-config.json"), { name: "prepared by an older runner" });
  await assert.rejects(loadRun(run.runId, paths), /has no arms/);
  await cleanRun(await loadRunLocation(run.runId, paths));
  await assert.rejects(stat(run.tempDir), /ENOENT/);
  assert.ok((await stat(run.runDir)).isDirectory());
  await removeTree(root);
});

test("the deny-list sandbox hides the experiment and contains writes", { skip: platform() !== "darwin" }, async () => {
  const { run, root } = await prepareFixture();
  for (const producerId of Object.keys(run.assignment.arms)) {
    const producerDir = join(run.tempDir, producerId);
    await mkdir(join(producerDir, ".runtime", "tmp"), { recursive: true, mode: 0o700 });
    await copyTree(join(run.runDir, "frozen", "source"), join(producerDir, "source"));
    await copyTree(join(run.runDir, "frozen", producerId, "context"), join(producerDir, ".context"));
    await makeReadOnly(join(producerDir, ".context"));
    const checks = await runSandboxProbes(run, producerId);
    for (const check of checks) assert.ok(check.passed, `${check.name}: ${check.detail ?? ""}`);
  }
  await removeTree(root);
});

test("the sandbox also hides live shared guidance, subagents, and the archive, but never node_modules", { skip: platform() !== "darwin" }, async () => {
  const { run, paths, root } = await prepareFixture();
  const shared = join(root, "guidance", "crafts");
  const agents = join(root, "agents");
  const packages = join(run.config.skills.root, "node_modules");
  for (const folder of [shared, agents, packages, paths.archiveRoot]) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "file"), "x\n");
  }
  const config = { ...run.config, skills: { ...run.config.skills, shared: [shared] }, subagents: { ...run.config.subagents, root: agents }, nodeModules: packages };
  const previous = process.env.CRUCIBLE_ARCHIVE_ROOT;
  process.env.CRUCIBLE_ARCHIVE_ROOT = paths.archiveRoot;
  try {
    const [producerId] = Object.keys(run.assignment.arms);
    const producerDir = join(run.tempDir, producerId!);
    await mkdir(join(producerDir, ".runtime", "tmp"), { recursive: true, mode: 0o700 });
    await copyTree(join(run.runDir, "frozen", "source"), join(producerDir, "source"));
    await copyTree(join(run.runDir, "frozen", producerId!, "context"), join(producerDir, ".context"));
    const checks = await runSandboxProbes({ ...run, config }, producerId!);
    for (const check of checks) assert.ok(check.passed, `${check.name}: ${check.detail ?? ""}`);
    const names = checks.map((check) => check.name.replace(`${producerId}: `, ""));
    for (const name of ["deny live shared crafts (deny)", "deny live subagents (deny)", "deny archive (deny)", "read node_modules (allow)"]) assert.ok(names.includes(name), name);
  } finally {
    if (previous === undefined) delete process.env.CRUCIBLE_ARCHIVE_ROOT;
    else process.env.CRUCIBLE_ARCHIVE_ROOT = previous;
  }
  assert.match(nodeModulesWarning(packages, hiddenFolders(config, paths)) ?? "", /inside .*no-skills, which the sandbox hides/);
  assert.equal(nodeModulesWarning(join(root, "elsewhere", "node_modules"), hiddenFolders(config, paths)), null);
  await removeTree(root);
});

test("the judge loads Crucible's own Playwright under the sandbox, beside the configured packages", { skip: platform() !== "darwin" }, async () => {
  assert.ok(RUNNER_PACKAGES, "Crucible's own Playwright is installed");
  const { run, root } = await prepareFixture();
  const load = 'require("playwright"); process.stdout.write(require("fs").realpathSync(require.resolve("playwright")))';
  const judgeLoads = async (config: ExperimentConfig, judgeId: string, script: string) => {
    const judgeDir = join(run.tempDir, judgeId);
    await mkdir(judgeDir, { recursive: true });
    assert.equal(await linkJudgePackages(config.nodeModules, judgeDir), true);
    const launch = await sandboxWrap({ ...run, config }, judgeId, process.execPath, ["-e", script], [], []);
    const result = spawnSync(launch.command, launch.args, { cwd: judgeDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  // With no config file, nodeModules is null: Playwright still comes from Crucible's install.
  assert.equal(run.config.nodeModules, null);
  assert.ok((await judgeLoads(run.config, "j-plain", load)).startsWith(await realpath(RUNNER_PACKAGES)));

  // A configured nodeModules, here inside the hidden skills root, adds its packages; its own Playwright gives way.
  const packages = join(run.config.skills.root, "node_modules");
  for (const name of ["left-pad", "playwright"]) {
    await mkdir(join(packages, name), { recursive: true });
    await writeFile(join(packages, name, "index.js"), `module.exports = "${name}";\n`);
  }
  const configured = await judgeLoads({ ...run.config, nodeModules: packages }, "j-configured", `require("left-pad"); ${load}`);
  assert.ok(configured.startsWith(await realpath(RUNNER_PACKAGES)), configured);
  await removeTree(root);
});

test("a skill linked into the skills root is frozen from its target; links that would loop or repeat are skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(root);
});

test("subagents freeze like skills: shared baseline, dependency .md only for the candidate's arm", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(root);
});

test("claude argv names nothing about the arm: subagents ride in a plugin dir, model and effort in the settings file", async () => {
  const producerDir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const contextDir = join(producerDir, ".context", "subagents");
  await mkdir(contextDir, { recursive: true });
  const definition = "---\nname: critic\ndescription: reviews\ntools: Read, Bash\n---\n\nBe harsh.\n";
  await writeFile(join(contextDir, "critic.md"), definition);
  await writeFile(
    join(producerDir, ".context", "subagent-catalog.json"),
    JSON.stringify([{ name: "critic", description: "reviews", path: "subagents/critic.md", candidate: false }]),
  );
  setClaudeTokenReader(async () => "token");
  const command = await adapterFor("claude").prepare({
    producerDir,
    cwd: join(producerDir, "source"),
    runtimeDir: join(producerDir, ".runtime"),
    prompt: "task",
    config: { agent: "claude", timeoutMs: 1000, model: "claude-opus-4-1", effort: "xhigh" },
  });
  const tools = command.args[command.args.indexOf("--tools") + 1];
  assert.equal(tools, "Bash,Read,Write,Edit,Glob,Grep,Task");
  // A sibling arm's `ps` sees argv; none of the frozen material or arm variables may be on it.
  const argv = command.args.join(" ");
  for (const secret of ["--agents", "Be harsh", "critic", "--model", "claude-opus-4-1", "--effort", "xhigh"]) {
    assert.ok(!argv.includes(secret), `argv exposes ${secret}: ${argv}`);
  }
  const plugin = command.args[command.args.indexOf("--plugin-dir") + 1]!;
  assert.equal(plugin, join(producerDir, ".runtime", "subagents"));
  assert.deepEqual(JSON.parse(await readFile(join(plugin, ".claude-plugin", "plugin.json"), "utf8")), { name: "frozen" });
  assert.equal(await readFile(join(plugin, "agents", "critic.md"), "utf8"), definition);
  const settings = JSON.parse(await readFile(command.args[command.args.indexOf("--settings") + 1]!, "utf8"));
  assert.deepEqual(settings, { model: "claude-opus-4-1", effortLevel: "xhigh" });
  // The producer is told the name the Task tool registers the plugin agent under.
  assert.match(subagentLoader([{ name: "critic", description: "reviews", path: "subagents/critic.md", candidate: false }], "claude", contextDir), /- frozen:critic: reviews/);
  await removeTree(producerDir);
});

test("Cursor registers frozen plugin reviewers with plain names and inherited settings", async () => {
  const producerDir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  try {
    const contextDir = join(producerDir, ".context");
    await mkdir(join(contextDir, "subagents"), { recursive: true });
    const catalog = [{ name: "dummy-reviewer", description: "reviews", path: "subagents/reviewer.md", candidate: true }];
    const definition = "---\nname: dummy-reviewer\ndescription: reviews\nmodel: haiku\ntools: Read, Bash\n---\nInspect independently.\n";
    await writeFile(join(contextDir, "subagents/reviewer.md"), definition);
    const runtimeDir = join(producerDir, ".runtime");
    const plugin = await writeSubagentPlugin(producerDir, runtimeDir, catalog, "cursor");
    assert.equal(plugin, join(runtimeDir, "subagents"));
    assert.deepEqual(await readJson(join(plugin!, ".cursor-plugin/plugin.json")), { name: "frozen" });
    assert.equal(await readFile(join(plugin!, "agents/reviewer.md"), "utf8"), definition);
    const prompt = subagentLoader(catalog, "cursor", contextDir);
    assert.match(prompt, /Task tool/);
    assert.match(prompt, /- dummy-reviewer: reviews/);
    assert.match(prompt, /subagent_type/);
    assert.match(prompt, /inherits this producer's model and effort/);
    assert.ok(!prompt.includes("frozen:dummy-reviewer"));
    assert.equal(subagentLoader([], "cursor", contextDir), "");
    assert.equal(await writeSubagentPlugin(producerDir, runtimeDir, [], "cursor"), null);
  } finally { await removeTree(producerDir); }
});

test("Codex delegates to its frozen reviewer with fresh context and inherited settings", async () => {
  const producerDir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  try {
    const contextDir = join(producerDir, ".context");
    await mkdir(join(contextDir, "subagents"), { recursive: true });
    const catalog = [{ name: "critic", description: "reviews", path: "subagents/critic.md", candidate: true }];
    await writeFile(join(contextDir, "subagent-catalog.json"), JSON.stringify(catalog));
    await writeFile(join(contextDir, "subagents/critic.md"), "---\nname: critic\ndescription: reviews\n---\nInspect independently.\n");
    const prompt = subagentLoader(catalog, "codex", contextDir);
    const command = await adapterFor("codex").prepare({
      producerDir, cwd: join(producerDir, "source"), runtimeDir: join(producerDir, ".runtime"), prompt,
      config: { agent: "codex", model: "gpt-6-astra", effort: "low", timeoutMs: 1000 },
    });
    assert.ok(command.args.includes("multi_agent"));
    assert.ok(command.args.includes("--ignore-user-config"));
    assert.match(command.stdin, /fork_context=false/);
    assert.match(command.stdin, /inherits this producer's model and effort/);
    assert.ok(command.stdin.includes(join(contextDir, "subagents/critic.md")));
    assert.ok(!command.stdin.includes("Task tool"));
    assert.equal(subagentLoader([], "codex", contextDir), "");
    assert.match(subagentLoader(catalog, "claude", contextDir), /Task tool/);
  } finally { await removeTree(producerDir); }
});

test("the claude adapter hands the producer the arm's own settings file", async () => {
  const producerDir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const settings = join(producerDir, "rtk-hooks.json");
  const hooks = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rewrite" }] }] } };
  await writeFile(settings, JSON.stringify(hooks));
  setClaudeTokenReader(async () => "token");
  const command = await adapterFor("claude").prepare({
    producerDir,
    cwd: join(producerDir, "source"),
    runtimeDir: join(producerDir, ".runtime"),
    prompt: "task",
    config: { agent: "claude", timeoutMs: 1000, settings },
  });
  // The producer starts in the project, not at the top of the workspace.
  assert.equal(command.cwd, join(producerDir, "source"));
  const written = command.args[command.args.indexOf("--settings") + 1]!;
  assert.equal(written, join(producerDir, ".runtime", "claude-settings.json"));
  assert.deepEqual(JSON.parse(await readFile(written, "utf8")), hooks);
  // Nothing from the real machine comes with it.
  assert.equal(command.args[command.args.indexOf("--setting-sources") + 1], "");
  await removeTree(producerDir);
});

test("a timed-out producer counts as complete only if it changed the source", () => {
  const failed = { succeeded: false, strayProcesses: false, terminalEvent: false, exitCode: null, signal: "SIGKILL" as const };
  assert.deepEqual(completionOutcome({ ...failed, timedOut: true }, true), { state: "complete", timedOut: true });
  const untouched = completionOutcome({ ...failed, timedOut: true }, false);
  assert.equal(untouched.state, "failed");
  assert.equal(untouched.error, "Producer timed out without changing the source");
  assert.deepEqual(completionOutcome({ succeeded: true, timedOut: false, strayProcesses: false, terminalEvent: true, exitCode: 0, signal: null }, false), { state: "complete" });
  const crash = completionOutcome({ ...failed, timedOut: false, terminalEvent: true, exitCode: 1, terminalSummary: "API error" }, false);
  assert.equal(crash.state, "failed");
  assert.equal(crash.error, "Producer exited with 1: API error");
});

test("a candidate can replace a baseline skill: the other arms keep the baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(root);
});

for (const environment of ["clean", "realistic"]) {
  test(`explicit replacements override only their own exclusions in ${environment} mode`, async () => {
    const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
    await removeTree(root);
  });
}

test("a replaced skill must exist in the baseline and match the candidate's name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(dir);
});

test("a configured shared folder that is missing stops preparation, and skills.shared names the folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(root);
});

test("arms can differ in producer model instead of a candidate skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  const write = (arms: string, producer = "{agent: claude, effort: high}") => writeFile(join(root, "experiment.yaml"), [
    "name: t",
    `arms: ${arms}`,
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    `producer: ${producer}`,
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  await write("[]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /at least 1 entry/);
  await write(`[${Array.from({ length: 7 }, (_, index) => `{label: a${index}}`).join(", ")}]`);
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /at most 6 entries/);
  // A replicate of the same settings is allowed, but its label cannot be guessed.
  await write("[{producer: {model: a}}, {producer: {model: a}}]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /deliberate replicate: give each one its own label/);
  await write("[{label: first, producer: {model: a}}, {label: second, producer: {model: a}}]");
  assert.deepEqual((await loadConfig(join(root, "experiment.yaml"))).arms.map((arm) => arm.label), ["first", "second"]);
  await write("[{producer: {model: small}}, {producer: {model: large}}]");
  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.candidate), [undefined, undefined]);
  assert.deepEqual(producerFor(config.producer, config.arms[0]!), { agent: "claude", effort: "high", model: "small", timeoutMs: 7_200_000 });
  assert.equal(producerFor(config.producer, config.arms[1]!).model, "large");
  const run = await prepareRun(config, paths);
  for (const producerId of Object.keys(run.assignment.arms)) {
    const catalog = await readJson<SkillCatalogEntry[]>(join(run.runDir, "frozen", producerId, "context", "skill-catalog.json"));
    assert.deepEqual(catalog, []);
  }
  const { identities } = await readJson<{ identities: ForbiddenIdentity[] }>(join(run.runDir, "audit", "forbidden-material.json"));
  assert.deepEqual(identities.map((entry) => entry.label), ["orchestrator path"]);
  await removeTree(root);
});

test("an arm can hook in a tool with settings, env, and a setup command", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  await writeFile(join(root, "rtk-hooks.json"), JSON.stringify({ hooks: { PreToolUse: [] } }));
  const write = (arms: string, producer = "{agent: claude, env: {PATH: '/opt/homebrew/bin:$PATH'}}", judge = "{agent: claude, rubric: ./rubric.md}") =>
    writeFile(join(root, "experiment.yaml"), [
      "name: t",
      `arms: ${arms}`,
      "source: {path: ./project, include: ['*']}",
      "task: do it",
      `producer: ${producer}`,
      "skills: {environment: clean, root: ./no-skills}",
      "subagents: {root: ./no-agents}",
      `judge: ${judge}`,
    ].join("\n"));

  await write("[{}, {producer: {settings: ./rtk-hooks.json, env: {RTK_MODE: 'on'}, setup: 'echo built'}}]");
  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.label), ["baseline", "rtk-hooks"]);
  const baseline = producerFor(config.producer, config.arms[0]!);
  const hooked = producerFor(config.producer, config.arms[1]!);
  assert.deepEqual(baseline.env, { PATH: "/opt/homebrew/bin:$PATH" });
  assert.equal(baseline.settings, undefined);
  // The shared block's variables and the arm's own both survive the merge.
  assert.deepEqual(hooked.env, { PATH: "/opt/homebrew/bin:$PATH", RTK_MODE: "on" });
  assert.equal(hooked.settings, join(root, "rtk-hooks.json"));
  assert.deepEqual(hooked.setup, ["echo built"]);

  // Only a claude producer can apply a settings file.
  await write("[{}, {producer: {settings: ./rtk-hooks.json}}]", "{agent: codex}");
  await assert.rejects(prepareRun(await loadConfig(join(root, "experiment.yaml")), paths), /only a claude producer can apply/);
  // The scrubbed home owns the isolation variables; PATH is the one exception.
  await write("[{}, {producer: {env: {HOME: /elsewhere}}}]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /may not set HOME/);
  // Arms that differ only in these fields are two arms; identical ones are a replicate that must be labelled.
  await write("[{producer: {setup: 'echo built'}}, {producer: {setup: 'echo built'}}]");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /deliberate replicate/);
  await write("[{producer: {env: {RTK_MODE: 'on'}}}, {producer: {env: {RTK_MODE: 'off'}}}]");
  // Two arms named after the same variable have to be labelled by hand.
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /both fall back to the label "rtk-mode"/);
  // The judge is never hooked up: it may only name its agent, model, effort, and timeout.
  await write("[{}, {producer: {effort: low}}]", "{agent: claude}", "{agent: claude, rubric: ./rubric.md, settings: ./rtk-hooks.json}");
  await assert.rejects(loadConfig(join(root, "experiment.yaml")), /judge may only set/);
  await removeTree(root);
});

test("extra environment variables expand against the scrubbed environment and nothing else", () => {
  const env = armEnvironment(scrubbedEnvironment("/tmp/rt", "claude"), {
    PATH: "/opt/homebrew/bin:$PATH",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
    CACHE: "${HOME}/cache",
    MISSING: "$NOT_SET/x",
  });
  assert.match(env.PATH!, /^\/opt\/homebrew\/bin:\/.+/);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8080");
  assert.equal(env.CACHE, "/tmp/rt/home/cache");
  assert.equal(env.MISSING, "/x");
  assert.equal(armEnvironment(scrubbedEnvironment("/tmp/rt", "claude"), undefined).PATH, process.env.PATH);
});

test("arm labels default to what each arm varied and can be overridden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crucible-test-"));
  await mkdir(join(dir, "footer"));
  await mkdir(join(dir, "elsewhere", "footer"), { recursive: true });
  await writeFile(join(dir, "rubric.md"), "quality\n");
  const base = ["source: {path: ., include: ['*']}", "task: do it", "producer: {agent: claude}", "judge: {agent: claude, rubric: ./rubric.md}"];
  const labelsOf = async (name: string) => (await loadConfig(join(dir, name))).arms.map((arm) => arm.label);
  const write = (name: string, ...lines: string[]) => writeFile(join(dir, name), ["name: t", ...lines, ...base].join("\n"));
  await write("candidate.yaml", "arms: [{}, {candidate: {path: ./footer}}]");
  await write("replaces.yaml", "arms: [{}, {candidate: {path: ./footer, replaces: footer}}]");
  await write("models.yaml", "arms: [{producer: {model: haiku}}, {producer: {model: sonnet, effort: high}}]");
  await write("three.yaml", "arms: [{}, {candidate: {path: ./footer}}, {producer: {effort: low}}]");
  await write("named.yaml", "series: footers", "arms: [{label: Footer Current}, {label: footer-revised, candidate: {path: ./footer}}]");
  await write("same.yaml", "arms: [{label: x}, {label: x, candidate: {path: ./footer}}]");
  await write("collide.yaml", "arms: [{candidate: {path: ./footer}}, {candidate: {path: ./elsewhere/footer}}]");
  assert.deepEqual(await labelsOf("candidate.yaml"), ["without-footer", "with-footer"]);
  assert.deepEqual(await labelsOf("replaces.yaml"), ["without-footer", "footer-variant"]);
  assert.deepEqual(await labelsOf("models.yaml"), ["haiku", "sonnet-high"]);
  assert.deepEqual(await labelsOf("three.yaml"), ["without-footer", "with-footer", "low"]);
  const named = await loadConfig(join(dir, "named.yaml"));
  assert.deepEqual(named.arms.map((arm) => arm.label), ["footer-current", "footer-revised"]);
  assert.equal(named.series, "footers");
  await assert.rejects(loadConfig(join(dir, "same.yaml")), /both labelled "x"/);
  await assert.rejects(loadConfig(join(dir, "collide.yaml")), /both fall back to the label "with-footer"/);
  await removeTree(dir);
});

test("verdict.json is checked, normalized, and revealed against the assignment", () => {
  const verdict = parseVerdict({
    winner: "B",
    confidence: 85,
    scores: [
      { criterion: "Reading", weight: 30, scores: { A: 6, B: 9 } },
      { criterion: "Craft", weight: 10, scores: { A: 9, B: 6.5 } },
    ],
    referenceGuess: { output: "B", confidence: 0.6 },
    summary: " Output B holds one measure; A's cards break it. ",
  }, judgeLetters(2));
  assert.equal(verdict.confidence, 0.85);
  const revealed = revealVerdict(verdict, { A: "hazel", B: "refero" }, ["hazel", "refero"]);
  assert.equal(revealed.winner, "refero");
  assert.equal(revealed.summary, "refero holds one measure; hazel's cards break it.");
  assert.deepEqual(revealed.totals, { hazel: 6.75, refero: 8.38 });
  assert.equal(revealed.margin, 1.63);
  assert.deepEqual(revealed.referenceGuess, { arm: "refero", confidence: 0.6, correct: false });
  // The judge's choice stands even when its own numbers disagree; the margin says so.
  const against = revealVerdict({ ...verdict, winner: "A" }, { A: "hazel", B: "refero" }, ["hazel", "refero"]);
  assert.equal(against.winner, "hazel");
  assert.equal(against.margin, -1.63);
  assert.throws(() => parseVerdict({ winner: "C", confidence: 0.5, scores: [] }, judgeLetters(2)), /winner must be/);
  assert.throws(() => parseVerdict({ winner: "A", confidence: 0.5, scores: [] }, judgeLetters(2)), /non-empty/);
  assert.throws(() => parseVerdict({ winner: "A", confidence: 0.5, scores: [{ criterion: "x", weight: 1, scores: { A: 11, B: 1 } }] }, judgeLetters(2)), /between 0 and 10/);
  assert.throws(() => parseVerdict({ winner: "A", confidence: 150, scores: [{ criterion: "x", weight: 1, scores: { A: 1, B: 1 } }] }, judgeLetters(2)), /confidence must be/);
});

test("the judge is told Playwright is available only when its workspace resolves it", () => {
  const run = { config: { task: "Improve the page", arms: [{ label: "baseline" }, { label: "variant" }] } } as ResolvedRun;
  const prompt = (tools: { playwright: boolean; chromium: boolean }) => judgePrompt(run, "/tmp/judge", ["A", "B"], [], tools);
  assert.match(prompt({ playwright: true, chromium: true }), /Playwright is available: require\("playwright"\) resolves from your working directory and its Chromium is installed/);
  assert.match(prompt({ playwright: true, chromium: false }), /its Chromium is not installed/);
  assert.doesNotMatch(prompt({ playwright: false, chromium: false }), /Playwright is available/);
});

test("the judge is asked to name the control arm, not an untouched source", () => {
  const letters = judgeLetters(5);
  const prompt = judgePrompt({ config: { task: "Improve the page", arms: [{ label: "baseline" }, { label: "variant" }] } } as ResolvedRun, "/tmp/judge", letters);
  assert.match(prompt, /One of the outputs is the control: it was produced without any candidate skill, tool, or setting override/);
  assert.match(prompt, /The control is one of A, B, C, D, E, so "none of them" is not an answer/);
  assert.match(prompt, /your guess at the control arm/);
  assert.doesNotMatch(prompt, /baseline/i);
  // A judge with nothing to go on may still answer null, and that is not counted as a hit.
  const verdict = parseVerdict({
    winner: "A",
    confidence: 0.5,
    scores: [{ criterion: "quality", weight: 1, scores: { A: 5, B: 6, C: 6, D: 6, E: 6 } }],
    referenceGuess: { output: null, confidence: 0 },
    summary: "",
  }, letters);
  const labels = ["one", "two", "three", "four", "five"];
  const armOf = Object.fromEntries(letters.map((letter, index) => [letter, labels[index]!]));
  assert.deepEqual(revealVerdict(verdict, armOf, labels).referenceGuess, { arm: null, confidence: 0, correct: null });
});

test("the report's markdown renderer covers a judge's verdict", () => {
  const html = renderMarkdown([
    "# Verdict",
    "",
    "Both **render** with `code` and a [link](https://example.com).",
    "",
    "| | A | B |",
    "|---|---|---|",
    "| Words | 2744 | 1954 |",
    "",
    "- one",
    "- two",
    "  continued",
    "",
    "```",
    "<pre> stays literal",
    "```",
  ].join("\n"));
  assert.match(html, /<h2>Verdict<\/h2>/);
  assert.match(html, /<b>render<\/b> with <code>code<\/code> and a <a href="https:\/\/example.com">link<\/a>/);
  assert.match(html, /<td class="num">2744<\/td>/);
  assert.match(html, /<li>two continued<\/li>/);
  assert.match(html, /&lt;pre&gt; stays literal/);
});

test("the markdown renderer links only web, mail, relative, and anchor targets", () => {
  const html = renderMarkdown([
    "[web](https://example.com) [mail](mailto:a@example.com) [page](outputs/a/index.html) [top](#verdict)",
    "[script](javascript:alert(1)) [data](data:text/html,x) [hidden](\u0001javascript:alert(1)) [Upper](JavaScript:alert(1))",
  ].join("\n"));
  for (const target of ["https://example.com", "mailto:a@example.com", "outputs/a/index.html", "#verdict"]) assert.ok(html.includes(`href="${target}"`), target);
  assert.doesNotMatch(html, /href="(javascript|data|JavaScript):/i);
  assert.match(html, /script/);
  assert.equal((html.match(/<a /g) ?? []).length, 4);
});

test("a series tallies its runs by label", () => {
  const result = (runId: string, winner: string, mono: number, refero: number): RunResult => ({
    runId, name: "t", series: "s", task: "", reportedAt: "2026-09-03T00:00:00.000Z", environment: "realistic",
    arms: [{ label: "mono", candidate: null, replaces: null }, { label: "refero", candidate: null, replaces: null }],
    producers: { mono: identity, refero: identity }, judgeAgent: identity,
    winner, confidence: 0.8, totals: { mono, refero }, margin: Math.abs(Number((refero - mono).toFixed(2))), scores: [],
    referenceGuess: { arm: null, confidence: 0, correct: null }, summary: "", cost: { mono: null, refero: null }, warnings: [], shots: null,
  });
  const view = { state: "reported" as const, createdAt: "", updatedAt: "", producers: {} };
  const runs = [
    { runId: "ab-00000001", name: "t", series: "s", view: { ...view, runId: "ab-00000001" }, result: result("ab-00000001", "refero", 7.28, 8.03) },
    { runId: "ab-00000002", name: "t", series: "s", view: { ...view, runId: "ab-00000002" }, result: result("ab-00000002", "mono", 8.5, 7.1) },
    { runId: "ab-00000003", name: "t", series: "other", view: { ...view, runId: "ab-00000003" }, result: null },
  ];
  const rendered = renderSeries(runs, "s");
  assert.match(rendered, /mono 1 · refero 1/);
  assert.match(rendered, /Mean total: mono 7.89 · refero 7.56/);
  assert.equal(resultCell(runs[1]!.result), "mono 8.50–7.10 80%");
  assert.equal(resultCell(null), "");
});

test("each adapter reads its own usage keys into one set of counts", () => {
  assert.deepEqual(
    adapterFor("claude").normalizeUsage({ input_tokens: 72, cache_creation_input_tokens: 92706, cache_read_input_tokens: 2378120, output_tokens: 45219 }),
    { input: 72, output: 45219, cacheRead: 2378120, cacheWrite: 92706 },
  );
  // Codex counts cached input inside input_tokens and reasoning inside output_tokens.
  assert.deepEqual(
    adapterFor("codex").normalizeUsage({ input_tokens: 150086, cached_input_tokens: 128256, cache_write_input_tokens: 0, output_tokens: 4559, reasoning_output_tokens: 1617 }),
    { input: 21830, output: 4559, cacheRead: 128256, cacheWrite: 0 },
  );
  assert.deepEqual(
    adapterFor("cursor").normalizeUsage({ inputTokens: 71792, outputTokens: 32852, cacheReadTokens: 1882290, cacheWriteTokens: 0 }),
    { input: 71792, output: 32852, cacheRead: 1882290, cacheWrite: 0 },
  );
  assert.equal(adapterFor("claude").normalizeUsage(null), null);
  assert.equal(adapterFor("claude").normalizeUsage({ nothing_familiar: 5 }), null);
});

test("claude usage is summed once per API call, and its output over every result event", () => {
  const stream = [
    { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } } },
    // The same message again, one line per content block.
    { type: "assistant", message: { id: "msg_1", usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } } },
    { type: "user", message: { content: [] } },
    { type: "assistant", message: { id: "msg_2", usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 } } },
    { type: "result", usage: { input_tokens: 6, output_tokens: 40, cache_read_input_tokens: 1200, cache_creation_input_tokens: 50 } },
    // A headless run can print more than one result event.
    { type: "result", usage: { input_tokens: 6, output_tokens: 25, cache_read_input_tokens: 1200, cache_creation_input_tokens: 50 } },
  ].map((line) => JSON.stringify(line)).join("\n");
  // Input-side counts are summed per message; output is every result event added up, since a message reports it before streaming ends.
  assert.deepEqual(adapterFor("claude").collectUsage(stream), { input_tokens: 6, output_tokens: 65, cache_read_input_tokens: 2200, cache_creation_input_tokens: 50 });
  assert.equal(adapterFor("claude").collectUsage("not json\n"), null);
  // Codex and Cursor print running totals, so the last one stands.
  const totals = [{ usage: { input_tokens: 10, output_tokens: 1 } }, { usage: { input_tokens: 25, output_tokens: 3 } }].map((line) => JSON.stringify(line)).join("\n");
  assert.deepEqual(adapterFor("codex").collectUsage(totals), { input_tokens: 25, output_tokens: 3 });
});

test("an arm reports its time and tokens, and says so when usage is missing", () => {
  const cost = armCost(identity, { wallTimeMs: 5000, usage: { input_tokens: 1000, output_tokens: 2000 } });
  assert.deepEqual(cost?.tokens, { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(describeCost(cost), "5s; 1k in, 2k out, 0 cache read, 0 cache write");
  assert.equal(armCost(identity, undefined), null);
  assert.equal(describeCost(armCost(identity, { wallTimeMs: 1000, usage: null })), "1s; tokens unavailable");
});

test("the gitignore matcher reads the patterns projects actually write", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  await writeFile(join(root, ".gitignore"), ["# build output", "dist/", "*.log", "!kept.log", "/tmp-cache", "site/**/generated", "", "  spaced.txt  "].join("\n"));
  const ignores = await gitignoreFilter(root);
  assert.equal(ignores("dist/index.html"), true);
  assert.equal(ignores("site/dist/assets/app.js"), true);
  assert.equal(ignores("dist", true), true);
  // `dist/` is a directory rule, so a file of that name is not covered.
  assert.equal(ignores("dist"), false);
  assert.equal(ignores("build.log"), true);
  assert.equal(ignores("docs/build.log"), true);
  assert.equal(ignores("kept.log"), false);
  assert.equal(ignores("tmp-cache/x"), true);
  assert.equal(ignores("site/tmp-cache/x"), false);
  assert.equal(ignores("site/a/b/generated/page.html"), true);
  assert.equal(ignores("spaced.txt"), true);
  assert.equal(ignores("src/index.ts"), false);
  // A project with no rules covers nothing.
  assert.equal((await gitignoreFilter(join(root, "nowhere")))("dist/index.html"), false);
  await removeTree(root);
});

/** Gives every arm the same finished workspace, the way a set of producers would. */
async function materializeOutputs(run: ResolvedRun, files: Record<string, string>): Promise<void> {
  for (const producerId of Object.keys(run.assignment.arms)) {
    const source = join(run.tempDir, producerId, "source");
    await copyTree(join(run.runDir, "frozen", "source"), source);
    await recordBaseline(run, producerId);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), content);
    }
  }
}

test("the judge's pictures are published under the arm labels, and what it could not picture is said", async () => {
  const { run, root } = await prepareFixture();
  const [first, second] = Object.keys(run.assignment.arms) as [string, string];
  const mapping = { A: second, B: first };
  const judgeDir = join(root, "judge");
  for (const letter of ["A", "B"]) await mkdir(join(judgeDir, "shots", letter), { recursive: true });
  await writeFile(join(judgeDir, "shots", "A", "01-index-desktop.png"), "A desktop\n");
  await writeFile(join(judgeDir, "shots", "A", "01-index-phone.png"), "A phone\n");
  await writeFile(join(judgeDir, "shots", "B", "index-desktop.png"), "B desktop\n");
  await writeFile(join(root, "elsewhere.png"), "not the judge's\n");
  await mkdir(join(run.runDir, "shots"), { recursive: true });
  await writeFile(join(run.runDir, "shots", "stale.png"), "from an earlier judging\n");
  await writeJson(join(judgeDir, "shots", "index.json"), {
    arms: {
      A: [{ page: "index.html", desktop: "shots/A/01-index-desktop.png", phone: "shots/A/01-index-phone.png" }],
      B: [
        { page: "index.html", desktop: "shots/B/index-desktop.png", phone: null, error: "phone: the page never finished loading" },
        { page: "NOTES.md", desktop: "../elsewhere.png", phone: "shots/B/gone.png", rendered: "markdown" },
      ],
    },
    omitted: { A: [], B: ["about.html"] },
  });

  const index = await publishShots(run, judgeDir, mapping);
  assert.equal(index.skipped, undefined);
  const [firstLabel, secondLabel] = [run.assignment.arms[first]!, run.assignment.arms[second]!];
  // A's pictures land under the arm it stood for, renamed the runner's way.
  assert.deepEqual(index.arms[secondLabel], [{ page: "index.html", desktop: `shots/${secondLabel}/01-index-desktop.png`, phone: `shots/${secondLabel}/01-index-phone.png` }]);
  assert.equal(await readFile(join(run.runDir, `shots/${secondLabel}/01-index-desktop.png`), "utf8"), "A desktop\n");
  // The judge's own error is kept; a picture outside its folder or missing is named, not copied.
  const [page, notes] = index.arms[firstLabel]!;
  assert.deepEqual(page, { page: "index.html", desktop: `shots/${firstLabel}/01-index-desktop.png`, phone: null, error: "phone: the page never finished loading" });
  assert.equal(notes?.rendered, "markdown");
  assert.equal(notes?.desktop, null);
  assert.equal(notes?.phone, null);
  assert.match(notes?.error ?? "", /outside shots\/B.*gone\.png is missing/);
  assert.deepEqual(index.omitted[firstLabel], ["about.html"]);
  assert.deepEqual(await readShotIndex(run.runDir), index);
  await assert.rejects(stat(join(run.runDir, "shots", "stale.png")), /ENOENT/);
  await removeTree(root);
});

test("a judge that wrote no pictures leaves a reason, not a failure", async () => {
  const { run, root } = await prepareFixture();
  const [first, second] = Object.keys(run.assignment.arms) as [string, string];
  const judgeDir = join(root, "judge");
  await mkdir(judgeDir, { recursive: true });
  assert.equal((await publishShots(run, judgeDir, { A: first, B: second })).skipped, "The judge wrote no screenshot index");
  await writeJson(join(judgeDir, "shots", "index.json"), { arms: { A: [], B: [] }, omitted: { A: [], B: [] } });
  assert.equal((await publishShots(run, judgeDir, { A: first, B: second })).skipped, "The judge pictured no pages");
  await removeTree(root);
});

function fixtureResult(run: ResolvedRun, totals: Record<string, number>): RunResult {
  const labels = run.config.arms.map((arm) => arm.label);
  return {
    runId: run.runId, name: run.config.name, series: null, task: run.config.task,
    reportedAt: "2026-09-03T00:00:00.000Z", environment: run.config.skills.environment,
    arms: run.config.arms.map((arm) => ({ label: arm.label, candidate: arm.candidate?.path ?? null, replaces: arm.candidate?.replaces ?? null })),
    producers: Object.fromEntries(labels.map((label) => [label, identity])), judgeAgent: identity,
    winner: labels[1]!, confidence: 0.8, totals, margin: Number((totals[labels[1]!]! - totals[labels[0]!]!).toFixed(2)),
    scores: [{ criterion: "quality", weight: 1, scores: totals }],
    referenceGuess: { arm: null, confidence: 0, correct: null }, summary: "",
    cost: Object.fromEntries(labels.map((label) => [label, null])), warnings: [], shots: null,
  };
}

async function withArchiveCaptures(run: ResolvedRun, result: RunResult, page = "index.html"): Promise<RunResult> {
  result.shots ??= { capturedAt: result.reportedAt, arms: {}, omitted: {} };
  for (const { label } of result.arms) {
    const captures = result.shots.arms[label] ??= [{ page, desktop: null, phone: null }];
    const capture = captures[0]!;
    if (capture.desktop || capture.phone) continue;
    capture.desktop = `shots/${label}/desktop.png`;
    await mkdir(join(run.runDir, "shots", label), { recursive: true });
    await writeFile(join(run.runDir, capture.desktop), "fixture capture");
  }
  return result;
}

test("archiving a run already in the archive refreshes it in place, keeping what a reader added", async () => {
  const { run, paths, root } = await prepareFixture();
  await materializeOutputs(run, { "index.html": "<h1>hi</h1>\n" });
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 }), "index.html"));
  await writeFile(join(run.runDir, "report.md"), "# fixture\n");
  await writeFile(join(run.runDir, "report.html"), "<h1>fixture</h1>\n");
  await mkdir(join(run.runDir, "judge", "agent"), { recursive: true });
  await writeFile(join(run.runDir, "judge", "agent", "stdout.jsonl"), '{"type":"turn.started"}\n');
  await setRunState(run.runDir, "reported");

  const destination = await archiveRun(run, paths.archiveRoot);
  const readmePath = join(destination, "README.md");
  const first = await readFile(readmePath, "utf8");
  assert.match(first, /with-candidate-skill won by 2.00: without-candidate-skill 6.00, with-candidate-skill 8.00 weighted/);
  await assert.rejects(stat(join(destination, "transcripts")), /ENOENT/);
  assert.deepEqual((await readdir(destination)).sort(), ["README.md", "dependencies", "outputs", "report.html", "result.json"]);
  await writeFile(readmePath, first + "\nA note only a reader could write.\n");

  await mkdir(join(run.runDir, "shots"), { recursive: true });
  await writeFile(join(run.runDir, "shots", "new-index.png"), "new capture\n");
  await mkdir(join(destination, "shots"), { recursive: true });
  await writeFile(join(destination, "shots", "old-board.png"), "stale capture\n");

  const resealed = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 9 });
  resealed.shots = { capturedAt: "2026-09-03T00:00:00.000Z", arms: { "with-candidate-skill": [{ page: "index.html", desktop: "shots/new-index.png", phone: null }] }, omitted: {} };
  await withArchiveCaptures(run, resealed);
  await writeJson(join(run.runDir, "result.json"), resealed);
  await writeFile(join(run.runDir, "report.html"), '<img src="shots/new-index.png">');
  await writeFile(join(run.runDir, "report.md"), "# fixture, resealed\n");
  // The outputs are gone, as they would be after crucible clean; a refresh must not need them.
  await removeTree(run.tempDir);
  await setRunState(run.runDir, "cleaned");

  assert.equal(await archiveRun(run, paths.archiveRoot), destination);
  assert.deepEqual(await readdir(paths.archiveRoot), [basename(destination)]);
  const refreshed = await readFile(readmePath, "utf8");
  assert.match(refreshed, /with-candidate-skill won by 3.00/);
  assert.match(refreshed, /A note only a reader could write\./);
  await assert.rejects(stat(join(destination, "REPORT.md")), /ENOENT/);
  assert.ok(refreshed.trim().split(/\s+/).length <= 200);
  assert.match(await readFile(join(destination, "report.html"), "utf8"), /dependencies\/shots\/new-index.png/);
  assert.equal((await readJson<JudgedResult>(join(destination, "result.json"))).totals["with-candidate-skill"], 9);
  assert.equal(await readFile(join(destination, "dependencies", "shots", "new-index.png"), "utf8"), "new capture\n");
  await assert.rejects(stat(join(destination, "shots", "old-board.png")), /ENOENT/);
  await removeTree(root);
});

test("a refresh keeps a reader's long notes and reports the length instead of dropping them", async () => {
  const { run, paths, root } = await prepareFixture();
  await materializeOutputs(run, { "index.html": "<h1>hi</h1>\n" });
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 }), "index.html"));
  await writeFile(join(run.runDir, "report.html"), "<h1>fixture</h1>\n");
  await setRunState(run.runDir, "reported");
  const destination = await archiveRun(run, paths.archiveRoot);
  const readmePath = join(destination, "README.md");

  // A reader's notes that take the README past the limit.
  const notes = `Hand-written notes: ${"word ".repeat(180).trim()}.`;
  await writeFile(readmePath, `# Old entry\n\n<!-- crucible:result -->\nstale facts\n<!-- /crucible:result -->\n\n${notes}\n`);
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 9 }), "index.html"));
  const warnings: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { warnings.push(chunk); return true; }) as typeof process.stderr.write;
  try { assert.equal(await archiveRun(run, paths.archiveRoot), destination); }
  finally { process.stderr.write = write; }

  const refreshed = await readFile(readmePath, "utf8");
  assert.equal(refreshed, `# Old entry\n\n<!-- crucible:result -->\nwith-candidate-skill won by 3.00: without-candidate-skill 6.00, with-candidate-skill 9.00 weighted. Judge confidence 80%.\n<!-- /crucible:result -->\n\n${notes}\n`);
  assert.match(warnings.join(""), /Warning: README\.md has \d+ words; expected 1–200/);
  assert.deepEqual(entryIssues(destination), [warnings.join("").match(/README\.md has \d+ words; expected 1–200/)![0]]);

  // A README with no markers at all keeps its text and gains the block.
  await writeFile(readmePath, "# By hand\n\nA note.\n");
  await archiveRun(run, paths.archiveRoot);
  assert.match(await readFile(readmePath, "utf8"), /^# By hand\n\nA note\.\n\n<!-- crucible:result -->\nwith-candidate-skill won by 3\.00/);
  await removeTree(root);
});

test("three arms: defaults, one candidate per arm, three letters, and the sealed result", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: a candidate for one arm\n---\n\n# Tone\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n2. clarity\n");
  await writeFile(join(root, "experiment.yaml"), [
    "name: three arms",
    "series: tone",
    "arms:",
    "  - {}",
    "  - {candidate: {path: ./tone-skill}}",
    "  - {producer: {effort: low}}",
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    "producer: {agent: claude, effort: high}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));

  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.label), ["without-tone-skill", "with-tone-skill", "low"]);
  const run = await prepareRun(config, paths);
  assert.equal(Object.keys(run.assignment.arms).length, 3);

  // Only the candidate's own arm sees it, and no other arm's context names it.
  for (const [producerId, label] of Object.entries(run.assignment.arms)) {
    const contextDir = join(run.runDir, "frozen", producerId, "context");
    const catalog = await readJson<SkillCatalogEntry[]>(join(contextDir, "skill-catalog.json"));
    assert.deepEqual(catalog.map((skill) => skill.name), label === "with-tone-skill" ? ["tone-skill"] : []);
    if (label !== "with-tone-skill") {
      await assert.rejects(stat(join(contextDir, "skills", "tone-skill")), /ENOENT/);
    }
  }

  const letters = judgeLetters(3);
  assert.deepEqual(letters, ["A", "B", "C"]);
  const verdict = parseVerdict({
    winner: "B",
    confidence: 0.7,
    scores: [
      { criterion: "quality", weight: 60, scores: { A: 5, B: 8, C: 6 } },
      { criterion: "clarity", weight: 40, scores: { A: 6, B: 7, C: 6 } },
    ],
    referenceGuess: { output: "A", confidence: 0.5 },
    summary: "The winner reads best.",
  }, letters);
  const armOf = { A: "without-tone-skill", B: "with-tone-skill", C: "low" };
  const revealed = revealVerdict(verdict, armOf, ["without-tone-skill", "with-tone-skill", "low"]);
  assert.equal(revealed.winner, "with-tone-skill");
  assert.deepEqual(revealed.totals, { "without-tone-skill": 5.4, "with-tone-skill": 7.6, low: 6 });
  assert.equal(revealed.margin, 1.6);
  assert.deepEqual(revealed.referenceGuess, { arm: "without-tone-skill", confidence: 0.5, correct: true });

  // What `crucible judge` would have left behind, so the report can be sealed.
  const producerIds = Object.keys(run.assignment.arms);
  const mapping = Object.fromEntries(letters.map((letter) => [
    letter,
    producerIds.find((id) => run.assignment.arms[id] === armOf[letter as keyof typeof armOf])!,
  ]));
  await writeJson(join(run.runDir, "judge", "mapping.json"), mapping);
  await writeFile(join(run.runDir, "judge", "verdict.md"), "# Verdict\n\nThe winner reads best.\n");
  await writeJson(join(run.runDir, "judge", "verdict.json"), verdict satisfies Verdict);
  await writeJson(join(run.runDir, "audit", "report.json"), {
    runId: run.runId, auditedAt: "2026-09-04T00:00:00.000Z", contextChanges: {}, leakFindings: {}, warnings: [],
  });
  await setRunState(run.runDir, "judged");
  await reportRun(run);

  const result = await readJson<JudgedResult>(join(run.runDir, "result.json"));
  assert.deepEqual(result.arms, [
    { label: "without-tone-skill", environment: "clean", candidate: null, replaces: null },
    { label: "with-tone-skill", environment: "clean", candidate, replaces: null },
    { label: "low", environment: "clean", candidate: null, replaces: null },
  ]);
  assert.equal(result.environment, "clean");
  assert.equal(result.series, "tone");
  assert.equal(result.winner, "with-tone-skill");
  assert.equal(result.margin, 1.6);
  assert.deepEqual(Object.keys(result.totals), ["without-tone-skill", "with-tone-skill", "low"]);
  assert.deepEqual(Object.keys(result.cost), ["without-tone-skill", "with-tone-skill", "low"]);
  assert.deepEqual(result.producers.low, { agent: "claude", model: null, effort: "low" });
  assert.deepEqual(Object.keys(result.scores[0]!.scores), ["without-tone-skill", "with-tone-skill", "low"]);
  assert.deepEqual(result.referenceGuess, { arm: "without-tone-skill", confidence: 0.5, correct: true });

  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /\| Criterion \| Weight \| without-tone-skill \| with-tone-skill \| low \|/);
  assert.match(markdown, /with-tone-skill won by 1.60/);
  assert.match(markdown, /Control arm guess: without-tone-skill at 50% \(correct\)\./);
  const html = await readFile(join(run.runDir, "report.html"), "utf8");
  assert.match(html, /<th class="num">low<\/th>/);

  // A judge that names an arm which did not score highest keeps its winner, and
  // the report says the numbers disagree.
  await writeJson(join(run.runDir, "judge", "verdict.json"), { ...verdict, winner: "A" } satisfies Verdict);
  await reportRun(run);
  const against = await readJson<JudgedResult>(join(run.runDir, "result.json"));
  assert.equal(against.winner, "without-tone-skill");
  assert.equal(against.margin, -2.2);
  assert.deepEqual(against.warnings, ["The judge named without-tone-skill the winner although with-tone-skill had the higher weighted total"]);
  assert.match(await readFile(join(run.runDir, "report.md"), "utf8"), /without-tone-skill won on the judge's call, 2.20 behind with-tone-skill/);
  await removeTree(root);
});

test("setup runs in the project, the shared command first, and a non-zero exit fails the arm", async () => {
  const { run, root } = await prepareFixture();
  const producerId = Object.keys(run.assignment.arms)[0]!;
  const producerDir = join(run.tempDir, producerId);
  await copyTree(join(run.runDir, "frozen", "source"), join(producerDir, "source"));
  // Without the Seatbelt wrapper, which the producer's own launch covers.
  const unsandboxed = { ...run, config: { ...run.config, sandbox: false } };
  const logDir = join(run.runDir, "producers", producerId);
  const setup = (commands: string[]) => runSetup({
    run: unsandboxed,
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
  await removeTree(root);
});

test("the judge's progress is tracked in state.json like a producer's, and a rerun starts its row afresh", async () => {
  const { run } = await prepareFixture();
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

test("an arm's changes are measured from after its setup, and the judge sees the project as it was frozen", async () => {
  const { run, root } = await prepareFixture();
  const [first, second] = Object.keys(run.assignment.arms) as [string, string];
  const unsandboxed = { ...run, config: { ...run.config, sandbox: false } };
  for (const producerId of [first, second]) {
    const producerDir = join(run.tempDir, producerId);
    await copyTree(join(run.runDir, "frozen", "source"), join(producerDir, "source"));
    // The tool's own installation: a file of its own, and its section in CLAUDE.md.
    assert.equal(await runSetup({
      run: unsandboxed,
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
  await removeTree(root);
});

test("the arm's own work is all that is counted or archived", async () => {
  const { run, paths, root } = await prepareFixture();
  const [first] = Object.keys(run.assignment.arms) as [string];
  for (const producerId of Object.keys(run.assignment.arms)) {
    const source = join(run.tempDir, producerId, "source");
    await copyTree(join(run.runDir, "frozen", "source"), source);
    // A setup step installing a tool: a folder of its own, and its line in a frozen file.
    await mkdir(join(source, "graphify-out"), { recursive: true });
    await writeFile(join(source, "graphify-out", "graph.txt"), "graph\n");
    await writeFile(join(source, "index.js"), "console.log('hi');\n// graphify\n");
    await recordBaseline(run, producerId);
    // The arm's own work, and what its build left behind.
    await writeFile(join(source, "page.html"), "<h1>arm</h1>\n");
    await mkdir(join(source, "dist", "assets"), { recursive: true });
    await writeFile(join(source, "dist", "index.html"), "<body></body>\n");
    await writeFile(join(source, "dist", "assets", "app.js"), "console.log(1);\n");
    await writeFile(join(source, "build.log"), "noise\n");
    await writeFile(join(source, "kept.log"), "kept\n");
  }

  // The changed count sees the arm's files and nothing else.
  assert.deepEqual(await armChanges(run, first), ["added: kept.log", "added: page.html"]);

  // So does the judge's copy: the build output goes whole, the negated pattern stays.
  const copy = join(root, "judge-input", "A");
  await copyTree(join(run.tempDir, first, "source"), copy);
  assert.equal(await withholdNonArmFiles(run.runDir, first, copy), 5);
  await assert.rejects(stat(join(copy, "dist")), /ENOENT/);
  await assert.rejects(stat(join(copy, "build.log")), /ENOENT/);
  assert.equal(await readFile(join(copy, "kept.log"), "utf8"), "kept\n");

  // And so does the archive, which used to copy the workspace raw.
  await writeJson(join(run.runDir, "result.json"), await withArchiveCaptures(run, fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 }), "page.html"));
  await writeFile(join(run.runDir, "report.md"), "# fixture\n");
  await writeFile(join(run.runDir, "report.html"), "<h1>fixture</h1>\n");
  await setRunState(run.runDir, "reported");
  const output = join(await archiveRun(run, paths.archiveRoot), "outputs", run.assignment.arms[first]!);
  assert.equal(await readFile(join(output, "page.html"), "utf8"), "<h1>arm</h1>\n");
  await assert.rejects(stat(join(output, "dist")), /ENOENT/);
  await assert.rejects(stat(join(output, "graphify-out")), /ENOENT/);
  await assert.rejects(stat(join(output, "index.js")), /ENOENT/);
  await assert.rejects(stat(join(output, "kept.log")), /ENOENT/);
  await removeTree(root);
});


test("archives retain referenced runtime assets and discard unrelated captures and source", async () => {
  const { run, paths, root } = await prepareFixture();
  await materializeOutputs(run, {
    "index.html": '<link rel="stylesheet" href="style.css"><script src="app.js"></script>',
    "style.css": 'body { background: url("image.svg") }',
    "image.svg": '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    "app.js": 'console.log("ready")',
    "scratch.png": "unused capture",
    "source.ts": "unused source",
  });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = {
    capturedAt: result.reportedAt,
    arms: Object.fromEntries(result.arms.map(({ label }) => [label, [{ page: "index.html", desktop: null, phone: null }]])),
    omitted: {},
  };
  await withArchiveCaptures(run, result, "index.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  for (const { label } of result.arms) {
    assert.deepEqual((await readdir(join(archive, "outputs", label))).sort(), ["app.js", "image.svg", "index.html", "style.css"]);
  }
  await cleanRun(run);
  assert.ok((await stat(join(run.runDir, "result.json"))).isFile());
  assert.ok((await stat(join(run.runDir, "frozen", "source"))).isDirectory());
  await removeTree(root);
});


test("archives follow import-map mappings to vendored modules", async () => {
  const { run, paths, root } = await prepareFixture();
  await materializeOutputs(run, {
    "index.html": [
      '<script type="importmap">',
      '{"imports": {"three": "./vendor/three.module.js", "three/addons/": "./vendor/jsm/"}}',
      "</script>",
      '<script type="module" src="./src/main.js"></script>',
    ].join("\n"),
    "src/main.js": "import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n",
    "vendor/three.module.js": "export const Scene = 1;",
    "vendor/jsm/controls/OrbitControls.js": "import { Vector3 } from 'three';\nimport { helper } from '../utils/helper.js';\nexport class OrbitControls {}",
    "vendor/jsm/utils/helper.js": "export const helper = 1;",
    "vendor/jsm/unused/Other.js": "export const other = 1;",
  });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  await withArchiveCaptures(run, result, "index.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  for (const { label } of result.arms) {
    const output = join(archive, "outputs", label);
    assert.ok((await stat(join(output, "vendor/three.module.js"))).isFile());
    assert.ok((await stat(join(output, "vendor/jsm/controls/OrbitControls.js"))).isFile());
    assert.ok((await stat(join(output, "vendor/jsm/utils/helper.js"))).isFile());
    assert.equal(await stat(join(output, "vendor/jsm/unused/Other.js")).catch(() => null), null);
  }
  await removeTree(root);
});

test("archive refresh leaves the existing entry intact when a new capture is missing", async () => {
  const { run, paths, root } = await prepareFixture();
  await materializeOutputs(run, {});
  for (const producerId of Object.keys(run.assignment.arms)) {
    const nested = join(run.tempDir, producerId, "source", "nested");
    await mkdir(nested);
    await writeFile(join(nested, "index.html"), "<h1>Final</h1>");
  }
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  await withArchiveCaptures(run, result, "nested/index.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const archive = await archiveRun(run, paths.archiveRoot);
  const before = await readFile(join(archive, "result.json"), "utf8");
  await cleanRun(run);
  await archiveRun(run, paths.archiveRoot);
  assert.equal(await readFile(join(archive, "outputs", result.arms[0]!.label, "nested/index.html"), "utf8"), "<h1>Final</h1>");
  result.shots = {
    capturedAt: result.reportedAt,
    arms: { [result.arms[0]!.label]: [{ page: "nested/index.html", desktop: "shots/missing.png", phone: null }] },
    omitted: {},
  };
  await writeJson(join(run.runDir, "result.json"), result);
  await assert.rejects(archiveRun(run, paths.archiveRoot), /ENOENT/);
  assert.equal(await readFile(join(archive, "result.json"), "utf8"), before);
  assert.deepEqual(await readdir(paths.archiveRoot), [basename(archive)]);
  await removeTree(root);
});


test("archives reject missing selected pages and development-server entrypoints", async () => {
  const { run, paths, root } = await prepareFixture();
  try {
    await materializeOutputs(run, { "index.html": '<script type="module" src="/src/main.ts"></script>' });
    const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
    result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, [{ page: "missing.html", desktop: null, phone: null }]])), omitted: {} };
    await writeJson(join(run.runDir, "result.json"), result);
    await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
    await setRunState(run.runDir, "reported");
    await assert.rejects(archiveRun(run, paths.archiveRoot), /Selected final artifact is missing/);
    for (const shots of Object.values(result.shots.arms)) shots[0]!.page = "index.html";
    await writeJson(join(run.runDir, "result.json"), result);
    await assert.rejects(archiveRun(run, paths.archiveRoot), /needs a build/);
    assert.deepEqual(await readdir(paths.archiveRoot), []);
  } finally { await removeTree(root); }
});

test("archives explicitly selected ignored builds and refreshes them after cleanup", async () => {
  const { run, paths, root } = await prepareFixture();
  try {
    for (const producerId of Object.keys(run.assignment.arms)) {
      await mkdir(join(run.tempDir, producerId, "source", "dist", "assets"), { recursive: true });
    }
    await materializeOutputs(run, {
      ".gitignore": "dist/\n",
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "dist/index.html": '<script type="module" src="./assets/app.js"></script>',
      "dist/assets/app.js": 'import "./chunk.js"; document.body.dataset.ready = "yes";',
      "dist/assets/chunk.js": 'console.log("ready")',
      "dist/unused.png": "unreferenced",
    });
    const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
    result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, [
      { page: "Showcase", artifact: "index.html", desktop: null, phone: null },
    ]])), omitted: {} };
    await withArchiveCaptures(run, result, "index.html");
  await writeJson(join(run.runDir, "result.json"), result);
    await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
    await setRunState(run.runDir, "reported");
    await assert.rejects(archiveRun(run, paths.archiveRoot), /needs a build/);
    await assert.rejects(archiveRun(run, paths.archiveRoot, "../outside"), /leaves its folder/);
    await assert.rejects(archiveRun(run, paths.archiveRoot, "missing"), /Build directory is missing/);
    const archive = await archiveRun(run, paths.archiveRoot, "dist");
    for (const { label } of result.arms) {
      const output = join(archive, "outputs", label);
      assert.equal(await readFile(join(output, "index.html"), "utf8"), '<script type="module" src="./assets/app.js"></script>');
      assert.deepEqual((await readdir(join(output, "assets"))).sort(), ["app.js", "chunk.js"]);
      await assert.rejects(stat(join(output, "unused.png")), /ENOENT/);
    }
    await cleanRun(run);
    assert.equal(await archiveRun(run, paths.archiveRoot, "dist"), archive);
    assert.equal(await readFile(join(archive, "outputs", result.arms[0]!.label, "assets/chunk.js"), "utf8"), 'console.log("ready")');
  } finally { await removeTree(root); }
});

test("archives root-relative HTML linked by a portable final page", async () => {
  const { run, paths, root } = await prepareFixture();
  try {
    await materializeOutputs(run, {
      "explanation.html": '<a href="paper.html#finding">Read the source</a>',
      "paper.html": '<link rel="stylesheet" href="/assets/paper.css"><h1 id="finding">Source</h1>',
    });
    const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
    result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, [
      { page: "Complete explainer", artifact: "explanation.html", desktop: null, phone: null },
    ]])), omitted: {} };
    await withArchiveCaptures(run, result, "explanation.html");
  await writeJson(join(run.runDir, "result.json"), result);
    await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
    await setRunState(run.runDir, "reported");
    const archive = await archiveRun(run, paths.archiveRoot);
    for (const { label } of result.arms) {
      assert.deepEqual((await readdir(join(archive, "outputs", label))).sort(), ["explanation.html", "paper.html"]);
    }
  } finally { await removeTree(root); }
});

test("archives preserve final code-only changes with an empty capture index", async () => {
  const { run, paths, root } = await prepareFixture();
  try {
    await materializeOutputs(run, { "solution.py": "print(42)\n" });
    const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
    result.shots = { capturedAt: result.reportedAt, arms: Object.fromEntries(result.arms.map(({ label }) => [label, []])), omitted: {} };
    await writeJson(join(run.runDir, "result.json"), result);
    await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
    await setRunState(run.runDir, "reported");
    const archive = await archiveRun(run, paths.archiveRoot);
    for (const { label } of result.arms) assert.equal(await readFile(join(archive, "outputs", label, "solution.py"), "utf8"), "print(42)\n");
    await assert.rejects(stat(join(archive, "source")), /ENOENT/);
  } finally { await removeTree(root); }
});


test("Codex collaboration calls are recorded as tool calls that say who they reached", () => {
  const adapter = adapterFor("codex");
  // Shapes from crucible smoke ab-67146973 (Codex 0.153.4): the wait items carry no receiver, and no spawn item is emitted.
  const wait = { id: "item_2", type: "collab_tool_call", tool: "wait", sender_thread_id: "parent", receiver_thread_ids: [], prompt: null, agents_states: {}, status: "in_progress" };
  const spawn = { id: "item_9", type: "collab_tool_call", tool: "spawn_agent", sender_thread_id: "parent", receiver_thread_ids: ["child-1"], prompt: "Review  output.html\nindependently", agents_states: { "child-1": "running" }, status: "completed" };
  const [started] = adapter.parseEvent(JSON.stringify({ type: "item.started", item: wait }), "p-test");
  const [finished] = adapter.parseEvent(JSON.stringify({ type: "item.completed", item: { ...wait, status: "completed" } }), "p-test");
  assert.equal(started?.kind, "tool.started");
  assert.equal(finished?.kind, "tool.finished");
  assert.equal(started?.summary, "collab wait; no receivers");
  const [spawned] = adapter.parseEvent(JSON.stringify({ type: "item.completed", item: spawn }), "p-test");
  assert.equal(spawned?.kind, "tool.finished");
  assert.equal(spawned?.nativeId, "item_9");
  assert.equal(spawned?.summary, "collab spawn_agent; receivers child-1; states child-1=running; prompt Review output.html independently");
});

test("Codex item lifecycle counts commands and edits once without counting messages or updates", async () => {
  const { run, root } = await prepareFixture();
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
  await removeTree(root);
});


test("archives use actual artifacts independently of slide labels and URL fragments", async () => {
  const { run, root } = await prepareFixture();
  await materializeOutputs(run, { "deck.html": "<!doctype html><h1>A finished deck</h1>" });
  const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
  result.shots = { capturedAt: new Date().toISOString(), omitted: {}, arms: Object.fromEntries(result.arms.map((arm) => [arm.label, [
    { page: "Opening slide", artifact: "deck.html", desktop: null, phone: null },
    { page: "Slide 4", artifact: "deck.html?mode=present#/4", desktop: null, phone: null },
  ]])) };
  await withArchiveCaptures(run, result, "deck.html");
  await writeJson(join(run.runDir, "result.json"), result);
  await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
  await setRunState(run.runDir, "reported");
  const destination = await archiveRun(run, join(root, "archive"));
  for (const arm of result.arms) assert.deepEqual(await readdir(join(destination, "outputs", arm.label)), ["deck.html"]);
  assert.equal(await archiveRun(run, join(root, "archive")), destination);
  for (const shots of Object.values(result.shots.arms)) shots[0]!.artifact = "../outside.html";
  await writeJson(join(run.runDir, "result.json"), result);
  await assert.rejects(archiveRun(run, join(root, "archive")), /leaves its folder/);
  await removeTree(root);
});

test("visual archives require each arm's screenshot before publication", async () => {
  const { run, paths, root } = await prepareFixture();
  try {
    await materializeOutputs(run, { "index.html": "<h1>Finished scene</h1>" });
    const result = fixtureResult(run, { "without-candidate-skill": 6, "with-candidate-skill": 8 });
    await writeJson(join(run.runDir, "result.json"), result);
    await writeFile(join(run.runDir, "report.html"), "<h1>Comparison</h1>");
    await setRunState(run.runDir, "reported");
    await assert.rejects(archiveRun(run, paths.archiveRoot), /Visual output .* requires a representative screenshot/);
    assert.deepEqual(await readdir(paths.archiveRoot), []);
    await withArchiveCaptures(run, result);
    await writeJson(join(run.runDir, "result.json"), result);
    const archive = await archiveRun(run, paths.archiveRoot);
    for (const { label } of result.arms) assert.equal(await readFile(join(archive, "dependencies", "shots", label, "desktop.png"), "utf8"), "fixture capture");
  } finally { await removeTree(root); }
});


test("reuse config is explicit and cannot pretend to run a candidate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crucible-reuse-"));
  const configPath = join(dir, "experiment.yaml");
  const write = (arm: string) => writeFile(configPath, [
    "name: reuse", `arms: [{}, ${arm}]`, "source: {path: ., include: ['*']}",
    "task: improve", "producer: {agent: codex}", "judge: {agent: codex, rubric: rubric.md}",
  ].join("\n"));
  await write("{reuse: {run: ab-12345678, arm: prior}}");
  const config = await loadConfig(configPath);
  assert.deepEqual(config.arms[1], { label: "frozen-prior", reuse: { run: "ab-12345678", arm: "prior" } });
  await write("{reuse: {run: ab-12345678, arm: prior}, candidate: {path: x}}");
  await assert.rejects(loadConfig(configPath), /cannot be combined/);
  await write("{reuse: {run: ab-12345678, arm: prior}, producer: {model: x}}");
  await assert.rejects(loadConfig(configPath), /cannot be combined/);
  await write("{reuse: {run: ../outside, arm: prior}}");
  await assert.rejects(loadConfig(configPath), /must be a run ID/);
  await removeTree(dir);
});

test("reused outputs survive historical cleanup, skip producers, and reach judging unchanged", async () => {
  const { run: old, paths, root } = await prepareFixture();
  try {
    const oldIds = Object.keys(old.assignment.arms);
    for (const [index, id] of oldIds.entries()) {
      const source = join(old.tempDir, id, "source");
      await copyTree(join(old.runDir, "frozen", "source"), source);
      await recordBaseline(old, id);
      await writeFile(join(source, "index.html"), `<canvas>${index}</canvas>`);
      await mkdir(join(source, "dist"));
      await writeFile(join(source, "dist", "ignored.html"), "ignored build");
      await updateProducer(old.runDir, id, { state: "complete" });
    }
    const judgeInput = join(old.tempDir, "judge", "input");
    const mapping = { A: oldIds[0]!, B: oldIds[1]! };
    await copyJudgeInputs(old, judgeInput, mapping);
    await recordReusableInputs(old.runDir, judgeInput, mapping);
    const materialPath = join(old.runDir, "audit", "forbidden-material.json");
    const historicalMaterial = await readJson<ForbiddenMaterial>(materialPath);
    historicalMaterial.hashes.push({ arm: old.assignment.arms[oldIds[0]!]!, value: await sha256File(join(judgeInput, "A", "index.html")) });
    await writeJson(materialPath, historicalMaterial);
    await writeJson(join(old.runDir, "audit", "report.json"), { contextChanges: {}, leakFindings: {}, warnings: [] });
    await writeJson(join(old.runDir, "judge", "package-scan.json"), { findings: [{ path: "A/index.html", identity: { label: "historical skill hash", value: "some-hash", kind: "identifier" } }] });
    await updateJudge(old.runDir, { state: "complete" });
    await setRunState(old.runDir, "judged");
    const arms = oldIds.map((id, index) => ({ label: `frozen-${index}`, reuse: { run: old.runId, arm: old.assignment.arms[id]! } }));
    const config = { ...old.config, arms };
    await setRunState(old.runDir, "produced");
    await assert.rejects(prepareRun(config, paths), /successfully judged run/);
    await setRunState(old.runDir, "judged");
    await assert.rejects(prepareRun({ ...config, task: "different" }, paths), /different task/);
    await updateProducer(old.runDir, oldIds[0]!, { timedOut: true });
    await assert.rejects(prepareRun(config, paths), /without a timeout/);
    await updateProducer(old.runDir, oldIds[0]!, { timedOut: false });
    await writeFile(join(old.tempDir, oldIds[0]!, "source", "index.html"), "changed after judging");
    const judgedHtml = await readFile(join(judgeInput, "A", "index.html"), "utf8");
    await writeFile(join(judgeInput, "A", "index.html"), "tampered judge evidence");
    await assert.rejects(prepareRun(config, paths), /historical judged input changed/);
    await writeFile(join(judgeInput, "A", "index.html"), judgedHtml);
    const run = await prepareRun(config, paths);
    const reusedA = Object.keys(run.assignment.arms).find((id) => run.assignment.arms[id] === "frozen-0")!;
    assert.equal(await readFile(join(run.runDir, "frozen", reusedA, "output", "index.html"), "utf8"), judgedHtml);
    await removeTree(old.tempDir);
    await startRun(run); // No provider CLI or auth is needed for frozen outputs.
    const state = await readRunState(run.runDir);
    assert.equal(state.state, "produced");
    assert.ok(Object.values(state.producers).every((producer) => producer.state === "complete" && producer.pid === undefined));
    const ids = Object.keys(run.assignment.arms);
    for (const id of ids) {
      assert.deepEqual(await readJson(join(run.tempDir, id, ".context", "skill-catalog.json")), []);
      assert.deepEqual(await readJson(join(run.tempDir, id, ".context", "subagent-catalog.json")), []);
      await assert.rejects(stat(join(run.runDir, "cost", `${id}.json`)), /ENOENT/);
      await assert.rejects(stat(join(run.tempDir, id, "source", "dist")), /ENOENT/);
    }
    const input = join(root, "judge-copy");
    await copyJudgeInputs(run, input, { A: ids[0]!, B: ids[1]! });
    assert.equal(await readFile(join(input, "A", "index.html"), "utf8"), await readFile(join(run.tempDir, ids[0]!, "source", "index.html"), "utf8"));
    const carried = hiddenFrom(await readJson<ForbiddenMaterial>(join(run.runDir, "audit", "forbidden-material.json")), null);
    const reuseScan = await scanFiles(join(run.tempDir, reusedA, "source"), ["index.html"], carried.identities, carried.hashes);
    assert.ok(reuseScan.some((finding) => finding.identity.label === "forbidden file hash"));
    assert.match(judgePrompt(run, join(root, "judge"), ["A", "B"]), /not an independent producer sample/);
    await writeJson(join(run.runDir, "judge", "mapping.json"), { A: ids[0], B: ids[1] });
    await writeJson(join(run.runDir, "judge", "verdict.json"), { winner: "A", confidence: 0.7, scores: [{ criterion: "quality", weight: 1, scores: { A: 8, B: 7 } }], referenceGuess: { output: null, confidence: 0 }, summary: "The winner is stronger." });
    await writeFile(join(run.runDir, "judge", "verdict.md"), "The winner is stronger.");
    await setRunState(run.runDir, "judged");
    await reportRun(run);
    const result = await readJson<RunResult>(join(run.runDir, "result.json"));
    assert.ok(result.warnings.some((warning) => warning.includes("not an independent producer sample")));
    assert.ok(result.warnings.some((warning) => warning.includes("Historical judge identity finding: index.html (historical skill hash)")));
    assert.ok(result.arms.every((arm) => arm.reuse?.run === old.runId));
    assert.ok(Object.values(result.cost).every((cost) => cost === null));
    await recordReusableInputs(run.runDir, input, { A: ids[0]!, B: ids[1]! });
    await updateJudge(run.runDir, { state: "complete" });
    await writeJson(join(run.runDir, "judge", "package-scan.json"), { findings: [] });
    await removeTree(input);
    await removeTree(run.tempDir);
    const chained = await prepareRun({ ...config, arms: run.config.arms.map((arm) => ({ label: arm.label, reuse: { run: run.runId, arm: arm.label } })) }, paths);
    assert.ok(chained.config.arms.every((arm) => arm.reuse?.run === run.runId));
  } finally {
    await removeTree(root);
  }
});

test("clean mode snapshots nothing shared unless the experiment asks, and a craft dependency reaches one arm", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(root);
});

test("arms may mix environments: each gets its own baseline, and a clean arm may name what realistic arms already have", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  try {
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
    await assert.rejects(prepare("[{}, {environment: clean, reuse: {run: ab-00000000, arm: x}}]"), /reuse cannot be combined with candidate, producer, or environment/);
    await assert.rejects(prepare("[{}, {environment: sterile}]"), /arms\[1\]\.environment must be realistic or clean/);
  } finally { await removeTree(root); }
});

test("arms may run different agents: labels, per-arm checks, and the agent each arm launches", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  try {
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
    await writeFile(join(root, "rubric.md"), "1. quality\n");
    await writeFile(join(root, "settings.json"), "{}\n");
    const load = async (arms: string) => {
      await writeFile(join(root, "experiment.yaml"), [
        "name: harnesses",
        `arms: ${arms}`,
        "source: {path: ./project, include: ['*']}",
        "task: do it",
        "producer: {agent: claude, model: claude-opus-5-5, effort: high}",
        "skills: {environment: clean, root: ./no-skills}",
        "subagents: {root: ./no-agents}",
        "judge: {agent: claude, rubric: ./rubric.md}",
      ].join("\n"));
      return loadConfig(join(root, "experiment.yaml"));
    };
    const config = await load("[{label: opus}, {producer: {agent: codex, model: gpt-6-sol, effort: high}}]");
    assert.deepEqual(config.arms.map((arm) => arm.label), ["opus", "codex-gpt-6-sol-high"]);
    assert.deepEqual(config.arms.map((arm) => producerFor(config.producer, arm).agent), ["claude", "codex"]);
    assert.equal(producerFor(config.producer, config.arms[1]!).model, "gpt-6-sol");

    await assert.rejects(load("[{}, {producer: {agent: gemini}}]"), /arms\[1\]\.producer\.agent must be one of/);
    await assert.rejects(load("[{}, {producer: {agent: cursor, mcpServers: {tool: {command: /bin/true}}}}]"), /mcpServers supports claude and codex/);
    const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
    await assert.rejects(
      prepareRun(await load("[{producer: {settings: ./settings.json}}, {producer: {agent: codex, settings: ./settings.json}}]"), paths),
      /codex runs with producer.settings, which only a claude producer can apply/,
    );
  } finally { await removeTree(root); }
});

test("one arm is scored against the rubric alone: no margin, no control guess", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const paths: PathsConfig = { runRoot: join(root, "runs"), tempRoot: join(root, "temp"), archiveRoot: join(root, "archive") };
  const candidate = join(root, "tone-skill");
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: the only candidate\n---\n\n# Tone\n");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(join(root, "project", "index.js"), "console.log('hi');\n");
  await writeFile(join(root, "rubric.md"), "1. quality\n");
  await writeFile(join(root, "experiment.yaml"), [
    "name: one arm",
    "arms: [{candidate: {path: ./tone-skill}}]",
    "source: {path: ./project, include: ['*']}",
    "task: do it",
    "producer: {agent: claude}",
    "skills: {environment: clean, root: ./no-skills}",
    "subagents: {root: ./no-agents}",
    "judge: {agent: claude, rubric: ./rubric.md}",
  ].join("\n"));
  const config = await loadConfig(join(root, "experiment.yaml"));
  assert.deepEqual(config.arms.map((arm) => arm.label), ["with-tone-skill"]);
  const run = await prepareRun(config, paths);
  assert.equal(Object.keys(run.assignment.arms).length, 1);

  const letters = judgeLetters(1);
  assert.deepEqual(letters, ["A"]);
  assert.match(judgePrompt(run, join(root, "judge"), letters), /score one anonymous output/);
  assert.doesNotMatch(judgePrompt(run, join(root, "judge"), letters), /referenceGuess/);
  const verdict = parseVerdict({
    winner: "A",
    confidence: 0.6,
    scores: [{ criterion: "quality", weight: 100, scores: { A: 7 } }],
    summary: "The output meets the bar.",
  }, letters);
  assert.deepEqual(verdict.referenceGuess, { output: null, confidence: 0 });
  const revealed = revealVerdict(verdict, { A: "with-tone-skill" }, ["with-tone-skill"]);
  assert.equal(revealed.margin, null);
  assert.equal(revealed.winner, "with-tone-skill");

  const producerId = Object.keys(run.assignment.arms)[0]!;
  await writeJson(join(run.runDir, "judge", "mapping.json"), { A: producerId });
  await writeFile(join(run.runDir, "judge", "verdict.md"), "# Verdict\n\nIt meets the bar.\n");
  await writeJson(join(run.runDir, "judge", "verdict.json"), verdict satisfies Verdict);
  await writeJson(join(run.runDir, "audit", "report.json"), {
    runId: run.runId, auditedAt: "2026-09-04T00:00:00.000Z", contextChanges: {}, leakFindings: {}, warnings: [],
  });
  await setRunState(run.runDir, "judged");
  await reportRun(run);

  const result = await readJson<JudgedResult>(join(run.runDir, "result.json"));
  assert.equal(result.margin, null);
  assert.deepEqual(result.warnings, []);
  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /with-tone-skill scored 7.00: with-tone-skill 7.00 weighted/);
  assert.match(markdown, /\| Criterion \| Weight \| with-tone-skill \|/);
  assert.match(markdown, /One arm ran alone/);
  assert.match(await readFile(join(run.runDir, "report.html"), "utf8"), /One arm ran alone/);
  assert.equal(resultCell(result), "with-tone-skill 7.00 60%");
  await removeTree(root);
});

test("the shared sweep drops shared files naming a candidate and leaves an arm's own style pack alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(root);
});

test("a candidate dependency that is a single file is hashed like a folder of them", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
  const candidate = join(root, "tone-skill");
  await mkdir(join(root, "crafts"), { recursive: true });
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: d\n---\n\n# Tone\n");
  const craft = join(root, "crafts", "writing.md");
  await writeFile(craft, "Write plainly.\n");
  const hashes = await collectForbiddenHashes(candidate, [craft]);
  assert.ok(hashes.has(await sha256File(craft)), "a file dependency contributes its own hash");
  assert.ok(hashes.has(await sha256File(join(candidate, "SKILL.md"))));
  await removeTree(root);
});

test("replicate arms with the same candidate do not leak into each other", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-test-"));
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
  await removeTree(root);
});
