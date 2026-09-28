<script lang="ts">
  import { onMount } from "svelte";
  import { fileUrl } from "../lib/api";
  import { plural } from "../lib/format";
  import { type Viewing, replaceRoute, viewerHref } from "../lib/route.svelte";
  import { correspondingPage, pageUrl, splitPage } from "../lib/runs";
  import type { Experiment } from "../lib/types";
  import { isJudged } from "../lib/verdict";
  import Icon from "./Icon.svelte";

  let { run, questionKey, viewing, onClose }: { run: Experiment; questionKey: string; viewing: Viewing; onClose: () => void } = $props();

  const result = $derived(run.result!);
  const labels = $derived(result.arms.map((arm) => arm.label));
  const arm = $derived(viewing.arm);
  const pages = $derived(run.pages[arm] ?? []);
  const file = $derived(splitPage(viewing.page).file);
  const known = $derived(labels.includes(arm) && pages.includes(file));
  const src = $derived(known ? pageUrl(run, arm, viewing.page, true) : null);
  const won = $derived(isJudged(result) && result.winner === arm && labels.length > 1);
  const captured = $derived((result.shots?.arms?.[arm]?.length ?? 0) > 0);

  let dialog = $state<HTMLDialogElement | null>(null);
  let frame = $state<HTMLIFrameElement | null>(null);
  let reloads = $state(0);
  let loading = $state(false);
  let slow = $state(false);
  /** Files the page asked for that did not load, and those the sandbox refused. */
  let missing = $state<string[]>([]);
  let blocked = $state<string[]>([]);
  /** Set when an arm switch could not find the same page in the other arm. */
  let substitute = $state<string | null>(null);

  /** `note` explains a page other than the one asked for; any other change clears it. */
  function go(change: Partial<Viewing>, note: string | null = null) {
    substitute = note;
    replaceRoute(viewerHref(questionKey, result.runId, { ...viewing, ...change }));
  }

  function showArm(target: string) {
    const match = correspondingPage(run, arm, target, viewing.page);
    go({ arm: target, page: match?.page ?? viewing.page }, match && !match.exact ? `${target} has no ${file}, so this is its ${splitPage(match.page).file}.` : null);
  }

  const step = (delta: number) => showArm(labels[(labels.indexOf(arm) + delta + labels.length) % labels.length]!);

  // Each page, and each reload, starts over: loading, with nothing missing yet.
  $effect(() => {
    if (!src) return;
    void reloads;
    loading = true;
    slow = false;
    missing = [];
    blocked = [];
    const timer = setTimeout(() => (slow = true), 150);
    return () => clearTimeout(timer);
  });

  function loaded() {
    loading = false;
    // So the page's own keys, a deck's arrows, work at once.
    frame?.focus();
  }

  onMount(() => {
    dialog?.showModal();
    // Only the frame this viewer shows may speak to it; see VIEWER_BRIDGE in src/ui.ts.
    const listen = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow || event.data?.crucible !== true) return;
      const { type, url } = event.data as { type?: string; url?: unknown };
      if (type === "escape") onClose();
      else if (type === "missing" && typeof url === "string" && !missing.includes(url)) missing = [...missing, url];
      else if (type === "blocked" && typeof url === "string" && !blocked.includes(url)) blocked = [...blocked, url];
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  });

  $effect(() => {
    const before = document.title;
    document.title = `${arm} · ${file} · crucible`;
    return () => (document.title = before);
  });

  /** Up to three names, then how many more: the full list is in the tooltip. */
  function names(urls: string[], name: (url: string) => string): string {
    const all = [...new Set(urls.map(name))];
    return all.length > 3 ? `${all.slice(0, 3).join(", ")} and ${all.length - 3} more` : all.join(", ");
  }
  const fileName = (url: string) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? url);
    } catch {
      return url;
    }
  };
  const hostName = (url: string) => {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  };
</script>

<dialog
  bind:this={dialog}
  class="viewer"
  aria-label="{arm}, {file}, live"
  oncancel={(event) => {
    event.preventDefault();
    onClose();
  }}
>
  <header class="bar">
    <button class="btn square quiet tips-start" onclick={onClose} aria-label="Close the viewer" data-tip="Close (Esc)">
      <Icon name="close" />
    </button>
    <div class="cluster arms">
      {#if labels.length > 1}
        <button class="btn square" onclick={() => step(-1)} aria-label="Previous arm" data-tip="Previous arm">
          <Icon name="chevron-left" />
        </button>
        <label>
          <span class="sr-only">Arm</span>
          <select class="field" value={arm} onchange={(event) => showArm(event.currentTarget.value)}>
            {#each labels as label (label)}
              <option value={label}>{label}{(run.pages[label] ?? []).length === 0 ? " (no HTML)" : ""}</option>
            {/each}
          </select>
        </label>
        <button class="btn square" onclick={() => step(1)} aria-label="Next arm" data-tip="Next arm">
          <Icon name="chevron-right" />
        </button>
      {:else}
        <span class="t-heading clip" title={arm}>{arm}</span>
      {/if}
      {#if won}<span class="winner-chip">Winner</span>{/if}
    </div>
    <div class="cluster pages">
      {#if pages.length > 1}
        <label>
          <span class="sr-only">Page</span>
          <select class="field" value={known ? file : ""} onchange={(event) => go({ page: event.currentTarget.value })}>
            {#if !known}<option value="" disabled>Choose a page</option>{/if}
            {#each pages as name (name)}<option value={name}>{name}</option>{/each}
          </select>
        </label>
      {:else if pages.length === 1 && known}
        <span class="t-meta clip" title={pages[0]}>{pages[0]}</span>
      {/if}
    </div>
    <div class="cluster push actions tips-end">
      <div class="segmented device" role="group" aria-label="Frame width">
        <button aria-pressed={viewing.device === "desktop"} onclick={() => go({ device: "desktop" })} aria-label="Desktop" data-tip="Desktop"><Icon name="desktop" /></button>
        <button aria-pressed={viewing.device === "phone"} onclick={() => go({ device: "phone" })} aria-label="Phone" data-tip="Phone"><Icon name="phone" /></button>
      </div>
      <button class="btn square quiet" onclick={() => reloads++} disabled={!src} aria-label="Reload" data-tip={src ? "Reload" : "There is no page here to reload"}><Icon name="reload" /></button>
      {#if src}
        <a class="btn square quiet" href={pageUrl(run, arm, viewing.page, false)} target="_blank" rel="noopener" aria-label="Open in new tab" data-tip="Open in new tab"><Icon name="external" /></a>
      {/if}
    </div>
  </header>

  {#if src && (substitute || missing.length || blocked.length)}
    <div class="notes t-meta" role="status">
      {#if substitute}<p>{substitute}</p>{/if}
      {#if missing.length}
        <p class="tone-warn" title={missing.join("\n")}>
          {plural(missing.length, "file")} this page asked for didn't load here ({names(missing, fileName)}), so it may need a server or a build to run.{captured ? " The captures on the question page show it as the judge served it." : ""}
        </p>
      {/if}
      {#if blocked.length}
        <p class="tone-warn" title={blocked.join("\n")}>
          The output sandbox kept this page from reaching {names(blocked, hostName)}. Outputs load only from their own folder and a few public library and font CDNs.
        </p>
      {/if}
    </div>
  {/if}

  <div class="stage" class:phone={viewing.device === "phone"}>
    {#if src}
      {#key `${src} ${reloads}`}
        <iframe bind:this={frame} {src} title="{arm}, {file}" sandbox="allow-scripts allow-forms" onload={loaded}></iframe>
      {/key}
      {#if loading && slow}<p class="loading t-meta surface" role="status">Loading {file}…</p>{/if}
    {:else}
      <div class="empty">
        {#if !labels.includes(arm)}
          <h2 class="t-heading">This run has no arm named “{arm}”</h2>
          <p class="t-body lede">Choose one of its arms above.</p>
        {:else if pages.length === 0}
          <h2 class="t-heading">{arm} made no HTML page to view live</h2>
          {#if run.outputs[arm]}
            <p class="t-body lede">Its output is a document: <a class="inline-link" href={fileUrl(run.outputs[arm]!)} target="_blank" rel="noopener">open it in a new tab</a>.</p>
          {:else if captured}
            <p class="t-body lede">Its captures are on the question page.</p>
          {/if}
        {:else}
          <h2 class="t-heading">{arm} has no page named {file}</h2>
          <p class="t-body lede"><button class="inline-link" onclick={() => go({ page: pages[0] })}>Show {pages[0]}</button>{pages.length > 1 ? ", or choose a page above" : ""}.</p>
        {/if}
      </div>
    {/if}
  </div>
</dialog>

<style>
  /* The whole window: an output page wants all the room it can get. */
  .viewer {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    margin: 0;
    border: none;
    background: var(--bg);
    color: var(--ink);
  }
  .viewer[open] { display: flex; flex-direction: column; }
  :global(html:has(dialog.viewer[open])) { overflow: hidden; }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-4);
    min-height: var(--topbar);
    padding: var(--s-2) var(--s-4);
    border-bottom: 1px solid var(--hairline);
  }
  .arms select { max-width: 240px; }
  .pages { flex: 1; }
  .pages select { max-width: 360px; }

  .notes {
    display: grid;
    gap: var(--s-1);
    padding: var(--s-2) var(--s-4);
    border-bottom: 1px solid var(--hairline);
  }
  .notes p { max-width: 110ch; }

  .stage { position: relative; flex: 1; min-height: 0; display: flex; justify-content: center; }
  iframe { flex: 1; min-width: 0; height: 100%; border: none; background: var(--page-ground); }
  .phone { padding: var(--s-4) 0; }
  .phone iframe {
    flex: 0 1 390px;
    border: 1px solid var(--frame);
    border-radius: var(--radius-small);
  }
  .loading {
    position: absolute;
    top: var(--s-3);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--s-1) var(--s-3);
    border-radius: var(--radius-pill);
    pointer-events: none;
  }
  .empty { align-self: center; display: grid; gap: var(--s-2); max-width: 52ch; padding: var(--s-5); text-align: center; }

  /* Narrow: a frame this wide is already a phone's, so the width switch goes. */
  @media (max-width: 640px) {
    /* Two rows: close and the arm, then the page and its actions. */
    .bar { padding: var(--s-2) var(--s-3); gap: var(--s-2); }
    .device { display: none; }
    .arms { flex: 1 1 calc(100% - var(--control) - var(--s-2)); }
    .arms label { flex: 1; min-width: 0; }
    .arms select, .pages select { width: 100%; max-width: none; }
    .pages { order: 3; flex: 1 1 0; min-width: 120px; }
    .pages label { flex: 1; min-width: 0; }
    .actions { order: 4; margin-left: 0; }

    .phone { padding: 0; }
    .phone iframe { flex-basis: 100%; border: none; border-radius: 0; }
  }
</style>
