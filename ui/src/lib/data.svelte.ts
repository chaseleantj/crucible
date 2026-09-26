// The one copy of the data, refreshed on a timer: every 5 seconds while
// something is running, every 30 otherwise, and whenever the tab regains focus.
import { type LoadFailure, LoadError, fetchSnapshot } from "./api";
import type { Snapshot } from "./types";

const LIVE_MS = 5_000;
const IDLE_MS = 30_000;

export const data = $state<{ snapshot: Snapshot | null; error: LoadFailure | null; updatedAt: number | null }>({
  snapshot: null,
  error: null,
  updatedAt: null,
});

let timer: ReturnType<typeof setTimeout> | undefined;
/** The newest refresh; an older one that answers late would bring back what was just deleted. */
let latest = 0;

export async function refresh(): Promise<void> {
  clearTimeout(timer);
  const request = ++latest;
  try {
    const snapshot = await fetchSnapshot();
    if (request !== latest) return;
    data.snapshot = snapshot;
    data.error = null;
    data.updatedAt = Date.now();
  } catch (error) {
    if (request !== latest) return;
    data.error = error instanceof LoadError
      ? error.failure
      : { message: `The results didn't load: ${error instanceof Error ? error.message : String(error)}`, hint: "Reload the page, or start the server again:", command: "crucible ui" };
  }
  const live = (data.snapshot?.experiments.live.inFlight.length ?? 0) > 0;
  timer = setTimeout(refresh, live ? LIVE_MS : IDLE_MS);
}

export function startPolling(): () => void {
  const onFocus = () => document.visibilityState === "visible" && refresh();
  document.addEventListener("visibilitychange", onFocus);
  refresh();
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onFocus);
  };
}
