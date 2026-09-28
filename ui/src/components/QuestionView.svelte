<script lang="ts">
  import { onMount } from "svelte";
  import { exact, plural, score, stamp } from "../lib/format";
  import { listHref } from "../lib/home.svelte";
  import { forPage } from "../lib/keys";
  import { type Viewing, closeViewer, leaveQuestion, questionHref, replaceRoute } from "../lib/route.svelte";
  import type { Snapshot } from "../lib/types";
  import { isJudged } from "../lib/verdict";
  import Icon from "./Icon.svelte";
  import RunActions from "./RunActions.svelte";
  import RunDetail from "./RunDetail.svelte";
  import ScoreByArm from "./ScoreByArm.svelte";
  import Viewer from "./Viewer.svelte";

  let { snapshot, key, runId, viewing, now }: { snapshot: Snapshot; key: string; runId: string | null; viewing: Viewing | null; now: number } = $props();

  const question = $derived(snapshot.experiments.questions.find((q) => q.key === key) ?? null);
  const run = $derived(question?.runs.find((r) => r.result?.runId === runId) ?? question?.runs[0] ?? null);
  const warnings = $derived(run?.result?.warnings.length ?? 0);
  const series = $derived((question?.runs.length ?? 0) > 1);
  // The plot shows spread; with one run per arm it would only redraw the table.
  const spread = $derived(
    question?.arms.some((arm) => question.runs.filter((test) => test.result && isJudged(test.result) && typeof test.result.totals[arm] === "number").length > 1) ?? false,
  );

  // The task folds to its first line; a long prompt must not outrank the title.
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
  <a class="text-button t-meta back" href={listHref()} aria-keyshortcuts="Escape">
    <Icon name="chevron-left" />
    All results
  </a>

  {#if !question || !run}
    <div class="state-page">
      <h1 class="t-page">This result isn't here any more</h1>
      <p class="t-body lede">It may have been deleted or moved out of the results folder.</p>
      <div><a class="btn" href={listHref()}>Back to results</a></div>
    </div>
  {:else}
    <header class="head">
      <div class="head-main">
        <h1 class="t-page">{question.title}</h1>
        {#if task}
          <div class="task" class:open={taskOpen}>
            <p class="t-body text" id="task-text">{taskOpen ? task : firstLine}</p>
            {#if folds}
              <button class="text-button" aria-expanded={taskOpen} aria-controls="task-text" onclick={() => (taskOpen = !taskOpen)}>{taskOpen ? "Fold the task" : "Show full task"}</button>
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
      <section class="section series" class:stacked={question.arms.length > 4} aria-labelledby="series-title">
        <div class="runs">
          <h2 id="series-title" class="t-heading section-head">{plural(question.runs.length, "run")}</h2>
          <div class="table-wrap">
            <table class="linked inset">
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
                      <a class="row-link pick" href={questionHref(key, result?.runId)} aria-current={selected ? "page" : undefined} title={result ? exact(result.reportedAt) : undefined}>
                        {result ? stamp(result.reportedAt) : "—"}
                      </a>
                    </td>
                    {#each question.arms as arm (arm)}
                      <td class="num" class:lead={judged?.winner === arm} class:dim={judged?.winner !== arm}>{judged ? score(judged.totals[arm]) : "—"}</td>
                    {/each}
                  </tr>
                {/each}
                <tr class="total">
                  <td>Mean</td>
                  {#each question.arms as arm (arm)}<td class="num" class:lead={question.winner === arm}>{score(question.meanTotals[arm])}</td>{/each}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        {#if spread}
          <div class="plot">
            <h2 class="t-heading section-head">Score by arm</h2>
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
  .back { margin-top: var(--s-2); padding-block: var(--s-1); }

  /* The head: the title, the task in one line; actions on the right. */
  .head { display: flex; align-items: flex-start; gap: var(--s-5); margin-top: var(--s-3); }
  .head-main { flex: 1; min-width: 0; display: grid; gap: var(--s-2); }
  .task { display: flex; align-items: baseline; gap: var(--s-3); min-width: 0; max-width: 880px; }
  .task .text { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .task button { flex: none; }
  .task.open { display: grid; justify-items: start; gap: var(--s-1); }
  .task.open .text { white-space: pre-line; max-width: var(--prose); color: var(--ink); }
  .warn-line { display: flex; gap: var(--s-2); }

  .series {
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr);
    gap: var(--s-6);
  }
  .series.stacked { grid-template-columns: minmax(0, 1fr); }
  .pick { white-space: nowrap; }

  @media (max-width: 1100px) {
    .series { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 720px) {
    .head { flex-direction: column; gap: var(--s-4); }
  }
</style>
