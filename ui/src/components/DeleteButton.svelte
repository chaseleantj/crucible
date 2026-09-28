<script lang="ts">
  import { deleteRun } from "../lib/api";
  import { refresh } from "../lib/data.svelte";
  import Icon from "./Icon.svelte";

  let {
    name,
    path,
    consequence,
    disabledReason = "",
    label = "Delete…",
    icon = false,
    onDeleted = () => {},
  }: {
    name: string;
    path: string;
    /** What goes, in a sentence: "Its captures and outputs are removed." */
    consequence: string;
    disabledReason?: string;
    label?: string;
    /** A square trash button, its label in the tooltip. */
    icon?: boolean;
    onDeleted?: () => void;
  } = $props();

  const id = $props.id();
  let dialog = $state<HTMLDialogElement | null>(null);
  let cancel = $state<HTMLButtonElement | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function open() {
    error = null;
    dialog?.showModal();
    cancel?.focus();
  }

  async function confirm() {
    busy = true;
    error = null;
    try {
      await deleteRun(path);
      dialog?.close();
      await refresh();
      onDeleted();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<button
  class="btn btn-danger"
  class:square={icon}
  class:quiet={icon}
  onclick={open}
  disabled={Boolean(disabledReason)}
  data-tip={disabledReason || (icon ? label : undefined)}
  aria-label={`${label.replace(/…$/, "")} ${name}`}
>{#if icon}<Icon name="trash" />{:else}{label}{/if}</button>

<dialog bind:this={dialog} aria-labelledby="delete-title-{id}" class="overlay dialog confirm" onclose={() => (error = null)}>
  <h2 id="delete-title-{id}" class="t-heading">Delete “{name}”?</h2>
  <p class="t-body">{consequence} This can't be undone.</p>
  {#if error}<p class="t-body tone-danger" role="alert">{error}</p>{/if}
  <div class="actions">
    <button class="btn" bind:this={cancel} onclick={() => dialog?.close()} disabled={busy}>Cancel</button>
    <button class="btn btn-danger solid" onclick={confirm} disabled={busy}>{busy ? "Deleting…" : "Delete"}</button>
  </div>
</dialog>
