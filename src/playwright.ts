import { existsSync } from "node:fs";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";
import { errorMessage } from "./errors.js";
import { RUNNER_ROOT, playwrightBrowsersPath } from "./paths.js";
import { isDirectory } from "./scan-files.js";

const require = createRequire(import.meta.url);

/**
 * The node_modules folder Crucible's own Playwright is installed in, or null
 * when it cannot be found. It usually lies inside this runner's install, which
 * the sandbox hides, so the sandbox reads it back out (see sandboxWrap).
 */
export const RUNNER_PACKAGES: string | null = (() => {
  try {
    return dirname(dirname(require.resolve("playwright/package.json")));
  } catch {
    return null;
  }
})();

/**
 * The judge's node_modules: a link to each package in the configured
 * nodeModules, with Crucible's own Playwright standing in for any configured
 * one, since its Chromium is the one `crucible doctor` checks. Returns whether
 * require("playwright") resolves from the judge's workspace.
 */
export async function linkJudgePackages(nodeModules: string | null, judgeDir: string): Promise<boolean> {
  const target = join(judgeDir, "node_modules");
  await mkdir(target, { recursive: true });
  const configured = nodeModules && isDirectory(nodeModules) ? await readdir(nodeModules) : [];
  const own = RUNNER_PACKAGES ? join(RUNNER_PACKAGES, "playwright") : null;
  for (const entry of configured) {
    if (entry === "playwright" && own) continue;
    await symlink(join(nodeModules!, entry), join(target, entry));
  }
  if (own) await symlink(own, join(target, "playwright"));
  return resolvesFrom(judgeDir, "playwright");
}

function resolvesFrom(directory: string, name: string): boolean {
  try {
    createRequire(join(directory, "noop.js")).resolve(name);
    return true;
  } catch {
    return false;
  }
}

/** Why Crucible's Playwright has no Chromium to launch, or null when it has. */
export async function chromiumProblem(): Promise<string | null> {
  let executable: string;
  try {
    executable = (await loadPlaywright()).chromium.executablePath();
  } catch (error) {
    return `Crucible's Playwright does not load: ${errorMessage(error)}`;
  }
  if (existsSync(executable)) return null;
  const { version } = require("playwright/package.json") as { version: string };
  return `Chromium for Playwright ${version} is not installed at ${executable}; run npm run setup:browsers in ${RUNNER_ROOT}`;
}

/**
 * Chromium from the user's Playwright browser cache: the same lookup the
 * producers and the judge are given, so a runner started inside a sandboxed
 * agent session finds the browser too.
 */
export async function launchChromium(): Promise<Browser> {
  return (await loadPlaywright()).chromium.launch();
}

async function loadPlaywright(): Promise<typeof import("playwright")> {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath();
  return import("playwright");
}
