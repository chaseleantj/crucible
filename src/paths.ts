import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathsConfig } from "./types.js";
import { loadUserConfig } from "./user-config.js";

/** This package's install directory, two levels above the compiled dist/src. */
export const RUNNER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Where runs, their workspaces, and the archive live; see user-config.ts for the precedence. */
export function pathsConfig(environment: NodeJS.ProcessEnv = process.env): PathsConfig {
  const { runsRoot, tempRoot, archiveRoot } = loadUserConfig(environment).values;
  return { runRoot: runsRoot, tempRoot, archiveRoot };
}

/**
 * Where Playwright keeps its browser builds for this user, and the one place
 * that decides it. Producers run with a scrubbed home, which hides the default
 * location from screenshot tools, so the producer environment names
 * it explicitly. An agent session inside its own sandbox may already point
 * PLAYWRIGHT_BROWSERS_PATH at a cache with no browser in it, so that value only
 * wins when a browser is actually installed under it.
 */
export function playwrightBrowsersPath(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  return override && hasInstalledBrowser(override) ? override : join(homedir(), "Library", "Caches", "ms-playwright");
}

/** Playwright marks a finished browser download with this file. */
const INSTALLATION_COMPLETE = "INSTALLATION_COMPLETE";

function hasInstalledBrowser(browsersPath: string): boolean {
  try {
    return readdirSync(browsersPath).some((entry) => existsSync(join(browsersPath, entry, INSTALLATION_COMPLETE)));
  } catch {
    return false;
  }
}

export function runDirectory(runId: string, paths = pathsConfig()): string {
  return join(paths.runRoot, runId);
}
