// Numbers, times and counts, formatted once for every view.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4 min ago", "3 h ago", "2 days ago", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  if (ms < 7 * DAY) return plural(Math.floor(ms / DAY), "day") + " ago";
  return date(iso);
}

/** "Sep 23", with the year only when it is not this one. */
export function date(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "Sep 23, 5:39 PM": enough to tell two runs of one day apart. */
export const stamp = (iso: string) => `${date(iso)}, ${new Date(iso).toLocaleTimeString("en", { timeStyle: "short" })}`;

/** The exact moment, for a tooltip beside a relative time. */
export const exact = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

/** "26s", "41m", "1h 12m". */
export function duration(ms: number): string {
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/** "812", "4.6k", "123k", "1.2M". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const percent = (value: number) => `${Math.round(value * 100)}%`;

/** "+0.27", "−0.12", "0.00": a difference with its sign, a true minus. */
export const signed = (value: number, digits = 2) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}`;

/** "4 s ago", "3 min ago": for what refreshes every few seconds. */
export function since(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

/** A score to two places, or an em dash for one nobody gave. */
export const score = (value: number | null | undefined) => (value == null ? "—" : value.toFixed(2));

/** "~/Desktop/…" for a path under the home folder the server reported. */
export function tilde(path: string, home: string | null): string {
  return home && path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
}
