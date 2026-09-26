// The results list as rows: one per question, one per report without a
// result, with what the table shows, filters on and sorts by.
import { date } from "./format";
import { isJudged, judgedRuns, questionJudge, questionMargin } from "./verdict";
import type { Experiment, Experiments, Question } from "./types";

export type Row =
  | { kind: "question"; key: string; question: Question; title: string; when: string; cover: string | null; margin: number | null; haystack: string }
  | { kind: "report"; key: string; test: Experiment; title: string; when: string; cover: string | null; margin: null; haystack: string };

export const FILTERS = [
  { id: "all", label: "All" },
  { id: "judged", label: "Judged" },
  { id: "unjudged", label: "Not judged" },
  { id: "series", label: "Series" },
] as const;
export type Filter = (typeof FILTERS)[number]["id"];

/**
 * When a row happened, for the date filter: a question's newest run (the
 * table's Date column), a report's folder date. Presets count back from now;
 * a custom range is whole local days, either end open.
 */
export const DATE_PRESETS = [
  { id: "any", label: "Any time" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
] as const;
export type DateRange = (typeof DATE_PRESETS)[number]["id"] | "custom";
/** `from` and `to` are local days, YYYY-MM-DD, and only mean something for "custom"; "" leaves that end open. */
export type DateFilter = { range: DateRange; from: string; to: string };
export const ANY_DATE: DateFilter = { range: "any", from: "", to: "" };

const DAY_MS = 86_400_000;
export const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(localDay(value));
const localDay = (day: string) => new Date(`${day}T00:00`).getTime();

/** The span a filter keeps, [start, end) in ms, or null when it keeps everything. */
export function dateSpan({ range, from, to }: DateFilter, now: number): [number, number] | null {
  if (range === "7d" || range === "30d") return [now - (range === "7d" ? 7 : 30) * DAY_MS, Infinity];
  if (range === "month") {
    const today = new Date(now);
    return [new Date(today.getFullYear(), today.getMonth(), 1).getTime(), Infinity];
  }
  if (range === "custom" && (from || to)) return [from ? localDay(from) : -Infinity, to ? localDay(to) + DAY_MS : Infinity];
  return null;
}

/** A row with no readable date is outside every span. */
export function withinSpan(row: Row, span: [number, number] | null): boolean {
  if (!span) return true;
  const at = Date.parse(row.when);
  return at >= span[0] && at < span[1];
}

/** What the filter's button says: the preset, or the custom days. */
export function dateLabel(filter: DateFilter): string {
  if (filter.range !== "custom") return DATE_PRESETS.find(({ id }) => id === filter.range)!.label;
  const day = (value: string) => date(`${value}T00:00`);
  if (filter.from && filter.to) return filter.from === filter.to ? day(filter.from) : `${day(filter.from)} – ${day(filter.to)}`;
  if (filter.from) return `Since ${day(filter.from)}`;
  if (filter.to) return `Until ${day(filter.to)}`;
  return "Any time";
}

export const SORTS = ["title", "margin", "arms", "runs", "date"] as const;
export type SortKey = (typeof SORTS)[number];
export type Sort = { key: SortKey; descending: boolean };

/** The first click on a header sorts the way a reader expects: names A to Z, numbers and dates largest first. */
export const firstDirection = (key: SortKey) => key !== "title";
export const DEFAULT_SORT: Sort = { key: "date", descending: true };

export function rowsOf(experiments: Experiments): Row[] {
  return [
    ...experiments.questions.map((question): Row => {
      const summary = judgedRuns(question)[0]?.summary ?? "";
      return {
        kind: "question",
        key: question.key,
        question,
        title: question.title,
        when: question.latest,
        cover: winnerCover(question) ?? question.runs[0]?.cover ?? null,
        margin: questionMargin(question),
        haystack: [question.title, question.series, question.arms.join(" "), summary].join(" ").toLowerCase(),
      };
    }),
    ...experiments.reportsOnly.map((test): Row => ({
      kind: "report",
      key: test.path,
      test,
      title: test.name,
      when: test.archivedAt,
      cover: test.cover,
      margin: null,
      haystack: [test.name, test.blurb].join(" ").toLowerCase(),
    })),
  ];
}

/** The newest run's capture of whichever arm the question favours. */
function winnerCover(question: Question): string | null {
  const preview = question.runs[0]?.preview;
  if (!preview) return null;
  const arm = question.winner && question.winner !== "tie" ? question.winner : question.arms[0];
  return (arm && preview[arm]) || null;
}

export function matches(row: Row, filter: Filter): boolean {
  if (filter === "all") return true;
  if (row.kind === "report") return false;
  const judged = row.question.runs.some((run) => run.result && isJudged(run.result));
  if (filter === "judged") return judged;
  if (filter === "unjudged") return !judged;
  return row.question.runs.length > 1;
}

const arms = (row: Row) => (row.kind === "question" ? row.question.arms.length : null);
const runs = (row: Row) => (row.kind === "question" ? row.question.runs.length : null);

const VALUE: Record<Exclude<SortKey, "title" | "date">, (row: Row) => number | null> = {
  margin: (row) => row.margin,
  arms,
  runs,
};

/** Sorted by one column; a row with nothing in it goes last either way, and ties fall back to newest first. */
export function sortRows(rows: Row[], { key, descending }: Sort): Row[] {
  const newest = (a: Row, b: Row) => b.when.localeCompare(a.when);
  const flip = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    if (key === "date") return flip * a.when.localeCompare(b.when);
    if (key === "title") return flip * a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true }) || newest(a, b);
    const x = VALUE[key](a);
    const y = VALUE[key](b);
    if (x === null || y === null) return x === y ? newest(a, b) : x === null ? 1 : -1;
    return flip * (x - y) || newest(a, b);
  });
}

/** The judge, as short as the table can take: the model, else the agent. */
export function judgeShort(question: Question): string | null {
  const judge = questionJudge(question);
  return judge ? judge.model ?? judge.agent : null;
}
