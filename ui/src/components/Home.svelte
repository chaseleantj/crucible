<script lang="ts">
  import { onMount, tick } from "svelte";
  import { data } from "../lib/data.svelte";
  import { plural, since } from "../lib/format";
  import { PAGE_SIZES, home, selection, setList } from "../lib/home.svelte";
  import { forPage } from "../lib/keys";
  import { ANY_DATE, type DateFilter, FILTERS, type Filter, type SortKey, dateLabel, dateSpan, firstDirection, matches, rowsOf, sortRows, withinSpan } from "../lib/results";
  import type { Snapshot } from "../lib/types";
  import DateFilterMenu from "./DateFilter.svelte";
  import DeleteSelected from "./DeleteSelected.svelte";
  import EmptyState from "./EmptyState.svelte";
  import LiveRunCard from "./LiveRunCard.svelte";
  import Pager from "./Pager.svelte";
  import ResultsTable from "./ResultsTable.svelte";
  import UnfinishedRuns from "./UnfinishedRuns.svelte";

  let { snapshot, now }: { snapshot: Snapshot; now: number } = $props();

  const experiments = $derived(snapshot.experiments);
  const live = $derived(experiments.live);
  const nothing = $derived(
    experiments.questions.length + experiments.reportsOnly.length + live.inFlight.length + live.unfinished.length === 0,
  );

  const rows = $derived(rowsOf(experiments));
  /**
   * A full margin bar, the same on every page: the lead nine in ten
   * results stay within, so one runaway result cannot flatten the rest;
   * the few past it draw full, their figure beside them.
   */
  const widest = $derived.by(() => {
    const leads = rows.map((row) => row.margin ?? 0).filter((margin) => margin > 0).sort((a, b) => a - b);
    return leads[Math.floor((leads.length - 1) * 0.9)] ?? 0;
  });

  const words = $derived(home.query.toLowerCase().trim().split(/\s+/).filter(Boolean));
  const span = $derived(dateSpan(home.date, now));
  const dated = $derived(span !== null);
  // Search and dates narrow the list; the filters then split what is left, each with its count.
  const found = $derived(rows.filter((row) => withinSpan(row, span) && words.every((word) => row.haystack.includes(word))));
  const counts = $derived(Object.fromEntries(FILTERS.map(({ id }) => [id, found.filter((row) => matches(row, id)).length])) as Record<Filter, number>);
  const shown = $derived(sortRows(found.filter((row) => matches(row, home.filter)), home.sort));
  const filterLabel = $derived(FILTERS.find(({ id }) => id === home.filter)!.label);

  // The selection is kept by key; what counts is what the list still shows.
  const chosen = $derived(shown.filter((row) => selection.has(row.key)));
  let anchor: string | null = null;
  let deleter = $state<DeleteSelected | null>(null);
  /** What the last delete did, said once beside the count. */
  let notice = $state<string | null>(null);

  /** A box ticked or cleared; with shift, every row from the last one ticked takes the same state. */
  function pick(index: number, checked: boolean, range: boolean) {
    notice = null;
    const from = range && anchor ? visible.findIndex((row) => row.key === anchor) : -1;
    const [start, end] = from < 0 ? [index, index] : [Math.min(from, index), Math.max(from, index)];
    for (const row of visible.slice(start, end + 1)) {
      if (checked) selection.add(row.key);
      else selection.delete(row.key);
    }
    anchor = visible[index]!.key;
  }

  function pickPage(checked: boolean) {
    notice = null;
    for (const row of visible) {
      if (checked) selection.add(row.key);
      else selection.delete(row.key);
    }
  }

  const pickAll = () => shown.forEach((row) => selection.add(row.key));
  function clearSelection() {
    selection.clear();
    anchor = null;
  }

  function deletedSome(count: number, kept: string[]) {
    clearSelection();
    kept.forEach((key) => selection.add(key));
    notice = count > 0 ? `Deleted ${plural(count, "result")}` : null;
  }

  // Paged on the client: the snapshot already holds every row, so search can
  // match across all of them and a page turn needs no request.
  const paged = $derived(shown.length > PAGE_SIZES[0]);
  const pages = $derived(Math.max(1, Math.ceil(shown.length / home.size)));
  const page = $derived(Math.min(home.page, pages));
  const visible = $derived(paged ? shown.slice((page - 1) * home.size, page * home.size) : shown);

  let bar = $state<HTMLElement | null>(null);
  let table = $state<ResultsTable | null>(null);

  /** A new page starts at its first row: scroll back up if that row is under the pinned bar. */
  async function turn(change: { page: number; size?: number }) {
    setList(change);
    await tick();
    const top = table?.top();
    if (bar && top !== undefined) {
      const gap = top - bar.getBoundingClientRect().bottom;
      if (gap < 0) window.scrollBy(0, gap);
    }
  }

  /** A new page size keeps the first row on screen in view. */
  const resize = (size: number) => turn({ size, page: Math.floor(((page - 1) * home.size) / size) + 1 });

  /** A new search, filter or sort starts from the first page. */
  const setQuery = (query: string) => setList({ query, page: 1 });
  const setFilter = (filter: Filter) => setList({ filter, page: 1 });
  const setDate = (date: DateFilter) => setList({ date, page: 1 });
  const sortBy = (key: SortKey) =>
    setList({ sort: { key, descending: home.sort.key === key ? !home.sort.descending : firstDirection(key) }, page: 1 });

  /** j and k: the next or previous row, onto the next or previous page at either end. */
  async function move(delta: 1 | -1) {
    if (!table) return;
    const at = table.focused();
    const target = at === null ? (delta > 0 ? 0 : visible.length - 1) : at + delta;
    if (target >= visible.length && page < pages) {
      await turn({ page: page + 1 });
      table.focusRow(0);
    } else if (target < 0 && page > 1) {
      await turn({ page: page - 1 });
      table.focusRow(-1);
    } else {
      table.focusRow(Math.max(0, Math.min(visible.length - 1, target)));
    }
  }

  // Coming back from a question returns to the same place in the list, and
  // to the row the keyboard opened it from.
  onMount(() => {
    tick().then(() => {
      window.scrollTo(0, home.scrollY);
      if (home.returnTo) table?.focusKey(home.returnTo);
      home.returnTo = null;
    });
    return () => (home.scrollY = window.scrollY);
  });

  // The running pill in the top bar asks for the running tests.
  $effect(() => {
    if (!home.showRunning) return;
    home.showRunning = false;
    document.getElementById("running")?.scrollIntoView({ block: "start" });
  });

  let searchInput = $state<HTMLInputElement | null>(null);
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && event.target === searchInput) {
      setQuery("");
      searchInput?.blur();
      return;
    }
    if (!forPage(event)) return;
    if (event.key === "/") {
      event.preventDefault();
      searchInput?.focus();
    } else if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      move(event.key === "j" ? 1 : -1);
    } else if (event.key === "x") {
      const at = table?.focused();
      if (at == null) return;
      event.preventDefault();
      pick(at, !selection.has(visible[at]!.key), false);
    } else if (event.key === "Escape" && chosen.length > 0) {
      event.preventDefault();
      clearSelection();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<main class="page">
  {#if nothing}
    <EmptyState archiveRoot={snapshot.archiveRoot} runsRoot={snapshot.runsRoot} />
  {:else}
    {#if live.inFlight.length > 0}
      <section id="running" class="section first" aria-labelledby="running-title">
        <div class="section-head">
          <!-- The top bar's pill counts the runs; the cards below are them. -->
          <h2 id="running-title" class="t-heading">Running</h2>
          {#if data.updatedAt}<span class="t-meta updated" role="status">Updated {since(data.updatedAt, now)}</span>{/if}
        </div>
        <div class="live-list">
          {#each live.inFlight as run (run.runId)}
            <LiveRunCard {run} {now} />
          {/each}
        </div>
      </section>
    {/if}

    <section class="section" class:first={live.inFlight.length === 0} aria-labelledby="results-title">
      <div class="section-head">
        <h2 id="results-title" class="t-heading">Results</h2>
        <!-- The All tab counts the list; only a search or dates add a total worth saying. -->
        {#if words.length || dated}<span class="count">{found.length} of {rows.length}</span>{/if}
        {#if notice}<span class="t-meta" role="status">{notice}</span>{/if}
        <span class="spacer"></span>
        <input
          bind:this={searchInput}
          class="field search"
          type="search"
          placeholder="Search"
          aria-label="Search results"
          aria-keyshortcuts="/"
          value={home.query}
          oninput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {#if rows.length === 0}
        <p class="t-meta none">No archived results yet. Finished runs appear here once they are archived.</p>
      {:else}
        <div class="list-bar" bind:this={bar}>
          {#if chosen.length > 0}
            <div class="selection" role="group" aria-label="Selection">
              <span class="t-body picked" role="status">{chosen.length} selected</span>
              {#if chosen.length < shown.length}
                <button class="btn quiet" onclick={pickAll}>Select all {shown.length}{words.length || dated || home.filter !== "all" ? " matching" : ""}</button>
              {:else if paged}
                <span class="t-meta">All {shown.length}{words.length || dated || home.filter !== "all" ? " matching" : ""}</span>
              {/if}
              <button class="btn btn-danger" onclick={() => deleter?.open(chosen)}>Delete…</button>
              <button class="btn quiet" onclick={clearSelection} title="Clear the selection (Esc)" aria-keyshortcuts="Escape">Clear</button>
            </div>
          {:else}
            <div class="filters">
              <div class="tabs" role="group" aria-label="Show">
                {#each FILTERS as { id, label } (id)}
                  <button aria-pressed={home.filter === id} onclick={() => setFilter(id)}>{label} <span class="n">{counts[id]}</span></button>
                {/each}
              </div>
              <DateFilterMenu value={home.date} onchange={setDate} />
            </div>
          {/if}
          {#if paged}
            <Pager total={shown.length} {page} size={home.size} onpage={(target) => turn({ page: target })} onsize={resize} />
          {/if}
        </div>

        {#if shown.length === 0}
          <div class="none">
            <p class="t-body">
              {#if words.length}No results match “{home.query.trim()}”{:else}No results{/if}{home.filter === "all" ? "" : ` under ${filterLabel}`}{dated ? `, ${dateLabel(home.date).replace(/^[A-Z]/, (c) => c.toLowerCase())}` : ""}.
            </p>
            {#if words.length}<button class="btn" onclick={() => setQuery("")}>Clear search</button>{/if}
            {#if dated}<button class="btn" onclick={() => setDate({ ...ANY_DATE })}>Any time</button>{/if}
            {#if home.filter !== "all"}<button class="btn" onclick={() => setFilter("all")}>Show all</button>{/if}
          </div>
        {:else}
          <ResultsTable
            bind:this={table}
            rows={visible}
            sort={home.sort}
            onsort={sortBy}
            {widest}
            onopen={(key) => (home.returnTo = key)}
            selected={selection}
            selecting={chosen.length > 0}
            onpick={pick}
            onpickpage={pickPage}
          />
        {/if}
        <DeleteSelected bind:this={deleter} runsRoot={snapshot.runsRoot} ondone={deletedSome} />
      {/if}
    </section>

    {#if live.unfinished.length > 0}
      <UnfinishedRuns runs={live.unfinished} {now} />
    {/if}
  {/if}
</main>

<style>
  .first { margin-top: 0; }
  #running { scroll-margin-top: calc(var(--topbar) + var(--s-4)); }
  .live-list { display: grid; gap: var(--s-3); }
  .updated { margin-left: var(--s-1); }
  .search { width: 240px; }
  .none { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); padding: var(--s-5) 0; }

  /* Filters on the left, paging on the right, pinned under the top bar. */
  .list-bar {
    position: sticky;
    top: var(--topbar);
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-5);
    padding: var(--s-2) 0;
    background: var(--bg);
  }
  /* The tabs, the dates, then paging at the right; narrow, the tabs take a row. */
  .filters { display: contents; }
  .selection { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); min-height: var(--control); }
  .list-bar :global(.pager) { margin-left: auto; margin-right: calc(-1 * var(--s-3)); }
  /* Quiet buttons at either end line their words up with the tabs and the table. */
  .filters :global(.date-filter) { margin-left: calc(-1 * var(--s-3)); }
  .picked { margin-right: var(--s-2); font-weight: 600; }

  @media (max-width: 640px) {
    .search { width: 160px; }
    .list-bar { position: static; column-gap: var(--s-2); }
    .tabs { flex-basis: 100%; gap: var(--s-4); overflow-x: auto; }
  }
</style>
