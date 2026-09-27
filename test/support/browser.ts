import { readdirSync } from "node:fs";
import { playwrightBrowsersPath } from "../../src/paths.js";

/** The capture needs the browser Playwright installs; without it the test says so instead of failing. */
export function chromiumMissing(): string | false {
  try {
    const path = playwrightBrowsersPath();
    return readdirSync(path).some((entry) => entry.startsWith("chromium"))
      ? false
      : `no Chromium under ${path}; run npm run setup:browsers`;
  } catch {
    return "Playwright's browser cache is unavailable; run npm run setup:browsers";
  }
}
