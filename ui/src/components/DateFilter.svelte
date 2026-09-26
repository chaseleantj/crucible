<script lang="ts">
  import { ANY_DATE, DATE_PRESETS, type DateFilter, dateLabel } from "../lib/results";
  import Menu from "./Menu.svelte";
  import MenuChoice from "./MenuChoice.svelte";

  // The list's date filter: one quiet button naming the dates it keeps, a
  // panel of presets and a custom range, and a clear button while it is on.
  let { value, onchange }: { value: DateFilter; onchange: (value: DateFilter) => void } = $props();

  const id = $props.id();
  const active = $derived(dateLabel(value) !== dateLabel(ANY_DATE));
  let menu = $state<Menu | null>(null);

  /** Clearing removes the clear button, so focus goes back to the filter. */
  function clear() {
    onchange({ ...ANY_DATE });
    menu?.focus();
  }

  /** A range typed backwards moves its other end along, so it always spans something. */
  function setDay(end: "from" | "to", day: string) {
    const next = { range: "custom" as const, from: value.range === "custom" ? value.from : "", to: value.range === "custom" ? value.to : "", [end]: day };
    if (next.from && next.to && next.from > next.to) next[end === "from" ? "to" : "from"] = day;
    onchange(next);
  }
</script>

<span class="date-filter">
  <Menu bind:this={menu} label="Newest run date: {dateLabel(value)}" title="Filter by each question's newest run" role="dialog" buttonClass="btn quiet{active ? ' active' : ''}" chevron>
    {#snippet button()}{dateLabel(value)}{/snippet}
    {#snippet children(close)}
      <p class="menu-note">By each question's newest run</p>
      <div role="menu" aria-label="Presets">
        {#each DATE_PRESETS as { id, label } (id)}
          <MenuChoice checked={value.range === id} onchoose={() => { onchange({ ...ANY_DATE, range: id }); close(); }}>{label}</MenuChoice>
        {/each}
      </div>
      <div class="menu-rule"></div>
      <p class="menu-note" id="custom-{id}">Custom range</p>
      <div class="custom" role="group" aria-labelledby="custom-{id}">
        <label>
          <span class="t-meta">From</span>
          <input class="field" type="date" value={value.range === "custom" ? value.from : ""} max={value.range === "custom" && value.to ? value.to : undefined} onchange={(event) => setDay("from", event.currentTarget.value)} />
        </label>
        <label>
          <span class="t-meta">To</span>
          <input class="field" type="date" value={value.range === "custom" ? value.to : ""} min={value.range === "custom" && value.from ? value.from : undefined} onchange={(event) => setDay("to", event.currentTarget.value)} />
        </label>
      </div>
    {/snippet}
  </Menu>
  {#if active}
    <button class="btn square quiet clear" aria-label="Clear the date filter" title="Clear the date filter" onclick={clear}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
    </button>
  {/if}
</span>

<style>
  .date-filter { display: inline-flex; align-items: center; }
  .date-filter :global(.btn.active) { color: var(--ink); font-weight: 600; }
  .clear { margin-left: calc(-1 * var(--s-1)); }
  .custom { display: grid; gap: var(--s-2); padding: var(--s-1) var(--s-2) var(--s-2); }
  .custom label { display: grid; grid-template-columns: 40px 1fr; align-items: center; gap: var(--s-2); }
  .custom .field { width: 100%; min-width: 0; }
</style>
