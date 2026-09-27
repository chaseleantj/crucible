import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { ARTIFACT_VIEW_FLAG, isMarkdown, isViewableArtifact } from "./artifact-view.js";
import { changedPaths } from "./baseline.js";
import { UserError, errorMessage } from "./errors.js";
import { removeTree } from "./files.js";
import { copyArmOutputs } from "./outputs.js";
import { launchChromium } from "./playwright.js";
import { producerOf } from "./run.js";
import { serveOutputs } from "./serve.js";
import { MAX_PAGES_PER_ARM, VIEWPORT_WIDTHS, resetShots, shotStem, shotsDir, writeShotIndex } from "./shots.js";
import { readRunState } from "./state.js";
import type { PageShot, ResolvedRun, ShotIndex } from "./types.js";

const PAGE_TIMEOUT_MS = 20_000;
/** Tall enough to lay a page out; the pictures themselves are full-page. */
const VIEWPORT_HEIGHT = 900;
const TEXT_FILES = /\.txt$/i;

/** What one arm changed, split into the pages the runner can open and the text it cannot render. */
interface ArmPages {
  pages: string[];
  text: string[];
}

/**
 * The pictures for a run with no judge. The runner serves each arm's own work
 * as static files, exactly as it serves the judge's copies, and opens every
 * HTML, SVG, and Markdown file the arm changed at both viewports. A page that needs a build or a
 * dev server first shows only what its source file shows, which is why a judged
 * run lets the judge take its own pictures.
 * Nothing here fails the run — a page that will not load gets its reason in the
 * index, and a missing browser leaves the index empty with the reason on it.
 */
export async function captureRun(run: ResolvedRun): Promise<ShotIndex> {
  if (run.config.judge) {
    throw new UserError(`Run ${run.runId} has a judge, which takes its own pictures: crucible judge ${run.runId}`);
  }
  const state = await readRunState(run.runDir);
  if (state.state !== "produced" && state.state !== "reported") {
    throw new UserError(`Run must have complete outputs before capturing; current state is ${state.state}`);
  }

  const labels = run.config.arms.map((arm) => arm.label);
  const captureDir = join(run.tempDir, "capture");
  await removeTree(captureDir);
  await copyArmOutputs(run, captureDir, Object.fromEntries(labels.map((label) => [label, producerOf(run.assignment, label)])));
  const changed = new Map<string, ArmPages>();
  for (const label of labels) changed.set(label, await changedFiles(run, label, join(captureDir, label)));

  const index: ShotIndex = {
    capturedAt: new Date().toISOString(),
    capturedBy: "runner",
    arms: Object.fromEntries(labels.map((label) => [label, [] as PageShot[]])),
    omitted: Object.fromEntries(labels.map((label) => [label, [
      ...changed.get(label)!.pages.slice(MAX_PAGES_PER_ARM),
      ...changed.get(label)!.text,
    ]])),
  };
  await resetShots(run.runDir);
  if (labels.every((label) => changed.get(label)!.pages.length === 0)) {
    index.skipped = "No arm changed an HTML, SVG, or Markdown file; other outputs are listed rather than rendered";
  } else {
    const failure = await captureArms(run, captureDir, labels, changed, index);
    if (failure) index.skipped = failure;
  }
  await writeShotIndex(run.runDir, index);
  await removeTree(captureDir);
  return index;
}

/** Fills the index in place, or returns why no picture could be taken at all. */
async function captureArms(
  run: ResolvedRun,
  captureDir: string,
  labels: string[],
  changed: Map<string, ArmPages>,
  index: ShotIndex,
): Promise<string | null> {
  let browser: Browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    return `The runner could not start Chromium: ${errorMessage(error)}`;
  }
  const servers = await serveOutputs(captureDir, labels);
  const urls = new Map(servers.served.map((output) => [output.name, output.url]));
  try {
    for (const label of labels) {
      const pages = changed.get(label)!.pages.slice(0, MAX_PAGES_PER_ARM);
      if (pages.length > 0) await mkdir(join(run.runDir, shotsDir(label)), { recursive: true });
      for (const [position, page] of pages.entries()) {
        index.arms[label]!.push(await capturePage(browser, urls.get(label)!, page, shotStem(label, position, page), run.runDir));
      }
    }
  } finally {
    await servers.close();
    await browser.close();
  }
  return null;
}

/** One page at both viewports; a viewport that fails leaves null and its reason. */
async function capturePage(browser: Browser, baseUrl: string, artifact: string, stem: string, runDir: string): Promise<PageShot> {
  const shot: PageShot = { page: artifact, artifact, desktop: null, phone: null };
  if (isMarkdown(artifact)) shot.rendered = "markdown";
  const errors: string[] = [];
  const url = new URL(artifact.split("/").map(encodeURIComponent).join("/"), baseUrl);
  url.searchParams.set(ARTIFACT_VIEW_FLAG, "");
  for (const [viewport, width] of Object.entries(VIEWPORT_WIDTHS) as Array<[keyof typeof VIEWPORT_WIDTHS, number]>) {
    const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT } });
    const target = `${stem}-${viewport}.png`;
    try {
      const page = await context.newPage();
      const response = await page.goto(url.href, { waitUntil: "load", timeout: PAGE_TIMEOUT_MS });
      if (!response?.ok()) throw new Error(`the page answered ${response ? response.status() : "nothing"}`);
      // The full height, never the full width: a deck whose slides sit side by
      // side off-screen would otherwise widen the picture to all of them.
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
      await page.screenshot({ path: join(runDir, target), fullPage: true, clip: { x: 0, y: 0, width, height } });
      shot[viewport] = target;
    } catch (error) {
      errors.push(`${viewport}: ${errorMessage(error)}`);
    } finally {
      await context.close();
    }
  }
  if (errors.length > 0) shot.error = errors.join("; ");
  return shot;
}

/** The pages and text files one arm added or changed, in a stable order and only where the reading copy kept them. */
async function changedFiles(run: ResolvedRun, label: string, armDir: string): Promise<ArmPages> {
  const kept: ArmPages = { pages: [], text: [] };
  const paths = await changedPaths(run, producerOf(run.assignment, label));
  for (const path of paths) {
    if (!isViewableArtifact(path) && !TEXT_FILES.test(path)) continue;
    if (!(await stat(join(armDir, path)).catch(() => null))?.isFile()) continue;
    (isViewableArtifact(path) ? kept.pages : kept.text).push(path);
  }
  return kept;
}
