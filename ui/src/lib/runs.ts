// Reading one run's evidence: which question it belongs to, which pages were
// captured and which can be viewed live, and how a live agent is doing.
import { fileUrl } from "./api";
import { duration } from "./format";
import type { Arm, Experiment, LiveAgent, LiveRun, Shot } from "./types";

export type Device = "desktop" | "phone";

/**
 * The captured pages of a run, aligned across arms by position: every arm is
 * pictured on the same pages in the same order. Named by the first arm that
 * names the page.
 */
export function pagesOf(run: Experiment): string[] {
  const lists = Object.values(run.result?.shots?.arms ?? {});
  const count = Math.max(0, ...lists.map((shots) => shots.length));
  return Array.from({ length: count }, (_, i) => lists.map((shots) => shots[i]?.page).find(Boolean) ?? `Page ${i + 1}`);
}

/** Whether any arm has a phone capture. */
export const hasPhone = (run: Experiment) =>
  Object.values(run.result?.shots?.arms ?? {}).some((shots) => shots.some((shot) => shot.phone ?? shot.mobile));

/** One arm's capture of one page, as an absolute path; falls back to the archive's preview. */
export function capture(run: Experiment, arm: Arm, page: number, device: Device): string | null {
  const shot: Shot | undefined = run.result?.shots?.arms?.[arm]?.[page];
  const relative = device === "phone" ? (shot?.phone ?? shot?.mobile) : shot?.desktop;
  if (relative) return `${run.path}/${relative}`;
  return page === 0 && device === "desktop" ? (run.preview?.[arm] ?? null) : null;
}

/** A page with any fragment (deck.html#/4) split into the file and the fragment, "#" included. */
export function splitPage(page: string): { file: string; fragment: string } {
  const at = page.indexOf("#");
  return at < 0 ? { file: page, fragment: "" } : { file: page.slice(0, at), fragment: page.slice(at) };
}

/** The live page one capture shows, fragment and all, when it is one of the arm's HTML pages. */
function capturedPage(run: Experiment, arm: Arm, index: number): string | null {
  const shot = run.result?.shots?.arms?.[arm]?.[index];
  // Older indexes name the file in page; newer ones keep page as a label.
  const page = shot?.artifact ?? shot?.page;
  return page && run.pages[arm]?.includes(splitPage(page).file) ? page : null;
}

/** Where the viewer opens for one arm: the page the capture at `index` shows, else the arm's output. */
export const livePage = (run: Experiment, arm: Arm, index: number): string | null =>
  capturedPage(run, arm, index) ?? run.pages[arm]?.[0] ?? null;

/**
 * The page of arm `to` that answers `page` of arm `from`, so switching arms
 * compares like with like: the same capture when the page is a captured
 * one, else the same file, else the other arm's output. `exact` is false
 * for that last resort. Null when `to` has no HTML page.
 */
export function correspondingPage(run: Experiment, from: Arm, to: Arm, page: string): { page: string; exact: boolean } | null {
  const pages = run.pages[to] ?? [];
  if (pages.length === 0) return null;
  const shots = run.result?.shots?.arms?.[from] ?? [];
  const index = shots.findIndex((_, i) => capturedPage(run, from, i) === page);
  const captured = index >= 0 ? capturedPage(run, to, index) : null;
  if (captured) return { page: captured, exact: true };
  if (pages.includes(splitPage(page).file)) return { page, exact: true };
  return { page: pages[0]!, exact: false };
}

/**
 * An arm's page as a URL: `framed` asks the server for the viewer's bridge,
 * placed before the fragment so the page still sees its own.
 */
export function pageUrl(run: Experiment, arm: Arm, page: string, framed: boolean): string {
  const { file, fragment } = splitPage(page);
  // The flag is the server's VIEWER_FLAG; outputs/<arm> is the archive's layout, as in the store.
  return `${fileUrl(`${run.path}/outputs/${arm}/${file}`)}${framed ? "?crucible-viewer" : ""}${fragment}`;
}

export type Tone = "ok" | "warn" | "danger" | "done";

/** A live agent's state in words, with the tone it deserves; when it last did something is its own column. */
export function agentStatus(agent: LiveAgent): { text: string; tone: Tone } {
  switch (agent.state) {
    case "ready":
      return { text: "Waiting to start", tone: "done" };
    case "complete":
      return agent.timedOut ? { text: "Hit its time limit", tone: "warn" } : { text: "Done", tone: "done" };
    case "failed":
      return { text: agent.error ?? "Failed", tone: "danger" };
    case "stopped":
      return { text: "Stopped", tone: "done" };
    case "running":
      switch (agent.health) {
        case "stalled":
          return { text: "Stalled", tone: "danger" };
        case "quiet":
          return { text: "Quiet", tone: "warn" };
        case "near timeout":
          return { text: `Near time limit, ${duration(agent.remainingMs ?? 0)} left`, tone: "danger" };
        default:
          return { text: "Working", tone: "ok" };
      }
  }
}

/** A run's agents in table order: the producers, unnamed until the report reveals the arms, then the judge. */
export const agentsOf = (run: LiveRun) => [
  ...run.producers.map((agent, i) => ({ label: `Producer ${i + 1}`, agent })),
  ...(run.judge ? [{ label: "Judge", agent: run.judge }] : []),
];

/** The worst tone among a run's agents: whether it needs you, at a glance. */
export function runTone(run: LiveRun): Tone {
  const tones = agentsOf(run).map(({ agent }) => agentStatus(agent).tone);
  return tones.includes("danger") ? "danger" : tones.includes("warn") ? "warn" : "ok";
}

export type StepState = "done" | "current" | "waiting" | "upcoming";

/**
 * Where a run is in produce, judge, report: the runner's state read as three
 * steps. A produced run with no judge at work is waiting for one.
 */
export function phaseSteps(run: LiveRun): { label: string; state: StepState }[] {
  const at = { prepared: 0, running: 0, produced: 1, judged: 2, reported: 3 }[run.state] ?? 0;
  const judging = run.judge?.state === "running";
  return ["Produce", "Judge", "Report"].map((label, i) => ({
    label,
    state: i < at ? "done" : i > at ? "upcoming" : i === 1 && !judging ? "waiting" : "current",
  }));
}
