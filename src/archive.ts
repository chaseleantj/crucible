import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { changedPaths, withholdNonArmFiles } from "./baseline.js";
import { copyTree, listFiles, removeTree, writePrivateFile } from "./files.js";
import { readOptionalJson, writeJson } from "./json.js";
import { describeOutcome } from "./html.js";
import { isJudged } from "./verdict.js";
import { entryIssues, readmeIssue } from "./check.js";
import { UserError } from "./errors.js";
import { pathsConfig } from "./paths.js";
import { readRunState } from "./state.js";
import type { ResolvedRun, RunResult } from "./types.js";
import { archiveReportAssets } from "./report-assets.js";
import { slug } from "./slug.js";

/** Publish a small reading copy. Reproducibility records remain in runDir. */
export async function archiveRun(run: ResolvedRun, destinationRoot = pathsConfig().archiveRoot, buildDirectory?: string): Promise<string> {
  const state = await readRunState(run.runDir);
  if (state.state !== "reported" && state.state !== "cleaned") {
    throw new UserError(`Run must be reported before archiving; current state is ${state.state}`);
  }
  const result = await readOptionalJson<RunResult>(join(run.runDir, "result.json"));
  if (!result) throw new UserError("This run has no result.json; run crucible report again");
  const existing = await archiveOf(destinationRoot, run.runId);
  if (!existing && state.state === "cleaned") {
    throw new UserError("The outputs were removed by crucible clean; archive a run before cleaning it");
  }
  await mkdir(destinationRoot, { recursive: true });
  const destination = existing ?? join(destinationRoot, await freeName(destinationRoot, slug(run.config.name)));
  const stage = await mkdtemp(join(destinationRoot, ".archive-"));
  try {
    for (const [producerId, label] of Object.entries(run.assignment.arms)) {
      const workspace = join(run.tempDir, producerId, "source");
      const previous = existing ? join(existing, "outputs", label) : null;
      if (await isDirectory(workspace) && buildDirectory) {
        const build = inside(workspace, buildDirectory);
        if (!await isDirectory(build)) throw new UserError(`Build directory is missing: ${build}`);
        if (!(await realpath(build)).startsWith(await realpath(workspace) + sep)) {
          throw new UserError(`Build directory leaves its workspace: ${buildDirectory}`);
        }
        const captured = result.shots?.arms[label]?.map((shot) => shot.artifact ?? shot.page);
        const pages = captured?.length ? captured : (await listFiles(build)).filter((path) => /\.html?$/i.test(path));
        if (!pages.length) throw new UserError(`Build directory has no final HTML pages: ${build}`);
        await copyArtifacts(build, join(stage, "outputs", label), pages);
      } else if (await isDirectory(workspace)) {
        const scratch = await mkdtemp(join(tmpdir(), "crucible-curate-"));
        try {
          await copyTree(workspace, scratch);
          await withholdNonArmFiles(run.runDir, producerId, scratch);
          const captured = result.shots?.arms[label]?.map((shot) => shot.artifact ?? shot.page);
          const pages = captured?.length ? captured : (await changedPaths(run, producerId))
              .filter((path) => /\.(html?|md|py|ts|tsx|jsx|js|mjs|sh|go|rs|c|cpp|h|java|rb|sql)$/i.test(path));
          await copyArtifacts(scratch, join(stage, "outputs", label), pages);
        } finally { await removeTree(scratch); }
      } else if (previous && await isDirectory(previous)) {
        const pages = result.shots?.arms[label]?.map((shot) => shot.artifact ?? shot.page)
          ?? (await listFiles(previous)).filter((path) => /\.(html?|md|py|ts|tsx|jsx|js|mjs|sh|go|rs|c|cpp|h|java|rb|sql)$/i.test(path));
        await copyArtifacts(previous, join(stage, "outputs", label), pages);
      } else if (!existing) {
        throw new UserError(`Producer workspace is missing: ${workspace}`);
      }
    }
    const archived = structuredClone(result);
    let report = await readFile(join(run.runDir, "report.html"), "utf8");
    for (const [source, target] of await archiveReportAssets(run.runDir, stage)) {
      report = report.replaceAll(source, target);
    }
    for (const shots of Object.values(archived.shots?.arms ?? {})) {
      for (const shot of shots) {
        for (const viewport of ["desktop", "phone"] as const) {
          const source = shot[viewport];
          if (!source) continue;
          if (!source.startsWith("shots/")) throw new UserError(`Unexpected capture path: ${source}`);
          const path = inside(run.runDir, source);
          const target = `dependencies/${source}`;
          await mkdir(dirname(join(stage, target)), { recursive: true });
          await copyFile(path, join(stage, target));
          shot[viewport] = target;
          report = report.replaceAll(source, target);
        }
      }
    }
    await writeJson(join(stage, "result.json"), archived);
    await writePrivateFile(join(stage, "report.html"), report);
    const note = existing ? await readFile(join(existing, "README.md"), "utf8").catch(() => null) : null;
    const text = readme(result, note);
    await writePrivateFile(join(stage, "README.md"), text);
    // Notes a reader wrote can push the README past its limit. Refusing the
    // refresh would strand the new result, and trimming would lose the notes,
    // so the length is reported and left to the reader.
    const long = readmeIssue(text);
    if (long) process.stderr.write(`Warning: ${long}. The notes around the result were kept; trim them, then run crucible check.\n`);
    const problems = entryIssues(stage).filter((problem) => problem !== long);
    if (problems.length) throw new UserError(problems.join("\n"));
    if (existing) {
      const backup = `${stage}-previous`;
      await rename(existing, backup);
      try { await rename(stage, destination); }
      catch (error) { await rename(backup, existing); throw error; }
      await removeTree(backup);
    } else {
      await rename(stage, destination);
    }
    return destination;
  } finally { await removeTree(stage); }
}

/** Only explicit local references travel with the final pages; no source-tree copy. */
async function copyArtifacts(source: string, destination: string, pages: string[]): Promise<void> {
  const copied = new Set<string>();
  /** Bare module specifiers resolve through the page's import map; the map travels down to every module the page reaches. */
  async function copy(path: string, finalPage = false, importMap: ImportMap = new Map()): Promise<void> {
    const absolute = inside(source, path);
    const key = relative(source, absolute);
    if (copied.has(key) || !(await stat(absolute).catch(() => null))?.isFile()) return;
    if (!(await realpath(absolute)).startsWith(await realpath(source) + sep)) {
      throw new UserError(`Artifact link leaves its folder: ${path}`);
    }
    copied.add(key);
    await mkdir(dirname(join(destination, key)), { recursive: true });
    await copyFile(absolute, join(destination, key));
    if (![".html", ".htm", ".md", ".css", ".js", ".mjs", ".svg"].includes(extname(key).toLowerCase())) return;
    const text = await readFile(absolute, "utf8");
    if (finalPage && /\.html?$/i.test(key) && (/(?:src|poster)\s*=\s*["']\/(?!\/)|<link\b[^>]*href\s*=\s*["']\/(?!\/)|<script\b[^>]*src\s*=\s*["'][^"']*\.(?:ts|tsx|jsx)(?:[?"'])/i.test(text))) {
      throw new UserError(`Final page ${key} needs a build or root-relative runtime assets. Build with relative asset URLs, then archive with --build-dir <directory>; the raw run remains available.`);
    }
    if (/\.html?$/i.test(key)) importMap = new Map([...importMap, ...readImportMap(text, dirname(absolute))]);
    for (const reference of localReferences(text)) {
      const target = reference.split(/[?#]/)[0]!;
      if (!target || target.includes("\u0000")) continue;
      // A literal is a runtime reference only when it names an existing local file.
      const candidate = mapImport(importMap, target) ?? resolve(dirname(absolute), target);
      if (!candidate.startsWith(resolve(source) + sep)) continue;
      await copy(relative(source, candidate), false, importMap);
    }
  }
  for (const page of pages) {
    if (/^(?:[a-z][\w+.-]*:|\/)/i.test(page)) continue;
    const artifact = page.split(/[?#]/)[0]!;
    if (!artifact || !(await stat(inside(source, artifact)).catch(() => null))?.isFile()) {
      throw new UserError(`Selected final artifact is missing: ${page}. Set the screenshot index artifact field to the actual file relative to its output folder, then run crucible report and archive again.`);
    }
    await copy(artifact, true);
  }
}

/**
 * Every quoted string, CSS url(), and Markdown link target that could name a
 * local file: attribute values and module or URL literals included. Each quote
 * kind is scanned on its own, so an empty string such as CSS `content:""` or an
 * apostrophe in prose cannot shift the pairing of the other kind and swallow
 * the references after it. Junk candidates are harmless: a reference only
 * matters when it names an existing file inside the output folder.
 */
export function localReferences(text: string): string[] {
  const patterns = [/"([^"\n]*)"/g, /'([^'\n]*)'/g, /url\(\s*([^\s)'"]+)\s*\)/g, /\]\(([^\s)]+)\)/g];
  const references: string[] = [];
  for (const pattern of patterns) {
    for (const [, reference] of text.matchAll(pattern)) {
      if (reference && !/^(?:[a-z][\w+.-]*:|\/|#)/i.test(reference)) references.push(reference);
    }
  }
  return references;
}

/** Import-map specifier (exact, or a prefix ending in "/") to the absolute local path it maps to. */
type ImportMap = Map<string, string>;

function readImportMap(html: string, base: string): ImportMap {
  const map: ImportMap = new Map();
  for (const [, body] of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let imports: unknown;
    try { imports = (JSON.parse(body!) as { imports?: unknown }).imports; } catch { continue; }
    if (!imports || typeof imports !== "object") continue;
    for (const [specifier, address] of Object.entries(imports as Record<string, unknown>)) {
      // Only addresses that stay local can name archived files; URLs and root-relative paths are left as they are.
      if (typeof address !== "string" || /^(?:[a-z][\w+.-]*:|\/)/i.test(address)) continue;
      if (specifier.endsWith("/") !== address.endsWith("/")) continue;
      map.set(specifier, resolve(base, address));
    }
  }
  return map;
}

/** The import-map resolution rule: an exact entry wins, then the longest matching prefix entry. */
function mapImport(map: ImportMap, specifier: string): string | null {
  const exact = map.get(specifier);
  if (exact !== undefined) return exact;
  let best: [string, string] | null = null;
  for (const [prefix, target] of map) {
    if (!prefix.endsWith("/") || !specifier.startsWith(prefix)) continue;
    if (!best || prefix.length > best[0].length) best = [prefix, target];
  }
  return best ? join(best[1], specifier.slice(best[0].length)) : null;
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root) + sep)) throw new UserError(`Artifact path leaves its folder: ${path}`);
  return absolute;
}

const FACTS = ["<!-- crucible:result -->", "<!-- /crucible:result -->"] as const;
const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean);

/**
 * The entry's README. A fresh one is a short generated note; an existing one
 * is the reader's, so only the generated result block between its markers
 * changes, and a README without markers keeps its text and gains the block.
 */
function readme(result: RunResult, previous: string | null): string {
  const outcome = isJudged(result)
    ? `${describeOutcome(result)}: ${result.arms.map(({ label }) => `${label} ${result.totals[label]!.toFixed(2)}`).join(", ")} weighted. Judge confidence ${Math.round(result.confidence * 100)}%.`
    : `${describeOutcome(result)}: ${result.arms.map(({ label }) => label).join(", ")} produced without a verdict; the captures show what each arm made.`;
  const facts = `${FACTS[0]}\n${outcome}\n${FACTS[1]}`;
  if (previous !== null) {
    const [start, end] = FACTS;
    if (!(previous.includes(start) && previous.indexOf(end) > previous.indexOf(start))) return `${previous.trimEnd()}\n\n${facts}\n`;
    const from = previous.indexOf(start) + start.length;
    return `${previous.slice(0, from)}\n${outcome}\n${previous.slice(previous.indexOf(end, from))}`;
  }
  // Full task, score details and warnings belong in result.json and report.html.
  const task = words(result.task);
  return [
    `# ${words(result.name).slice(0, 16).join(" ")}`,
    "", `Run ${result.runId}, ${result.reportedAt.slice(0, 10)}.`, "",
    `Question: ${task.slice(0, 45).join(" ")}${task.length > 45 ? " …" : ""}`,
    "", facts, "",
    isJudged(result)
      ? "One run per arm: evidence, not proof. report.html has the full comparison."
      : "One run per arm, and nothing ranks them. report.html shows what each made and cost.",
    "",
  ].join("\n");
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

export async function archiveOf(root: string, runId: string): Promise<string | null> {
  for (const entry of (await readdir(root).catch(() => [] as string[])).sort()) {
    if (entry.startsWith(".")) continue;
    const destination = join(root, entry);
    const result = await readOptionalJson<RunResult>(join(destination, "result.json")).catch(() => undefined);
    if (result?.runId === runId) return destination;
  }
  return null;
}

async function freeName(root: string, base: string): Promise<string> {
  const taken = new Set(await readdir(root).catch(() => [] as string[]));
  if (!taken.has(base)) return base;
  for (let attempt = 2; ; attempt += 1) {
    const candidate = `${base}-run${attempt}`;
    if (!taken.has(candidate)) return candidate;
  }
}
