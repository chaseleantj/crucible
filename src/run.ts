import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "./errors.js";
import { readJson, readOptionalJson } from "./json.js";
import { pathsConfig, runDirectory } from "./paths.js";
import { readRunState } from "./state.js";
import type { Assignment, ExperimentConfig, PathsConfig, ResolvedRun, RunLocation, RunResult, RunView } from "./types.js";

interface RunRecord {
  runId: string;
  tempDir: string;
}

/**
 * Where a run keeps its files. This is all cleanup needs, so a run frozen by an
 * older runner can still be cleaned even when its experiment no longer loads.
 */
export async function loadRunLocation(runId: string, paths: PathsConfig = pathsConfig()): Promise<RunLocation> {
  if (!/^ab-[a-f0-9]{8}$/.test(runId)) throw new UserError(`Invalid run ID: ${runId}`);
  const runDir = runDirectory(runId, paths);
  let record: RunRecord;
  try {
    record = await readJson<RunRecord>(join(runDir, "run.json"));
  } catch (error) {
    throw notLoadable(runId, error);
  }
  if (record.runId !== runId) throw new UserError(`Run record does not match ${runId}`);
  return { runId, runDir, tempDir: record.tempDir };
}

/** A run with the experiment it froze: what every command but clean works from. */
export async function loadRun(runId: string, paths: PathsConfig = pathsConfig()): Promise<ResolvedRun> {
  const location = await loadRunLocation(runId, paths);
  let config: ExperimentConfig;
  let assignment: Assignment;
  try {
    [config, assignment] = await Promise.all([
      readJson<ExperimentConfig>(join(location.runDir, "resolved-config.json")),
      readJson<Assignment>(join(location.runDir, "assignment.json")),
    ]);
  } catch (error) {
    throw notLoadable(runId, error);
  }
  if (!Array.isArray(config.arms)) throw new UserError(`Run ${runId} has no arms; prepare it again`);
  return { ...location, config: readLegacySharedFolders(config), assignment };
}

/**
 * Legacy records. Runs prepared before a record listed its shared folders
 * (skills.shared as a list) and its nodeModules were read with a fixed
 * layout: one shared root holding crafts and styles, named by a string
 * skills.shared or else the parent of skills.root, and the node_modules beside
 * skills.root. Such runs are still read, so each missing field is filled in
 * with what that layout meant. Only the shape of the record decides; a record
 * that lists its shared folders is returned unchanged.
 */
function readLegacySharedFolders(config: ExperimentConfig): ExperimentConfig {
  const recorded: unknown = config.skills.shared;
  if (Array.isArray(recorded)) return config;
  const root = typeof recorded === "string" ? recorded : dirname(config.skills.root);
  return {
    ...config,
    skills: { ...config.skills, shared: ["crafts", "styles"].map((name) => join(root, name)), sharedInClean: typeof recorded === "string" },
    nodeModules: config.nodeModules === undefined ? join(dirname(config.skills.root), "node_modules") : config.nodeModules,
  };
}

function notLoadable(runId: string, error: unknown): UserError {
  return new UserError(`Could not load run ${runId}: ${error instanceof Error ? error.message : error}`);
}

/** The producer that ran one arm, looked up by the arm's label. */
export function producerOf(assignment: Assignment, label: string): string {
  const producerId = Object.keys(assignment.arms).find((id) => assignment.arms[id] === label);
  if (!producerId) throw new Error(`No producer is assigned to ${label}`);
  return producerId;
}

export interface ListedRun {
  runId: string;
  name: string;
  series: string | null;
  view: RunView;
  /** Present once the run is reported. */
  result: RunResult | null;
}

export async function listRuns(paths: PathsConfig = pathsConfig()): Promise<ListedRun[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.runRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs: ListedRun[] = [];
  for (const runId of entries.filter((entry) => /^ab-[a-f0-9]{8}$/.test(entry)).sort()) {
    try {
      const [view, config, result] = await Promise.all([
        readRunState(runDirectory(runId, paths)),
        readJson<ExperimentConfig>(join(runDirectory(runId, paths), "resolved-config.json")),
        readOptionalJson<RunResult>(join(runDirectory(runId, paths), "result.json")),
      ]);
      runs.push({ runId, name: config.name, series: config.series ?? null, view, result: result ?? null });
    } catch {
      // A partially prepared or hand-edited run directory is not listable.
    }
  }
  return runs.sort((left, right) => left.view.createdAt.localeCompare(right.view.createdAt));
}
