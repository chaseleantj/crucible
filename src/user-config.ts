// The user's own defaults: where runs and the archive live, which skills and
// subagents a realistic arm starts from, and what every run withholds. An
// experiment file overrides these, and the CRUCIBLE_*_ROOT variables override the
// storage roots, so the order is experiment > environment > this file > the
// defaults below.
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { UserError } from "./errors.js";
import { optionalObject, optionalString, optionalStringArray, requireObject, resolvePath, unique, type ObjectValue } from "./fields.js";

export interface UserConfig {
  runsRoot: string;
  tempRoot: string;
  archiveRoot: string;
  skills: {
    /** The skills a realistic arm starts from. */
    root: string;
    /** Folders of shared guidance (crafts, styles, and the like) every realistic arm gets a copy of. */
    shared: string[];
    excludeCategories: string[];
    exclude: string[];
  };
  subagents: {
    root: string;
    exclude: string[];
  };
  /** A node_modules folder linked into every workspace, so frozen skills' scripts resolve their packages; null for none. */
  nodeModules: string | null;
}

/** Where a value came from: a default, the config file, or the named environment variable. */
export type ConfigSource = "default" | "config file" | `$${string}`;

export interface LoadedUserConfig {
  /** The config file consulted, whether or not it exists. */
  file: string;
  exists: boolean;
  values: UserConfig;
  /** Each setting's dotted name to where its value came from. */
  sources: Record<string, ConfigSource>;
}

/** Every setting, by the dotted name `crucible config` shows it under. */
export const SETTINGS = ["runsRoot", "tempRoot", "archiveRoot", "skills.root", "skills.shared", "skills.excludeCategories",
  "skills.exclude", "subagents.root", "subagents.exclude", "nodeModules"] as const;
const FILE_KEYS = new Set(["runsRoot", "tempRoot", "archiveRoot", "skills", "subagents", "nodeModules"]);
const SKILLS_KEYS = new Set(["root", "shared", "excludeCategories", "exclude"]);
const SUBAGENTS_KEYS = new Set(["root", "exclude"]);

/** What a stranger gets with no config file: everything Crucible writes under ~/.crucible, Claude's own skill folders, nothing withheld. */
function defaults(): UserConfig {
  const home = homedir();
  return {
    runsRoot: join(home, ".crucible", "runs"),
    tempRoot: join(tmpdir(), "crucible-runs"),
    archiveRoot: join(home, ".crucible", "archive"),
    skills: { root: join(home, ".claude", "skills"), shared: [], excludeCategories: [], exclude: [] },
    subagents: { root: join(home, ".claude", "agents"), exclude: [] },
    nodeModules: null,
  };
}

/** The storage roots an environment variable may override, and which one. */
const ENVIRONMENT_OVERRIDES = [
  ["runsRoot", "CRUCIBLE_RUNS_ROOT"],
  ["tempRoot", "CRUCIBLE_TEMP_ROOT"],
  ["archiveRoot", "CRUCIBLE_ARCHIVE_ROOT"],
] as const;

/** $CRUCIBLE_CONFIG, else config.yaml under $XDG_CONFIG_HOME, else ~/.config/crucible/config.yaml. */
export function userConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.CRUCIBLE_CONFIG) return resolve(environment.CRUCIBLE_CONFIG);
  return join(environment.XDG_CONFIG_HOME ? resolve(environment.XDG_CONFIG_HOME) : join(homedir(), ".config"), "crucible", "config.yaml");
}

export function loadUserConfig(environment: NodeJS.ProcessEnv = process.env): LoadedUserConfig {
  const file = userConfigPath(environment);
  let raw: string | null;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new UserError(`Could not read config file ${file}: ${(error as Error).message}`);
    raw = null;
  }
  let parsed: unknown;
  try {
    parsed = raw === null ? null : parseYaml(raw);
  } catch (error) {
    throw new UserError(`Could not parse config file ${file}: ${(error as Error).message}`);
  }
  const values = defaults();
  const sources: Record<string, ConfigSource> = Object.fromEntries(SETTINGS.map((key) => [key, "default"]));
  // An empty file is a config with nothing set.
  if (parsed != null) readFileValues(requireObject(parsed, `config file ${file}`), dirname(file), values, sources);

  for (const [key, variable] of ENVIRONMENT_OVERRIDES) {
    const override = environment[variable];
    if (!override) continue;
    values[key] = resolve(override);
    sources[key] = `$${variable}`;
  }
  return { file, exists: raw !== null, values, sources };
}

/** Overlay what the file sets onto `values`, marking each such setting's source. */
function readFileValues(value: ObjectValue, base: string, values: UserConfig, sources: Record<string, ConfigSource>): void {
  rejectUnknown(value, FILE_KEYS, "config file");
  const skills = optionalObject(value.skills, "skills");
  const subagents = optionalObject(value.subagents, "subagents");
  rejectUnknown(skills, SKILLS_KEYS, "skills");
  rejectUnknown(subagents, SUBAGENTS_KEYS, "subagents");
  const path = (field: unknown, label: string) => {
    const text = optionalString(field, label);
    return text === undefined ? undefined : resolvePath(text, base);
  };
  const names = (field: unknown, label: string) => unique(optionalStringArray(field, label));
  const given: Record<(typeof SETTINGS)[number], unknown> = {
    runsRoot: value.runsRoot, tempRoot: value.tempRoot, archiveRoot: value.archiveRoot, nodeModules: value.nodeModules,
    "skills.root": skills.root, "skills.shared": skills.shared, "skills.excludeCategories": skills.excludeCategories,
    "skills.exclude": skills.exclude, "subagents.root": subagents.root, "subagents.exclude": subagents.exclude,
  };
  for (const key of SETTINGS) if (given[key] !== undefined) sources[key] = "config file";
  values.runsRoot = path(value.runsRoot, "runsRoot") ?? values.runsRoot;
  values.tempRoot = path(value.tempRoot, "tempRoot") ?? values.tempRoot;
  values.archiveRoot = path(value.archiveRoot, "archiveRoot") ?? values.archiveRoot;
  values.nodeModules = path(value.nodeModules, "nodeModules") ?? values.nodeModules;
  values.skills.root = path(skills.root, "skills.root") ?? values.skills.root;
  if (skills.shared !== undefined) values.skills.shared = optionalStringArray(skills.shared, "skills.shared").map((folder) => resolvePath(folder, base));
  if (skills.excludeCategories !== undefined) values.skills.excludeCategories = names(skills.excludeCategories, "skills.excludeCategories");
  if (skills.exclude !== undefined) values.skills.exclude = names(skills.exclude, "skills.exclude");
  values.subagents.root = path(subagents.root, "subagents.root") ?? values.subagents.root;
  if (subagents.exclude !== undefined) values.subagents.exclude = names(subagents.exclude, "subagents.exclude");
}

function rejectUnknown(value: ObjectValue, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new UserError(`Unknown ${label} field: ${unknown.join(", ")}. Valid fields: ${[...allowed].join(", ")}`);
}
