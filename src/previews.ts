// Which picture stands for an archived arm. Validation and every reader of the
// archive choose it here, so a preview that passes the check is the one shown.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isMacJunk } from "./files.js";

export interface VisualPreview {
  /** The output is visual (a page, deck, video, or image), so a preview is expected. */
  required: boolean;
  path: string | null;
}

export const isPreviewImage = (name: string) => /\.(png|jpe?g|gif|webp|avif)$/i.test(name);
const visualArtifact = (name: string) => /\.(html?|pdf|pptx?|mp4|webm|mov|svg)$/i.test(name);
/** Folders whose files support an output rather than being it. */
const SUPPORT_FOLDERS = ["dependencies", "src", "templates", "assets"];
/** Installed packages and working state: never part of an entry, never walked. */
export const WORKING_STATE = ["node_modules", ".git", "__pycache__"];

/** Every regular file under `directory`, relative to it; symlinks, working state, and macOS metadata skipped. */
export function entryFiles(directory: string, prefix = ""): string[] {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return [];
  return readdirSync(directory).filter((name) => !isMacJunk(name)).flatMap((name) => {
    const file = join(directory, name);
    const info = lstatSync(file);
    const local = join(prefix, name);
    if (info.isSymbolicLink()) return [];
    if (info.isDirectory()) return WORKING_STATE.includes(name) ? [] : entryFiles(file, local);
    return info.isFile() ? [local] : [];
  });
}

function previewFile(directory: string, name: unknown, files: string[]): string | null {
  if (typeof name !== "string" || !isPreviewImage(name)) return null;
  const file = resolve(directory, name);
  return files.includes(relative(resolve(directory), file)) ? file : null;
}

/**
 * One output folder's preview: a `preview.*` image, then a screenshot its
 * README embeds, then any top-level image when nothing in it is a visual
 * artifact of its own.
 */
export function visualPreview(directory: string): VisualPreview {
  const files = entryFiles(directory);
  const required = files.some((file) => !file.split("/").slice(0, -1).some((folder) => SUPPORT_FOLDERS.includes(folder)) && visualArtifact(file));
  const note = files.includes("README.md") ? readFileSync(join(directory, "README.md"), "utf8") : "";
  const embedded = [...note.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].flatMap((match) => {
    try { return [decodeURIComponent((match[1] ?? match[2])!)]; } catch { return []; }
  });
  const candidates = [
    ...files.filter((file) => /^(?:dependencies\/)?preview\.[^/]+$/i.test(file)),
    ...embedded,
    ...(!required ? files.filter((file) => !file.includes("/") && isPreviewImage(file)) : []),
  ];
  const path = candidates.map((name) => previewFile(directory, name, files)).find(Boolean) ?? null;
  return { required: required || files.some((file) => !file.includes("/") && isPreviewImage(file)), path };
}

/**
 * Each arm's preview in an archive: its captures in result.json (desktop,
 * then mobile, then phone), then legacy captures under dependencies/shots,
 * then whatever its output folder offers. Labels come from the result, its
 * captures, and the folders on disk, so an arm the result forgot still shows.
 */
export function experimentVisualPreviews(directory: string, result: unknown = null): Record<string, VisualPreview> {
  const folders = (root: string) => existsSync(root) && lstatSync(root).isDirectory()
    ? readdirSync(root).filter((name) => {
      const info = lstatSync(join(root, name));
      return info.isDirectory() && !info.isSymbolicLink();
    })
    : [];
  const saved = (result ?? {}) as { arms?: unknown; shots?: { arms?: unknown } | null };
  const shots = saved.shots?.arms;
  const shotMap = shots && typeof shots === "object" && !Array.isArray(shots) ? shots as Record<string, unknown> : null;
  const labels = [...new Set([
    ...(Array.isArray(saved.arms) ? saved.arms.map((arm: { label?: unknown } | null) => arm?.label).filter((label): label is string => typeof label === "string") : []),
    ...(shotMap ? Object.keys(shotMap) : []),
    ...folders(join(directory, "outputs")),
    ...folders(join(directory, "dependencies", "shots")),
  ])];
  const files = entryFiles(directory);
  return Object.fromEntries(labels.filter((label) => label !== ".." && !/[\\/]/.test(label)).map((label) => {
    const output = visualPreview(join(directory, "outputs", label));
    const captures = (Array.isArray(shotMap?.[label]) ? shotMap[label] : []) as Array<Record<string, unknown> | null>;
    const legacy = files.filter((file) => file.startsWith(`dependencies/shots/${label}/`) && isPreviewImage(file));
    const candidates = [
      ...captures.map((shot) => shot?.desktop), ...captures.map((shot) => shot?.mobile), ...captures.map((shot) => shot?.phone),
      ...legacy.filter((file) => /desktop/i.test(file)), ...legacy,
    ];
    const path = candidates.map((name) => previewFile(directory, name, files)).find(Boolean) ?? output.path;
    return [label, { required: output.required, path }];
  }));
}
