// The dashboard's key. Its API and actions answer only a browser that holds
// it, so anything else that reaches the port gets nothing, including an agent
// under test, which cannot read the home folder the key lives in.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const dashboardKeyFile = () => join(homedir(), ".crucible", "ui-key");

/** This machine's dashboard key, made the first time it is asked for. */
export function dashboardKey(file = dashboardKeyFile()): string {
  try {
    const key = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(key)) return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

/** The address that signs a browser in: it trades the key for a cookie, then drops it from the address. */
export const dashboardLoginUrl = (origin: string, key = dashboardKey(), hash = "") => `${origin}/?key=${key}${hash}`;
