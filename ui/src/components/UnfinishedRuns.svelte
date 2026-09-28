<script lang="ts">
  import { ago, exact } from "../lib/format";
  import { home } from "../lib/home.svelte";
  import type { LiveRun } from "../lib/types";
  import DeleteButton from "./DeleteButton.svelte";
  import Icon from "./Icon.svelte";

  let { runs, now }: { runs: LiveRun[]; now: number } = $props();
</script>

<section class="section" aria-labelledby="unfinished-title">
  <button class="section-head" aria-expanded={home.unfinishedOpen} aria-controls="unfinished-list" onclick={() => (home.unfinishedOpen = !home.unfinishedOpen)}>
    <h2 id="unfinished-title" class="t-heading">Unfinished runs</h2>
    <span class="count">{runs.length}</span>
    <span class="t-meta note">Stopped, failed, or finished without being archived</span>
    <Icon name="chevron-down" class={home.unfinishedOpen ? "fold open" : "fold"} />
  </button>
  {#if home.unfinishedOpen}
    <ul id="unfinished-list" class="list">
      {#each runs as run (run.runId)}
        <li class="item">
          <span class="stack">
            <span class="t-body clip" title={run.name}>{run.name}</span>
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
  .section-head :global(.fold) { margin-left: auto; color: var(--muted); transition: transform var(--speed) var(--ease); }
  .section-head :global(.fold.open) { transform: rotate(180deg); }
  .list { list-style: none; border-top: 1px solid var(--hairline); }
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--s-4);
    padding: var(--s-2) 0;
    border-bottom: 1px solid var(--hairline);
  }
  .item:last-child { border-bottom: none; }
  @media (max-width: 640px) {
    .note { display: none; }
    .item .id { display: none; }
  }
</style>
