<script lang="ts">
  import { onMount } from "svelte";
  import { SHORTCUTS } from "../lib/keys";

  let { onClose }: { onClose: () => void } = $props();
  let dialog = $state<HTMLDialogElement | null>(null);

  onMount(() => dialog?.showModal());
</script>

<!-- A click on the backdrop lands on the dialog itself, and closes it. -->
<dialog
  bind:this={dialog}
  class="surface sheet"
  aria-labelledby="shortcuts-title"
  onclose={onClose}
  onclick={(event) => event.target === dialog && dialog?.close()}
  onkeydown={(event) => event.key === "?" && dialog?.close()}
>
  <div class="head">
    <h2 id="shortcuts-title" class="t-heading">Keyboard shortcuts</h2>
    <button class="btn" onclick={() => dialog?.close()}>Done</button>
  </div>
  {#each SHORTCUTS as group (group.title)}
    <section aria-label={group.title}>
      <h3 class="t-meta">{group.title}</h3>
      <dl>
        {#each group.keys as { keys, action } (action)}
          <div>
            <dt>{#each keys as key, i (key)}{#if i > 0}<span class="or t-meta">or</span>{/if}<kbd class="kbd">{key}</kbd>{/each}</dt>
            <dd class="t-body">{action}</dd>
          </div>
        {/each}
      </dl>
    </section>
  {/each}
</dialog>

<style>
  .sheet {
    margin: auto;
    width: min(480px, calc(100vw - 2 * var(--s-4)));
    padding: var(--s-5);
    color: var(--ink);
    box-shadow: var(--shadow-dialog);
    border-color: var(--hairline-strong);
  }
  .sheet::backdrop { background: var(--scrim); }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--s-2); }
  section { margin-top: var(--s-4); }
  h3 { margin-bottom: var(--s-2); }
  dl { display: grid; gap: var(--s-2); }
  dl div { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: var(--s-3); align-items: center; }
  dt { display: flex; align-items: center; gap: var(--s-1); }
  .or { padding: 0 2px; }
</style>
