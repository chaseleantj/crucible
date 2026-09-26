import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentName } from "./types.js";
import { environmentFor } from "./config.js";
import { UserError } from "./errors.js";
import { sharedDependencyKind } from "./skills.js";
import type { ArmConfig, CandidateConfig, ExperimentConfig } from "./types.js";

export interface SubagentCatalogEntry {
  name: string;
  description: string;
  /** Relative to the producer's context directory. */
  path: string;
  candidate: boolean;
}

export interface SubagentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

/**
 * Subagents follow the skills model: every realistic arm gets the same frozen
 * baseline definitions, a clean arm gets none, and an arm receives the
 * definitions declared as its own candidate's dependencies. Claude and Cursor
 * register named agents; Codex delegates with the frozen instructions.
 */
export async function snapshotSubagents(config: ExperimentConfig, contextDir: string, arm: ArmConfig): Promise<SubagentCatalogEntry[]> {
  const destination = join(contextDir, "subagents");
  const catalog: SubagentCatalogEntry[] = [];

  if (environmentFor(config, arm) === "realistic") {
    for (const fileName of await listSubagentFiles(config.subagents.root)) {
      const source = join(config.subagents.root, fileName);
      const definition = await readSubagentDefinition(source);
      if (config.subagents.exclude.includes(definition.name)) continue;
      // A dependency that is this very file stays a baseline definition here:
      // a clean arm asked for what a realistic arm already has.
      if (allSubagentDependencies(config).some((dependency) => basename(dependency) === fileName && resolve(dependency) !== resolve(source))) continue;
      await copyDefinition(source, join(destination, fileName));
      catalog.push({ name: definition.name, description: definition.description, path: join("subagents", fileName), candidate: false });
    }
  }

  if (arm.candidate) {
    for (const dependency of subagentDependencies(config, arm.candidate)) {
      const definition = await readSubagentDefinition(dependency);
      await copyDefinition(dependency, join(destination, basename(dependency)));
      catalog.push({ name: definition.name, description: definition.description, path: join("subagents", basename(dependency)), candidate: true });
    }
  }

  return catalog.sort((left, right) => left.name.localeCompare(right.name));
}

/** One candidate's dependencies that are agent definition files rather than support folders or shared-folder files. */
export function subagentDependencies(config: ExperimentConfig, candidate: CandidateConfig | undefined): string[] {
  return (candidate?.dependencies ?? []).filter((dependency) => dependency.endsWith(".md") && !sharedDependencyKind(config, dependency));
}

/** Every arm's subagent dependencies, so none of them is frozen as a baseline definition. */
export function allSubagentDependencies(config: ExperimentConfig): string[] {
  return config.arms.flatMap((arm) => subagentDependencies(config, arm.candidate));
}

export async function readSubagentDefinition(path: string): Promise<SubagentDefinition> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new UserError(`Subagent definition is not readable: ${path}`);
  }
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(content);
  if (!match) throw new UserError(`Subagent definition has no frontmatter: ${path}`);
  const value = parseYaml(match[1]!);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError(`Invalid subagent frontmatter: ${path}`);
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.name !== "string" || typeof metadata.description !== "string") {
    throw new UserError(`Subagent frontmatter requires name and description: ${path}`);
  }
  const tools = typeof metadata.tools === "string"
    ? metadata.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
    : undefined;
  return {
    name: metadata.name,
    description: metadata.description,
    prompt: content.slice(match[0].length),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
  };
}

/** Plugin name the Claude adapter registers frozen subagents under; the Task tool sees them as `frozen:<name>`. */
export const SUBAGENT_PLUGIN = "frozen";

export function subagentLoader(catalog: SubagentCatalogEntry[], agent: AgentName, contextDir: string): string {
  if (catalog.length === 0) return "";
  if (agent === "codex") {
    return [
      "Independent subagents are available through the native spawn_agent tool. When a skill calls for a named reviewer, delegate to a fresh subagent; do not perform its review yourself.",
      "Use a spawn name containing only lowercase letters, digits, and underscores (replace hyphens in the reviewer name with underscores). Start with no conversation history (fork_context=false, or fork_turns=none if that is the available schema). Give the reviewer the original task, references, output paths, and the absolute path to its frozen definition below. Tell it to read and follow that definition, inspect the output independently, and return its findings. Do not include your self-assessment or earlier critiques. Wait for its result before applying fixes.",
      "Omit model and reasoning overrides so the reviewer inherits this producer's model and effort. Tool names and model aliases in definition frontmatter are Claude-specific metadata; follow the review instructions using native tools within this arm's existing sandbox.",
      ...catalog.map((entry) => `- ${entry.name}: ${entry.description}. Definition: ${join(contextDir, entry.path)}`),
    ].join("\n");
  }
  const lines = catalog.map((entry) => `- ${agent === "cursor" ? entry.name : `${SUBAGENT_PLUGIN}:${entry.name}`}: ${entry.description}`);
  return [
    "Independent subagents are available through the Task tool. Use them where a skill or the work calls for an independent review:",
    ...(agent === "cursor" ? [
      "Use the registered reviewer name as subagent_type. Give it the original task, output paths, and enough context to work independently; wait for its result before applying fixes.",
      "Omit model overrides so the reviewer inherits this producer's model and effort. Cursor plugin agents use the frozen definition's prose; Claude frontmatter model aliases and tool lists do not override their settings.",
    ] : []),
    ...lines,
  ].join("\n");
}

async function copyDefinition(source: string, destination: string): Promise<void> {
  await mkdir(join(destination, ".."), { recursive: true, mode: 0o755 });
  await copyFile(source, destination);
}

async function listSubagentFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}
