<script lang="ts">
  import { PAGE_SIZES } from "../lib/home.svelte";
  import Menu from "./Menu.svelte";
  import MenuChoice from "./MenuChoice.svelte";

  // Paging for the results list, in the bar above it. `page` may be past the end
  // (an old address, a list that shrank); the pager shows the page actually on
  // screen and pages on from there.
  let { total, page, size, onpage, onsize }: {
    total: number;
    page: number;
    size: number;
    onpage: (page: number) => void;
    onsize: (size: number) => void;
  } = $props();

  const pages = $derived(Math.max(1, Math.ceil(total / size)));
  const first = $derived((page - 1) * size + 1);
  const last = $derived(Math.min(page * size, total));

  // aria-disabled rather than disabled, so the button just pressed keeps focus
  // when it reaches an end.
  function go(target: number) {
    if (target >= 1 && target <= pages && target !== page) onpage(target);
  }
</script>

<nav class="pager" aria-label="Result pages">
  {#if pages > 1}
    <Menu label="Go to rows" title="Go to rows" chevron>
      {#snippet button()}<span class="range num">{first}–{last} of {total}</span>{/snippet}
      {#snippet children(close)}
        {#each { length: pages } as _, i (i)}
          <MenuChoice checked={i + 1 === page} onchoose={() => { go(i + 1); close(); }}>
            <span class="num">{i * size + 1}–{Math.min((i + 1) * size, total)}</span>
          </MenuChoice>
        {/each}
      {/snippet}
    </Menu>
    <span class="steps">
      <button class="btn square quiet" aria-label="Previous page" title={page === 1 ? "Already on the first page" : "Previous page"} aria-disabled={page === 1} onclick={() => go(page - 1)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
      </button>
      <button class="btn square quiet" aria-label="Next page" title={page === pages ? "Already on the last page" : "Next page"} aria-disabled={page === pages} onclick={() => go(page + 1)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
      </button>
    </span>
  {:else}
    <span class="range alone t-meta num" role="status">{first}–{last} of {total}</span>
  {/if}
  <span class="sizes">
  <Menu label="Results per page" align="end" chevron>
    {#snippet button()}{size} per page{/snippet}
    {#snippet children(close)}
      {#each PAGE_SIZES as option (option)}
        <MenuChoice checked={option === size} onchoose={() => { onsize(option); close(); }}>{option} per page</MenuChoice>
      {/each}
    {/snippet}
  </Menu>
  </span>
</nav>

<style>
  .pager { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1); }
  .range { white-space: nowrap; }
  .alone { padding: 0 var(--s-3); color: var(--muted); }
  .steps { display: flex; align-items: center; }
  /* A phone keeps the smallest page; the choice would crowd the paging off its row. */
  @media (max-width: 640px) {
    .sizes { display: none; }
  }
</style>
