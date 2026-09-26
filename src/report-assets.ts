import { copyFile, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { UserError } from "./errors.js";
import { removeTree, sha256File } from "./files.js";
import { readOptionalJson, writeJson } from "./json.js";

const INDEX = "judge/report-assets.json";
const ASSETS = "review-assets";
const LINK = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
interface ReportAssets { links: Record<string, string | null>; warnings: string[] }

/** Preserve referenced evidence before the judge's temporary workspace is cleaned. */
export async function publishReportAssets(runDir: string, judgeDir: string): Promise<void> {
  const verdict = await readFile(join(runDir, "judge", "verdict.md"), "utf8");
  const index: ReportAssets = { links: {}, warnings: [] };
  await removeTree(join(runDir, ASSETS));
  for (const match of verdict.matchAll(LINK)) {
    const reference = match[1]!;
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference) || reference in index.links) continue;
    try {
      const path = decodeURIComponent(reference.split(/[?#]/)[0]!).replace(/^(?:\.\/)+/, "");
      if (!evidencePathAllowed(path)) {
        throw new UserError("not a judge evidence file");
      }
      const file = await containedFile(judgeDir, path);
      const target = `${ASSETS}/${(await sha256File(file)).slice(0, 20)}${extname(file).toLowerCase()}`;
      await mkdir(join(runDir, ASSETS), { recursive: true });
      await copyFile(file, join(runDir, target));
      index.links[reference] = target + reference.slice(reference.split(/[?#]/)[0]!.length);
    } catch (error) {
      index.links[reference] = null;
      index.warnings.push(`Judge evidence unavailable: ${reference} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  await writeJson(join(runDir, INDEX), index);
}

/** Keep the original verdict intact; only its presentation resolves saved evidence paths. */
export async function reportEvidence(runDir: string, verdict: string): Promise<{ text: string; warnings: string[] }> {
  const index = await readOptionalJson<ReportAssets>(join(runDir, INDEX));
  if (!index) return { text: verdict, warnings: [] };
  const text = verdict.replace(LINK, (full, reference: string) => {
    if (!(reference in index.links)) return full;
    const target = index.links[reference];
    return target === null ? full.replace(/^!?\[([^\]]*)\].*$/, "$1 (evidence unavailable)") : full.replace(`(${reference})`, `(${target})`);
  });
  return { text, warnings: index.warnings };
}

/** Only evidence named by the sealed verdict travels into the reading copy. */
export async function archiveReportAssets(runDir: string, destination: string): Promise<Map<string, string>> {
  const index = await readOptionalJson<ReportAssets>(join(runDir, INDEX));
  const replacements = new Map<string, string>();
  for (const reference of Object.values(index?.links ?? {})) {
    if (reference === null) continue;
    const path = reference.split(/[?#]/)[0]!;
    if (!path.startsWith(`${ASSETS}/`)) throw new UserError(`Unexpected review asset path: ${path}`);
    const source = await containedFile(runDir, path);
    const target = `dependencies/${path}`;
    await mkdir(join(destination, "dependencies", ASSETS), { recursive: true });
    await copyFile(source, join(destination, target));
    replacements.set(path, target);
  }
  return replacements;
}

async function containedFile(root: string, path: string): Promise<string> {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root) + sep)) throw new UserError("path leaves its evidence folder");
  const canonical = await realpath(absolute);
  if (!canonical.startsWith(await realpath(root) + sep)) throw new UserError("symlink leaves its evidence folder");
  if (!evidencePathAllowed(relative(await realpath(root), canonical))) throw new UserError("resolved path is private judge material");
  if (!(await stat(canonical)).isFile()) throw new UserError(`not a file: ${relative(root, absolute)}`);
  return canonical;
}

function evidencePathAllowed(path: string): boolean {
  return !!path && !path.split(/[\\/]/).some((part) => part.startsWith("."))
    && !/^(?:input(?:[\\/]|$)|judge(?:[\\/]|$)|verdict\.|stdout|stderr)/.test(path);
}
