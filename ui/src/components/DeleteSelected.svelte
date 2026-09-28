<script lang="ts">
  import { tick } from "svelte";
  import { type DeleteResult, deleteSelections } from "../lib/api";
  import { refresh } from "../lib/data.svelte";
  import { plural } from "../lib/format";
  import type { Row } from "../lib/results";

  // Deleting the chosen results: a dry run first, so the dialog lists exactly
  // what each takes (every archived run and run record) and which the store
  // would refuse, then the delete itself, each result whole or not at all.
  let { runsRoot, ondone }: {
    runsRoot: string;
    /** After a delete: what went, and the keys of what was kept, still chosen. */
    ondone: (deleted: number, kept: string[]) => void;
  } = $props();

  type Item = { key: string; title: string; report: boolean; paths: string[]; takes: string[] | null; error: string | null };

  let dialog = $state<HTMLDialogElement | null>(null);
  let cancel = $state<HTMLButtonElement | null>(null);
  let done = $state<HTMLButtonElement | null>(null);
  let items = $state<Item[]>([]);
  let phase = $state<"checking" | "confirm" | "deleting" | "result">("checking");
  /** A request that failed outright, before any result could be read. */
  let failure = $state<string | null>(null);
  let deleted = $state(0);
  let slow = $state(false);

  const ready = $derived(items.filter((item) => item.takes && !item.error));
  const refused = $derived(items.filter((item) => item.error));

  const pathsOf = (row: Row) => (row.kind === "question" ? row.question.runs.map((run) => run.path) : [row.test.path]);
  const isRecord = (path: string) => path.startsWith(`${runsRoot}/`);

  /** What one result takes with it, in words. */
  function takes(item: Item): string {
    if (!item.takes) return "Checking…";
    const records = item.takes.filter(isRecord).length;
    const archived = item.takes.length - records;
    return `${item.report ? plural(archived, "archived report") : plural(archived, "archived run")} · ${records === 0 ? "no run records" : plural(records, "run record")}`;
  }

  const apply = (results: DeleteResult[], to: Item[]) =>
    to.forEach((item, i) => {
      const result = results[i];
      if (!result) item.error = "The server did not answer for this one.";
      else if ("error" in result) item.error = result.error;
      else item.takes = result.deleted;
    });

  export async function open(rows: Row[]) {
    items = rows.map((row) => ({ key: row.key, title: row.title, report: row.kind === "report", paths: pathsOf(row), takes: null, error: null }));
    phase = "checking";
    failure = null;
    deleted = 0;
    slow = false;
    dialog?.showModal();
    cancel?.focus();
    const timer = setTimeout(() => (slow = true), 150);
    try {
      apply(await deleteSelections(items.map((item) => item.paths), true), items);
      phase = "confirm";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function confirm() {
    const going = ready;
    phase = "deleting";
    failure = null;
    try {
      const results = await deleteSelections(going.map((item) => item.paths));
      for (const item of going) item.takes = null;
      apply(results, going);
      deleted = going.filter((item) => !item.error).length;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      phase = "confirm";
      return;
    }
    await refresh();
    const kept = items.filter((item) => item.error).map((item) => item.key);
    ondone(deleted, kept);
    if (kept.length === 0) dialog?.close();
    else {
      phase = "result";
      await tick();
      done?.focus();
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="overlay dialog wide confirm"
  aria-labelledby="bulk-title"
  aria-describedby="bulk-what"
  oncancel={(event) => phase === "deleting" && event.preventDefault()}
>
  {#if phase === "result"}
    <h2 id="bulk-title" class="t-heading">Deleted {deleted} of {items.length}</h2>
    <p id="bulk-what" class="t-body">{plural(refused.length, "result")} could not be deleted and {refused.length === 1 ? "is" : "are"} still selected:</p>
  {:else}
    <h2 id="bulk-title" class="t-heading">Delete {plural(items.length, "result")}?</h2>
    <p id="bulk-what" class="t-body">
      Every archived run under each, with its captures and outputs, and the runner's records of them are removed. This can't be undone.
    </p>
  {/if}

  <ul class="items" aria-busy={phase === "checking"}>
    {#each phase === "result" ? refused : items as item (item.key)}
      <li class="stack">
        <span class="title t-body">{item.title}</span>
        {#if item.error}
          <span class="t-meta tone-danger">{item.error}</span>
        {:else if item.takes || slow}
          <span class="t-meta">{takes(item)}</span>
        {/if}
      </li>
    {/each}
  </ul>

  {#if failure}<p class="t-body tone-danger" role="alert">{failure}</p>{/if}
  {#if phase === "confirm" && refused.length > 0}
    <p class="t-body" role="status">{refused.length === items.length ? "None of these can be deleted." : `${plural(refused.length, "result")} can't be deleted and will be kept.`}</p>
  {/if}

  <div class="actions">
    {#if phase === "result"}
      <button class="btn" bind:this={done} onclick={() => dialog?.close()}>Close</button>
    {:else}
      <button class="btn" bind:this={cancel} onclick={() => dialog?.close()} disabled={phase === "deleting"}>Cancel</button>
      <button
        class="btn btn-danger solid"
        onclick={confirm}
        disabled={phase !== "confirm" || ready.length === 0}
        data-tip={phase === "checking" ? "Checking what each would take" : phase === "confirm" && ready.length === 0 ? "Nothing selected can be deleted" : undefined}
      >{phase === "deleting" ? "Deleting…" : `Delete ${phase === "checking" || ready.length === items.length ? "" : `${ready.length} of `}${plural(items.length, "result")}`}</button>
    {/if}
  </div>
</dialog>

<style>
  .items {
    display: grid;
    gap: var(--s-2);
    max-height: min(320px, 45vh);
    margin-top: var(--s-4);
    padding: var(--s-2) 0;
    overflow: auto;
    list-style: none;
    border-block: 1px solid var(--hairline);
  }
  .items .title { color: var(--ink); overflow-wrap: anywhere; }
</style>
