<script lang="ts">
  import { score, stamp } from "../lib/format";
  import { questionHref } from "../lib/route.svelte";
  import type { Experiment, Question } from "../lib/types";
  import { isJudged } from "../lib/verdict";

  // A dot plot of a series: one row per arm, one dot per judged run at its
  // weighted total, a tick at the arm's mean. The leading arm is drawn in
  // ink, the rest in a quiet grey; the run on screen is ringed, as its row
  // is marked in the table beside. No legend: a dot's tooltip gives its run,
  // the tick's its mean. The table holds every value; this shows
  // the spread the table cannot.
  let { question, selected }: { question: Question; selected: Experiment } = $props();

  const ROW = 32;
  const TOP = 8;
  const AXIS = 40;
  const DOT = 4.5;

  let width = $state(0);

  type Point = { value: number; run: Experiment; offset: number };

  const rows = $derived(
    question.arms.map((arm) => {
      const points: Point[] = question.runs
        .flatMap((run) => (run.result && isJudged(run.result) && typeof run.result.totals[arm] === "number" ? [{ value: run.result.totals[arm]!, run, offset: 0 }] : []))
        .sort((a, b) => a.value - b.value);
      return { arm, points, mean: question.meanTotals[arm] ?? null, lead: question.winner === arm };
    }),
  );

  const values = $derived(rows.flatMap((row) => row.points.map((point) => point.value)));

  /** Clean ticks around the data: the step that gives at most six of them. */
  const axis = $derived.by(() => {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = Math.max(hi - lo, 0.5);
    const step = [0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50].find((s) => span / s <= 5) ?? 100;
    // Totals are never negative, so the axis stops at zero rather than pad past it.
    const min = Math.max(lo >= 0 ? 0 : -Infinity, Math.floor((lo - step * 0.25) / step) * step);
    const max = Math.ceil((hi + step * 0.25) / step) * step;
    const ticks: number[] = [];
    for (let t = min; t <= max + step / 1000; t += step) ticks.push(Number(t.toFixed(4)));
    return { min, max, ticks };
  });

  const label = $derived(Math.min(148, Math.max(88, width * 0.3)));
  /** As many characters as the label gutter holds, at about 6.5px each in this face. */
  const fit = $derived(Math.max(6, Math.floor(label / 6.5)));
  const x = (value: number) => label + 16 + ((value - axis.min) / (axis.max - axis.min || 1)) * Math.max(0, width - label - 32);
  const height = $derived(TOP + rows.length * ROW + AXIS);

  /** Runs with near-equal totals would hide each other: nudge them up and down. */
  const placed = $derived(
    rows.map((row) => {
      let last = -Infinity;
      let flip = 1;
      const points = row.points.map((point) => {
        const px = x(point.value);
        const clash = px - last < DOT * 1.6;
        last = px;
        flip = clash ? -flip : 1;
        return { ...point, offset: clash ? flip * 6 : 0 };
      });
      return { ...row, points };
    }),
  );

  const summary = $derived(
    `Score by arm across ${question.runs.length} runs. ` +
      rows.map((row) => `${row.arm}: mean ${score(row.mean)}${row.lead ? ", leading" : ""}`).join("; ") + ".",
  );

  let tip = $state<{ x: number; y: number; value: number; when: string } | null>(null);
</script>

<figure class="plot" bind:clientWidth={width}>
  {#if width > 0 && values.length > 0}
    <svg {width} {height} role="img" aria-label={summary}>
      {#each axis.ticks as tick (tick)}
        <line class="grid" x1={x(tick)} x2={x(tick)} y1={TOP} y2={TOP + rows.length * ROW} />
        <text class="tick" x={x(tick)} y={TOP + rows.length * ROW + 16} text-anchor="middle">{tick}</text>
      {/each}
      <text class="axis-title" x={label + 16 + (width - label - 32) / 2} y={height - 4} text-anchor="middle">Weighted total</text>

      {#each placed as row, i (row.arm)}
        {@const cy = TOP + i * ROW + ROW / 2}
        <g class:lead={row.lead}>
          <line class="rule" x1={label + 16} x2={width - 16} y1={cy} y2={cy} />
          <text class="arm" x={label} y={cy} dy="0.35em" text-anchor="end">{row.arm.length > fit ? `${row.arm.slice(0, fit - 1)}…` : row.arm}<title>{row.arm}</title></text>
          <!-- A mean of one run is that run: no tick to pretend otherwise. -->
          {#if row.mean !== null && row.points.length > 1}
            <line class="mean" x1={x(row.mean)} x2={x(row.mean)} y1={cy - 9} y2={cy + 9}><title>{row.arm}, mean {score(row.mean)}</title></line>
          {/if}
          {#each row.points as point (point.run.path)}
            {@const px = x(point.value)}
            {@const py = cy + point.offset}
            {@const shown = point.run === selected}
            <a
              href={questionHref(question.key, point.run.result?.runId)}
              tabindex="-1"
              aria-label="{row.arm}, {score(point.value)}, run of {point.run.result ? stamp(point.run.result.reportedAt) : ''}"
              onpointerenter={() => (tip = { x: px, y: py, value: point.value, when: point.run.result ? stamp(point.run.result.reportedAt) : "" })}
              onpointerleave={() => (tip = null)}
            >
              <circle class="hit" cx={px} cy={py} r="11" />
              {#if shown}<circle class="ring" cx={px} cy={py} r={DOT + 3} />{/if}
              <circle class="dot" cx={px} cy={py} r={DOT} />
            </a>
          {/each}
        </g>
      {/each}
    </svg>
    {#if tip}
      <div class="tip surface" style="left: {tip.x}px; top: {tip.y}px" aria-hidden="true">
        <strong>{score(tip.value)}</strong>
        <span class="t-meta">{tip.when}</span>
      </div>
    {/if}
  {:else if values.length === 0}
    <p class="t-meta">No run in this series was judged, so there are no scores to plot.</p>
  {/if}
</figure>

<style>
  .plot { position: relative; min-width: 0; }
  svg { display: block; overflow: visible; font: var(--text-meta); }
  .grid { stroke: var(--hairline); stroke-width: 1; }
  .rule { stroke: var(--hairline); stroke-width: 1; }
  .tick { fill: var(--faint); font-size: 12px; }
  .axis-title { fill: var(--muted); font-size: 12px; }
  .arm { fill: var(--muted); }
  .lead .arm { fill: var(--ink); font-weight: 600; }
  .mean { stroke: var(--muted); stroke-width: 2; stroke-linecap: round; }
  .lead .mean { stroke: var(--ink); }
  /* A 2px ring in the ground keeps overlapping dots apart. */
  .dot { fill: var(--faint); stroke: var(--bg); stroke-width: 2; }
  .lead .dot { fill: var(--ink); }
  .ring { fill: none; stroke: var(--ink); stroke-width: 2; }
  .hit { fill: transparent; }
  a { cursor: pointer; }
  a:hover .dot { stroke: var(--ink); stroke-width: 1.5; }

  .tip {
    position: absolute;
    transform: translate(-50%, calc(-100% - 12px));
    display: grid;
    gap: 0;
    padding: var(--s-1) var(--s-2);
    border-radius: var(--radius-small);
    border-color: var(--hairline-strong);
    box-shadow: var(--shadow-dialog);
    white-space: nowrap;
    pointer-events: none;
    font: var(--text-meta);
  }
</style>
