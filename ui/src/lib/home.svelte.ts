// What the list remembers while you look at one question: the search, the
// filter, the dates, the sort, the page, the selection, the folded section,
// where you had scrolled to, and the row the keyboard opened. The search,
// filter, dates, sort and page are also written to the address
// (#/?q=…&filter=series&date=7d&sort=margin&page=2), so a reload or the back
// button lands on the same page of the same list.
import { SvelteSet } from "svelte/reactivity";
import { ANY_DATE, DATE_PRESETS, DEFAULT_SORT, type DateFilter, FILTERS, type Filter, SORTS, type Sort, type SortKey, isDay } from "./results";

export const PAGE_SIZES = [20, 50, 100] as const;
const DEFAULT_SIZE = PAGE_SIZES[0];

export const home = $state({
  query: "",
  filter: "all" as Filter,
  date: { ...ANY_DATE } as DateFilter,
  sort: { ...DEFAULT_SORT } as Sort,
  page: 1,
  size: DEFAULT_SIZE as number,
  unfinishedOpen: false,
  scrollY: 0,
  /** The row opened from the keyboard, focused again on the way back. */
  returnTo: null as string | null,
  /** Set by the running pill: the list scrolls to its running tests. */
  showRunning: false,
});

type List = Pick<typeof home, "query" | "filter" | "date" | "sort" | "page" | "size">;

/**
 * The rows chosen for a bulk action, by key. Paging and sorting keep it; a
 * change to which rows match clears it, so nothing chosen is ever out of
 * sight when it is deleted.
 */
export const selection = new SvelteSet<string>();

/** The address of the list as it is now; defaults are left out. */
export function listHref(): string {
  const params = new URLSearchParams();
  if (home.query.trim()) params.set("q", home.query);
  if (home.filter !== "all") params.set("filter", home.filter);
  if (home.date.range !== "any") params.set("date", home.date.range);
  if (home.date.range === "custom") {
    if (home.date.from) params.set("from", home.date.from);
    if (home.date.to) params.set("to", home.date.to);
  }
  if (home.sort.key !== DEFAULT_SORT.key || home.sort.descending !== DEFAULT_SORT.descending) {
    params.set("sort", home.sort.key);
    params.set("order", home.sort.descending ? "desc" : "asc");
  }
  if (home.page > 1) params.set("page", String(home.page));
  if (home.size !== DEFAULT_SIZE) params.set("size", String(home.size));
  const query = params.toString();
  return query ? `#/?${query}` : "#/";
}

/** Takes the list's state from an address; anything unreadable is the default. */
export function readList(params: URLSearchParams): void {
  const page = Number(params.get("page"));
  const size = Number(params.get("size"));
  const filter = params.get("filter");
  const sort = params.get("sort");
  const range = params.get("date");
  const day = (key: string) => {
    const value = params.get(key) ?? "";
    return isDay(value) ? value : "";
  };
  const before = matching();
  home.query = params.get("q") ?? "";
  home.filter = FILTERS.some((option) => option.id === filter) ? (filter as Filter) : "all";
  home.date = range === "custom"
    ? { range, from: day("from"), to: day("to") }
    : DATE_PRESETS.some((option) => option.id === range) ? { ...ANY_DATE, range: range as DateFilter["range"] } : { ...ANY_DATE };
  home.sort = (SORTS as readonly string[]).includes(sort ?? "")
    ? { key: sort as SortKey, descending: params.get("order") !== "asc" }
    : { ...DEFAULT_SORT };
  home.page = Number.isInteger(page) && page >= 1 ? page : 1;
  home.size = (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_SIZE;
  if (matching() !== before) selection.clear();
}

/** Which rows the list matches, as a string to compare. */
const matching = () => JSON.stringify([home.query.toLowerCase().trim().split(/\s+/), home.filter, home.date]);

/**
 * Changes the list and rewrites the address in place: paging and typing
 * would otherwise fill the history, and back should leave the list, not
 * step through it.
 */
export function setList(change: Partial<List>): void {
  const before = matching();
  Object.assign(home, change);
  if (matching() !== before) selection.clear();
  history.replaceState(history.state, "", listHref());
}
