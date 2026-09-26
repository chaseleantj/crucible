<script lang="ts">
  import { onMount } from "svelte";
  import { exact, plural, score, stamp } from "../lib/format";
  import { listHref } from "../lib/home.svelte";
  import { forPage } from "../lib/keys";
  import { type Viewing, closeViewer, leaveQuestion, questionHref, replaceRoute } from "../lib/route.svelte";
  import type { Snapshot } from "../lib/types";
  import { NOT_JUDGED, isJudged, verdictLine } from "../lib/verdict";
  import RunActions from "./RunActions.svelte";
  import RunDetail from "./RunDetail.svelte";
  import ScoreByArm from "./ScoreByArm.svelte";
  import Viewer from "./Viewer.svelte";

  let { snapshot, key, runId, viewing, now }: { snapshot: Snapshot; key: string; runId: string | null; viewing: Viewing | null; now: number } = $props();

  const question = $derived(snapshot.experiments.questions.find((q) => q.key === key) ?? null);
  const run = $derived(question?.runs.find((r) => r.result?.runId === runId) ?? question?.runs[0] ?? null);
  const line = $derived(question ? verdictLine(question) : null);
  const warnings = $derived(run?.result?.warnings.length ?? 0);
  const series = $derived((question?.runs.length ?? 0) > 1);
  // The plot shows spread; with one run per arm it would only redraw the table.
  const spread = $derived(
    question?.arms.some((arm) => question.runs.filter((test) => test.result && isJudged(test.result) && typeof test.result.totals[arm] === "number").length > 1) ?? false,
  );

  // The task folds to its first line; a long prompt must not outrank the verdict.
  const task = $derived(run?.result?.task.trim() ?? "");
  const firstLine = $derived(task.split("\n").find((part) => part.trim()) ?? "");
  const folds = $derived(task.length > firstLine.length || firstLine.length > 110);
  let taskOpen = $state(false);

  function showWarnings() {
    const section = document.getElementById("warnings");
    section?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    section?.focus({ preventScroll: true });
  }

  /** j and k: the next or previous run of a series, in the table's order. */
  function stepRun(delta: 1 | -1) {
    if (!question || !run) return;
    const at = question.runs.indexOf(run);
    const next = question.runs[Math.max(0, Math.min(question.runs.length - 1, at + delta))];
    if (next && next !== run && next.result) replaceRoute(questionHref(key, next.result.runId));
  }

  function onKey(event: KeyboardEvent) {
    if (!forPage(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      leaveQuestion();
    } else if (series && (event.key === "j" || event.key === "k")) {
      event.preventDefault();
      stepRun(event.key === "j" ? 1 : -1);
    }
  }

  onMount(() => window.scrollTo(0, 0));
  $effect(() => {
    if (question) document.title = `${question.title} · crucible`;
    return () => (document.title = "crucible");
  });
</script>

<svelte:window onkeydown={onKey} />

<main class="page">
  <a class="back t-meta" href={listHref()} aria-keyshortcuts="Escape">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
    All results
  </a>

  {#if !question || !run}
    <div class="missing">
      <h1 class="t-page">This result isn't here any more</h1>
      <p class="t-body">It may have been deleted or moved out of the results folder.</p>
      <div><a class="btn" href={listHref()}>Back to results</a></div>
    </div>
  {:else}
    <header class="head">
      <div class="head-main">
        <h1 class="t-page">{question.title}</h1>
        <p class="verdict t-body">
          {#if line}
            <span class="headline">{line.headline}</span>{#each line.details as detail (detail)}<span class="detail"><span class="sep" aria-hidden="true">·</span>{detail}</span>{/each}
          {:else}
            <span class="detail">{NOT_JUDGED}</span>
          {/if}
        </p>
        {#if task}
          <div class="task" class:open={taskOpen}>
            <p class="t-body text" id="task-text">{taskOpen ? task : firstLine}</p>
            {#if folds}
              <button class="inline-link t-meta" aria-expanded={taskOpen} aria-controls="task-text" onclick={() => (taskOpen = !taskOpen)}>{taskOpen ? "Fold the task" : "Show full task"}</button>
            {/if}
          </div>
        {/if}
        {#if warnings > 0}
          <p class="t-meta warn-line">
            <span class="tone-warn">{plural(warnings, "warning")}{series ? " on the run shown" : ""}</span>
            <button class="inline-link" onclick={showWarnings}>Read {warnings === 1 ? "it" : "them"}</button>
          </p>
        {/if}
      </div>
      <RunActions {run} single={!series} />
    </header>

    {#if series}
      <section class="series" class:stacked={question.arms.length > 4} aria-labelledby="series-title">
        <div class="runs">
          <h2 id="series-title" class="t-heading">{plural(question.runs.length, "run")}</h2>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reported</th>
                  {#each question.arms as arm (arm)}<th class="num arm-col">{arm}</th>{/each}
                </tr>
              </thead>
              <tbody>
                {#each question.runs as test (test.path)}
                  {@const result = test.result}
                  {@const judged = result && isJudged(result) ? result : null}
                  {@const selected = test === run}
                  <tr class:current={selected}>
                    <td>
                      <a class="pick" href={questionHref(key, result?.runId)} aria-current={selected ? "page" : undefined} title={result ? exact(result.reportedAt) : undefined}>
                        {result ? stamp(result.reportedAt) : "—"}
                      </a>
                    </td>
                    {#each question.arms as arm (arm)}
                      <td class="num" class:lead={judged?.winner === arm} class:dim={judged?.winner !== arm}>{judged ? score(judged.totals[arm]) : "—"}</td>
                    {/each}
                  </tr>
                {/each}
                <tr class="mean">
                  <td>Mean</td>
                  {#each question.arms as arm (arm)}<td class="num" class:lead={question.winner === arm}>{score(question.meanTotals[arm])}</td>{/each}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        {#if spread}
          <div class="plot">
            <h2 class="t-heading">Score by arm</h2>
            <ScoreByArm {question} selected={run} />
          </div>
        {/if}
      </section>
    {/if}

    {#key run.path}
      <RunDetail {run} {question} {now} single={!series} />
    {/key}
    {#if viewing && run.result}
      <Viewer {run} questionKey={key} {viewing} onClose={() => closeViewer(key, run.result!.runId)} />
    {/if}
  {/if}
</main>

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    margin-top: var(--s-2);
    padding: var(--s-1) var(--s-2) var(--s-1) 0;
  }
  .back:hover { color: var(--ink); }
  .missing { padding: var(--s-7) 0; display: grid; gap: var(--s-3); }
  .missing p { color: var(--muted); }

  /* The verdict strip: the title, the verdict in one line, the task in one line; actions on the right. */
  .head { display: flex; align-items: flex-start; gap: var(--s-5); margin-top: var(--s-3); }
  .head-main { flex: 1; min-width: 0; display: grid; gap: var(--s-2); }
  .verdict { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: var(--s-2); color: var(--muted); }
  .headline { color: var(--ink); font-weight: 600; }
  /* The dot travels with its detail, so a wrapped line never ends on one. */
  .sep { color: var(--faint); margin-right: var(--s-2); }
  .task { display: flex; align-items: baseline; gap: var(--s-3); min-width: 0; max-width: 880px; }
  .task .text { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .task button { flex: none; color: var(--muted); }
  .task.open { display: grid; justify-items: start; gap: var(--s-1); }
  .task.open .text { white-space: pre-line; max-width: 72ch; color: var(--ink); }
  .warn-line { display: flex; gap: var(--s-2); }

  .series {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr);
    gap: var(--s-6);
    margin-top: var(--s-6);
  }
  .series.stacked { grid-template-columns: minmax(0, 1fr); }
  .series h2 { margin-bottom: var(--s-3); }
  /* Arm names wrap at their hyphens rather than clip. */
  .arm-col { white-space: normal; max-width: 120px; vertical-align: bottom; }
  tbody tr { position: relative; }
  .pick { white-space: nowrap; }
  .pick::after { content: ""; position: absolute; inset: 0; }
  .pick:focus-visible { outline: none; }
  tbody tr:hover td { background: var(--surface-hover); }
  tbody tr:has(.pick:focus-visible) td:first-child { box-shadow: inset 2px 0 0 var(--ink); }
  .series th:first-child, .series td:first-child { padding-left: var(--s-3); }
  td.lead { font-weight: 600; }
  td.dim { color: var(--muted); }
  tr.current td.dim { color: var(--ink); }
  /* The mean is the answer: the strongest row. */
  tr.mean td { border-top: 1px solid var(--hairline-strong); color: var(--ink); font-weight: 600; height: 40px; vertical-align: middle; }

  @media (max-width: 1100px) {
    .series { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 720px) {
    .head { flex-direction: column; gap: var(--s-4); }
  }
</style>
