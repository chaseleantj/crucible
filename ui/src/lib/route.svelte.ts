// The URL hash is the only navigation state: #/ for the list (with its search
// and page, see home.svelte.ts), #/q/<question>/<run> for one question, and
// #/q/<question>/<run>/view/<arm>/<page> for one arm's page live, with
// ?phone for the narrow frame. A reload or the back button lands where you
// were, and a viewer address can be shared.
import { listHref, readList } from "./home.svelte";
import type { Device } from "./runs";

export interface Viewing {
  arm: string;
  /** Relative to the arm's output folder, with any fragment: deck.html#/4. */
  page: string;
  device: Device;
}

export type Route = { view: "home" } | { view: "question"; key: string; runId: string | null; viewing: Viewing | null };

/**
 * A hash that does not decode, pasted or truncated, is the list. `apply`
 * takes a list address's search and page into the list's state; reading an
 * address only to compare it leaves them alone.
 */
function parse(hash: string, apply = true): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  let parts: string[];
  try {
    parts = path.split("/").map(decodeURIComponent);
  } catch {
    return { view: "home" };
  }
  const [kind, key, runId, view, arm, page] = parts;
  if (kind === "q" && key) {
    const viewing = runId && view === "view" && arm && page ? { arm, page, device: new URLSearchParams(query).has("phone") ? "phone" as const : "desktop" as const } : null;
    return { view: "question", key, runId: runId || null, viewing };
  }
  if (apply) readList(new URLSearchParams(query));
  return { view: "home" };
}

export const route = $state<{ current: Route }>({ current: parse(location.hash) });

window.addEventListener("hashchange", () => {
  route.current = parse(location.hash);
});

/**
 * Moves to an address without a history entry, as the viewer does when you
 * switch arm, page, or width: back should leave the viewer, not step
 * through every page you looked at.
 */
export function replaceRoute(href: string): void {
  history.replaceState(history.state, "", href);
  route.current = parse(href);
}

/** The Navigation API, which this TypeScript's DOM library does not declare yet. */
interface Navigation {
  currentEntry: { index: number } | null;
  entries(): { key: string; url: string | null }[];
  traverseTo(key: string): unknown;
}

/**
 * Goes back one entry when that entry is `wanted`, so back and forward keep
 * their meaning; else replaces this entry with `fallback`, so leaving never
 * leaves the app. A page in the viewer's frame may have added history
 * entries of its own, which history.back() would step through, so the
 * Navigation API finds the app's own previous entry.
 */
function backOr(wanted: (route: Route) => boolean, fallback: string): void {
  const navigation = (window as { navigation?: Navigation }).navigation;
  const index = navigation?.currentEntry?.index ?? 0;
  const before = index > 0 ? navigation?.entries()[index - 1] : undefined;
  const from = before?.url ? parse(new URL(before.url).hash, false) : null;
  if (navigation && before && from && wanted(from)) navigation.traverseTo(before.key);
  else location.replace(fallback);
}

/** Closes the viewer, back to its question. */
export const closeViewer = (key: string, runId: string) =>
  backOr((from) => from.view === "question" && from.key === key && !from.viewing, questionHref(key, runId));

/** Leaves a question for the list it was opened from. */
export const leaveQuestion = () => backOr((from) => from.view === "home", listHref());

export const questionHref = (key: string, runId?: string) =>
  `#/q/${encodeURIComponent(key)}${runId ? `/${encodeURIComponent(runId)}` : ""}`;

export const viewerHref = (key: string, runId: string, { arm, page, device }: Viewing) =>
  `${questionHref(key, runId)}/view/${encodeURIComponent(arm)}/${encodeURIComponent(page)}${device === "phone" ? "?phone" : ""}`;
