<script lang="ts">
  import { fileUrl } from "../lib/api";
  import { forPage } from "../lib/keys";
  import { onMount } from "svelte";
  import { leaveQuestion, viewerHref } from "../lib/route.svelte";
  import { type Device, capture, hasPhone, livePage, pageUrl, pagesOf } from "../lib/runs";
  import type { Experiment, JudgedRun } from "../lib/types";
  import { identity } from "../lib/verdict";
  import Icon from "./Icon.svelte";

  // The arms side by side, one column each, on the same page: one control
  // above them steps every arm together while "Sync pages" is on, or each
  // column steps on its own. A column shows the arm's capture of the page,
  // or the page itself running when Live is chosen: then synced decks turn
  // together, a key pressed in one replayed in the rest through the viewer's
  // bridge (VIEWER_BRIDGE in src/ui.ts). Past four arms the columns scroll
  // sideways under headers that stay in view.
  let { run, questionKey, judged }: { run: Experiment; questionKey: string; judged: JudgedRun | null } = $props();

  const result = $derived(run.result!);
  const labels = $derived(result.arms.map((arm) => arm.label));
  const pages = $derived(pagesOf(run));
  const phone = $derived(hasPhone(run));
  const anyLive = $derived(labels.some((label) => (run.pages[label]?.length ?? 0) > 0));

  let sync = $state(true);
  let shared = $state(0);
  let own = $state<Record<string, number>>({});
  let device = $state<Device>("desktop");
  let mode = $state<"captures" | "live">("captures");

  const at = (label: string) => (sync ? shared : own[label] ?? shared);
  const clamp = (index: number) => Math.max(0, Math.min(pages.length - 1, index));

  /** Every arm a page on or back: the shared page, or each arm's own. */
  function stepAll(delta: number) {
    if (sync) shared = clamp(shared + delta);
    else own = Object.fromEntries(labels.map((label) => [label, clamp(at(label) + delta)]));
  }
  const stepOne = (label: string, delta: number) => (own = { ...own, [label]: clamp(at(label) + delta) });

  function setSync(on: boolean) {
    if (!on) own = Object.fromEntries(labels.map((label) => [label, shared]));
    sync = on;
  }

  /** The live frames, by arm. */
  let frames = $state<Record<string, HTMLIFrameElement | null>>({});

  /** A left or right arrow for every live frame but `except`, which pressed it itself. */
  function turn(key: "ArrowLeft" | "ArrowRight", except: Window | null = null) {
    for (const frame of Object.values(frames)) {
      const target = frame?.contentWindow;
      if (target && target !== except) target.postMessage({ crucible: true, type: "turn", key }, "*");
    }
  }

  /**
   * Whether the output is a deck, so live slide buttons and synced turning
   * mean something: a capture names a slide or opens at a fragment.
   */
  const deck = $derived(
    labels.some((label) => (result.shots?.arms?.[label] ?? []).some((shot) => /\bslide/i.test(shot.page ?? "") || (shot.artifact ?? "").includes("#"))),
  );
  /** Sync matters only with two arms or more to keep together. */
  const syncable = $derived(labels.length > 1);

  /** Live, the captured pages matter only when they are different files or slides to open. */
  const livePages = $derived(new Set(pages.flatMap((_, i) => labels.map((label) => livePage(run, label, i)))).size > labels.length);

  function onKey(event: KeyboardEvent) {
    if (!forPage(event) || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    if (mode === "live") {
      if (!sync) return;
      event.preventDefault();
      turn(event.key);
    } else if (pages.length > 1) {
      event.preventDefault();
      stepAll(event.key === "ArrowRight" ? 1 : -1);
    }
  }

  onMount(() => {
    // Only these frames may speak to this list; the full-window viewer listens to its own.
    const listen = (event: MessageEvent) => {
      const from = Object.values(frames).find((frame) => frame?.contentWindow === event.source);
      if (!from || event.data?.crucible !== true) return;
      if (event.data.type === "turn" && sync && (event.data.key === "ArrowLeft" || event.data.key === "ArrowRight")) turn(event.data.key, from.contentWindow);
      else if (event.data.type === "escape") leaveQuestion();
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  });

  const producers = $derived(new Set(labels.map((label) => identity(result.producers[label]))).size > 1);

  // The header strip scrolls with the columns but lives outside their
  // scroller, so it can stay pinned while the page scrolls.
  let heads = $state<HTMLElement | null>(null);
  let barHeight = $state(0);

  /**
   * One column's width, the same in the strip and the scroller: up to four
   * arms share the width, more scroll; a phone frame is phone-sized; on a
   * narrow window one arm fills most of it, with the next peeking in.
   */
  const GAP = 16;
  const PEEK = 40;
  let span = $state(0);
  let body = $state<HTMLElement | null>(null);
  let scrolled = $state(0);
  const column = $derived.by(() => {
    if (span === 0) return null;
    const narrow = span < 600;
    if (device === "phone") return narrow ? 200 : 240;
    if (narrow) return labels.length === 1 ? span : Math.round(span * 0.84);
    // Past four, the fifth peeks in at the edge, so the fade falls on it and not on a score.
    if (labels.length > 4) return (span - 4 * GAP - PEEK) / 4;
    return (span - (labels.length - 1) * GAP) / labels.length;
  });
  const columns = $derived(column === null ? "" : `grid-template-columns: repeat(${labels.length}, ${column}px)`);

  /** Which arms are in view when they scroll: "Arms 1–4 of 7", and a step to either side. */
  const fits = $derived(column === null ? labels.length : Math.max(1, Math.floor((span + GAP) / (column + GAP))));
  const first = $derived(column === null ? 0 : Math.round(scrolled / (column + GAP)));
  const more = $derived({ left: first > 0, right: first + fits < labels.length });
  function scrollArms(delta: number) {
    if (!body || column === null) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    body.scrollTo({ left: (first + delta) * (column + GAP), behavior: reduce ? "auto" : "smooth" });
  }
  const follow = (event: Event) => {
    scrolled = (event.currentTarget as HTMLElement).scrollLeft;
    if (heads) heads.scrollLeft = scrolled;
  };

  /** A live page, drawn at a real window's width and scaled down to its column. */
  const FRAME = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 823 } };
  let widths = $state<Record<string, number>>({});
</script>

<svelte:window onkeydown={onKey} />

<section class="compare" style="--arms: {labels.length}; --bar: {barHeight}px; --gap: {GAP}px; --peek: {PEEK}px" class:phone={device === "phone"} aria-label="Arms">
  <div class="controls" bind:offsetHeight={barHeight}>
    <div class="cluster">
      {#if mode === "live"}
        {#if deck && sync}
          <button class="btn square quiet" aria-label="Previous slide, in every arm" data-tip="Previous slide (←)" onclick={() => turn("ArrowLeft")}><Icon name="chevron-left" /></button>
          <button class="btn square quiet" aria-label="Next slide, in every arm" data-tip="Next slide (→)" onclick={() => turn("ArrowRight")}><Icon name="chevron-right" /></button>
        {/if}
        {#if livePages}{@render pagePick()}{/if}
        {#if deck && syncable}{@render syncBox()}{/if}
      {:else if pages.length > 1}
        {#if sync}
          <button class="btn square" aria-label="Previous page" data-tip="Previous page (←)" aria-disabled={shared === 0} onclick={() => stepAll(-1)}><Icon name="chevron-left" /></button>
          {@render pagePick()}
          <button class="btn square" aria-label="Next page" data-tip="Next page (→)" aria-disabled={shared === pages.length - 1} onclick={() => stepAll(1)}><Icon name="chevron-right" /></button>
        {/if}
        {#if syncable}{@render syncBox()}{/if}
      {:else if pages.length === 1}
        <span class="t-meta clip" title={pages[0]}>{pages[0]}</span>
      {/if}
    </div>
    <div class="cluster tips-end">
      {#if fits < labels.length}
        <span class="t-meta range">{fits === 1 ? `Arm ${first + 1}` : `Arms ${first + 1}–${Math.min(labels.length, first + fits)}`} of {labels.length}</span>
        <button class="btn square quiet" aria-label="Show earlier arms" data-tip="Earlier arms" aria-disabled={!more.left} onclick={() => scrollArms(-1)}>
          <Icon name="chevron-left" />
        </button>
        <button class="btn square quiet" aria-label="Show later arms" data-tip="Later arms" aria-disabled={!more.right} onclick={() => scrollArms(1)}>
          <Icon name="chevron-right" />
        </button>
      {/if}
      {#if anyLive}
        <div class="segmented" role="group" aria-label="Show">
          <button aria-pressed={mode === "captures"} onclick={() => (mode = "captures")} aria-label="Captures" data-tip="Captures"><Icon name="image" /></button>
          <button aria-pressed={mode === "live"} onclick={() => (mode = "live")} aria-label="Live page" data-tip="Live page"><Icon name="live" /></button>
        </div>
      {/if}
      {#if phone || mode === "live"}
        <div class="segmented" role="group" aria-label="Frame width">
          <button aria-pressed={device === "desktop"} onclick={() => (device = "desktop")} aria-label="Desktop" data-tip="Desktop"><Icon name="desktop" /></button>
          <button aria-pressed={device === "phone"} onclick={() => (device = "phone")} aria-label="Phone" data-tip="Phone"><Icon name="phone" /></button>
        </div>
      {/if}
    </div>
  </div>

  <div class="heads" class:fade-left={more.left} class:fade-right={more.right} bind:this={heads} aria-hidden="true">
    <div class="grid" style={columns}>
      {#each labels as label (label)}
        {@render head(label)}
      {/each}
    </div>
  </div>

  <div class="body" class:fade-left={more.left} class:fade-right={more.right} bind:this={body} onscroll={follow} bind:clientWidth={span}>
    <div class="grid" style={columns}>
      {#each labels as label (label)}
        {@const index = at(label)}
        {@const image = capture(run, label, index, device)}
        {@const live = livePage(run, label, index)}
        {@const viewer = live ? viewerHref(questionKey, result.runId, { arm: label, page: live, device }) : null}
        {@const output = run.outputs[label]}
        {@const stepper = !sync && pages.length > 1 && mode === "captures"}
        {@const footLink = mode === "live" ? viewer : viewer ? null : output}
        <figure class="arm">
          <!-- The header again, for screen readers; the pinned strip above is its picture. -->
          <figcaption class="sr-only">{label}{judged?.winner === label && labels.length > 1 ? ", winner" : ""}</figcaption>
          {#if mode === "live" && live}
            {@const frame = FRAME[device]}
            <div class="shot live" bind:clientWidth={widths[label]}>
              <iframe
                bind:this={frames[label]}
                src={pageUrl(run, label, live, true)}
                title="{label}, {live}, live"
                sandbox="allow-scripts allow-forms"
                loading="lazy"
                style="width: {frame.width}px; height: {frame.height}px; transform: scale({(widths[label] ?? 0) / frame.width})"
              ></iframe>
            </div>
          {:else if mode === "live"}
            <div class="shot none t-meta">{label} made no HTML page to view live</div>
          {:else if image}
            <!-- A capture opens its page live when there is one; else the picture itself. -->
            <a
              class="shot"
              href={viewer ?? fileUrl(image)}
              target={viewer ? undefined : "_blank"}
              rel={viewer ? undefined : "noopener"}
              aria-label={viewer ? `View ${label}'s ${live} live` : `Open ${label}'s capture full size`}
            >
              <img src={fileUrl(image)} alt="{label}, {pages[index] ?? 'output'}, {device}" loading="lazy" decoding="async" />
            </a>
          {:else}
            {@const why = run.result?.shots?.arms?.[label]?.[index]?.error}
            {@const missing = `${device === "phone" ? "No phone capture" : "No capture"} of this page${why ? `: ${why.trim().replace(/\.+$/, "")}` : ""}`}
            {#if viewer}
              <a class="shot none t-meta" href={viewer}>{missing}. View it live</a>
            {:else}
              <div class="shot none t-meta">{missing}</div>
            {/if}
          {/if}
          <!-- The capture itself opens the viewer, so the foot links only what nothing else reaches. -->
          {#if stepper || producers || footLink}
          <div class="foot t-meta">
            {#if stepper}
              <span class="own">
                <button class="btn square quiet tip-above" aria-label="{label}: previous page" data-tip="Previous page" aria-disabled={index === 0} onclick={() => stepOne(label, -1)}>
                  <Icon name="chevron-left" />
                </button>
                <span title={pages[index]}>{index + 1} / {pages.length}</span>
                <button class="btn square quiet tip-above" aria-label="{label}: next page" data-tip="Next page" aria-disabled={index === pages.length - 1} onclick={() => stepOne(label, 1)}>
                  <Icon name="chevron-right" />
                </button>
              </span>
            {:else if producers}
              <span class="clip" title={identity(result.producers[label])}>{identity(result.producers[label])}</span>
            {/if}
            {#if mode === "live" && viewer}
              <a class="btn square quiet push tip-above tips-end" href={viewer} aria-label="{label}: full window" data-tip="Full window"><Icon name="expand" /></a>
            {:else if !viewer && output}
              <a class="btn square quiet push tip-above tips-end" href={fileUrl(output)} target="_blank" rel="noopener" aria-label="{label}: open output" data-tip="Open output"><Icon name="external" /></a>
            {/if}
          </div>
          {/if}
        </figure>
      {/each}
    </div>
  </div>
</section>

{#snippet pagePick()}
  <label class="page-pick">
    <span class="sr-only">Captured page, in every arm</span>
    <select class="field" value={shared} onchange={(event) => (shared = Number(event.currentTarget.value))}>
      {#each pages as name, i (i)}<option value={i}>Capture {i + 1} of {pages.length} · {name}</option>{/each}
    </select>
  </label>
{/snippet}

{#snippet syncBox()}
  <label class="sync">
    <input type="checkbox" checked={sync} onchange={(event) => setSync(event.currentTarget.checked)} />
    Sync pages
  </label>
{/snippet}

<!-- Each arm's name and the winner; the totals are the criteria table's last row. -->
{#snippet head(label: string)}
  <div class="head">
    <div class="name">
      <span class="t-heading clip" title={label}>{label}</span>
      {#if judged?.winner === label && labels.length > 1}<span class="winner-chip">Winner</span>{/if}
    </div>
  </div>
{/snippet}

<style>
  .controls {
    position: sticky;
    top: var(--topbar);
    z-index: 4;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-2) var(--s-4);
    padding: var(--s-2) 0;
    background: var(--bg);
  }
  .page-pick select { max-width: 360px; }
  .sync { display: inline-flex; align-items: center; gap: var(--s-2); font: var(--text-meta); cursor: pointer; }

  .grid {
    display: grid;
    grid-auto-flow: column;
    grid-template-columns: repeat(var(--arms), minmax(0, 1fr));
    gap: var(--gap);
    width: max-content;
    min-width: 100%;
  }
  .heads {
    position: sticky;
    top: calc(var(--topbar) + var(--bar));
    z-index: 3;
    overflow: hidden;
    background: var(--bg);
    padding-bottom: var(--s-2);
  }
  .body { overflow-x: auto; padding-bottom: var(--s-2); scrollbar-width: thin; scroll-snap-type: x mandatory; }
  /* Columns hidden past an edge fade into the ground there. */
  .fade-right { mask-image: linear-gradient(to right, #000 calc(100% - var(--peek)), transparent); }
  .fade-left { mask-image: linear-gradient(to left, #000 calc(100% - var(--s-5)), transparent); }
  .fade-left.fade-right { mask-image: linear-gradient(to right, transparent, #000 var(--s-5), #000 calc(100% - var(--peek)), transparent); }
  .range { white-space: nowrap; margin-right: var(--s-1); }

  .name { display: flex; align-items: center; gap: var(--s-2); min-width: 0; height: var(--s-5); margin-top: var(--s-1); }

  /* Positioned, so its screen-reader caption stays inside the scroller rather than widen the page. */
  .arm { position: relative; min-width: 0; scroll-snap-align: start; }
  .shot {
    position: relative;
    display: block;
    aspect-ratio: 16 / 10;
    overflow: hidden;
    border: 1px solid var(--frame);
    border-radius: var(--radius-small);
    background: var(--surface);
    transition: border-color var(--speed) var(--ease);
  }
  .phone .shot { aspect-ratio: 390 / 823; }
  a.shot:hover { border-color: var(--faint); }
  .shot img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
  .shot.none { display: grid; place-items: center; text-align: center; padding: var(--s-4); }
  .live iframe { position: absolute; top: 0; left: 0; border: none; background: var(--page-ground); transform-origin: 0 0; }

  .foot { display: flex; gap: var(--s-3); min-height: var(--control); align-items: center; margin-top: var(--s-1); }
  .own { display: inline-flex; align-items: center; gap: var(--s-1); }

  @media (max-width: 640px) {
    .page-pick select { max-width: calc(100vw - 2 * var(--s-4) - 2 * var(--control) - 2 * var(--s-2)); }
    .controls { position: static; }
    .heads { top: var(--topbar); }
  }
</style>
