<script lang="ts">
  import { onMount } from "svelte";
  import { data, refresh, startPolling } from "./lib/data.svelte";
  import { plural, stamp } from "./lib/format";
  import { home, listHref } from "./lib/home.svelte";
  import { forPage } from "./lib/keys";
  import { route } from "./lib/route.svelte";
  import { runTone } from "./lib/runs";
  import { type ThemeChoice, chooseTheme, theme } from "./lib/theme.svelte";
  import Home from "./components/Home.svelte";
  import Icon, { type IconName } from "./components/Icon.svelte";
  import Menu from "./components/Menu.svelte";
  import MenuChoice from "./components/MenuChoice.svelte";
  import QuestionView from "./components/QuestionView.svelte";
  import Shortcuts from "./components/Shortcuts.svelte";

  onMount(startPolling);

  // A slow first load shows the skeleton; a fast one shows nothing at all.
  let slow = $state(false);
  onMount(() => {
    const timer = setTimeout(() => (slow = true), 150);
    return () => clearTimeout(timer);
  });

  // Re-render relative times: every few seconds, so "updated 5 s ago" is true.
  let now = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 5_000);
    return () => clearInterval(timer);
  });

  const snapshot = $derived(data.snapshot);
  const running = $derived(snapshot?.experiments.live.inFlight ?? []);
  /** The worst state among every running agent, for the pill's dot. */
  const runningTone = $derived(running.map(runTone).find((tone) => tone === "danger") ?? running.map(runTone).find((tone) => tone === "warn") ?? "ok");
  const runningLabel = $derived(
    `${running.length} running${runningTone === "danger" ? ", needs attention" : runningTone === "warn" ? ", one is slow" : ""}`,
  );

  let shortcuts = $state(false);
  function onKey(event: KeyboardEvent) {
    if (event.key === "?" && forPage(event)) {
      event.preventDefault();
      shortcuts = true;
    }
  }

  const THEMES: { choice: ThemeChoice; label: string; icon: IconName }[] = [
    { choice: "system", label: "System", icon: "theme-system" },
    { choice: "light", label: "Light", icon: "theme-light" },
    { choice: "dark", label: "Dark", icon: "theme-dark" },
  ];
  const currentTheme = $derived(THEMES.find(({ choice }) => choice === theme.choice)!);
</script>

<svelte:window onkeydown={onKey} />

<header class="topbar">
  <div class="column topbar-inner tips-end">
    <a class="wordmark t-heading" href={listHref()}>
      <!-- The 16 cut, brand/logo/mark-16.svg, drawn in the theme's tones. -->
      <svg class="mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <defs><clipPath id="mark-mouth"><path d="M10.972 9.898L12.689 3.029L4.676 4.746Z" /></clipPath></defs>
        <path class="lip" d="M1 4L12 13L12 14.5L1 5.5Z" />
        <path class="inner" d="M10.972 9.898L12.689 3.029L4.676 4.746Z" />
        <path class="melt" clip-path="url(#mark-mouth)" d="M10.972 10.898L12.689 4.029L4.676 5.746Z" />
        <path class="rim" fill-rule="evenodd" d="M12 13L15 1L1 4ZM10.972 9.898L12.689 3.029L4.676 4.746Z" />
      </svg>
      crucible
    </a>
    <span class="spacer"></span>
    {#if data.error && snapshot && data.updatedAt}
      <span class="t-meta stale" role="status">Last updated {stamp(new Date(data.updatedAt).toISOString())}</span>
    {/if}
    {#if running.length > 0}
      <a class="btn" href={listHref()} aria-label={runningLabel} data-tip={runningLabel} onclick={() => (home.showRunning = true)}>
        <span class="dot tone-{runningTone}" class:pulse={runningTone === "ok"} aria-hidden="true"></span>
        {running.length} running
      </a>
    {/if}
    <button class="btn square quiet" onclick={() => (shortcuts = true)} aria-label="Keyboard shortcuts" data-tip="Keyboard shortcuts (?)" aria-keyshortcuts="?"><Icon name="keyboard" /></button>
    <Menu label="Theme" tip="Theme: {currentTheme.label}" buttonClass="btn square quiet flush-end" align="end">
      {#snippet button()}<Icon name={currentTheme.icon} />{/snippet}
      {#snippet children(close)}
        {#each THEMES as { choice, label, icon } (choice)}
          <MenuChoice checked={theme.choice === choice} onchoose={() => { chooseTheme(choice); close(); }}><Icon name={icon} /> {label}</MenuChoice>
        {/each}
      {/snippet}
    </Menu>
  </div>
</header>

{#if shortcuts}<Shortcuts onClose={() => (shortcuts = false)} />{/if}

{#if data.error && snapshot}
  <div class="column banner-row">
    <div class="banner" role="alert">
      <div class="banner-text">
        <p class="t-body">{data.error.message} The results below are from {data.updatedAt ? stamp(new Date(data.updatedAt).toISOString()) : "the last load"}.</p>
        <p class="t-meta">{data.error.hint} <code>{data.error.command}</code></p>
      </div>
      <button class="btn" onclick={refresh}>Retry</button>
    </div>
  </div>
{/if}

{#if snapshot}
  {#key route.current.view}
    {#if route.current.view === "question"}
      <QuestionView {snapshot} key={route.current.key} runId={route.current.runId} viewing={route.current.viewing} {now} />
    {:else}
      <Home {snapshot} {now} />
    {/if}
  {/key}
{:else if data.error}
  <main class="page">
    <section class="state-page" role="alert" aria-labelledby="failed-title">
      <h1 id="failed-title" class="t-page">Results didn't load</h1>
      <p class="t-body">{data.error.message}</p>
      <p class="t-body lede">{data.error.hint}</p>
      <code class="command">{data.error.command}</code>
      <div><button class="btn" onclick={refresh}>Retry</button></div>
    </section>
  </main>
{:else if slow}
  <main class="page" aria-busy="true" aria-label="Loading results">
    <div class="skeleton title"></div>
    <div class="skeleton bar"></div>
    {#each { length: 12 } as _, i (i)}
      <div class="skeleton-row">
        <div class="skeleton thumb"></div>
        <div class="skeleton line wide"></div>
        <div class="skeleton line push"></div>
      </div>
    {/each}
  </main>
{/if}

<style>
  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    border-bottom: 1px solid var(--hairline);
  }
  .topbar-inner { display: flex; align-items: center; gap: var(--s-2); height: var(--topbar); }
  @media (max-width: 640px) {
    .stale { display: none; }
  }
  .wordmark { display: flex; align-items: center; gap: var(--s-2); }
  /* 1px low, as on the brand sheet, so it sits with the lowercase word. */
  .mark { flex: none; position: relative; top: 1px; }
  .mark .rim { fill: var(--mark-rim); }
  .mark .lip { fill: var(--mark-lip); }
  .mark .inner { fill: var(--mark-inner); }
  .mark .melt { fill: var(--mark-melt); }
  .stale { margin-right: var(--s-2); }
  .banner-row { margin-top: var(--s-4); }
  .banner {
    display: flex;
    align-items: center;
    gap: var(--s-4);
    padding: var(--s-3) var(--s-4);
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .banner-text { flex: 1; display: grid; gap: var(--s-1); min-width: 0; }
  .banner code { color: var(--ink); user-select: all; }
  .skeleton-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    height: var(--row);
    border-bottom: 1px solid var(--hairline);
  }
  /* Each placeholder takes the size of what it stands for. */
  .title { width: 120px; height: var(--chip); margin-top: var(--s-5); }
  .bar { height: var(--control); margin: var(--s-4) 0 var(--s-2); }
  .thumb { width: 40px; height: 25px; }
  .line { height: var(--s-3); }
  .line.wide { flex: 1; max-width: 40%; }
  .line.push { width: 120px; }
</style>
