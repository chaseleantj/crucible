import { archiveOf } from "./archive.js";
import { removeTree, treeSize } from "./files.js";
import { runActive } from "./health.js";
import { pathsConfig } from "./paths.js";
import { cleanRun } from "./report.js";
import { listRuns, loadRunLocation } from "./run.js";
import type { PathsConfig, RunLocation, RunState } from "./types.js";

/**
 * A run whose work is over: judged, reported, or already cleaned. Everything
 * else — prepared, running, failed, stopped — is either in flight or waiting
 * for a relaunch, so prune leaves it alone.
 */
const FINISHED_STATES: ReadonlySet<RunState> = new Set<RunState>(["judged", "reported", "cleaned"]);

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneCandidate extends RunLocation {
  createdAt: string;
  state: RunState;
  archived: boolean;
  /** The run record and its temporary workspace together. */
  bytes: number;
}

/**
 * Local runs that are safe to drop: finished work the archive already holds a
 * copy of, plus finished unarchived runs older than `olderThanDays` when that
 * is given. The archive itself is only read.
 */
export async function pruneCandidates(olderThanDays?: number, paths: PathsConfig = pathsConfig()): Promise<PruneCandidate[]> {
  const cutoff = olderThanDays === undefined ? null : Date.now() - olderThanDays * DAY_MS;
  const candidates: PruneCandidate[] = [];
  for (const { runId, view } of await listRuns(paths)) {
    // A finished run can still be judged again; the dashboard's rule for
    // deletion holds here too.
    if (!FINISHED_STATES.has(view.state) || runActive(view)) continue;
    const archived = await archiveOf(paths.archiveRoot, runId) !== null;
    if (!archived && !(cutoff !== null && Date.parse(view.createdAt) < cutoff)) continue;
    // A run record we cannot read is a run we do not delete.
    const location = await loadRunLocation(runId, paths).catch(() => null);
    if (!location) continue;
    const bytes = await treeSize(location.runDir) + await treeSize(location.tempDir);
    candidates.push({ ...location, createdAt: view.createdAt, state: view.state, archived, bytes });
  }
  return candidates;
}

/** Remove one candidate whole: its temporary workspace first, then its run record. */
export async function pruneRun(candidate: PruneCandidate): Promise<void> {
  await cleanRun(candidate);
  await removeTree(candidate.runDir);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${UNITS[unit]}`;
}
