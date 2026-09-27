import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { BROKER_ENVIRONMENT_VARIABLES, ISOLATION_VARIABLES } from "./adapters.js";
import { UserError } from "./errors.js";
import {
  optionalBoolean, optionalObject, optionalString, optionalStringArray, requireObject, requireString, requireStringArray,
  resolvePath, unique, type ObjectValue,
} from "./fields.js";
import { slug } from "./slug.js";
import { loadUserConfig, type UserConfig } from "./user-config.js";
import { AGENTS, type AgentIdentity, type AgentName, type ArmConfig, type ArmOverride, type ExperimentConfig, type JudgeConfig, type ProducerConfig, type McpServerConfig, type RuntimeConfig, type SkillEnvironment, type SkillsConfig } from "./types.js";

const DEFAULT_PRODUCER_TIMEOUT = "120m";
const DEFAULT_JUDGE_TIMEOUT = "30m";
/** What `judge:` says to run the outputs without a judgment. */
const NO_JUDGE = "none";
export const MAX_ARMS = 10;
/** One arm is a rubric score with nothing to compare it against, which is still a result. */
export const MIN_ARMS = 1;
const TOP_LEVEL_KEYS = new Set(["name", "series", "arms", "source", "task", "producer", "skills", "subagents", "runtime", "sandbox", "judge", "archive", "cleanup"]);
const ARM_KEYS = new Set(["label", "candidate", "producer", "environment", "reuse", "task", "inputs"]);
const DEFAULT_RUNTIME: RuntimeConfig = { concurrency: 2, cpus: 2, memoryMb: 4096 };
/** What a judge block may set; the producer block adds the overrides an arm can also carry. */
const JUDGE_KEYS = new Set(["agent", "model", "effort", "timeout", "rubric"]);
const OVERRIDE_KEYS = new Set(["agent", "model", "effort", "settings", "env", "setup", "mcpServers"]);
const PRODUCER_KEYS = new Set(["timeout", ...OVERRIDE_KEYS]);
/** PATH is the one scrubbed variable an arm may extend: a tool has to be findable. */
const EXTENDABLE_VARIABLE = "PATH";
type UnlabelledArm = Omit<ArmConfig, "label"> & { label?: string };

export async function loadConfig(path: string): Promise<ExperimentConfig> {
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new UserError(`Could not read experiment file ${absolutePath}: ${error instanceof Error ? error.message : error}`);
  }
  return resolveConfig(requireObject(parsed, "experiment"), dirname(absolutePath), loadUserConfig().values);
}

/** The experiment file's values over the user's config; see user-config.ts. */
function resolveConfig(value: ObjectValue, baseDir: string, user: UserConfig): ExperimentConfig {
  const unknown = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    const replaced = unknown.filter((key) => key === "candidate" || key === "labels");
    if (replaced.length > 0) throw armsReplaced(replaced);
    throw new UserError(`Unknown experiment field: ${unknown.join(", ")}. Valid fields: ${[...TOP_LEVEL_KEYS].join(", ")}`);
  }

  const source = requireObject(value.source, "source");
  const producer = parseProducer(requireObject(value.producer, "producer"), "producer", baseDir);
  const skills = optionalObject(value.skills, "skills");
  const subagents = optionalObject(value.subagents, "subagents");
  const judge = parseJudge(value.judge, baseDir);
  assertGuestCompatible(optionalBoolean(value.sandbox, "sandbox") ?? true, user.nodeModules);

  const include = requireStringArray(source.include, "source.include");
  if (include.length === 0) {
    throw new UserError("source.include must contain at least one file or glob pattern");
  }

  const environment = parseEnvironmentName(skills.environment, "skills.environment") ?? "realistic";

  const cleanup = optionalString(value.cleanup, "cleanup") ?? "manual";
  if (cleanup !== "manual" && cleanup !== "automatic") {
    throw new UserError("cleanup must be manual or automatic");
  }

  const series = optionalString(value.series, "series");
  const skillsRoot = pathOr(optionalString(skills.root, "skills.root"), baseDir, user.skills.root);
  const arms = parseArms(value.arms, baseDir, producer);
  // A reused arm is a fixed historical benchmark, which only means something
  // against a fresh arm a judge scores beside it.
  const reused = arms.find((arm) => arm.reuse);
  if (judge === null && reused) {
    throw new UserError(`${reused.label} reuses ${reused.reuse!.run}, which needs a judge to compare against; a run with judge: none scores nothing. Give the experiment a judge block, or drop the reuse arm.`);
  }

  return {
    name: requireString(value.name, "name"),
    ...(series ? { series } : {}),
    arms,
    source: {
      path: resolvePath(requireString(source.path, "source.path"), baseDir),
      include,
    },
    task: requireString(value.task, "task"),
    producer,
    skills: {
      environment,
      root: skillsRoot,
      ...parseShared(skills.shared, baseDir, user.skills.shared),
      excludeCategories: skills.excludeCategories === undefined
        ? [...user.skills.excludeCategories]
        : unique(requireStringArray(skills.excludeCategories, "skills.excludeCategories")),
      exclude: unique([...user.skills.exclude, ...optionalStringArray(skills.exclude, "skills.exclude")]),
    },
    subagents: {
      root: pathOr(optionalString(subagents.root, "subagents.root"), baseDir, user.subagents.root),
      exclude: unique([...user.subagents.exclude, ...optionalStringArray(subagents.exclude, "subagents.exclude")]),
    },
    nodeModules: user.nodeModules,
    sandbox: true,
    runtime: parseRuntime(value.runtime),
    judge,
    archive: optionalBoolean(value.archive, "archive") ?? true,
    cleanup,
  };
}

/** Reject old host-execution settings instead of silently changing their meaning. */
export function assertGuestCompatible(sandbox: boolean, nodeModules: string | null): void {
  if (sandbox === false) throw new UserError("sandbox: false is no longer supported: every run uses a Harbor Linux guest. Remove sandbox; there is no host execution fallback.");
  if (nodeModules) throw new UserError("nodeModules cannot share host packages with a Linux guest. Remove nodeModules from your Crucible config and install dependencies with producer.setup (for example npm ci), or add them to the runtime image.");
}

function parseRuntime(value: unknown): RuntimeConfig {
  const runtime = optionalObject(value, "runtime");
  const unknown = Object.keys(runtime).filter((key) => !Object.hasOwn(DEFAULT_RUNTIME, key));
  if (unknown.length) throw new UserError(`runtime may only set concurrency, cpus, memoryMb, not ${unknown.join(", ")}`);
  const parsed = { ...DEFAULT_RUNTIME };
  for (const key of Object.keys(DEFAULT_RUNTIME) as Array<keyof RuntimeConfig>) {
    const item = runtime[key];
    if (item === undefined) continue;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1) throw new UserError(`runtime.${key} must be a positive integer`);
    parsed[key] = item;
  }
  return parsed;
}

/** Old records use the same runtime defaults when explicitly resumed. */
export function runtimeFor(config: Pick<ExperimentConfig, "runtime">): RuntimeConfig {
  return config.runtime ?? { ...DEFAULT_RUNTIME };
}

export function taskFor(config: Pick<ExperimentConfig, "task">, arm: Pick<ArmConfig, "task">): string {
  return arm.task ?? config.task;
}

function pathOr(path: string | undefined, baseDir: string, fallback: string): string {
  return path === undefined ? fallback : resolvePath(path, baseDir);
}

/**
 * The shared folders and who gets them. Unnamed, the configured folders reach
 * realistic arms only. `skills.shared: true` gives the configured folders to
 * every arm, clean ones included, a list gives exactly those folders to every
 * arm, and `false` gives none to any. Each folder lands in an arm under shared/<its name>, so two
 * folders may not share a name.
 */
function parseShared(value: unknown, baseDir: string, configured: string[]): Pick<SkillsConfig, "shared" | "sharedInClean"> {
  if (value !== undefined && typeof value !== "boolean" && !Array.isArray(value)) {
    throw new UserError("skills.shared must list the shared folders themselves, for example [~/agent-guides/standards, ~/agent-guides/styles], or be true for the configured ones");
  }
  const shared = Array.isArray(value)
    ? requireStringArray(value, "skills.shared").map((folder) => resolvePath(folder, baseDir))
    : value === false ? [] : configured;
  const everyArm = value === true || Array.isArray(value);
  const names = shared.map((folder) => basename(folder));
  const twin = names.find((name, index) => names.indexOf(name) !== index);
  if (twin) throw new UserError(`Two shared folders are both named ${twin}; each lands in an arm under shared/<name>, so the names must differ`);
  return { shared, sharedInClean: everyArm };
}

function parseEnvironmentName(value: unknown, label: string): SkillEnvironment | undefined {
  const environment = optionalString(value, label);
  if (environment !== undefined && environment !== "realistic" && environment !== "clean") {
    throw new UserError(`${label} must be realistic or clean`);
  }
  return environment;
}

/** The skill environment one arm runs in: its own, else the experiment's. */
export function environmentFor(config: ExperimentConfig, arm: ArmConfig): SkillEnvironment {
  return arm.environment ?? config.skills.environment;
}

/**
 * The shared folders one arm gets a copy of. A realistic arm gets them all; a
 * clean arm gets none unless the experiment asked, since it receives nothing
 * but its own candidate and that candidate's dependencies.
 */
export function sharedFoldersFor(config: ExperimentConfig, arm: ArmConfig): string[] {
  return config.skills.sharedInClean || environmentFor(config, arm) === "realistic" ? config.skills.shared : [];
}

/**
 * The judge block, or null for `judge: none` — a run that produces outputs, has
 * the runner capture them, and reports what they cost without ranking them. A
 * missing block is more likely forgotten than meant, so it stops the run and
 * names the way to skip judging on purpose.
 */
function parseJudge(value: unknown, baseDir: string): JudgeConfig | null {
  if (value === NO_JUDGE) return null;
  if (value === undefined) throw new UserError(`judge must be a judge block with a rubric, or "${NO_JUDGE}" to run without a judgment`);
  const judge = requireObject(value, "judge");
  return {
    ...parseProducer(judge, "judge", baseDir, DEFAULT_JUDGE_TIMEOUT, JUDGE_KEYS),
    rubric: resolvePath(requireString(judge.rubric, "judge.rubric"), baseDir),
  };
}

/**
 * The arms in the order they were written, the first being the reference the
 * others are compared against. Two arms may carry the same candidate and
 * producer settings — a deliberate replicate — as long as each is labelled.
 */
function parseArms(raw: unknown, baseDir: string, shared: ProducerConfig): ArmConfig[] {
  if (!Array.isArray(raw)) {
    throw new UserError(`arms must be a list of ${MIN_ARMS} to ${MAX_ARMS} entries, the first being the one the others are compared against`);
  }
  if (raw.length < MIN_ARMS) throw new UserError(`arms must hold at least ${MIN_ARMS} entry`);
  if (raw.length > MAX_ARMS) throw new UserError(`arms may hold at most ${MAX_ARMS} entries`);

  const parsed = raw.map((entry, index) => parseArm(requireObject(entry, `arms[${index}]`), `arms[${index}]`, baseDir));
  for (const arm of parsed) {
    const producer = producerFor(shared, arm);
    if (Object.keys(producer.mcpServers ?? {}).length && producer.agent === "cursor") {
      throw new UserError("producer.mcpServers supports claude and codex producers; cursor has no explicit MCP configuration");
    }
  }
  return withLabels(parsed);
}

function parseArm(value: ObjectValue, label: string, baseDir: string): UnlabelledArm {
  const unknown = Object.keys(value).filter((key) => !ARM_KEYS.has(key));
  if (unknown.length > 0) throw new UserError(`${label} may only set ${[...ARM_KEYS].join(", ")}, not ${unknown.join(", ")}`);
  if (value.reuse !== undefined) {
    if (["candidate", "producer", "environment", "task", "inputs"].some((key) => value[key] !== undefined)) {
      throw new UserError(`${label}.reuse cannot be combined with candidate, producer, environment, task, or inputs`);
    }
    const reuse = requireObject(value.reuse, `${label}.reuse`);
    if (Object.keys(reuse).some((key) => key !== "run" && key !== "arm")) throw new UserError(`${label}.reuse may only set run and arm`);
    const run = requireString(reuse.run, `${label}.reuse.run`);
    if (!/^ab-[a-f0-9]{8}$/.test(run)) throw new UserError(`${label}.reuse.run must be a run ID`);
    return {
      ...(value.label !== undefined ? { label: requireString(value.label, `${label}.label`) } : {}),
      reuse: { run, arm: requireString(reuse.arm, `${label}.reuse.arm`) },
    };
  }
  const candidate = optionalObject(value.candidate, `${label}.candidate`);
  const override = value.producer === undefined
    ? undefined
    : parseArmOverride(requireObject(value.producer, `${label}.producer`), `${label}.producer`, baseDir);
  const environment = parseEnvironmentName(value.environment, `${label}.environment`);
  const task = optionalString(value.task, `${label}.task`);
  const inputs = parseInputs(value.inputs, `${label}.inputs`, baseDir);
  return {
    ...(value.label !== undefined ? { label: requireString(value.label, `${label}.label`) } : {}),
    ...(value.candidate === undefined ? {} : {
      candidate: {
        path: resolvePath(requireString(candidate.path, `${label}.candidate.path`), baseDir),
        ...(candidate.replaces !== undefined ? { replaces: requireString(candidate.replaces, `${label}.candidate.replaces`) } : {}),
        dependencies: optionalStringArray(candidate.dependencies, `${label}.candidate.dependencies`).map((path) => resolvePath(path, baseDir)),
      },
    }),
    ...(override && Object.keys(override).length > 0 ? { producer: override } : {}),
    ...(environment ? { environment } : {}),
    ...(task ? { task } : {}),
    ...(value.inputs !== undefined ? { inputs } : {}),
  };
}

export function parseInputs(value: unknown, label: string, baseDir: string): Record<string, string> {
  const entries = Object.entries(optionalObject(value, label));
  const names = new Set<string>();
  return Object.fromEntries(entries.map(([name, source]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new UserError(`${label} names must be simple file or directory names, without slashes: ${name}`);
    if (names.has(name.toLowerCase())) throw new UserError(`${label} has colliding names: ${name}`);
    names.add(name.toLowerCase());
    return [name, resolvePath(requireString(source, `${label}.${name}`), baseDir)];
  }));
}

/**
 * Labels name the arms wherever a result is shown or archived, and become
 * sibling folder names, so they are unique slugs. The default says what the arm
 * varied: a replaced skill gives -variant, a candidate gives with-, a producer
 * override is named after its settings, an arm's own environment is appended,
 * and an arm that varies nothing is the baseline the candidate is missing from.
 */
function withLabels(arms: UnlabelledArm[]): ArmConfig[] {
  const candidateNames = unique(arms.flatMap((arm) => (arm.candidate ? [basename(arm.candidate.path)] : [])));
  const labelled: ArmConfig[] = [];
  for (const [index, arm] of arms.entries()) {
    const explicit = arm.label !== undefined;
    const label = slug(arm.label ?? defaultLabel(arm, candidateNames));
    if (!label) throw new UserError(`arms[${index}].label must contain letters or digits`);
    const twin = labelled.findIndex((other) => other.label === label);
    if (twin !== -1) {
      throw new UserError(explicit
        ? `arms[${twin}] and arms[${index}] are both labelled "${label}"`
        : `arms[${twin}] and arms[${index}] both fall back to the label "${label}". Two arms that vary the same thing are a deliberate replicate: give each one its own label.`);
    }
    labelled.push({ ...arm, label });
  }
  return labelled;
}

function defaultLabel(arm: UnlabelledArm, candidateNames: string[]): string {
  if (arm.reuse) return `frozen-${arm.reuse.arm}`;
  const varied = arm.candidate?.replaces ? `${arm.candidate.replaces}-variant`
    : arm.candidate ? `with-${basename(arm.candidate.path)}`
    : arm.producer ? overrideLabel(arm.producer)
    : "";
  if (arm.environment) return varied ? `${varied}-${arm.environment}` : arm.environment;
  return varied || (candidateNames.length === 1 ? `without-${candidateNames[0]}` : "baseline");
}

/**
 * What a producer override is named after: its agent, model, and effort, else the
 * settings file without its extension, the first extra variable, or the setup
 * command's own name — whichever the arm actually varied.
 */
function overrideLabel(override: ArmOverride): string {
  const named = [override.agent, override.model, override.effort].filter(Boolean).join("-");
  return named
    || (override.settings ? basename(override.settings, extname(override.settings)) : "")
    || Object.keys(override.mcpServers ?? {})[0]
    || Object.keys(override.env ?? {})[0]
    || override.setup?.split(/\s+/)[0]
    || "";
}

/** What a producer or judge block names, with the environment reduced to its variable names. */
export function agentIdentity(config: ProducerConfig): AgentIdentity {
  return {
    ...(config.mcpServers ? { mcpServers: Object.keys(config.mcpServers) } : {}),
    agent: config.agent,
    model: config.model ?? null,
    effort: config.effort ?? null,
    ...(config.settings ? { settings: config.settings } : {}),
    ...(config.env ? { env: Object.keys(config.env) } : {}),
    ...(config.setup ? { setup: config.setup } : {}),
  };
}

/** How one arm was hooked up, for the report and the archive; values stay out, names do not. */
export function describeToolSetup(label: string, identity: AgentIdentity): string[] {
  return [
    ...(identity.mcpServers ? [`MCP servers (${label}): ${identity.mcpServers.join(", ")}`] : []),
    ...(identity.settings ? [`Settings (${label}): ${identity.settings}`] : []),
    ...(identity.env ? [`Environment (${label}): ${identity.env.join(", ")}`] : []),
    ...(identity.setup ?? []).map((command) => `Setup (${label}): ${command}`),
  ];
}

/** One identity as a line of text: `claude / claude-opus-5 / low`. */
export function describeIdentity(identity: AgentIdentity): string {
  return [identity.agent, identity.model, identity.effort].filter(Boolean).join(" / ");
}

/** The arm one label names. */
export function armFor(config: ExperimentConfig, label: string): ArmConfig {
  const arm = config.arms.find((entry) => entry.label === label);
  if (!arm) throw new Error(`No arm is labelled ${label}`);
  return arm;
}

/**
 * The producer settings one arm runs with: the shared block with that arm's
 * overrides applied. Extra environment variables are merged by name, so a
 * shared PATH and an arm's own variable both survive, and a shared setup
 * command runs before the arm's own rather than being replaced by it.
 */
export function producerFor(shared: ProducerConfig, arm: { producer?: ArmOverride }): ProducerConfig {
  const { setup, ...override } = arm.producer ?? {};
  const env = { ...shared.env, ...override.env };
  const mcpServers = Object.fromEntries(Object.entries({ ...shared.mcpServers, ...override.mcpServers }).sort(([a], [b]) => a.localeCompare(b)));
  const commands = [...(shared.setup ?? []), ...(setup ? [setup] : [])];
  return {
    ...shared,
    ...override,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(commands.length > 0 ? { setup: commands } : {}),
  };
}

/**
 * The producer settings an arm, or the shared block, may name. `settings`,
 * `env`, and `setup` are how a tool that is not a skill reaches a producer: a
 * settings file carries its hooks, `env` points it at a proxy or a binary, and
 * `setup` builds whatever it needs in the workspace first.
 */
function parseArmOverride(value: ObjectValue, label: string, baseDir: string, allowed = OVERRIDE_KEYS): ArmOverride {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new UserError(`${label} may only set ${[...allowed].join(", ")}, not ${unknown.join(", ")}`);
  const agent = optionalString(value.agent, `${label}.agent`);
  if (agent !== undefined && !AGENTS.includes(agent as AgentName)) {
    throw new UserError(`${label}.agent must be one of: ${AGENTS.join(", ")}`);
  }
  const model = optionalString(value.model, `${label}.model`);
  const effort = optionalString(value.effort, `${label}.effort`);
  const settings = optionalString(value.settings, `${label}.settings`);
  const env = parseEnvironment(value.env, `${label}.env`, true);
  const mcpServers = parseMcpServers(value.mcpServers, `${label}.mcpServers`);
  const setup = optionalString(value.setup, `${label}.setup`);
  return {
    ...(agent ? { agent: agent as AgentName } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(settings ? { settings: resolvePath(settings, baseDir) } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(setup ? { setup } : {}),
  };
}

function parseMcpServers(value: unknown, label: string): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(optionalObject(value, label))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, raw]) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new UserError(`${label} server names must contain only letters, digits, underscores, or hyphens`);
      const server = requireObject(raw, `${label}.${name}`);
      const unknown = Object.keys(server).filter((key) => !["command", "args", "env"].includes(key));
      if (unknown.length) throw new UserError(`${label}.${name} may only set command, args, env`);
      const args = server.args;
      if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
        throw new UserError(`${label}.${name}.args must be a list of strings`);
      }
      const env = parseEnvironment(server.env, `${label}.${name}.env`);
      return [name, {
        command: requireString(server.command, `${label}.${name}.command`),
        ...(args !== undefined ? { args: args as string[] } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      }];
    }));
}

/**
 * Extra variables, in name order so two arms written differently still compare
 * as written. The scrubbed home owns HOME, TMPDIR, and the XDG paths; only PATH
 * may be extended, or the isolation could be undone one variable at a time.
 */
function parseEnvironment(value: unknown, label: string, protectCredentials = false): Record<string, string> {
  const entries = Object.entries(optionalObject(value, label));
  const names = entries.map(([name]) => name);
  const owned = names.filter((name) => ISOLATION_VARIABLES.includes(name) && name !== EXTENDABLE_VARIABLE);
  if (owned.length > 0) {
    throw new UserError(`${label} may not set ${owned.join(", ")}: the scrubbed environment owns ${ISOLATION_VARIABLES.join(", ")}, and only ${EXTENDABLE_VARIABLE} may be extended`);
  }
  if (protectCredentials) {
    const overrides = names.filter((name) => BROKER_ENVIRONMENT_VARIABLES.has(name));
    if (overrides.length) throw new UserError(`${label} may not set ${overrides.join(", ")}: provider authentication and routing are owned by the credential broker`);
  }
  return Object.fromEntries(entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, item]) => [name, requireString(item, `${label}.${name}`)]));
}

function parseProducer(value: ObjectValue, label: string, baseDir: string, defaultTimeout = DEFAULT_PRODUCER_TIMEOUT, allowed = PRODUCER_KEYS): ProducerConfig {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const replaced = unknown.filter((key) => key === "control" || key === "treatment");
    if (replaced.length > 0) throw armsReplaced(replaced.map((key) => `${label}.${key}`));
    throw new UserError(`${label} may only set ${[...allowed].join(", ")}, not ${unknown.join(", ")}`);
  }
  requireString(value.agent, `${label}.agent`);
  const { setup, agent, ...override } = parseArmOverride(value, label, baseDir, allowed);
  return {
    agent: agent!,
    ...override,
    ...(setup ? { setup: [setup] } : {}),
    timeoutMs: parseDuration(optionalString(value.timeout, `${label}.timeout`) ?? defaultTimeout, `${label}.timeout`),
  };
}

/** The fields the arms list took over from, so an experiment file written for the old shape says why it stopped. */
function armsReplaced(fields: string[]): UserError {
  const subject = fields.length === 1 ? `${fields[0]} was` : `${fields.join(" and ")} were`;
  return new UserError(`${subject} replaced by arms: list every arm, each with its own label, candidate, and producer override`);
}

export function parseDuration(value: string, label = "duration"): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!match) {
    throw new UserError(`${label} must use ms, s, m, or h, for example 120m`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}
