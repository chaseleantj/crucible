// Every request the dashboard makes. Paths in the data are absolute; the
// server serves a file in an archive entry or run record at
// <that folder's prefix in snapshot.files>/<path>, so a report's relative
// links keep working, and a page can reach nothing outside its own folder.
import type { Snapshot } from "./types";

/** Folder to the prefix its files are served under; the snapshot names them, with a token each. */
let files: Record<string, string> = {};

/** Why the results didn't load, and the command that should fix it. */
export interface LoadFailure {
  message: string;
  hint: string;
  command: string;
}

export class LoadError extends Error {
  constructor(readonly failure: LoadFailure) {
    super(failure.message);
  }
}

export const UNREACHABLE: LoadFailure = {
  message: "Couldn't reach the dashboard server.",
  hint: "It stops when its terminal closes. Start it again, then retry:",
  command: "crucible ui",
};

export async function fetchSnapshot(): Promise<Snapshot> {
  let response: Response;
  try {
    response = await fetch("api/experiments", { cache: "no-store" });
  } catch {
    throw new LoadError(UNREACHABLE);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const said = typeof body?.error === "string" ? body.error : null;
    throw new LoadError(response.status >= 500
      ? {
          message: `The dashboard server failed while reading the results${said ? `: ${said}` : "."}`,
          hint: "Find the archive entry it trips on, fix or remove it, then retry:",
          command: "crucible check",
        }
      : {
          message: `The dashboard server refused the request (${response.status})${said ? `: ${said}` : "."}`,
          hint: "Open the address the server printed when it started, or start it again:",
          command: "crucible ui",
        });
  }
  const snapshot: Snapshot = await response.json();
  files = snapshot.files;
  return snapshot;
}

/** A file's URL; one outside every folder the server opens gets a prefix that answers 404. */
export function fileUrl(path: string): string {
  const folder = Object.keys(files).filter((scope) => path.startsWith(`${scope}/`)).reduce((a, b) => (b.length > a.length ? b : a), "");
  return `${files[folder] ?? "files/-"}${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Show a file or folder in Finder. */
export const reveal = (path: string) => post("api/reveal", { path }).then(() => {});

/** What became of one selection: every path it took, or why none of it went. */
export type DeleteResult = { deleted: string[] } | { error: string };

/**
 * Deletes selections of archived runs and run records, each whole or not at
 * all, answering for each in order. The store adds each archived run's idle
 * record; a dry run removes nothing and says what each would take.
 */
export const deleteSelections = (items: string[][], dryRun = false) =>
  post<{ results: DeleteResult[] }>("api/delete", { items, dryRun }).then((body) => body.results);

/** Delete an archived run folder or a runner record, by its absolute path. */
export async function deleteRun(path: string): Promise<void> {
  const [result] = await deleteSelections([[path]]);
  if (result && "error" in result) throw new Error(result.error);
}

async function post<T = unknown>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    // The server refuses an action without X-Crucible, which only this page sends.
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Crucible": "1" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach the dashboard server. Start it again with crucible ui, then retry.");
  }
  if (!response.ok) throw new Error(await failure(response));
  return response.json();
}

async function failure(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : `The server answered ${response.status}.`;
}
