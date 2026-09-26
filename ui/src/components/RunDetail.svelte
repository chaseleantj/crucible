<script lang="ts">
  import { ago, compact, duration, exact, score, signed } from "../lib/format";
  import type { Experiment, Question, SkillEnvironment } from "../lib/types";
  import { NOT_JUDGED, confidenceLine, controlGuess, identity, isJudged } from "../lib/verdict";
  import ArmsCompare from "./ArmsCompare.svelte";

  let { run, question, now, single }: { run: Experiment; question: Question; now: number; single: boolean } = $props();

  const result = $derived(run.result!);
  const judged = $derived(isJudged(result) ? result : null);
  const labels = $derived(result.arms.map((arm) => arm.label));
  /** The reference arm, first in run order: the control the others are measured against. */
  const reference = $derived(labels.length > 1 ? labels[0]! : null);

  /** The producer every arm shared, when they all ran the same one. */
  const sharedProducer = $derived.by(() => {
    const lines = new Set(labels.map((label) => identity(result.producers[label])));
    return lines.size === 1 ? [...lines][0]! : null;
  });

  const ENVIRONMENTS: Record<SkillEnvironment, string> = {
    realistic: "Every arm had the usual global skills",
    clean: "No skills except each arm's candidate",
  };
  const environment = $derived(
    result.environment === "mixed"
      ? `Mixed: ${result.arms.map((arm) => `${arm.label} ${arm.environment ?? "not recorded"}`).join(", ")}`
      : result.environment ? ENVIRONMENTS[result.environment] : "Not recorded",
  );

  /** A warning with its long hashes shortened; the full value stays in the tooltip. */
  function warningParts(warning: string): { text: string; hash: boolean }[] {
    return warning.split(/\b([0-9a-f]{20,})\b/).filter(Boolean).map((text) => ({ text, hash: /^[0-9a-f]{20,}$/.test(text) }));
  }

  /** The best score on each criterion, so the leader of each row stands out. */
  const best = (scores: Record<string, number>) => Math.max(...Object.values(scores));

  const guess = $derived(judged ? controlGuess(judged) : null);

  // Time and output tokens, each drawn against the largest in its column.
  const costs = $derived(labels.map((label) => ({ label, cost: result.cost?.[label] ?? null })));
  const longest = $derived(Math.max(0, ...costs.map(({ cost }) => cost?.wallTimeMs ?? 0)));
  const most = $derived(Math.max(0, ...costs.map(({ cost }) => cost?.tokens?.output ?? 0)));
  const wide = $derived(labels.length > 3);
</script>

<section class="run" aria-label="Run {result.runId}">
  <!-- A series names the run shown by its row in the runs table, so no heading repeats its date and score. -->
  {#if run.issues?.length}
    <p class="t-meta tone-warn issues" role="status">{run.issues.join(" · ")}</p>
  {/if}

  <ArmsCompare {run} questionKey={question.key} {judged} />

  <div class="columns" class:wide>
    <div class="column">
      {#if judged && judged.scores.length > 0}
        <section aria-labelledby="criteria-title">
          <h3 id="criteria-title" class="t-heading">Criteria</h3>
          <div class="table-wrap">
            <table class="criteria">
              <thead>
                <tr>
                  <th>Criterion</th>
                  <th class="num">Weight</th>
                  {#each labels as label (label)}<th class="num arm-col">{label}</th>{/each}
                </tr>
              </thead>
              <tbody>
                {#each judged.scores as row (row.criterion)}
                  {@const top = best(row.scores)}
                  <tr>
                    <td class="criterion">{row.criterion}</td>
                    <td class="num dim">{row.weight}</td>
                    {#each labels as label (label)}
                      {@const lead = labels.length > 1 && row.scores[label] === top}
                      <td class="num" class:lead class:dim={!lead}>{row.scores[label] ?? "—"}</td>
                    {/each}
                  </tr>
                {/each}
                <tr class="sum">
                  <td class="row-label">Weighted total</td>
                  <td></td>
                  {#each labels as label (label)}
                    <td class="num" class:lead={labels.length > 1 && judged.winner === label}>{score(judged.totals[label])}</td>
                  {/each}
                </tr>
                {#if reference && judged.totals[reference] !== undefined}
                  <tr class="delta">
                    <td class="row-label">Against {reference}</td>
                    <td></td>
                    {#each labels as label (label)}
                      {@const total = judged.totals[label]}
                      <td class="num">{label === reference || total === undefined ? "—" : signed(total - judged.totals[reference]!)}</td>
                    {/each}
                  </tr>
                {/if}
              </tbody>
            </table>
          </div>
        </section>
      {:else if !judged}
        <section aria-labelledby="unjudged-title">
          <h3 id="unjudged-title" class="t-heading">{NOT_JUDGED}</h3>
          <p class="t-body prose">This run was produced and captured without a judge, so it has no scores or winner. The captures above are its evidence.</p>
        </section>
      {/if}

      <section aria-labelledby="cost-title">
        <h3 id="cost-title" class="t-heading">Time and tokens</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Arm</th>
                <th class="num">Time</th>
                <th class="num">Output</th>
                <th class="num">Input</th>
                <th class="num">Cache reads</th>
              </tr>
            </thead>
            <tbody>
              {#each costs as { label, cost } (label)}
                <tr>
                  <td class="clip arm-name" title={label}>{label}</td>
                  <td class="num">
                    {#if cost}<span class="with-bar">{duration(cost.wallTimeMs)}<span class="meter" aria-hidden="true"><span style="--value: {longest ? cost.wallTimeMs / longest : 0}"></span></span></span>{:else}—{/if}
                  </td>
                  <td class="num">
                    {#if cost?.tokens}<span class="with-bar">{compact(cost.tokens.output)}<span class="meter" aria-hidden="true"><span style="--value: {most ? cost.tokens.output / most : 0}"></span></span></span>{:else}—{/if}
                  </td>
                  <td class="num dim">{cost?.tokens ? compact(cost.tokens.input) : "—"}</td>
                  <td class="num dim">{cost?.tokens ? compact(cost.tokens.cacheRead) : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="column">
      {#if judged}
        <section aria-labelledby="judge-title">
          <h3 id="judge-title" class="t-heading">Judge's reasoning</h3>
          {#if judged.summary}<p class="t-body prose">{judged.summary}</p>{/if}
          <dl class="facts">
            {#if guess}
              <div>
                <dt>Control guess</dt>
                <dd>
                  {guess.text}{#if guess.correct !== null}<span class="t-meta">{guess.correct ? " · correct" : " · wrong"}</span>{/if}
                </dd>
              </div>
            {/if}
            <div><dt>Confidence</dt><dd>{confidenceLine(judged)}</dd></div>
            <div><dt>Judge</dt><dd>{identity(judged.judgeAgent)}</dd></div>
          </dl>
        </section>
      {/if}

      <section aria-labelledby="facts-title">
        <h3 id="facts-title" class="t-heading">Run</h3>
        <dl class="facts">
          {#if sharedProducer}<div><dt>Producer</dt><dd>{sharedProducer}</dd></div>{/if}
          <div><dt>Skills</dt><dd>{environment}</dd></div>
          <!-- A series dates each run in its table. -->
          {#if single}<div><dt>Reported</dt><dd title={ago(result.reportedAt, now)}>{exact(result.reportedAt)}</dd></div>{/if}
          {#if result.series}<div><dt>Series</dt><dd>{result.series}</dd></div>{/if}
          <div><dt>Run ID</dt><dd>{result.runId}</dd></div>
        </dl>
      </section>

      {#if result.warnings.length > 0}
        <section id="warnings" aria-labelledby="warnings-title" tabindex="-1">
          <h3 id="warnings-title" class="t-heading tone-warn">{result.warnings.length === 1 ? "Warning" : `${result.warnings.length} warnings`}</h3>
          <ul class="warnings t-body">
            {#each result.warnings as warning, i (i)}
              <li>
                {#each warningParts(warning) as part, j (j)}{#if part.hash}<span class="hash" title={part.text}>{part.text.slice(0, 8)}…</span>{:else}{part.text}{/if}{/each}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  </div>
</section>

<style>
  .run { margin-top: var(--s-6); }
  .issues { margin-bottom: var(--s-3); }

  .columns {
    display: grid;
    grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
    gap: var(--s-7);
    margin-top: var(--s-6);
  }
  /* Many arms: the tables take the full width, the reasoning sits beneath. */
  .columns.wide { grid-template-columns: minmax(0, 1fr); gap: var(--s-6); }
  .columns.wide .column:last-child { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); column-gap: var(--s-7); }
  .column { display: grid; gap: var(--s-6); align-content: start; min-width: 0; }
  .column > * { min-width: 0; }
  .column h3 { margin-bottom: var(--s-3); display: flex; align-items: baseline; gap: var(--s-2); }
  .prose { max-width: 68ch; color: var(--ink); }
  .facts { display: grid; gap: var(--s-2); margin-top: var(--s-4); font: var(--text-meta); }
  .facts div { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: var(--s-3); }
  .facts dt { color: var(--muted); }
  .facts dd { overflow-wrap: anywhere; }
  /* Arm names wrap at their hyphens rather than clip. */
  .arm-col { white-space: normal; max-width: 120px; vertical-align: bottom; }
  .arm-name { max-width: 200px; }
  .criterion { min-width: 160px; }

  /* The best cell of each row: bold on a quiet neutral ground, never a hue. */
  .criteria td.lead { font-weight: 600; background: var(--best); }
  td.dim { color: var(--muted); }
  /* The weighted total is the answer: the strongest row. */
  .criteria td:last-child, .criteria th:last-child { padding-right: var(--s-3); }
  tr.sum td { border-top: 1px solid var(--hairline-strong); font-weight: 600; color: var(--ink); vertical-align: middle; height: 40px; }
  tr.sum td.lead { background: var(--best); }
  .row-label { white-space: nowrap; }
  tr.delta td { color: var(--muted); }
  .with-bar { display: inline-flex; align-items: center; gap: var(--s-2); }
  .with-bar .meter { width: 48px; }

  .warnings { padding-left: var(--s-4); display: grid; gap: var(--s-2); color: var(--ink); overflow-wrap: anywhere; }
  .hash { color: var(--muted); }
  #warnings { scroll-margin-top: calc(var(--topbar) + var(--s-5)); }
  #warnings:focus { outline: none; }

  @media (max-width: 960px) {
    .columns { grid-template-columns: minmax(0, 1fr); gap: var(--s-6); }
  }
</style>
