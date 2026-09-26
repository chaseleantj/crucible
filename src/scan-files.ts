// Synchronous reads for the archive and run scanners, where a missing file or
// folder is a normal outcome rather than an error.
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Subdirectories of `parent`, symlinked ones included, dotfiles skipped. Missing dir → []. */
export function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
      .filter((entry) => isDirectory(join(parent, entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Files directly in `parent`, dotfiles skipped. Missing dir → []. */
export function listDirectFiles(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && isFile(join(parent, entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Files anywhere below `parent`, as paths relative to it, sorted; nothing
 * under a dot folder or node_modules, no dotfiles. Missing dir → [].
 */
export function listFilesDeep(parent: string): string[] {
  try {
    return readdirSync(parent, { recursive: true, encoding: "utf8" })
      .filter((path) => !path.split(sep).some((part) => part.startsWith(".") || part === "node_modules") && isFile(join(parent, path)))
      .sort();
  } catch {
    return [];
  }
}

export function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `path` lies strictly below `root`, by name alone. */
export function isWithin(root: string, path: string): boolean {
  return resolve(path).startsWith(resolve(root) + sep);
}

/** Whether `path` lies strictly below `root` both by name and once links are resolved; false for anything missing. */
export function isReallyWithin(root: string, path: string): boolean {
  if (!isWithin(root, path)) return false;
  try {
    return realpathSync(path).startsWith(realpathSync(root) + sep);
  } catch {
    return false;
  }
}

/** An existing file below root, including the real target of any symlinks; null otherwise. */
export function containedFile(root: string, relative: unknown): string | null {
  if (typeof relative !== "string" || !relative || isAbsolute(relative)) return null;
  const target = resolve(root, relative);
  return isFile(target) && isReallyWithin(root, target) ? target : null;
}

export function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readJsonSync(file: string): unknown {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Markdown's first prose paragraph as plain text: headings, comments, and quotes skipped. "" when there is none. */
export function firstParagraph(markdown: string): string {
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const prose = trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("<!--") && !trimmed.startsWith(">");
    if (prose) lines.push(trimmed);
    else if (lines.length > 0) break;
  }
  return lines.join(" ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}
