import { copyFile, chmod, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest, gitignoreFilter, listFiles, sha256File, verifyManifest } from "./files.js";
import { readJson, writeJson } from "./json.js";
import type { FileManifest, FileManifestEntry, ResolvedRun } from "./types.js";

const MANIFEST_DIR = "manifests";
const FROZEN_SOURCE = "source.json";

/**
 * The workspace as the producer will first see it, recorded once the setup
 * step has run. Whatever a setup command installed belongs to the project for
 * that arm, so every reading of what the arm changed is measured against this,
 * not against the frozen source.
 */
export async function recordBaseline(run: ResolvedRun, producerId: string): Promise<void> {
  await writeJson(baselinePath(run.runDir, producerId), await buildManifest(join(run.tempDir, producerId, "source")));
}

/**
 * The paths one arm added or changed, in a stable order. `armChanges` reports
 * differences as prose, and this is the one place that reads them back, so a
 * caller that wants file paths never parses the prefixes itself.
 */
export async function changedPaths(run: ResolvedRun, producerId: string): Promise<string[]> {
  return (await armChanges(run, producerId))
    .filter((change) => !change.startsWith("missing: "))
    .map((change) => change.replace(/^(added|changed): /, ""))
    .sort();
}

/**
 * What one arm changed, as `verifyManifest` reports it, measured against its
 * baseline and leaving out two things that are not the arm's work: whatever
 * sits under a directory the setup step created, since a tool writing into its
 * own folder while the arm works is the tool's doing, and whatever the
 * project's own `.gitignore` covers, since build output the arm regenerated is
 * not something it wrote.
 */
export async function armChanges(run: ResolvedRun, producerId: string): Promise<string[]> {
  const { baseline, installedRoots } = await readBaseline(run.runDir, producerId);
  const ignores = await gitignoreFilter(frozenSourceDir(run.runDir));
  const differences = await verifyManifest(join(run.tempDir, producerId, "source"), baseline);
  return differences.filter((difference) => {
    const path = difference.replace(/^(added|changed|missing): /, "");
    if (ignores(path)) return false;
    return !ancestors(path).some((directory) => installedRoots.has(directory)) && !installedRoots.has(path);
  });
}

/** One arm's baseline, with the directories its setup step created. */
async function readBaseline(runDir: string, producerId: string): Promise<{ baseline: FileManifest; frozen: Map<string, FileManifestEntry>; installedRoots: Set<string> }> {
  const baseline = await readJson<FileManifest>(baselinePath(runDir, producerId));
  const frozen = new Map((await readJson<FileManifest>(join(runDir, MANIFEST_DIR, FROZEN_SOURCE))).entries.map((entry) => [entry.path, entry]));
  const frozenDirs = new Set([...frozen.keys()].flatMap(ancestors));
  const installedRoots = new Set<string>();
  for (const entry of baseline.entries) {
    if (frozen.has(entry.path)) continue;
    installedRoots.add(ancestors(entry.path).find((directory) => !frozenDirs.has(directory)) ?? entry.path);
  }
  return { baseline, frozen, installedRoots };
}

/**
 * Trims a copy of an arm's workspace down to the arm's own work on top of the
 * project every arm started from, which is what the judge should read and what
 * the archive should keep. A directory the setup created goes away whole, with
 * whatever the tool wrote into it afterwards: a cache or a query stamp is the
 * tool's state, not the arm's work. A frozen file the setup changed goes back
 * to the frozen version when the arm never touched it. Anything the project's
 * `.gitignore` covers goes too. Returns how many files were withheld.
 */
export async function withholdNonArmFiles(runDir: string, producerId: string, copyDir: string): Promise<number> {
  const frozenDir = frozenSourceDir(runDir);
  const { baseline, frozen, installedRoots } = await readBaseline(runDir, producerId);
  let withheld = 0;
  for (const entry of baseline.entries) {
    const original = frozen.get(entry.path);
    if (!original) {
      withheld += 1;
      continue;
    }
    if (original.sha256 === entry.sha256) continue;
    const target = join(copyDir, entry.path);
    if (!(await stat(target).catch(() => null))?.isFile()) continue;
    if (await sha256File(target) !== entry.sha256) continue;
    await copyFile(join(frozenDir, entry.path), target);
    await chmod(target, original.mode);
    withheld += 1;
  }
  for (const root of installedRoots) await rm(join(copyDir, root), { recursive: true, force: true });
  return withheld + await removeIgnored(copyDir, await gitignoreFilter(frozenDir));
}

/**
 * Deletes whatever the ignore rules cover, a covered directory whole so no
 * empty shell of one is left behind. Returns how many files went.
 */
async function removeIgnored(copyDir: string, ignores: (path: string, isDirectory?: boolean) => boolean, prefix = ""): Promise<number> {
  let removed = 0;
  for (const entry of await readdir(join(copyDir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (!entry.isDirectory()) {
      if (!ignores(path)) continue;
      await rm(join(copyDir, path));
      removed += 1;
    } else if (ignores(path, true)) {
      removed += (await listFiles(join(copyDir, path))).length;
      await rm(join(copyDir, path), { recursive: true });
    } else {
      removed += await removeIgnored(copyDir, ignores, path);
    }
  }
  return removed;
}

/** A path's directories from the top down, without the path itself: `a/b/c.txt` gives `a`, `a/b`. */
function ancestors(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function frozenSourceDir(runDir: string): string {
  return join(runDir, "frozen", "source");
}

function baselinePath(runDir: string, producerId: string): string {
  return join(runDir, MANIFEST_DIR, `${producerId}-${FROZEN_SOURCE}`);
}
