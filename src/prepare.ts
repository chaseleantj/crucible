import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { environmentFor, producerFor, sharedFoldersFor } from "./config.js";
import { buildForbiddenIdentities, collectForbiddenHashes, hiddenFrom, scanFiles } from "./leaks.js";
import { UserError } from "./errors.js";
import {
  assertDirectory,
  assertFile,
  buildManifest,
  copySelectedSource,
  listSkillDirectories,
  removeTree,
  samePath,
  sha256File,
  sha256Text,
  writePrivateFile,
} from "./files.js";
import { readJson, writeJson } from "./json.js";
import { pathsConfig } from "./paths.js";
import { hiddenFolders, nodeModulesWarning } from "./sandbox.js";
import { producerOf } from "./run.js";
import { freezeReusedOutputs } from "./reuse.js";
import {
  insideSharedFolders,
  replacedBaselineSkill,
  replacedSkillNames,
  resolveSkillExclusions,
  sharedDependencyKind,
  skillMetadata,
  snapshotSkills,
} from "./skills.js";
import { readSubagentDefinition, snapshotSubagents, subagentDependencies } from "./subagents.js";
import { createRunState } from "./state.js";
import type {
  ArmConfig,
  Assignment,
  CandidateConfig,
  ExperimentConfig,
  ForbiddenHash,
  ForbiddenIdentity,
  ForbiddenMaterial,
  LeakFinding,
  PathsConfig,
  ResolvedRun,
  SkillEnvironment,
} from "./types.js";

/** Where the run keeps what must not cross from one arm to another. */
export const MATERIAL_FILE = join("audit", "forbidden-material.json");

/**
 * Preparation freezes everything a run needs under the run directory: one copy
 * of the selected source and, per arm, a pristine context of frozen skills.
 * Producer workspaces are materialized from these copies at start, so
 * restarting a failed arm is the same operation as starting it.
 */
export async function prepareRun(unresolved: ExperimentConfig, paths: PathsConfig = pathsConfig()): Promise<ResolvedRun> {
  // Categories are resolved to names once, here, so every later check and the
  // run's own record speak of the skills that were actually withheld.
  const config: ExperimentConfig = {
    ...unresolved,
    skills: { ...unresolved.skills, exclude: await resolveSkillExclusions(unresolved) },
  };
  await validateInputs(config);
  const runId = `ab-${randomBytes(4).toString("hex")}`;
  const runDir = join(paths.runRoot, runId);
  const tempDir = join(paths.tempRoot, runId);
  const producerIds = config.arms.map(() => `p-${randomBytes(3).toString("hex")}`);
  const seed = randomBytes(16).toString("hex");
  const assignment: Assignment = {
    seed,
    arms: Object.fromEntries(shuffle(producerIds, seed).map((id, index) => [id, config.arms[index]!.label])),
  };

  await Promise.all([
    mkdir(paths.runRoot, { recursive: true, mode: 0o700 }),
    mkdir(paths.tempRoot, { recursive: true, mode: 0o700 }),
  ]);
  await mkdir(runDir, { recursive: false, mode: 0o700 });
  await mkdir(tempDir, { recursive: true, mode: 0o700 });

  try {
    await writeRunRecords(runDir, tempDir, runId, config, assignment);
    await freezeInputs(runDir, config, assignment);
    await freezeReusedOutputs(runDir, config, assignment, paths);
    await createRunState(runDir, runId, producerIds);
    const warning = config.sandbox ? nodeModulesWarning(config.nodeModules, hiddenFolders(config, paths)) : null;
    if (warning) process.stderr.write(`Warning: ${warning}.\n`);
    return { runId, runDir, tempDir, config, assignment };
  } catch (error) {
    await removeTree(runDir);
    await removeTree(tempDir);
    throw error;
  }
}

/** A permutation of the producer ids drawn from the run's own seed, so which arm ran where is recorded, not guessed. */
function shuffle(values: string[], seed: string): string[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const draw = Number.parseInt(seed.slice(index * 2, index * 2 + 2), 16) % (index + 1);
    [result[index], result[draw]] = [result[draw]!, result[index]!];
  }
  return result;
}

/** Every arm that carries a candidate, with its label, since most checks are per candidate. */
function candidateArms(config: ExperimentConfig): Array<ArmConfig & { candidate: CandidateConfig }> {
  return config.arms.filter((arm): arm is ArmConfig & { candidate: CandidateConfig } => arm.candidate !== undefined);
}

async function validateInputs(config: ExperimentConfig): Promise<void> {
  for (const arm of candidateArms(config)) {
    await assertDirectory(arm.candidate.path, `${arm.label} candidate.path`);
    await assertFile(join(arm.candidate.path, "SKILL.md"), `${arm.label} candidate SKILL.md`);
    for (const dependency of arm.candidate.dependencies) {
      if (dependency.endsWith(".md")) await assertFile(dependency, "candidate dependency");
      else await assertDirectory(dependency, "candidate dependency");
    }
  }
  await validateProducerSettings(config);
  await assertDirectory(config.source.path, "source.path");
  if (config.judge) await assertFile(config.judge.rubric, "judge.rubric");
  const fresh = config.arms.filter((arm) => !arm.reuse);
  for (const folder of new Set(fresh.flatMap((arm) => sharedFoldersFor(config, arm)))) await assertDirectory(folder, "shared folder");
  await assertSharedDependenciesAreNotShared(config);
  if (fresh.some((arm) => environmentFor(config, arm) === "realistic")) {
    await assertDirectory(config.skills.root, "skills.root");
    await assertDependenciesAreNotBaselineSkills(config);
    await assertDependenciesAreNotBaselineSubagents(config);
  }
  for (const arm of candidateArms(config)) {
    if (arm.candidate.replaces) await assertReplacementKeepsName(config, arm.candidate);
  }
}

/**
 * A file under one of an arm's own shared folders already reaches that arm, so
 * naming it as its candidate dependency would copy it over the snapshot and
 * read as that arm's candidate leaking into the others.
 */
async function assertSharedDependenciesAreNotShared(config: ExperimentConfig): Promise<void> {
  for (const arm of candidateArms(config)) {
    const shared = sharedFoldersFor(config, arm);
    for (const dependency of arm.candidate.dependencies) {
      if (!sharedDependencyKind(config, dependency) || !insideSharedFolders(shared, dependency)) continue;
      throw new UserError(
        `${arm.label} names ${dependency} as a candidate dependency, which its shared folders (${shared.join(", ")}) already hold. `
          + (config.skills.sharedInClean
            ? "Remove it from candidate.dependencies, or drop skills.shared so only this arm receives it."
            : "Remove it from candidate.dependencies, or make this arm clean so it receives only what it names."),
      );
    }
  }
}

/**
 * A settings file reaches the producer through the Claude CLI's --settings
 * flag, the way subagents reach it through --agents, so the other adapters
 * refuse it rather than dropping part of the experiment. It has to be JSON:
 * the CLI would otherwise fail long after the run started.
 */
async function validateProducerSettings(config: ExperimentConfig): Promise<void> {
  for (const arm of config.arms) {
    const { agent, settings } = producerFor(config.producer, arm);
    if (!settings) continue;
    if (agent !== "claude") {
      throw new UserError(
        `${arm.label} runs with producer.settings, which only a claude producer can apply. `
          + "Run this arm with agent claude, or remove the settings file.",
      );
    }
    await assertFile(settings, `${arm.label} producer.settings`);
    try {
      JSON.parse(await readFile(settings, "utf8"));
    } catch (error) {
      throw new UserError(`${arm.label} producer.settings is not valid JSON: ${settings} (${error instanceof Error ? error.message : error})`);
    }
  }
}

/**
 * A replacement stands in for a baseline skill, so it must exist there and the
 * candidate must carry the same name; otherwise the arms would differ in which
 * skills exist, not in what one of them says.
 */
async function assertReplacementKeepsName(config: ExperimentConfig, candidate: CandidateConfig): Promise<void> {
  const baseline = await replacedBaselineSkill(config, candidate);
  const variant = await skillMetadata(candidate.path);
  if (variant.name !== baseline.name) {
    throw new UserError(
      `candidate.replaces names ${baseline.name} but the candidate is named ${variant.name}. `
        + "A replacement must keep the baseline skill's name so every arm sees the same skill list.",
    );
  }
}

/**
 * A realistic arm already has the ordinary skills, so declaring one as its
 * candidate dependency would copy it in twice and make its content read as
 * that arm's candidate leaking into the others.
 */
async function assertDependenciesAreNotBaselineSkills(config: ExperimentConfig): Promise<void> {
  const directories = await listSkillDirectories(config.skills.root);
  for (const arm of candidateArms(config).filter((entry) => environmentFor(config, entry) === "realistic")) {
    for (const dependency of arm.candidate.dependencies) {
      for (const directoryName of directories) {
        if (config.skills.exclude.includes(directoryName)) continue;
        if (!(await samePath(dependency, join(config.skills.root, directoryName)))) continue;
        throw new UserError(
          `${arm.label} names the ordinary skill ${directoryName} as a candidate dependency, which a realistic arm already has. `
            + `Remove ${dependency} from candidate.dependencies, or add ${directoryName} to skills.exclude to hide it from the other arms.`,
        );
      }
    }
  }
}

/**
 * A realistic arm already has the baseline subagents, so declaring one as its
 * candidate dependency would hand it a second copy and read as that arm's
 * candidate leaking into the others.
 */
async function assertDependenciesAreNotBaselineSubagents(config: ExperimentConfig): Promise<void> {
  const realistic = candidateArms(config).filter((arm) => environmentFor(config, arm) === "realistic");
  for (const dependency of realistic.flatMap((arm) => subagentDependencies(config, arm.candidate))) {
    if (!(await isBaselineSubagent(config, dependency))) continue;
    const definition = await readSubagentDefinition(dependency);
    throw new UserError(
      `candidate.dependencies names the baseline subagent ${definition.name}, which a realistic arm already has. `
        + `Remove ${dependency} from candidate.dependencies, or add ${definition.name} to subagents.exclude to hide it from the other arms.`,
    );
  }
}

/** Whether a dependency is a baseline subagent definition a realistic arm freezes. */
async function isBaselineSubagent(config: ExperimentConfig, dependency: string): Promise<boolean> {
  if (!(await samePath(dependency, join(config.subagents.root, basename(dependency))))) return false;
  return !config.subagents.exclude.includes((await readSubagentDefinition(dependency)).name);
}

/** Whether a dependency is an ordinary skill folder a realistic arm freezes. */
async function isBaselineSkill(config: ExperimentConfig, dependency: string): Promise<boolean> {
  const name = basename(dependency);
  if (config.skills.exclude.includes(name)) return false;
  return samePath(dependency, join(config.skills.root, name));
}

/**
 * Whether another arm already receives this dependency as baseline material:
 * a clean arm that names a craft, skill, or critic a realistic arm has anyway.
 * Such a file is not a clue about which arm is which, so it is not forbidden.
 */
async function ambientDependency(config: ExperimentConfig, arm: ArmConfig, dependency: string): Promise<boolean> {
  for (const other of config.arms) {
    if (other === arm || other.reuse) continue;
    if (sharedDependencyKind(config, dependency)) {
      if (insideSharedFolders(sharedFoldersFor(config, other), dependency)) return true;
      continue;
    }
    if (environmentFor(config, other) !== "realistic") continue;
    if (dependency.endsWith(".md") ? await isBaselineSubagent(config, dependency) : await isBaselineSkill(config, dependency)) return true;
  }
  return false;
}

async function writeRunRecords(
  runDir: string,
  tempDir: string,
  runId: string,
  config: ExperimentConfig,
  assignment: Assignment,
): Promise<void> {
  // `judge: none` is what the experiment file says and what parseJudge reads
  // back; the resolved config holds null, which it would reject.
  await writePrivateFile(join(runDir, "config.yaml"), stringifyYaml({ ...config, judge: config.judge ?? "none" }));
  await writeJson(join(runDir, "resolved-config.json"), config);
  await writeJson(join(runDir, "assignment.json"), assignment);
  if (config.judge) await writePrivateFile(join(runDir, "rubric.md"), await readFile(config.judge.rubric, "utf8"));
  await writeJson(join(runDir, "run.json"), { runId, tempDir });
}

/**
 * What must not reach an arm other than the one it belongs to, or the judge. A
 * replacement shares its name with the baseline skill the other arms keep, so
 * its slug, title, and aliases are not clues; only paths and changed files are.
 * A settings file one arm alone names counts the same way, by its path and its
 * content; one in the shared producer block belongs to every arm and so gives
 * nothing away. A dependency another arm has as baseline material is not a
 * clue either. The rubric and the run directory belong to no arm: nobody may
 * see them.
 */
async function forbiddenMaterial(runDir: string, config: ExperimentConfig): Promise<ForbiddenMaterial> {
  const identities: ForbiddenIdentity[] = [];
  const hashes: ForbiddenHash[] = config.judge ? [{ value: await sha256File(config.judge.rubric) }] : [];
  for (const arm of candidateArms(config)) {
    const dependencies: string[] = [];
    for (const dependency of arm.candidate.dependencies) {
      if (!(await ambientDependency(config, arm, dependency))) dependencies.push(dependency);
    }
    const armIdentities = await buildForbiddenIdentities(arm.candidate.path, dependencies, arm.label);
    identities.push(...(arm.candidate.replaces ? armIdentities.filter((identity) => identity.kind === "path") : armIdentities));
    const armHashes = await collectForbiddenHashes(arm.candidate.path, dependencies);
    if (arm.candidate.replaces) {
      const baseline = await buildManifest((await replacedBaselineSkill(config, arm.candidate)).path);
      for (const entry of baseline.entries) armHashes.delete(entry.sha256);
    }
    for (const value of armHashes) hashes.push({ value, arm: arm.label });
  }
  for (const arm of config.arms) {
    const settings = arm.producer?.settings;
    if (!settings) continue;
    identities.push({ label: "arm settings path", value: settings, kind: "path", arm: arm.label });
    hashes.push({ value: await sha256File(settings), arm: arm.label });
  }
  identities.push({ label: "orchestrator path", value: runDir, kind: "path" });
  return { identities, hashes };
}

async function freezeInputs(runDir: string, config: ExperimentConfig, assignment: Assignment): Promise<void> {
  const material = await forbiddenMaterial(runDir, config);
  await writeJson(join(runDir, MATERIAL_FILE), material);
  const everything = hiddenFrom(material, null);
  for (const arm of candidateArms(config)) {
    await writeJson(join(runDir, "manifests", `candidate-${arm.label}.json`), await buildManifest(arm.candidate.path));
  }

  const sourceDir = join(runDir, "frozen", "source");
  const copied = await copySelectedSource(config.source.path, sourceDir, config.source.include);
  const sourceFindings = await scanFiles(sourceDir, copied, everything.identities, everything.hashes);
  if (sourceFindings.length > 0) throw leakError(sourceFindings);
  await writeJson(join(runDir, "manifests", "source.json"), await buildManifest(sourceDir));

  const catalogs = new Map<string, Awaited<ReturnType<typeof snapshotSkills>>>();
  const contextDirFor = (producerId: string) => join(runDir, "frozen", producerId, "context");
  for (const [producerId, arm] of armsByProducer(config, assignment)) {
    const contextDir = contextDirFor(producerId);
    await mkdir(contextDir, { recursive: true, mode: 0o755 });
    const catalog = arm.reuse ? [] : await snapshotSkills(config, contextDir, arm);
    catalogs.set(producerId, catalog);
    await writeJson(join(contextDir, "skill-catalog.json"), catalog);
    await writeJson(join(contextDir, "subagent-catalog.json"), arm.reuse ? [] : await snapshotSubagents(config, contextDir, arm));
  }

  // Arms receive either every shared folder or none, so the arms that have them form one group.
  const sharing = armsByProducer(config, assignment)
    .filter(([, arm]) => !arm.reuse && sharedFoldersFor(config, arm).length > 0)
    .map(([producerId]) => producerId);
  const omitted = new Set(sharing.length > 0 ? await omitSharedFilesNamingCandidate(config.skills.shared, everything, contextDirFor, sharing) : []);
  if (omitted.size > 0) await writeJson(join(runDir, "audit", "omitted-shared-files.json"), [...omitted].sort());

  for (const [producerId, arm] of armsByProducer(config, assignment)) {
    const contextDir = contextDirFor(producerId);
    const contextManifest = await buildManifest(contextDir);
    const hidden = hiddenFrom(material, arm.label);
    const contextFindings = await scanFiles(
      contextDir,
      contextManifest.entries.map((entry) => entry.path),
      hidden.identities,
      hidden.hashes,
    );
    if (contextFindings.length > 0) throw leakError(contextFindings);
    await writeJson(join(runDir, "manifests", `${producerId}-context.json`), contextManifest);
  }

  await assertMatchingBaselineSkills(config, assignment, runDir, catalogs);
  await assertMatchingBaselineSubagents(config, assignment, runDir);
}

/** The producers in run order, each with the arm it is running. */
function armsByProducer(config: ExperimentConfig, assignment: Assignment): Array<[string, ArmConfig]> {
  return config.arms.map((arm) => [producerOf(assignment, arm.label), arm]);
}

/**
 * The shared folders' snapshot is identical for every arm that gets
 * it, so a shared file that happens to name a candidate is not a clue about
 * which arm has it.
 * Leaving it in would still tell the other arms that the candidate exists, so
 * it is dropped from all of them and the comparison stays matched. Skills that
 * name a candidate are different: those must be excluded deliberately, so they
 * still stop preparation.
 *
 * The scan reads the shared source, not an arm's snapshot. An arm's own craft
 * or style dependency lands in the same `shared/` folder, and scanning a
 * snapshot would find that dependency by its own hash and delete it from the
 * arm that was supposed to have it.
 */
async function omitSharedFilesNamingCandidate(
  folders: string[],
  everything: { identities: ForbiddenIdentity[]; hashes: Set<string> },
  contextDirFor: (producerId: string) => string,
  producerIds: string[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const root of folders) {
    const name = basename(root);
    let manifest;
    try {
      manifest = await buildManifest(root);
    } catch {
      continue;
    }
    const findings = await scanFiles(root, manifest.entries.map((entry) => entry.path), everything.identities, everything.hashes);
    paths.push(...new Set(findings.map((finding) => join(name, finding.path))));
  }
  for (const path of paths) {
    for (const producerId of producerIds) {
      const snapshot = join(contextDirFor(producerId), "shared");
      await rm(join(snapshot, path), { force: true });
      await removeEmptyParents(snapshot, path);
    }
  }
  return paths;
}

/** Remove the directories a dropped file left behind, up to but not including the snapshot root. */
async function removeEmptyParents(root: string, path: string): Promise<void> {
  let directory = dirname(join(root, path));
  while (directory !== root && directory.startsWith(root)) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}

/**
 * The fresh producers grouped by skill environment, each group in run order.
 * Arms in one environment must see the same baseline; arms in different ones
 * differ on purpose.
 */
function armsByEnvironment(config: ExperimentConfig, assignment: Assignment): Array<[SkillEnvironment, Array<[string, ArmConfig]>]> {
  const groups = new Map<SkillEnvironment, Array<[string, ArmConfig]>>();
  for (const entry of armsByProducer(config, assignment)) {
    if (entry[1].reuse) continue;
    const environment = environmentFor(config, entry[1]);
    groups.set(environment, [...(groups.get(environment) ?? []), entry]);
  }
  return [...groups];
}

/**
 * Every arm in one environment must see the same baseline skills, by catalog
 * and by content, and a clean arm none at all. What an experiment varies — a
 * candidate, or either side of a replaced skill — is left out of the
 * comparison; everything else has to match.
 */
async function assertMatchingBaselineSkills(
  config: ExperimentConfig,
  assignment: Assignment,
  runDir: string,
  catalogs: Map<string, Awaited<ReturnType<typeof snapshotSkills>>>,
): Promise<void> {
  for (const [environment, entries] of armsByEnvironment(config, assignment)) {
    await assertMatchingSkillGroup(config, environment, entries, runDir, catalogs);
  }
}

async function assertMatchingSkillGroup(
  config: ExperimentConfig,
  environment: SkillEnvironment,
  entries: Array<[string, ArmConfig]>,
  runDir: string,
  catalogs: Map<string, Awaited<ReturnType<typeof snapshotSkills>>>,
): Promise<void> {
  const replaced = replacedSkillNames(config);
  const baselineOf = (producerId: string) => (catalogs.get(producerId) ?? [])
    .filter((skill) => !skill.candidate && !replaced.includes(skill.name));
  const [referenceId, referenceArm] = entries[0]!;
  const reference = baselineOf(referenceId);
  const comparable = (items: typeof reference) => JSON.stringify(items.map(({ name, description }) => ({ name, description })));

  for (const [producerId, arm] of entries.slice(1)) {
    if (comparable(baselineOf(producerId)) !== comparable(reference)) {
      throw new UserError(`Prepared baseline skill catalogs do not match: ${referenceArm.label} against ${arm.label}`);
    }
  }
  for (const skill of reference) {
    const hashes = await Promise.all(entries.map(([producerId]) => hashTree(join(runDir, "frozen", producerId, "context", "skills", skill.name))));
    const differing = entries.findIndex((_, index) => hashes[index] !== hashes[0]);
    if (differing !== -1) throw new UserError(`Baseline skill differs between arms: ${skill.name} in ${entries[differing]![1].label}`);
  }

  if (environment === "clean" && reference.length !== 0) {
    throw new UserError(`Clean mode exposed baseline skills to ${referenceArm.label}`);
  }
}

/**
 * Baseline subagents must match between arms in one environment the way
 * baseline skills do; an arm may only add the definitions declared as its own
 * candidate's dependencies.
 */
async function assertMatchingBaselineSubagents(config: ExperimentConfig, assignment: Assignment, runDir: string): Promise<void> {
  for (const [, entries] of armsByEnvironment(config, assignment)) await assertMatchingSubagentGroup(entries, runDir);
}

async function assertMatchingSubagentGroup(entries: Array<[string, ArmConfig]>, runDir: string): Promise<void> {
  const catalogFor = async (producerId: string) =>
    (await readJson<Awaited<ReturnType<typeof snapshotSubagents>>>(join(runDir, "frozen", producerId, "context", "subagent-catalog.json")))
      .filter((entry) => !entry.candidate);
  const [referenceId, referenceArm] = entries[0]!;
  const reference = await catalogFor(referenceId);
  for (const [producerId, arm] of entries.slice(1)) {
    if (JSON.stringify(await catalogFor(producerId)) !== JSON.stringify(reference)) {
      throw new UserError(`Prepared baseline subagent catalogs do not match: ${referenceArm.label} against ${arm.label}`);
    }
  }
  for (const entry of reference) {
    const hashes = await Promise.all(entries.map(([producerId]) => hashTree(join(runDir, "frozen", producerId, "context", entry.path))));
    const differing = entries.findIndex((_, index) => hashes[index] !== hashes[0]);
    if (differing !== -1) throw new UserError(`Baseline subagent differs between arms: ${entry.name} in ${entries[differing]![1].label}`);
  }
}

async function hashTree(root: string): Promise<string> {
  const manifest = await buildManifest(root);
  return sha256Text(manifest.entries.map(({ path, sha256, mode }) => `${path}\0${sha256}\0${mode}`).join("\n"));
}

function leakError(findings: LeakFinding[]): UserError {
  const details = findings.slice(0, 5).map((finding) => `${finding.path}: ${finding.identity.label} '${finding.identity.value}'`);
  const remaining = findings.length > details.length ? `\n...and ${findings.length - details.length} more` : "";
  return new UserError(`Preparation found experiment material in producer inputs:\n${details.join("\n")}${remaining}`);
}
