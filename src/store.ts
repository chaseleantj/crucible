// The A/B tests on disk, read from two places. The archive holds results:
// `crucible archive` writes a result.json per run, the verdict with the arms
// revealed, and this groups those into the questions they answer, so repeated
// runs of one question are one question with several samples. The run records
// say what is happening right now: a run still producing or judging, and one
// that finished without ever being archived.
//
// Everything here is synchronous: a dashboard reads a snapshot per request and
// nothing else waits on it.
import { lstatSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { entryIssues, previewIssues, resultIssues } from "./check.js";
import { UserError } from "./errors.js";
import { agentActive, agentHealth, elapsedMs, runActive, type AgentHealth } from "./health.js";
import { pathsConfig } from "./paths.js";
import { experimentVisualPreviews } from "./previews.js";
import { containedFile, firstParagraph, isDirectory, isFile, isWithin, listDirectFiles, listDirs, listFilesDeep, readJsonSync, readText } from "./scan-files.js";
import type { ExperimentConfig, ProducerState, ProducerStatus, RunResult, RunState, RunView } from "./types.js";
import { isJudged } from "./verdict.js";

export { README_WORD_LIMIT, copiedRunIssues, entryIssues, previewIssues, resultIssues } from "./check.js";
export { experimentVisualPreviews, visualPreview, type VisualPreview } from "./previews.js";
export { isJudged } from "./verdict.js";

export interface StoreRoots {
  /** Where `crucible archive` writes entries. */
  archiveRoot: string;
  /** Where the runner keeps its run records. */
  runsRoot: string;
}

/**
 * The roots the CLI uses, resolved the same way: the CRUCIBLE_*_ROOT variables,
 * then the config file, then the defaults.
 */
export function storeRoots(environment: NodeJS.ProcessEnv = process.env): StoreRoots {
  const { archiveRoot, runRoot } = pathsConfig(environment);
  return { archiveRoot, runsRoot: runRoot };
}

export interface ArchivedExperiment {
  /** The entry's folder name. */
  name: string;
  path: string;
  /** README.md, when there is one. */
  doc: string | null;
  blurb: string | null;
  /** The folder's modification time, ISO; "" when it cannot be read. */
  archivedAt: string;
  /** report.html, else a hand-written REPORT.md or report.md. */
  report: string | null;
  /** Null for a legacy, missing, or untrustworthy result.json; `issues` says why. */
  result: RunResult | null;
  issues: string[];
  /** Arm label to its preview image, one slot per arm whether or not it was captured. */
  preview: Record<string, string | null>;
  /** Arm label to the file that best stands for its output. */
  outputs: Record<string, string | null>;
  /**
   * Arm label to every HTML page and SVG in its output folder, relative to it, at
   * any depth: the page `outputs` names first, then the rest by path.
   */
  pages: Record<string, string[]>;
  /** The first arm's preview that exists. */
  cover: string | null;
}

export interface Question {
  /**
   * Names the question in links (#/q/<key>/<runId>): its series, or its only
   * run's ID. When two questions claim one key, each run question appends
   * @<its entry's folder name>; a series keeps its own.
   */
  key: string;
  title: string;
  series: string | null;
  arms: string[];
  /** The newest run's reportedAt. */
  latest: string;
  /** Newest first. */
  runs: Array<ArchivedExperiment & { result: RunResult }>;
  /** Judged wins per arm, plus "tie". */
  tally: Record<string, number>;
  meanTotals: Record<string, number | null>;
  /** Null when no run was judged. */
  winner: string | null;
  /**
   * The winner is an arm that won no more than half the judged runs, so it
   * leads without the runs agreeing, as when two runs each pick a different
   * arm and the higher mean total decides. Never true for a tie or no winner.
   */
  split: boolean;
}

export interface AgentProgress {
  state: ProducerState;
  elapsedMs: number | null;
  toolCalls: number;
  lastActivityAt: string | null;
  timedOut: boolean;
  error: string | null;
  /** Only while running; a missing process reads as stalled. */
  health: Exclude<AgentHealth, "process missing"> | null;
  remainingMs: number | null;
}

export interface LiveRun {
  runId: string;
  /** No agent is at work in it, so its record can be removed. */
  deletable: boolean;
  path: string;
  name: string;
  labels: string[];
  state: string;
  phase: string;
  startedAt: string;
  updatedAt: string;
  /** In producer order, with the arm kept hidden. */
  producers: AgentProgress[];
  judge: AgentProgress | null;
}

export interface LiveRuns {
  inFlight: LiveRun[];
  unfinished: LiveRun[];
}

export interface ExperimentsScan {
  root: string;
  /** The archive README's first paragraph. */
  blurb: string | null;
  live: LiveRuns;
  questions: Question[];
  /** Entries with no trustworthy result.json, newest folder first. */
  reportsOnly: ArchivedExperiment[];
}

/**
 * The runner's states, in the words a reader shows. A run is judging only
 * while a judge is at work; a produced run without one is waiting for
 * `crucible judge`, like a judged run waits for `crucible report`. A run still
 * marked running with no agent at work was interrupted.
 */
const PHASES: Partial<Record<RunState, string>> = {
  prepared: "prepared, not started",
  running: "producing",
  produced: "produced, not judged",
  judged: "judged, not reported",
  reported: "finished, not archived",
  stopped: "stopped",
};
const JUDGING = "judging";
const INTERRUPTED = "interrupted";

export function scanExperiments({ archiveRoot, runsRoot }: StoreRoots): ExperimentsScan {
  const root = resolve(archiveRoot);
  const tests = listDirs(root).map((name) => readArchive(join(root, name), name));
  const readable = tests.filter((test): test is ArchivedExperiment & { result: RunResult } => test.result !== null);
  return {
    root,
    blurb: firstParagraph(readText(join(root, "README.md")) ?? "") || null,
    live: scanRuns(runsRoot, new Set(readable.map((test) => test.result.runId))),
    questions: groupQuestions(readable),
    // Archived by hand, before result.json existed, or with a result this
    // reader cannot trust: a README to open and nothing to compare.
    reportsOnly: tests.filter((test) => test.result === null).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)),
  };
}

/** One archived run, read from its folder: the verdict, the arms' captures, and their outputs. */
export function readArchive(dir: string, name = basename(dir)): ArchivedExperiment {
  const readmePath = join(dir, "README.md");
  const readme = readText(readmePath);
  const raw = readText(join(dir, "result.json"));
  let result: RunResult | null = null;
  const issues: string[] = [];
  if (raw !== null) {
    try {
      const saved = JSON.parse(raw) as unknown;
      issues.push(...resultIssues(saved));
      // Older hand-written comparisons keep their report without inventing
      // the runner's scores, arms, or timestamps.
      result = (saved as { legacy?: unknown } | null)?.legacy === true || issues.length ? null : saved as RunResult;
    } catch {
      issues.push("result.json is not valid JSON");
    }
  }
  if (result) issues.push(...previewIssues(dir, result));
  const visual = experimentVisualPreviews(dir, result);
  const preview = Object.fromEntries(Object.entries(visual).map(([label, item]) => [label, item.path]));
  const outputs = archivedOutputs(dir, result);
  return {
    name,
    path: dir,
    doc: readme === null ? null : readmePath,
    blurb: firstParagraph(readme ?? "") || null,
    archivedAt: mtime(dir),
    report: existing(dir, "report.html") ?? existing(dir, "REPORT.md") ?? existing(dir, "report.md"),
    result,
    issues,
    preview,
    outputs,
    pages: Object.fromEntries(Object.entries(outputs).map(([label, output]) => [label, htmlPages(join(dir, "outputs", label), output)])),
    cover: Object.values(preview).find(Boolean) ?? null,
  };
}

/** A file the live viewer can open on its own: a page, or an SVG image. */
const isPage = (file: string) => /\.(html?|svg)$/i.test(file);

/**
 * Outputs are stored under their revealed arm label. Captured artifacts name
 * the intended page; otherwise prefer an HTML entry point, then an SVG, then prose.
 */
function archivedOutputs(dir: string, result: RunResult | null): Record<string, string | null> {
  const root = join(dir, "outputs");
  const labels = [...new Set([...(result?.arms.map((arm) => arm.label) ?? []), ...listDirs(root)])];
  return Object.fromEntries(labels.map((label) => {
    const folder = join(root, label);
    const files = listDirectFiles(folder);
    const captures = result?.shots?.arms?.[label] as unknown;
    // An artifact may carry the fragment of the slide it shows.
    const captured = Array.isArray(captures)
      ? captures.map((shot: { artifact?: unknown; page?: unknown } | null) => shot?.artifact ?? shot?.page)
        .filter((file): file is string => typeof file === "string").map((file) => file.split(/[?#]/)[0]!)
      : [];
    const html = files.filter((file) => /\.html?$/i.test(file));
    const svg = files.filter((file) => /\.svg$/i.test(file));
    const markdown = files.filter((file) => /\.md$/i.test(file));
    // Drafts and notes often accompany the deliverable; prefer them only when
    // the archive has no other document.
    const aside = (file: string) => Number(/^(draft|notes|readme)\.md$/i.test(file));
    markdown.sort((a, b) => aside(a) - aside(b));
    const candidates = [...captured.filter(isPage), ...html.filter((file) => /^index\.html?$/i.test(file)), ...html, ...svg, ...markdown];
    const output = candidates.map((file) => containedFile(dir, relative(dir, join(folder, file)))).find(Boolean) ?? null;
    return [label, output];
  }));
}

/** The pages in one arm's output folder that really are in it, its chosen output first. */
function htmlPages(folder: string, output: string | null): string[] {
  const pages = listFilesDeep(folder).filter((file) => isPage(file) && containedFile(folder, file));
  const first = output ? relative(folder, output) : null;
  return first && pages.includes(first) ? [first, ...pages.filter((page) => page !== first)] : pages;
}

/**
 * One question per series, and one per run that belongs to no series, newest
 * first. The arms and the title come from the newest run: a series is one
 * question, so its arms are named the same way throughout.
 */
function groupQuestions(readable: Array<ArchivedExperiment & { result: RunResult }>): Question[] {
  const bySeries = new Map<string, Array<ArchivedExperiment & { result: RunResult }>>();
  for (const test of readable) {
    const group = test.result.series ?? test.path;
    bySeries.set(group, [...(bySeries.get(group) ?? []), test]);
  }
  const groups = [...bySeries.values()];
  const claimed = (runs: Array<{ result: RunResult }>) => runs[0]!.result.series ?? runs[0]!.result.runId;
  const claims = new Map<string, number>();
  for (const runs of groups) claims.set(claimed(runs), (claims.get(claimed(runs)) ?? 0) + 1);
  return groups.map((runs) => {
    const key = claimed(runs);
    const shared = runs[0]!.result.series === null && claims.get(key)! > 1;
    return describeQuestion(runs, shared ? `${key}@${runs[0]!.name}` : key);
  }).sort((a, b) => b.latest.localeCompare(a.latest));
}

function describeQuestion(runs: Array<ArchivedExperiment & { result: RunResult }>, key: string): Question {
  const sorted = runs.sort((a, b) => b.result.reportedAt.localeCompare(a.result.reportedAt));
  const newest = sorted[0]!.result;
  // Only a judged run has a verdict to count; a run produced without a judge
  // still belongs to its question and simply casts no vote.
  const judged = sorted.filter((test) => isJudged(test.result));
  // The newest run's arms, in its order, plus any arm an older run's winner
  // names, so a renamed arm does not lose the runs it won, and the arm of
  // each older one-arm run, which names no winner but still has a score.
  const solo = judged.flatMap((test) => test.result.arms.length === 1 ? [test.result.arms[0]!.label] : []);
  const arms = [...new Set([...newest.arms.map((arm) => arm.label), ...judged.map((test) => winnerOf(test.result)), ...solo])]
    .filter((label) => label !== "tie" && label !== "");
  const tally = Object.fromEntries([...arms, "tie"].map((label) => [label, judged.filter((test) => winnerOf(test.result) === label).length]));
  const meanTotals = Object.fromEntries(arms.map((label) => [label, meanTotal(judged, label)]));
  // Runs that compared arms at all: a one-arm run is scored, not won.
  const contested = Object.values(tally).reduce((sum, count) => sum + count, 0);
  const winner = judged.length === 0 ? null : seriesWinner(tally, meanTotals, contested);
  return {
    key,
    title: newest.name,
    series: newest.series,
    arms,
    latest: newest.reportedAt,
    runs: sorted,
    tally,
    meanTotals,
    winner,
    split: winner !== null && winner !== "tie" && contested > 0 && tally[winner]! * 2 <= judged.length,
  };
}

/** The arm a judged run picked over the others; a run of one arm beat nobody. */
const winnerOf = (result: RunResult) => isJudged(result) && result.arms.length > 1 ? result.winner : "";

/** Averaged over the runs that scored this arm; null for an arm none of them did. */
function meanTotal(runs: Array<{ result: RunResult }>, label: string): number | null {
  const totals = runs.map(({ result }) => isJudged(result) ? result.totals[label] : undefined)
    .filter((value): value is number => typeof value === "number");
  if (totals.length === 0) return null;
  return Number((totals.reduce((sum, value) => sum + value, 0) / totals.length).toFixed(2));
}

/**
 * Most wins takes it. An even tally falls to the higher mean total, and stays
 * a tie when that is even too, or when no arm won a single run, which is what
 * a question of nothing but ties is. A question with no contested run, only
 * runs of one arm each, goes to the higher mean total alone.
 */
function seriesWinner(tally: Record<string, number>, meanTotals: Record<string, number | null>, contested: number): string {
  const arms = Object.keys(meanTotals);
  const most = Math.max(...arms.map((label) => tally[label]!));
  const leaders = contested === 0 ? arms : arms.filter((label) => tally[label] === most);
  if (leaders.length === 1) return leaders[0]!;
  if (contested > 0 && most === 0) return "tie";
  const best = Math.max(...leaders.map((label) => meanTotals[label] ?? 0));
  const ahead = leaders.filter((label) => (meanTotals[label] ?? 0) === best);
  return ahead.length === 1 ? ahead[0]! : "tie";
}

/**
 * The run records, split into what is happening now and what was left behind.
 * A reported run that has been archived is already a result and is not listed
 * again; one that has not is unfinished work, along with every run that
 * stopped or failed and was never cleaned.
 */
export function scanRuns(runsRoot: string, archivedRunIds: Set<string> = new Set()): LiveRuns {
  const runs = listDirs(runsRoot)
    .map((id) => readRun(join(runsRoot, id), id))
    .filter((run): run is LiveRun => run !== null && run.state !== "cleaned" && !archivedRunIds.has(run.runId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
  return { inFlight: runs.filter(inFlight), unfinished: runs.filter((run) => !inFlight(run)) };
}

/** Still moving on its own: some agent is at work. */
const inFlight = (run: LiveRun) => !run.deletable;

/** A run record without its state or config is not a run yet, or no longer one. */
function readRun(dir: string, runId: string): LiveRun | null {
  const state = readJsonSync(join(dir, "state.json")) as RunView | null;
  const config = readJsonSync(join(dir, "resolved-config.json")) as ExperimentConfig | null;
  if (!state || !config || typeof config.name !== "string" || !Array.isArray(config.arms) ||
      !config.arms.every((arm) => arm && typeof arm.label === "string") ||
      typeof state.state !== "string" || typeof state.updatedAt !== "string" ||
      !state.producers || typeof state.producers !== "object" ||
      !Object.values(state.producers).every((agent) => agent && typeof agent.state === "string") ||
      !config.producer || !config.judge) return null;
  const active = runActive(state);
  const judging = state.judge !== undefined && agentActive(state.judge, state.state);
  return {
    runId,
    deletable: !active,
    path: dir,
    name: config.name,
    labels: config.arms.map((arm) => arm.label),
    state: state.state,
    // Older records carry states this runner no longer writes; they read as
    // failures, which is what every one of them was.
    phase: judging ? JUDGING : state.state === "running" && !active ? INTERRUPTED : PHASES[state.state] ?? "failed",
    // Records from before createdAt existed keep a stable position by using
    // their first available timestamp.
    startedAt: state.createdAt ?? state.updatedAt,
    updatedAt: state.updatedAt,
    producers: Object.values(state.producers).map((producer) => describeAgent(producer, config.producer.timeoutMs)),
    // The runner tracks the judge the same way once judging starts; older
    // records have no row.
    judge: state.judge ? describeAgent(state.judge, config.judge.timeoutMs) : null,
  };
}

/**
 * One agent's progress: a producer's, with the arm hidden because only the
 * report reveals the assignment, or the judge's.
 */
function describeAgent(agent: ProducerStatus, budgetMs: number): AgentProgress {
  const elapsed = agent.startedAt ? elapsedMs(agent) : null;
  const running = agent.state === "running";
  const health = running ? agentHealth(agent, budgetMs) : null;
  return {
    state: agent.state,
    elapsedMs: elapsed,
    toolCalls: agent.toolCalls,
    lastActivityAt: agent.lastActivityAt ?? null,
    timedOut: agent.timedOut ?? false,
    error: agent.error ?? null,
    health: health === "process missing" ? "stalled" : health,
    remainingMs: running ? Math.max(0, budgetMs - (elapsed ?? 0)) : null,
  };
}

/**
 * Every problem `crucible check` reports for one archive folder or one entry in
 * it: the entry rules, and anything that keeps a reader from trusting its
 * result. Each message is prefixed with its entry's path. A target that is
 * not a folder is a problem in itself, not an empty archive.
 */
export function checkArchive(target: string): { entries: number; problems: string[] } {
  const root = resolve(target);
  if (!isDirectory(root)) return { entries: 0, problems: [`${root}: ${isFile(root) ? "not a folder" : "does not exist"}`] };
  const entries = isFile(join(root, "result.json")) || isFile(join(root, "report.html")) ? [root] : listDirs(root).map((name) => join(root, name));
  const problems = entries.flatMap((entry) => [...new Set([...entryIssues(entry), ...readArchive(entry).issues])].map((issue) => `${entry}: ${issue}`));
  return { entries: entries.length, problems };
}

/**
 * Delete archive entries and idle run records, named by absolute path, never
 * anything else. Deleting an archived run also deletes its run record, and is
 * refused while that run still has an agent at work. The whole selection is
 * checked before anything is removed, and no path is followed through a link.
 */
export function deleteEntries(given: StoreRoots, paths: string[]): string[] {
  const [outcome] = deleteEach(given, [paths]);
  if ("error" in outcome!) throw outcome.error;
  return outcome!.deleted;
}

/** One selection's fate: what was deleted (or, in a dry run, would be), or why none of it was. */
export type DeleteOutcome = { deleted: string[] } | { error: DeleteError };

/**
 * Several selections, each deleted as deleteEntries deletes one: all of it or
 * none of it, so one selection's refusal leaves the others to go ahead. The
 * store is read once for all of them. A dry run removes nothing and says what
 * each selection would take with it, run records included.
 */
export function deleteEach(given: StoreRoots, selections: string[][], { dryRun = false } = {}): DeleteOutcome[] {
  const store = readForDelete(given);
  return selections.map((paths) => {
    try {
      return { deleted: deleteSelection(store, paths, dryRun) };
    } catch (error) {
      if (error instanceof DeleteError) return { error };
      throw error;
    }
  });
}

interface DeletableStore {
  roots: string[];
  archives: ArchivedExperiment[];
  records: LiveRun[];
  allowed: Set<string>;
  /** Removed by an earlier selection in the same call: two archived copies of one run share its record. */
  gone: Set<string>;
}

function readForDelete(given: StoreRoots): DeletableStore {
  // Resolved once, so the scan's paths and the containment checks agree.
  const archiveRoot = resolve(given.archiveRoot);
  const runsRoot = resolve(given.runsRoot);
  const scan = scanExperiments({ archiveRoot, runsRoot });
  const archives = [...scan.questions.flatMap((question) => question.runs), ...scan.reportsOnly];
  const all = scanRuns(runsRoot);
  const records = [...all.inFlight, ...all.unfinished];
  const allowed = new Set([...archives.map((archive) => archive.path), ...records.filter((run) => run.deletable).map((run) => run.path)]);
  return { roots: [archiveRoot, runsRoot], archives, records, allowed, gone: new Set() };
}

function deleteSelection({ roots, archives, records, allowed, gone }: DeletableStore, paths: string[], dryRun: boolean): string[] {
  if (paths.length === 0 || paths.some((target) => typeof target !== "string" || !target.startsWith(sep))) {
    throw new DeleteError("invalid", "Choose at least one archive entry or run record, by absolute path.");
  }
  const targets = [...new Set(paths)];
  const busy = records.find((run) => !run.deletable && targets.includes(run.path));
  if (busy) throw new DeleteError("active", `This run still has an agent at work: ${busy.path}`);
  for (const archive of archives) {
    if (!targets.includes(archive.path) || !archive.result) continue;
    const record = records.find((run) => run.runId === archive.result!.runId);
    if (record && !record.deletable) throw new DeleteError("active", "This experiment still has active workers. Stop them before deleting it.");
    if (record && !targets.includes(record.path) && !gone.has(record.path)) targets.push(record.path);
  }
  for (const target of targets) {
    const root = roots.find((base) => isWithin(base, target));
    if (!allowed.has(target) || !root) throw new DeleteError("unavailable", `Not an archive entry or idle run record: ${target}`);
    let current = root;
    for (const part of relative(root, target).split(sep)) {
      current = join(current, part);
      if (isLink(current)) throw new DeleteError("link", `Refusing to delete through a symbolic link: ${target}`);
    }
  }
  if (dryRun) return targets;
  const deleted: string[] = [];
  try {
    // rm unlinks links inside an entry; it never follows them.
    for (const target of targets) {
      rmSync(target, { recursive: true });
      deleted.push(target);
      gone.add(target);
    }
  } catch (error) {
    throw new DeleteError("partial", `Deleted ${deleted.length} of ${targets.length} selected items. ${(error as Error).message}`);
  }
  return deleted;
}

/** Whether a path is a symbolic link; one that vanished since the scan is no longer there to delete. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DeleteError("unavailable", `No longer there: ${path}`);
    throw error;
  }
}

/** Why a deletion was refused; `reason` lets a caller map it to its own responses. */
export class DeleteError extends UserError {
  constructor(readonly reason: "invalid" | "active" | "unavailable" | "link" | "partial", message: string) {
    super(message);
    this.name = "DeleteError";
  }
}

function mtime(dir: string): string {
  try {
    return statSync(dir).mtime.toISOString();
  } catch {
    return "";
  }
}

function existing(dir: string, file: string): string | null {
  const full = join(dir, file);
  return isFile(full) ? full : null;
}
