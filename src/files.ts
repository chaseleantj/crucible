import { createHash } from "node:crypto";
import { chmod, copyFile, glob, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FileManifest, FileManifestEntry } from "./types.js";
import { UserError } from "./errors.js";

const ALWAYS_EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".claude",
  ".codex",
  ".cursor",
  ".crucible",
  "crucible-output",
  "node_modules",
  "tmp",
]);
const ALWAYS_EXCLUDED_NAMES = [
  /^HANDOFF(?:\..+)?$/i,
  /^RUBRIC(?:\..+)?$/i,
  /^assignment(?:\..+)?$/i,
  /^experiment(?:\..+)?$/i,
  /^crucible(?:\..+)?$/i,
  /^report(?:\..+)?$/i,
];
const INSTRUCTION_NAMES = new Set(["AGENTS.md", "CLAUDE.md"]);

export async function assertDirectory(path: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new UserError(`${label} does not exist: ${path}`);
  }
  if (!details.isDirectory()) throw new UserError(`${label} must be a directory: ${path}`);
}

export async function assertFile(path: string, label: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch {
    throw new UserError(`${label} does not exist: ${path}`);
  }
  if (!details.isFile()) throw new UserError(`${label} must be a file: ${path}`);
}

export async function copySelectedSource(sourceRoot: string, destination: string, patterns: string[]): Promise<string[]> {
  await assertDirectory(sourceRoot, "source.path");
  await mkdir(destination, { recursive: true });
  const selected = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.startsWith("/") || pattern.split(/[\\/]/).includes("..")) {
      throw new UserError(`source.include must stay inside source.path: ${pattern}`);
    }
    for await (const entry of glob(pattern, { cwd: sourceRoot })) {
      const normalized = normalizeRelative(entry);
      if (!normalized || isAlwaysExcluded(normalized)) continue;
      selected.add(normalized);
    }
  }

  const copied: string[] = [];
  for (const path of [...selected].sort()) {
    const source = join(sourceRoot, path);
    const details = await lstat(source);
    if (details.isDirectory()) continue;
    rejectUnsupportedFile(details, source);
    await copyFileExclusive(source, join(destination, path), details.mode);
    copied.push(path);
  }

  if (copied.length === 0) throw new UserError("source.include did not select any allowed files");
  // The project's ignore rules travel with it whether or not a pattern picked
  // them up: what the project does not track is not an arm's work.
  if (!selected.has(GITIGNORE)) {
    const details = await lstat(join(sourceRoot, GITIGNORE)).catch(() => null);
    if (details?.isFile()) {
      await copyFileExclusive(join(sourceRoot, GITIGNORE), join(destination, GITIGNORE), details.mode);
      copied.push(GITIGNORE);
    }
  }
  return copied.sort();
}

const GITIGNORE = ".gitignore";

/** Stands in for `**` while the rest of a pattern is escaped, so the escaping cannot reach it. */
const ANY_DEPTH = "\u0000";

/** One line of a `.gitignore`, ready to test against a path. */
interface IgnoreRule {
  pattern: RegExp;
  /** Matched against the whole path from the root, rather than a single name at any depth. */
  anchored: boolean;
  directoryOnly: boolean;
  negated: boolean;
}

/**
 * A project's root `.gitignore` as a test for whether it covers a path, so
 * build output and other untracked leftovers can be told apart from an arm's
 * work. It reads the patterns git users write — a bare name, `dir/`, a `*` or
 * `**` glob, a leading `/` anchor, a `!` exception — and not the rest of the
 * format: no per-directory files, no `[a-z]` ranges. A project with no
 * `.gitignore` ignores nothing.
 */
export async function gitignoreFilter(root: string): Promise<(path: string, isDirectory?: boolean) => boolean> {
  const text = await readFile(join(root, GITIGNORE), "utf8").catch(() => "");
  const rules = text.split("\n").flatMap(parseIgnoreRule);
  return (path, isDirectory = false) => {
    const segments = path.split("/");
    // A directory the rules cover takes everything under it, which is why each
    // ancestor is tested from the top down before the path itself.
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const candidate = segments.slice(0, depth).join("/");
      const candidateIsDirectory = depth < segments.length || isDirectory;
      let ignored = false;
      for (const rule of rules) {
        if (rule.directoryOnly && !candidateIsDirectory) continue;
        if (!rule.pattern.test(rule.anchored ? candidate : segments[depth - 1]!)) continue;
        ignored = !rule.negated;
      }
      if (ignored) return true;
    }
    return false;
  };
}

function parseIgnoreRule(line: string): IgnoreRule[] {
  let pattern = line.trim();
  if (pattern === "" || pattern.startsWith("#")) return [];
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.replace(/\/$/, "");
  // `**/name` is git's way of writing a name at any depth, which is what a
  // bare name already means here.
  pattern = pattern.replace(/^\*\*\//, "");
  // A leading slash, or a slash anywhere inside, ties the pattern to the root;
  // a bare name matches at any depth.
  const anchored = pattern.includes("/");
  pattern = pattern.replace(/^\//, "");
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ANY_DEPTH)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll(ANY_DEPTH, ".*");
  return [{ pattern: new RegExp(`^${body}$`), anchored, directoryOnly, negated }];
}

export async function collectProjectInstructions(sourceRoot: string): Promise<string> {
  const sections: string[] = [];
  for (const name of INSTRUCTION_NAMES) {
    const path = join(sourceRoot, name);
    try {
      const details = await lstat(path);
      rejectUnsupportedFile(details, path);
      sections.push(`# ${name}\n\n${await readFile(path, "utf8")}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return sections.join("\n\n");
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await assertDirectory(source, "directory");
  for await (const entry of glob(["**/*", "**/.*", ".*"], { cwd: source })) {
    const path = normalizeRelative(entry);
    if (!path || isTreeNoise(path)) continue;
    const from = join(source, path);
    const details = await lstat(from);
    if (details.isDirectory()) {
      await mkdir(join(destination, path), { recursive: true, mode: 0o755 });
      continue;
    }
    rejectUnsupportedFile(details, from);
    await copyFileExclusive(from, join(destination, path), details.mode);
  }
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
}

/** Every file in a tree that counts as its content, sorted, relative to the root. */
export async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of glob(["**/*", "**/.*", ".*"], { cwd: root })) {
    const path = normalizeRelative(entry);
    // Installed dependencies are not an arm's work, and a package manager
    // may leave symlinks in them.
    if (isTreeNoise(path)) continue;
    const details = await lstat(join(root, path));
    if (details.isSymbolicLink()) throw new UserError(`Manifest cannot include symlink: ${join(root, path)}`);
    if (details.isFile()) files.push(path);
  }
  return files.sort();
}

/**
 * Removes every symlink and special file under an arm's output, without
 * following any, and returns their paths. An agent can leave a link to a file
 * of the user's; nothing downstream follows links, but one would otherwise stop
 * the audit, the judge's copy, and the archive.
 */
export async function removeLinks(root: string, prefix = ""): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (TREE_NOISE.has(entry.name)) continue;
    if (entry.isDirectory()) removed.push(...await removeLinks(root, path));
    else if (!entry.isFile()) {
      await rm(join(root, path), { force: true });
      removed.push(path);
    }
  }
  return removed;
}

export async function buildManifest(root: string): Promise<FileManifest> {
  const entries: FileManifestEntry[] = [];
  for (const path of await listFiles(root)) {
    const absolute = join(root, path);
    const details = await stat(absolute);
    entries.push({
      path,
      sha256: await sha256File(absolute),
      bytes: details.size,
      mode: details.mode & 0o777,
    });
  }
  return { createdAt: new Date().toISOString(), entries };
}

export async function verifyManifest(root: string, expected: FileManifest): Promise<string[]> {
  const actual = await buildManifest(root);
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const differences: string[] = [];
  for (const path of new Set([...expectedByPath.keys(), ...actualByPath.keys()])) {
    const before = expectedByPath.get(path);
    const after = actualByPath.get(path);
    if (!before) differences.push(`added: ${path}`);
    else if (!after) differences.push(`missing: ${path}`);
    else if (before.sha256 !== after.sha256) differences.push(`changed: ${path}`);
  }
  return differences.sort();
}

export async function makeReadOnly(root: string): Promise<void> {
  const paths = [root];
  for await (const entry of glob(["**/*", "**/.*", ".*"], { cwd: root })) paths.push(join(root, entry));
  paths.sort((left, right) => right.length - left.length);
  for (const path of paths) {
    const details = await lstat(path);
    await chmod(path, details.isDirectory() ? 0o555 : 0o444);
  }
}

export async function removeTree(root: string): Promise<void> {
  try {
    await makeDirectoriesWritable(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rm(root, { recursive: true, force: true });

  async function makeDirectoriesWritable(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => makeDirectoriesWritable(join(directory, entry.name))));
  }
}

/**
 * Bytes a whole tree occupies, counting everything removeTree would delete —
 * including the dependencies and build output a manifest deliberately skips.
 * A tree that is already gone is zero bytes.
 */
export async function treeSize(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total += (await lstat(join(entry.parentPath, entry.name)).catch(() => null))?.size ?? 0;
  }
  return total;
}

export async function sha256File(path: string): Promise<string> {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let read = await handle.read(buffer, 0, buffer.length, null);
    while (read.bytesRead > 0) {
      hash.update(buffer.subarray(0, read.bytesRead));
      read = await handle.read(buffer, 0, buffer.length, null);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export function manifestFingerprint(manifest: FileManifest): string {
  return sha256Text(manifest.entries.map(({ path, sha256 }) => `${path}:${sha256}`).join("\n"));
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function listSkillDirectories(root: string): Promise<string[]> {
  await assertDirectory(root, "skills.root");
  const entries = await readdir(root, { withFileTypes: true });
  const skills: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && await isLinkedSkillFolder(join(root, entry.name), root))) continue;
    try {
      await assertFile(join(root, entry.name, "SKILL.md"), "skill");
      skills.push(entry.name);
    } catch {
      // Non-skill directories under the shared root are ignored.
    }
  }
  return skills.sort();
}

/**
 * A skill linked into the root from elsewhere counts, and is frozen from its
 * target. A link back into the root, or to a folder holding it, would list a
 * skill twice or copy the root into itself, so it does not.
 */
async function isLinkedSkillFolder(link: string, root: string): Promise<boolean> {
  try {
    const [target, base] = await Promise.all([realpath(link), realpath(root)]);
    if (!(await stat(target)).isDirectory()) return false;
    return !(target === base || target.startsWith(base + sep) || base.startsWith(target + sep));
  } catch {
    return false;
  }
}

export async function samePath(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return resolve(left) === resolve(right);
  }
}

export function normalizeRelative(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function isAlwaysExcluded(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => ALWAYS_EXCLUDED_SEGMENTS.has(segment)) || ALWAYS_EXCLUDED_NAMES.some((pattern) => pattern.test(basename(path)));
}

/** Metadata macOS writes beside files on its own: Finder's .DS_Store and AppleDouble `._*` files. */
export const isMacJunk = (name: string) => name === ".DS_Store" || name.startsWith("._");

/** Never part of a tree's own content: version control, dependencies, agent configuration, macOS metadata. */
const TREE_NOISE = new Set([".git", "node_modules", ".claude", ".codex", ".cursor"]);

export function isTreeNoise(path: string): boolean {
  return path.split("/").some((segment) => TREE_NOISE.has(segment) || isMacJunk(segment));
}

function rejectUnsupportedFile(details: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (details.isSymbolicLink()) throw new UserError(`Symlinks are not allowed in frozen inputs: ${path}`);
  if (!details.isFile() && !details.isDirectory()) throw new UserError(`Special files are not allowed in frozen inputs: ${path}`);
}

async function copyFileExclusive(source: string, destination: string, mode: number): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, mode & 0o777);
}
