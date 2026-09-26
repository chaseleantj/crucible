import { copyFile, mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { errorMessage } from "./errors.js";
import { removeTree } from "./files.js";
import { readOptionalJson, writeJson } from "./json.js";
import { slug } from "./slug.js";
import type { JudgeOutput, PageShot, ResolvedRun, ShotIndex } from "./types.js";

/** Pages per arm worth a picture; the rest are named in the index, not lost. */
export const MAX_PAGES_PER_ARM = 4;
export const VIEWPORT_WIDTHS = { desktop: 1440, phone: 390 } as const;
const SHOTS_DIR = "shots";
const INDEX_FILE = "index.json";

/** What the judge writes: the same index, under the anonymous letters and without a timestamp. */
type JudgeShotIndex = Pick<ShotIndex, "arms" | "omitted">;

export async function readShotIndex(runDir: string): Promise<ShotIndex | null> {
  return (await readOptionalJson<ShotIndex>(join(runDir, SHOTS_DIR, INDEX_FILE))) ?? null;
}

/** Where one arm's pictures go, relative to the run directory. */
export function shotsDir(label: string): string {
  return join(SHOTS_DIR, label);
}

/**
 * Where one arm's picture of one page goes, relative to the run directory and
 * without the viewport suffix. This module owns the layout, whoever took the
 * picture.
 */
export function shotStem(label: string, position: number, page: string): string {
  return join(shotsDir(label), `${String(position + 1).padStart(2, "0")}-${slug(page.replace(/\.[a-z]+$/i, ""))}`);
}

/** Pictures from an earlier judging or capture go first, so a run shows only what its current index is about. */

export async function resetShots(runDir: string): Promise<void> {
  await removeTree(join(runDir, SHOTS_DIR));
}

export async function writeShotIndex(runDir: string, index: ShotIndex): Promise<void> {
  await writeJson(join(runDir, SHOTS_DIR, INDEX_FILE), index);
}

/**
 * The part of the judge's prompt that asks for the pictures. The judge starts
 * each output the way that output's own instructions say, so it is the one
 * agent that sees a page finished rather than as a source file. A run with no
 * judge has no such agent, and `crucible capture` opens the files directly
 * instead.
 */
export function shotsPrompt(judgeDir: string, letters: JudgeOutput[]): string[] {
  const example = (letter: JudgeOutput) => [{ page: "Opening slide", artifact: "index.html", desktop: `${SHOTS_DIR}/${letter}/01-index-desktop.png`, phone: `${SHOTS_DIR}/${letter}/01-index-phone.png` }];
  const shape: JudgeShotIndex = {
    arms: Object.fromEntries(letters.map((letter) => [letter, example(letter)])),
    omitted: Object.fromEntries(letters.map((letter) => [letter, []])),
  };
  return [
    `Picture the pages you judge, so the report shows what you saw. Run each output the way its own README or scripts say — a static page through the URL the runner already serves it at, a build or install from a scratch copy under /tmp — and never open a framework's source index.html as a static page; the app's own server and route is what counts. Do not change an output to make it run. Take full-page PNGs with Playwright at ${VIEWPORT_WIDTHS.desktop} and ${VIEWPORT_WIDTHS.phone} wide — the page's full height at exactly that width, so clip to the viewport's width whenever the page is wider than it, as a deck whose slides sit side by side off-screen is — up to ${MAX_PAGES_PER_ARM} pages or states per output, the finished experience first, and use the same display label for comparable states in every output. Look at each picture before you keep it: a loading screen, an error page, or the wrong entry point means the launch was wrong, so fix the launch and take it again.`,
    `Save the pictures under ${join(judgeDir, SHOTS_DIR)}/<letter>/ and write ${join(judgeDir, SHOTS_DIR, INDEX_FILE)} in this shape, paths relative to your working directory:`,
    JSON.stringify(shape),
    'The page field is a display label for comparison (for example "Slide 4"). The artifact field must name the actual existing file relative to that output folder, for example "launch-deck.html"; filenames may differ between outputs. Multiple slide states can share one artifact. Never normalize filenames to index.html or put a label in artifact. Fragment/query suffixes are allowed but only the underlying file is archived. For a server-backed app without a portable file, omit artifact and use its route as page; explain the packaging limit in error.',
    'An output that is only Markdown is rendered on a plain readable page and pictured that way, with "rendered": "markdown" on the entry. An image output, such as an SVG, is pictured first centred on a plain page and scaled up to fill most of the viewport, never opened bare where a small icon sits in a corner of an empty picture; other sizes it must work at can follow as further states. A page that will not run at all gets null for that viewport and an "error" saying why; never stand in a broken picture for it. Pages an output has that you did not picture go under omitted by name. Work with no visual form leaves the list empty.',
  ];
}

/**
 * Moves the judge's pictures into the run under the arm labels, so the report,
 * the archive, and any reader of it show the pages the verdict was about. Problems are
 * recorded, never thrown: the verdict is complete by now and a missing picture
 * must not undo it. An earlier judging's pictures go first, so a rejudged run
 * shows only what its verdict is about.
 */
export async function publishShots(run: ResolvedRun, judgeDir: string, mapping: Record<JudgeOutput, string>): Promise<ShotIndex> {
  await resetShots(run.runDir);
  const labels = run.config.arms.map((arm) => arm.label);
  const index: ShotIndex = {
    capturedAt: new Date().toISOString(),
    capturedBy: "judge",
    arms: Object.fromEntries(labels.map((label) => [label, []])),
    omitted: Object.fromEntries(labels.map((label) => [label, []])),
  };
  const judged = await readOptionalJson<JudgeShotIndex>(join(judgeDir, SHOTS_DIR, INDEX_FILE));
  if (!judged?.arms) {
    index.skipped = "The judge wrote no screenshot index";
  } else {
    for (const [letter, producerId] of Object.entries(mapping) as Array<[JudgeOutput, string]>) {
      const label = run.assignment.arms[producerId]!;
      const pages = (judged.arms[letter] ?? []).filter((shot) => typeof shot?.page === "string");
      index.omitted[label] = [...(judged.omitted?.[letter] ?? []), ...pages.slice(MAX_PAGES_PER_ARM).map((shot) => shot.page)];
      await mkdir(join(run.runDir, shotsDir(label)), { recursive: true });
      for (const [position, shot] of pages.slice(0, MAX_PAGES_PER_ARM).entries()) {
        index.arms[label]!.push(await publishPage(judgeDir, letter, shot, shotStem(label, position, shot.page), run.runDir));
      }
    }
    if (labels.every((label) => index.arms[label]!.length === 0)) index.skipped = "The judge pictured no pages";
  }
  await writeShotIndex(run.runDir, index);
  return index;
}

/** One page's pictures copied under the run, keeping only what the judge really wrote for that letter. */
async function publishPage(judgeDir: string, letter: JudgeOutput, shot: PageShot, stem: string, runDir: string): Promise<PageShot> {
  const published: PageShot = { page: shot.page, ...(typeof shot.artifact === "string" ? { artifact: shot.artifact } : {}), desktop: null, phone: null, ...(shot.rendered ? { rendered: shot.rendered } : {}) };
  const errors = shot.error ? [shot.error] : [];
  for (const viewport of Object.keys(VIEWPORT_WIDTHS) as Array<keyof typeof VIEWPORT_WIDTHS>) {
    const source = shot[viewport];
    if (source === null || source === undefined) continue;
    const target = `${stem}-${viewport}.png`;
    try {
      await copyFile(await judgeFile(judgeDir, letter, source), join(runDir, target));
      published[viewport] = target;
    } catch (error) {
      errors.push(`${viewport}: ${errorMessage(error)}`);
    }
  }
  if (errors.length > 0) published.error = errors.join("; ");
  return published;
}

/** A picture the judge names has to be a file inside its own folder for that letter. */
async function judgeFile(judgeDir: string, letter: JudgeOutput, path: string): Promise<string> {
  const file = join(judgeDir, path);
  const inside = relative(join(judgeDir, SHOTS_DIR, letter), file);
  if (isAbsolute(path) || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${path} is outside ${SHOTS_DIR}/${letter}`);
  if (!(await stat(file).catch(() => null))?.isFile()) throw new Error(`${path} is missing`);
  return file;
}
