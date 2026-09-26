// The shape `GET /api/experiments` returns: the store's scanExperiments, plus
// the two folders it read. Mirrors the runner's RunResult for archived runs
// and its state records for live ones.

/** An arm's label: the unique slug a run names one producer configuration by. */
export type Arm = string;

export interface CriterionScore {
  criterion: string;
  weight: number;
  scores: Record<Arm, number>;
}

/** Which agent, model and effort one side of a run used. */
export interface AgentIdentity {
  agent: string;
  model: string | null;
  effort: string | null;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ArmCost {
  wallTimeMs: number;
  tokens: TokenCounts | null;
}

export type SkillEnvironment = "realistic" | "clean";

export interface RunArm {
  label: Arm;
  candidate: string | null;
  replaces: string | null;
  environment?: SkillEnvironment;
}

/** One captured page of one arm; image paths are relative to the archive folder. */
export interface Shot {
  page?: string;
  artifact?: string;
  desktop?: string;
  phone?: string;
  /** Older archives called the narrow capture mobile. */
  mobile?: string;
  /** Why the page has no picture, when it would not render. */
  error?: string;
}

interface RunFacts {
  runId: string;
  name: string;
  series: string | null;
  task: string;
  reportedAt: string;
  environment: SkillEnvironment | "mixed" | null;
  /** Run order, the reference arm first. */
  arms: RunArm[];
  producers: Record<Arm, AgentIdentity>;
  cost: Record<Arm, ArmCost | null> | null;
  warnings: string[];
  shots?: { arms?: Record<Arm, Shot[]> | null } | null;
}

export interface JudgedRun extends RunFacts {
  judged?: true;
  judgeAgent: AgentIdentity;
  winner: Arm | "tie";
  /** 0 to 1; 0 when a hand-converted verdict recorded none. */
  confidence: number;
  totals: Record<Arm, number>;
  /** Winner's total minus the best other arm's; null for a single arm. */
  margin: number | null;
  scores: CriterionScore[];
  /** Which arm the blind judge took for the control. */
  referenceGuess?: { arm: Arm | null; confidence: number; correct: boolean | null };
  summary: string;
}

export interface UnjudgedRun extends RunFacts {
  judged: false;
}

export type RunResult = JudgedRun | UnjudgedRun;

/** One archived run folder. */
export interface Experiment {
  name: string;
  path: string;
  doc: string | null;
  blurb: string | null;
  archivedAt: string;
  report: string | null;
  /** Null for an archive without a readable result.json. */
  result: RunResult | null;
  issues?: string[];
  preview: Record<Arm, string | null> | null;
  outputs: Record<Arm, string | null>;
  /** Every HTML page and SVG in each arm's output, relative to its folder, the one `outputs` names first. */
  pages: Record<Arm, string[]>;
  cover: string | null;
}

/** A series of repeated runs, or a single run in no series. */
export interface Question {
  /** Names the question in links: its series, or its only run's ID, told apart by folder name when two claim one. */
  key: string;
  title: string;
  series: string | null;
  arms: Arm[];
  latest: string;
  /** Newest first. */
  runs: Experiment[];
  tally: Record<Arm | "tie", number>;
  meanTotals: Record<Arm, number | null>;
  /** Null when no run was judged. */
  winner: Arm | "tie" | null;
  /** The winner won no more than half the judged runs: it leads, but the runs split. */
  split: boolean;
}

export type AgentHealth = "working" | "quiet" | "stalled" | "near timeout";

export interface LiveAgent {
  state: "ready" | "running" | "complete" | "failed" | "stopped";
  elapsedMs: number | null;
  toolCalls: number;
  lastActivityAt: string | null;
  timedOut: boolean;
  error: string | null;
  health: AgentHealth | null;
  remainingMs: number | null;
}

export interface LiveRun {
  deletable: boolean;
  runId: string;
  path: string;
  name: string;
  labels: Arm[];
  state: string;
  /** The state in words: producing, judging, stopped… */
  phase: string;
  startedAt: string;
  updatedAt: string;
  /** Arms stay hidden until the report, so producers are unnamed. */
  producers: LiveAgent[];
  judge: LiveAgent | null;
}

export interface Experiments {
  root: string;
  live: { inFlight: LiveRun[]; unfinished: LiveRun[] };
  /** Newest first. */
  questions: Question[];
  reportsOnly: Experiment[];
}

export interface Snapshot {
  archiveRoot: string;
  runsRoot: string;
  /** Each archive entry and run record folder, to the relative URL its files are served under. */
  files: Record<string, string>;
  experiments: Experiments;
}
