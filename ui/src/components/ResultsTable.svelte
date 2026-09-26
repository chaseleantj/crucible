<script lang="ts">
  import { fileUrl } from "../lib/api";
  import { date, plural, signed } from "../lib/format";
  import { questionHref } from "../lib/route.svelte";
  import { type Row, type Sort, type SortKey, judgeShort } from "../lib/results";
  import { NOT_JUDGED } from "../lib/verdict";

  let { rows, sort, onsort, widest, onopen, selected, selecting, onpick, onpickpage }: {
    rows: Row[];
    sort: Sort;
    onsort: (key: SortKey) => void;
    /** The widest margin in the whole list: a full bar. */
    widest: number;
    /** A row opened from the keyboard, to focus again on the way back. */
    onopen: (key: string) => void;
    /** The keys chosen for a bulk action. */
    selected: ReadonlySet<string>;
    /** Something is chosen, so every row shows its box. */
    selecting: boolean;
    /** A row's box was ticked or cleared; `range` when shift was held. */
    onpick: (index: number, checked: boolean, range: boolean) => void;
    /** The header's box: every row on this page, or none. */
    onpickpage: (checked: boolean) => void;
  } = $props();

  const picked = $derived(rows.filter((row) => selected.has(row.key)).length);

  let table = $state<HTMLTableElement | null>(null);
  const links = () => [...(table?.querySelectorAll<HTMLAnchorElement>("a.row-link") ?? [])];

  /** Where the table starts on screen. */
  export const top = () => table?.getBoundingClientRect().top;

  /** The row that has focus, on its link or its box, if any. */
  export function focused(): number | null {
    const row = document.activeElement?.closest("tbody tr");
    const at = row ? [...(table?.tBodies[0]?.rows ?? [])].indexOf(row as HTMLTableRowElement) : -1;
    return at < 0 ? null : at;
  }

  /** Focuses a row, -1 for the last, and keeps it clear of the pinned bar. */
  export function focusRow(index: number) {
    const all = links();
    const link = all.at(index);
    if (!link) return;
    link.focus({ preventScroll: true });
    link.closest("tr")?.scrollIntoView({ block: "nearest" });
  }

  export function focusKey(key: string) {
    const at = links().findIndex((link) => link.dataset.key === key);
    if (at >= 0) focusRow(at);
  }

  const COLUMNS: { key: SortKey | null; label: string; className: string }[] = [
    { key: "title", label: "Question", className: "c-question" },
    { key: null, label: "Verdict", className: "c-verdict" },
    { key: "margin", label: "Margin", className: "c-margin" },
    { key: "arms", label: "Arms", className: "c-arms num" },
    { key: "runs", label: "Runs", className: "c-runs num" },
    { key: null, label: "Judge", className: "c-judge" },
    { key: "date", label: "Date", className: "c-date num" },
  ];

  const ariaSort = (key: SortKey | null) =>
    key && sort.key === key ? (sort.descending ? "descending" : "ascending") : undefined;
</script>

<table bind:this={table} class="results" class:selecting aria-label="Results">
  <thead>
    <tr>
      <th scope="col" class="c-pick">
        <input
          type="checkbox"
          aria-label="Select every result on this page"
          title="Select every result on this page"
          checked={picked > 0 && picked === rows.length}
          indeterminate={picked > 0 && picked < rows.length}
          onchange={(event) => onpickpage(event.currentTarget.checked)}
        />
      </th>
      {#each COLUMNS as column (column.label)}
        <th scope="col" class={column.className} aria-sort={ariaSort(column.key)}>
          {#if column.key}
            {@const key = column.key}
            <button class="sort" class:active={sort.key === key} onclick={() => onsort(key)}>
              {column.label}
              <svg class="arrow" class:up={sort.key === key && !sort.descending} width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" /></svg>
            </button>
          {:else}
            {column.label}
          {/if}
        </th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each rows as row, index (row.key)}
      {#if row.kind === "question"}
        {@render questionRow(row, index)}
      {:else}
        {@render reportRow(row, index)}
      {/if}
    {/each}
  </tbody>
</table>

{#snippet thumb(cover: string | null)}
  <span class="thumb" aria-hidden="true">
    {#if cover}<img src={fileUrl(cover)} alt="" loading="lazy" decoding="async" />{/if}
  </span>
{/snippet}

{#snippet pick(row: Row, index: number)}
  <td class="c-pick">
    <!-- The capture's slot is the box's label: a whole-cell target above the
         row's link, the box shown in place of the capture while it matters. -->
    <label>
      {@render thumb(row.cover)}
      <input
        type="checkbox"
        aria-label="Select {row.title}"
        checked={selected.has(row.key)}
        onclick={(event) => onpick(index, event.currentTarget.checked, event.shiftKey)}
      />
    </label>
  </td>
{/snippet}

{#snippet questionRow(row: Extract<Row, { kind: "question" }>, index: number)}
  {@const question = row.question}
  {@const judge = judgeShort(question)}
  {@const verdict = question.winner === null ? null : question.winner === "tie" ? "Tie" : question.winner}
  {@const won = question.winner && question.winner !== "tie" ? question.tally[question.winner] ?? 0 : 0}
  <!-- A question of one-arm runs was never won, only scored, so it has no tally to show. -->
  {@const tally = question.runs.length > 1 && won > 0 ? `${won} of ${question.runs.length}` : null}
  <tr class:checked={selected.has(row.key)}>
    {@render pick(row, index)}
    <td class="c-question">
      <a class="row-link" href={questionHref(question.key)} data-key={row.key} onkeydown={(event) => event.key === "Enter" && onopen(row.key)}>
        <span class="title">{row.title}</span>
      </a>
      <span class="meta t-meta">
        <span class="m-verdict">{verdict ?? NOT_JUDGED}{question.split ? ", split" : tally ? `, ${tally}` : ""}</span>
        <span class="m-counts">{plural(question.arms.length, "arm")} · {plural(question.runs.length, "run")}</span>
        {#if judge}<span class="m-judge">{judge}</span>{/if}
      </span>
    </td>
    <td class="c-verdict">
      {#if verdict}
        <span class="verdict"><span class="clip">{verdict}</span>{#if question.split}<span class="t-meta tally">split</span>{:else if tally}<span class="t-meta tally">{tally}</span>{/if}</span>
      {:else}
        <span class="t-meta">{NOT_JUDGED}</span>
      {/if}
    </td>
    <td class="c-margin">
      {#if row.margin === null}
        <span class="t-meta figure-none">—</span>
      {:else}
        <span class="margin">
          <span class="figure">{signed(row.margin)}</span>
          <span class="meter" class:over={widest > 0 && row.margin > widest} aria-hidden="true"><span style="--value: {widest > 0 ? Math.min(1, Math.max(0, row.margin) / widest) : 0}"></span></span>
        </span>
      {/if}
    </td>
    <td class="c-arms num">{question.arms.length}</td>
    <td class="c-runs num">{question.runs.length}</td>
    <td class="c-judge"><span class="clip">{judge ?? "—"}</span></td>
    <td class="c-date num">{date(row.when)}</td>
  </tr>
{/snippet}

{#snippet reportRow(row: Extract<Row, { kind: "report" }>, index: number)}
  {@const target = row.test.report ?? row.test.doc}
  <tr class:checked={selected.has(row.key)}>
    {@render pick(row, index)}
    <td class="c-question">
      <a class="row-link" href={target ? fileUrl(target) : undefined} target="_blank" rel="noopener" data-key={row.key}>
        <span class="title">{row.title}</span>
      </a>
      <span class="meta t-meta"><span class="m-verdict">Report only</span></span>
    </td>
    <td class="c-verdict"><span class="t-meta">Report only</span></td>
    <td class="c-margin"><span class="t-meta figure-none">—</span></td>
    <td class="c-arms num t-meta">—</td>
    <td class="c-runs num t-meta">—</td>
    <td class="c-judge t-meta">—</td>
    <td class="c-date num">{date(row.when)}</td>
  </tr>
{/snippet}

<style>
  .results { table-layout: fixed; border-top: 1px solid var(--hairline); }
  th { height: 36px; padding-top: 0; padding-bottom: 0; vertical-align: middle; border-bottom-color: var(--hairline-strong); }
  td { height: var(--row); padding-top: var(--s-1); padding-bottom: var(--s-1); vertical-align: middle; }
  th:first-child, td:first-child { padding-left: var(--s-2); }
  th:last-child, td:last-child { padding-right: var(--s-2); }

  /* The box and the capture share the first column: the capture at rest,
     the box under the pointer, on the keyboard's row, and whenever anything
     is chosen. Its whole cell is the target, over the row's link. */
  .c-pick { width: calc(var(--s-2) + 40px); }
  th.c-pick, td.c-pick { padding-right: 0; }
  td.c-pick { position: relative; z-index: 1; padding-top: 0; padding-bottom: 0; }
  .c-pick label { display: grid; place-items: center start; height: 100%; min-height: var(--row); cursor: pointer; }
  .c-pick label > * { grid-area: 1 / 1; }
  th.c-pick input { margin-left: 12px; vertical-align: middle; }
  td.c-pick input { justify-self: center; }
  td.c-pick input { opacity: 0; }
  tbody tr:hover td.c-pick input, tbody tr:focus-within td.c-pick input, .selecting td.c-pick input, tr.checked td.c-pick input { opacity: 1; }
  tbody tr:hover .thumb, tbody tr:focus-within .thumb, .selecting .thumb, tr.checked .thumb { visibility: hidden; }
  tbody tr.checked td { background: var(--surface-selected); }

  .c-verdict { width: 200px; }
  .c-margin { width: 132px; }
  .c-arms, .c-runs { width: 60px; }
  .c-judge { width: 136px; }
  .c-date { width: 76px; }

  .sort { display: inline-flex; align-items: center; gap: var(--s-1); color: inherit; border-radius: 4px; }
  .sort:hover, .sort.active { color: var(--ink); }
  .arrow { opacity: 0; transition: transform var(--speed) var(--ease); }
  .sort:hover .arrow { opacity: 0.5; }
  .sort.active .arrow { opacity: 1; }
  .arrow.up { transform: rotate(180deg); }

  /* The whole row opens the question: the title's link covers it, so
     nothing else in a row carries a tooltip or a control of its own. */
  tbody tr { position: relative; scroll-margin: calc(var(--topbar) + 96px) 0 var(--s-4); }
  tbody tr:hover td { background: var(--surface-hover); }
  tbody tr:has(.row-link:focus-visible) td { background: var(--surface-selected); }
  tbody tr:has(.row-link:focus-visible) td:first-child { box-shadow: inset 2px 0 0 var(--ink); }
  .row-link { display: flex; align-items: center; gap: var(--s-3); min-width: 0; color: var(--ink); }
  .row-link::after { content: ""; position: absolute; inset: 0; }
  .row-link:focus-visible { outline: none; }

  .thumb {
    flex: none;
    width: 40px;
    height: 25px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface);
    border: 1px solid var(--frame);
  }
  .thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .title {
    min-width: 0;
    font: var(--text-body);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .verdict { display: flex; align-items: baseline; gap: var(--s-2); min-width: 0; }
  .tally { white-space: nowrap; }
  /* The figure first, right-aligned in its own slot, so the bars start on one line. */
  .margin { display: inline-flex; align-items: center; gap: var(--s-3); }
  .margin .figure, .figure-none { display: inline-block; width: 44px; text-align: right; }
  .c-judge .clip { display: block; }

  /* Collapsing: what leaves a column moves under the title, never away;
     the pieces are spaced, not joined by dots, so a wrapped line starts clean. */
  .meta { display: none; flex-wrap: wrap; column-gap: var(--s-3); }
  .m-verdict { display: none; }
  @media (max-width: 1100px) {
    /* No captures: the box alone, always shown. */
    .thumb { display: none; }
    .c-pick { width: calc(var(--s-2) + 16px); }
    th.c-pick input { margin-left: 0; }
    td.c-pick input { justify-self: start; opacity: 1; }
    .c-verdict { width: 150px; }
    .c-margin { width: 100px; }
    .margin .meter { width: 40px; }
    .c-judge { width: 140px; }
  }
  @media (max-width: 900px) {
    .c-arms, .c-runs, .c-judge { display: none; }
    .meta { display: flex; }
  }
  @media (max-width: 640px) {
    .c-verdict { display: none; }
    .m-verdict { display: inline; color: var(--ink); }
    .c-margin { width: 56px; text-align: right; }
    .margin .meter { display: none; }
    .c-date { width: 60px; }
    td { padding-top: var(--s-2); padding-bottom: var(--s-2); vertical-align: top; }
    .c-question .title { -webkit-line-clamp: 3; line-clamp: 3; }
    /* Rows top-aligned: the box sits on the title's first line. */
    .c-pick label { min-height: 0; padding-top: var(--s-2); place-items: start; }
    td.c-pick input { margin-top: 2px; }
  }
</style>
