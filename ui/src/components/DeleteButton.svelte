<script lang="ts">
  import { deleteRun } from "../lib/api";
  import { refresh } from "../lib/data.svelte";

  let {
    name,
    path,
    consequence,
    disabledReason = "",
    label = "Delete",
    onDeleted = () => {},
  }: {
    name: string;
    path: string;
    /** What goes, in a sentence: "Its captures and outputs are removed." */
    consequence: string;
    disabledReason?: string;
    label?: string;
    onDeleted?: () => void;
  } = $props();

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
  onclick={open}
  disabled={Boolean(disabledReason)}
  title={disabledReason || undefined}
  aria-label={`${label} ${name}`}
>{label}</button>

<dialog bind:this={dialog} aria-labelledby="delete-title" class="surface confirm" onclose={() => (error = null)}>
  <h2 id="delete-title" class="t-heading">Delete “{name}”?</h2>
  <p class="t-body">{consequence} This can't be undone.</p>
  {#if error}<p class="t-body error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button class="btn" bind:this={cancel} onclick={() => dialog?.close()} disabled={busy}>Cancel</button>
    <button class="btn btn-danger solid" onclick={confirm} disabled={busy}>{busy ? "Deleting…" : "Delete"}</button>
  </div>
</dialog>
