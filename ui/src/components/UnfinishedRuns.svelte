<script lang="ts">
  import { ago, exact } from "../lib/format";
  import { home } from "../lib/home.svelte";
  import type { LiveRun } from "../lib/types";
  import DeleteButton from "./DeleteButton.svelte";

  let { runs, now }: { runs: LiveRun[]; now: number } = $props();
</script>

<section class="section" aria-labelledby="unfinished-title">
  <button class="section-head toggle" aria-expanded={home.unfinishedOpen} aria-controls="unfinished-list" onclick={() => (home.unfinishedOpen = !home.unfinishedOpen)}>
    <h2 id="unfinished-title" class="t-heading">Unfinished runs</h2>
    <span class="count">{runs.length}</span>
    <span class="t-meta">Stopped, failed, or finished without being archived</span>
    <svg class:open={home.unfinishedOpen} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5 8 10.5 12 6.5" /></svg>
  </button>
  {#if home.unfinishedOpen}
    <ul id="unfinished-list" class="list">
      {#each runs as run (run.runId)}
        <li class="item">
          <span class="main">
            <span class="t-heading clip" title={run.name}>{run.name}</span>
            <span class="t-meta">
              <span class:tone-danger={run.phase === "failed"}>{run.phase}</span> · <span title={exact(run.updatedAt)}>{ago(run.updatedAt, now)}</span> · {run.labels.join(" vs ")}
            </span>
          </span>
          <span class="id t-meta">{run.runId}</span>
          <DeleteButton
            name={run.name}
            path={run.path}
            consequence="The runner's record of this run is removed. Archived results are kept."
            disabledReason={run.deletable ? "" : "Stop this run's agents before deleting it."}
          />
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .toggle { width: 100%; text-align: left; border-radius: var(--radius-small); }
  .toggle .t-meta { margin-left: var(--s-2); }
  .toggle svg { margin-left: auto; color: var(--muted); transition: transform var(--speed) var(--ease); }
  .toggle svg.open { transform: rotate(180deg); }
  .list { list-style: none; border-top: 1px solid var(--hairline); }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--s-4);
    min-height: 60px;
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--hairline);
  }
  .main { display: grid; gap: 2px; min-width: 0; }
  @media (max-width: 640px) {
    .toggle .t-meta:not(.count) { display: none; }
    .item .id { display: none; }
  }
</style>
