export const AGENTS = ["claude", "codex", "cursor"] as const;
export type AgentName = (typeof AGENTS)[number];

export type SkillEnvironment = "realistic" | "clean";
export type CleanupMode = "manual" | "automatic";

export interface CandidateConfig {
  path: string;
  /** Name of a baseline skill the candidate stands in for: every other arm keeps the baseline. */
  replaces?: string;
  dependencies: string[];
}

export interface SourceConfig {
  path: string;
  include: string[];
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * What one arm may vary about its producer: model, effort, and tool access.
 * The agent and timeout stay shared. Judges take only model and effort.
 */
export interface ArmOverride {
  /** An arm's own agent CLI, for comparing harnesses; the shared block names the default. */
  agent?: AgentName;
  /** Explicit stdio servers; no user MCP configuration is inherited. */
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  effort?: string;
  /** A JSON file whose contents become the producer's Claude settings, so hooks reach one arm. */
  settings?: string;
  /** Extra environment variables, added on top of the scrubbed environment. */
  env?: Record<string, string>;
  /** A shell command run in the producer's workspace before the producer launches. */
  setup?: string;
}

export interface ProducerConfig extends Omit<ArmOverride, "agent" | "setup"> {
  agent: AgentName;
  timeoutMs: number;
  /** The shared setup command and then the arm's own: both run, in that order. */
  setup?: string[];
}

/**
 * One producer configuration, named by its label. An arm may carry a candidate
 * skill, a producer override, both, or neither. `arms[0]` is the reference arm:
 * the one the others are compared against.
 */
export interface ReuseConfig {
  run: string;
  arm: string;
}

export interface ArmConfig {
  label: string;
  /** Snapshot a completed historical output instead of launching a producer. */
  reuse?: ReuseConfig;
  candidate?: CandidateConfig;
  producer?: ArmOverride;
  /** This arm's own skill environment; absent means `skills.environment`. */
  environment?: SkillEnvironment;
}

export interface SkillsConfig {
  /** The default for every arm; an arm may name its own. */
  environment: SkillEnvironment;
  root: string;
  /** Folders of shared guidance (crafts, styles, and the like), each copied into an arm under shared/<folder name>. */
  shared: string[];
  /**
   * Whether clean arms get the shared folders too. Only when the experiment
   * asks: clean means an arm gets nothing it did not ask for.
   */
  sharedInClean: boolean;
  /** Baseline skill categories withheld from every arm, resolved to names during preparation. */
  excludeCategories: string[];
  /** The baseline skill names withheld from every arm; preparation replaces it with the resolved list. */
  exclude: string[];
}

/** Subagents follow each arm's skill environment: realistic freezes the baseline, clean freezes none. */
export interface SubagentsConfig {
  root: string;
  exclude: string[];
}

export interface JudgeConfig extends ProducerConfig {
  rubric: string;
}

export interface ExperimentConfig {
  name: string;
  /** Groups repeated runs of one question so their verdicts can be tallied together. */
  series?: string;
  /** One to six arms, the reference first. */
  arms: ArmConfig[];
  source: SourceConfig;
  task: string;
  producer: ProducerConfig;
  skills: SkillsConfig;
  subagents: SubagentsConfig;
  sandbox: boolean;
  /** Null for `judge: none`: the outputs are produced, captured, and reported without a verdict. */
  judge: JudgeConfig | null;
  /** A node_modules folder linked into every workspace so frozen skills' scripts resolve their packages; null for none. */
  nodeModules: string | null;
  /** Whether a complete `crucible run` copies itself into the archive when the report is sealed. */
  archive: boolean;
  cleanup: CleanupMode;
}
export type RunState =
  | "prepared"
  | "running"
  | "produced"
  | "failed"
  | "stopped"
  | "judged"
  | "reported"
  | "cleaned";

export type ProducerState = "ready" | "running" | "complete" | "failed" | "stopped";

export interface ProducerStatus {
  state: ProducerState;
  pid?: number;
  processStartedAt?: string;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt?: string;
  toolCalls: number;
  exitCode?: number;
  timedOut?: boolean;
  error?: string;
}

export interface RunView {
  runId: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  producers: Record<string, ProducerStatus>;
  /** The judge's progress, kept the same way; absent until the first `crucible judge`. */
  judge?: ProducerStatus;
}

export interface Assignment {
  seed: string;
  /** Producer id to arm label. */
  arms: Record<string, string>;
}

export interface PathsConfig {
  runRoot: string;
  tempRoot: string;
  /** Where `crucible archive` writes readable copies. */
  archiveRoot: string;
}

/** Where a run keeps its frozen inputs and its producer workspaces. */
export interface RunLocation {
  runId: string;
  runDir: string;
  tempDir: string;
}

export interface ResolvedRun extends RunLocation {
  config: ExperimentConfig;
  assignment: Assignment;
}

export interface NormalizedEvent {
  time: string;
  producer?: string;
  kind: string;
  summary?: string;
  nativeId?: string;
  usage?: Record<string, number | null>;
}

export interface FileManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}

export interface FileManifest {
  createdAt: string;
  entries: FileManifestEntry[];
}

export interface ForbiddenIdentity {
  label: string;
  value: string;
  kind: "identifier" | "path";
  /** The arm whose candidate this names; absent for material no arm may see. */
  arm?: string;
}

/** A file whose exact content gives one arm's candidate away. */
export interface ForbiddenHash {
  value: string;
  arm?: string;
}

/** Everything that must not reach an arm other than the one it belongs to. */
export interface ForbiddenMaterial {
  identities: ForbiddenIdentity[];
  hashes: ForbiddenHash[];
}

export interface LeakFinding {
  path: string;
  identity: ForbiddenIdentity;
}

export interface StartCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

/** One of the letters A, B, C, … the judge sees instead of arm labels. */
export type JudgeOutput = string;

/** One rubric criterion as the judge scored it, on the rubric's 0–10 scale. */
export interface CriterionScore<Side extends string> {
  criterion: string;
  weight: number;
  scores: Record<Side, number>;
}

/** The judge's structured verdict, still anonymous: it speaks of letters. */
export interface Verdict {
  winner: JudgeOutput | "tie";
  /** 0–1. */
  confidence: number;
  scores: CriterionScore<JudgeOutput>[];
  /** Which output the judge took for the control arm, the one produced without a candidate or override. */
  referenceGuess: { output: JudgeOutput | null; confidence: number };
  summary: string;
}

/** The judge's full-page captures of one page an arm produced. */
export interface PageShot {
  /** Shared display label for a comparable page or slide state. */
  page: string;
  /** Actual path relative to this arm’s output; legacy indexes use page. */
  artifact?: string;
  /** Paths relative to the run directory, or null when that capture failed. */
  desktop: string | null;
  phone: string | null;
  /** Set when the picture is the judge's rendering of a text file, not a page the arm wrote. */
  rendered?: "markdown";
  error?: string;
}

export interface ShotIndex {
  capturedAt: string;
  /**
   * Who took the pictures. The judge runs each output the way its own
   * instructions say; the runner opens the changed pages as static files, which
   * shows nothing of a page that needs a build or a server first. Absent on
   * indexes written before a run could go unjudged, which the judge took.
   */
  capturedBy?: "judge" | "runner";
  arms: Record<string, PageShot[]>;
  /** Pages beyond the per-arm cap, listed so the index never hides work. */
  omitted: Record<string, string[]>;
  /** Set when nothing could be captured at all, with the reason. */
  skipped?: string;
}

/** Tokens under one set of names, whatever the agent's own usage keys were called. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ArmCost {
  wallTimeMs: number;
  /** The agent's own usage keys, exactly as it reported them. */
  usage: Record<string, number | null> | null;
  tokens: TokenCounts | null;
}

/** Which agent, model, and effort one arm of a run used, and how anything extra was hooked in. */
export interface AgentIdentity {
  /** Server names only; commands, arguments, and credentials stay private. */
  mcpServers?: string[];
  agent: AgentName;
  model: string | null;
  effort: string | null;
  /** The settings file the producer ran with, when the arm named one. */
  settings?: string;
  /** The names of the arm's extra environment variables, never their values: one could be a token. */
  env?: string[];
  /** The setup commands the arm ran in its workspace before the producer started, in order. */
  setup?: string[];
}

/** What one arm varied, as the report and any dashboard read it. */
export interface ResultArm {
  label: string;
  /** Absent in results written before arms could differ in environment. */
  environment?: SkillEnvironment;
  reuse?: ReuseConfig;
  candidate: string | null;
  replaces: string | null;
}

/** What every sealed run records, judged or not — what the report, the archive, and any dashboard read. */
export interface ProducedResult {
  runId: string;
  name: string;
  series: string | null;
  task: string;
  reportedAt: string;
  /** Mixed when the arms had different environments; null only for hand-converted archives that never recorded it. */
  environment: SkillEnvironment | "mixed" | null;
  /** Run order, reference arm first, because object key order is not a contract. */
  arms: ResultArm[];
  producers: Record<string, AgentIdentity>;
  cost: Record<string, ArmCost | null>;
  warnings: string[];
  shots: ShotIndex | null;
}

/** The verdict with the assignment revealed. */
export interface JudgedResult extends ProducedResult {
  judged?: true;
  judgeAgent: AgentIdentity;
  winner: string;
  confidence: number;
  /** Weighted mean of the criterion scores, per arm. */
  totals: Record<string, number>;
  /** The winner's total minus the runner-up's; 0 for a tie, null when one arm ran alone. */
  margin: number | null;
  scores: CriterionScore<string>[];
  referenceGuess: { arm: string | null; confidence: number; correct: boolean | null };
  summary: string;
}

/** A run of an experiment with `judge: none`: the outputs and what they cost, with nothing ranked. */
export interface UnjudgedResult extends ProducedResult {
  judged: false;
}

export type RunResult = JudgedResult | UnjudgedResult;
