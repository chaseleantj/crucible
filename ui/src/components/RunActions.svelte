<script lang="ts">
  import { fileUrl, reveal } from "../lib/api";
  import { listHref } from "../lib/home.svelte";
  import type { Experiment } from "../lib/types";
  import DeleteButton from "./DeleteButton.svelte";
  import Icon from "./Icon.svelte";

  // What you can do with the run on screen, as quiet icons: the top bar's
  // idiom for chrome, so they never rival the results.
  let { run, single }: { run: Experiment; single: boolean } = $props();

  let revealError = $state<string | null>(null);
  async function revealFolder() {
    revealError = null;
    try {
      await reveal(run.path);
    } catch (error) {
      revealError = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<div class="actions tips-end flush-end">
  {#if run.report}
    <a class="btn square quiet" href={fileUrl(run.report)} target="_blank" rel="noopener" aria-label="Open report" data-tip="Open report"><Icon name="report" /></a>
  {/if}
  <button class="btn square quiet" onclick={revealFolder} aria-label="Show in Finder" data-tip="Show in Finder"><Icon name="folder" /></button>
  <DeleteButton
    name={run.result?.name ?? run.name}
    path={run.path}
    consequence={`${single ? "The archived result" : "This run's archived result"}, its captures and outputs, and the runner's record of it are removed.${single ? "" : " Other runs in the series are kept."}`}
    label={single ? "Delete" : "Delete run"}
    onDeleted={() => (location.hash = listHref())}
    icon
  />
  {#if revealError}<p class="t-meta tone-danger error" role="alert">{revealError}</p>{/if}
</div>

<style>
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: var(--s-2); }
  .error { flex-basis: 100%; text-align: right; }
</style>
