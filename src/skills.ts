import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { homedir } from "node:os";
import { environmentFor, sharedFoldersFor } from "./config.js";
import { UserError } from "./errors.js";
import { copyTree, listSkillDirectories, samePath } from "./files.js";
import type { ArmConfig, CandidateConfig, ExperimentConfig } from "./types.js";

/**
 * Which shared folder a candidate dependency belongs to, by the name of the
 * folder holding it: with a shared `crafts` folder configured,
 * `<anywhere>/crafts/frontend.md` is a craft. Such a dependency is delivered
 * to its own arm under `shared/`, where the frozen skills are pointed.
 */
export function sharedDependencyKind(config: ExperimentConfig, path: string): string | null {
  const parent = basename(dirname(path));
  return config.skills.shared.some((folder) => basename(folder) === parent) ? parent : null;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** Relative to the producer's context directory. */
  path: string;
  candidate: boolean;
}

export interface BaselineSkill {
  /** The folder under `skills.root`, which need not match the frontmatter name. */
  directoryName: string;
  path: string;
  name: string;
  description: string;
  category?: string;
}

export async function snapshotSkills(config: ExperimentConfig, contextDir: string, arm: ArmConfig): Promise<SkillCatalogEntry[]> {
  const destination = join(contextDir, "skills");
  const catalog: SkillCatalogEntry[] = [];
  await snapshotSharedFolders(sharedFoldersFor(config, arm), contextDir);

  // A replaced skill reaches every other arm in either environment; the arm
  // whose candidate replaces it gets the candidate under the same name instead.
  const replaced = replacedSkillNames(config);
  const clean = environmentFor(config, arm) === "clean";
  const baseline = !clean || replaced.length > 0 ? await listBaselineSkills(config) : [];
  for (const { path, name, description } of baseline) {
    if (clean && !replaced.includes(name)) continue;
    if (name === arm.candidate?.replaces) continue;
    await copyTree(path, join(destination, name));
    catalog.push({ name, description, path: skillCatalogPath(name), candidate: false });
  }

  if (arm.candidate) {
    const { name, description } = await skillMetadata(arm.candidate.path);
    await copyTree(arm.candidate.path, join(destination, name));
    catalog.push({ name, description, path: skillCatalogPath(name), candidate: true });

    for (const dependency of arm.candidate.dependencies) {
      const shared = sharedDependencyKind(config, dependency);
      if (shared) {
        // A dependency may be a file or a folder; either lands where the
        // frozen skills are pointed for shared material.
        const target = join(contextDir, "shared", shared, basename(dependency));
        if ((await stat(dependency)).isDirectory()) await copyTree(dependency, target);
        else {
          await mkdir(dirname(target), { recursive: true, mode: 0o755 });
          await copyFile(dependency, target);
        }
        continue;
      }
      if (dependency.endsWith(".md")) continue; // a subagent definition; snapshotSubagents delivers it
      await copyTree(dependency, join(contextDir, "dependencies", basename(dependency)));
    }
  }

  return catalog.sort((left, right) => left.name.localeCompare(right.name));
}

/** Baseline skill names some arm's candidate stands in for. */
export function replacedSkillNames(config: ExperimentConfig): string[] {
  return config.arms.flatMap((arm) => (arm.candidate?.replaces ? [arm.candidate.replaces] : []));
}

/** Skills a run may freeze. Explicit replacements override exclusions; candidate folders stay out. */
/**
 * Every skill under `skills.root`, read once with the frontmatter both callers
 * need. An arm's own candidate is never one of them, wherever it sits.
 */
async function listSkills(config: ExperimentConfig): Promise<BaselineSkill[]> {
  const candidatePaths = config.arms.flatMap((arm) => (arm.candidate ? [arm.candidate.path] : []));
  const skills: BaselineSkill[] = [];
  for (const directoryName of await listSkillDirectories(config.skills.root)) {
    const path = join(config.skills.root, directoryName);
    if (await isOneOf(path, candidatePaths)) continue;
    skills.push({ directoryName, path, ...await skillMetadata(path) });
  }
  return skills;
}

/** The skills every arm receives: everything under the root that the run does not withhold. */
export async function listBaselineSkills(config: ExperimentConfig): Promise<BaselineSkill[]> {
  const replaced = replacedSkillNames(config);
  const withheld = (skill: BaselineSkill) => [skill.directoryName, skill.name]
    .some((name) => config.skills.exclude.includes(name) && !replaced.includes(name));
  return (await listSkills(config)).filter((skill) => !withheld(skill));
}

export async function replacedBaselineSkill(config: ExperimentConfig, candidate: CandidateConfig): Promise<BaselineSkill> {
  const skill = (await listBaselineSkills(config)).find((entry) => entry.name === candidate.replaces);
  if (!skill) throw new UserError(`No baseline skill named ${candidate.replaces} under ${config.skills.root} for candidate.replaces`);
  return skill;
}

async function isOneOf(path: string, others: string[]): Promise<boolean> {
  for (const other of others) if (await samePath(path, other)) return true;
  return false;
}

export function skillCatalogPath(name: string): string {
  return join("skills", name, "SKILL.md");
}

/**
 * The skill section of a producer's prompt. `sharedFolders` are the live
 * folders this arm has a snapshot of; frozen skills name them by their live
 * paths, so each gets a redirect to its copy.
 */
export function skillLoader(catalog: SkillCatalogEntry[], contextDir: string, sharedFolders: string[]): string {
  if (catalog.length === 0) return "No reusable skills are available for this task.";
  const lines = catalog.map((skill) => `- ${skill.name}: ${skill.description} (${join(contextDir, skill.path)})`);
  return [
    "Reusable skills are listed below. When the task clearly matches one, read its SKILL.md completely before acting.",
    "Use only these listed skills. Do not search for other user or global skills.",
    // The redirect only makes sense for an arm that actually received a shared
    // snapshot; a clean arm has none, and pointing at an empty folder invites
    // the producer to go looking for the real one.
    ...sharedFolders.map((folder) => `If a frozen skill refers to ${displayPath(folder)}, use ${join(contextDir, "shared", basename(folder))} instead.`),
    `Support files, when present, are frozen under ${join(contextDir, "dependencies")} by their folder name.`,
    "",
    ...lines,
  ].join("\n");
}

/**
 * What shared material one arm ended up with, for the report. `omitted` is what
 * preparation dropped from every arm because it named a candidate, so the line
 * describes the snapshot rather than the configuration.
 */
export function describeSharedMaterial(config: ExperimentConfig, arm: ArmConfig, omitted: string[] = []): string {
  const own = (arm.candidate?.dependencies ?? []).flatMap((dependency) => {
    const kind = sharedDependencyKind(config, dependency);
    return kind ? [join(kind, basename(dependency))] : [];
  });
  const material = [...sharedFoldersFor(config, arm), ...own];
  if (material.length === 0) return "none";
  if (omitted.length === 0) return material.join(", ");
  return `${material.join(", ")}, less ${omitted.length} file(s) that named a candidate`;
}

async function snapshotSharedFolders(folders: string[], contextDir: string): Promise<void> {
  for (const folder of folders) await copyTree(folder, join(contextDir, "shared", basename(folder)));
}

/** A path the way a skill would write it: under the home directory, with `~`. */
function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The baseline skill names a run withholds from every arm: the ones whose
 * category is excluded, and the ones excluded by name. Preparation resolves
 * this once and records it, so a report reader sees exactly what was withheld.
 * A run that snapshots no baseline skills reads none of them to find out.
 */
export async function resolveSkillExclusions(config: ExperimentConfig): Promise<string[]> {
  const names = new Set(config.skills.exclude);
  if (config.skills.excludeCategories.length > 0 && await usesBaselineSkills(config)) {
    for (const skill of await listSkills(config)) {
      if (!skill.category || !config.skills.excludeCategories.includes(skill.category)) continue;
      names.add(skill.directoryName);
      names.add(skill.name);
    }
  }
  return [...names].sort();
}

/**
 * Whether any arm receives a baseline skill. A clean arm gets nothing it
 * did not ask for, except the baseline side of a replaced skill, and its
 * `skills.root` may not even exist.
 */
async function usesBaselineSkills(config: ExperimentConfig): Promise<boolean> {
  if (!config.arms.some((arm) => environmentFor(config, arm) === "realistic") && replacedSkillNames(config).length === 0) return false;
  return ((await stat(config.skills.root).catch(() => null))?.isDirectory() ?? false);
}

export async function skillMetadata(path: string): Promise<Omit<SkillCatalogEntry, "path" | "candidate"> & { category?: string }> {
  const skillPath = join(path, "SKILL.md");
  let content: string;
  try {
    content = await readFile(skillPath, "utf8");
  } catch {
    throw new UserError(`Skill is missing SKILL.md: ${path}`);
  }
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(content);
  const value = match?.[1] ? parseYaml(match[1]) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`Invalid skill frontmatter: ${skillPath}`);
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.name !== "string" || typeof metadata.description !== "string") {
    throw new UserError(`Skill frontmatter requires name and description: ${skillPath}`);
  }
  return {
    name: metadata.name,
    description: metadata.description,
    ...(typeof metadata.category === "string" ? { category: metadata.category } : {}),
  };
}

/** Whether a path lies inside one of `folders`. */
export function insideSharedFolders(folders: string[], path: string): boolean {
  return folders.some((folder) => {
    const relation = relative(resolve(folder), resolve(path));
    return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
  });
}
