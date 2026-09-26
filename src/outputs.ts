import { join } from "node:path";
import { withholdNonArmFiles } from "./baseline.js";
import { copyTree } from "./files.js";
import type { ResolvedRun } from "./types.js";

/**
 * Which producer's output goes in which folder. The judge asks for anonymous
 * letters; a capture asks for the arms' own labels.
 */
export type OutputFolders = Record<string, string>;

/**
 * Each arm's own work on top of the project as it was frozen, in a folder named
 * by the key it was asked under. Returns one note per arm whose workspace held
 * files the arm did not write.
 */
export async function copyArmOutputs(run: ResolvedRun, destination: string, folders: OutputFolders): Promise<string[]> {
  const withheld: string[] = [];
  for (const [folder, producerId] of Object.entries(folders)) {
    await copyTree(join(run.tempDir, producerId, "source"), join(destination, folder));
    // What an arm's setup installed, and what the project does not track, is
    // not the arm's work.
    const count = await withholdNonArmFiles(run.runDir, producerId, join(destination, folder));
    if (count > 0) withheld.push(`The reading copy withheld ${count} file(s) that ${run.assignment.arms[producerId]} did not write: what its setup step installed, and what the project's .gitignore covers`);
  }
  return withheld;
}
