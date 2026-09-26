<script lang="ts">
  import { ago, duration, exact, plural } from "../lib/format";
  import { agentStatus, agentsOf, phaseSteps, runTone } from "../lib/runs";
  import type { LiveAgent, LiveRun } from "../lib/types";

  let { run, now }: { run: LiveRun; now: number } = $props();

  const agents = $derived(agentsOf(run));
  const steps = $derived(phaseSteps(run));
  const tone = $derived(runTone(run));
</script>

<article class="surface card" aria-label={run.name}>
  <header class="head">
    <div class="title">
      <h3 class="t-heading">{run.name}</h3>
      <p class="t-meta">
        {#if tone === "danger"}<span class="tone-danger">Needs attention</span> · {:else if tone === "warn"}<span class="tone-warn">Slow</span> · {/if}
        <span title={run.labels.join(", ")}>{plural(run.labels.length, "arm")}</span> · {run.runId} · started <span title={exact(run.startedAt)}>{ago(run.startedAt, now)}</span>
      </p>
    </div>
    <ol class="steps" aria-label="Progress: {run.phase}">
      {#each steps as step (step.label)}
        <li class={step.state} aria-current={step.state === "current" || step.state === "waiting" ? "step" : undefined}>
          <span class="marker" aria-hidden="true"></span>
          <span class="t-meta">{step.label}{#if step.state === "waiting"}<span class="sr-only">, waiting</span>{:else if step.state === "done"}<span class="sr-only">, done</span>{/if}</span>
        </li>
      {/each}
    </ol>
  </header>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th class="num">Time</th>
          <th class="num">Tool calls</th>
          <th class="num">Last activity</th>
        </tr>
      </thead>
      <tbody>
        {#each agents as { label, agent } (label)}
          {@render agentRow(label, agent)}
        {/each}
        {#if !run.judge && run.state === "produced"}
          <tr><td class="agent">Judge</td><td colspan="4" class="t-meta">Waiting for the judge to start</td></tr>
        {/if}
      </tbody>
    </table>
  </div>
</article>

{#snippet agentRow(label: string, agent: LiveAgent)}
  {@const status = agentStatus(agent)}
  <tr>
    <td class="agent">{label}</td>
    <td>
      <span class="status tone-{status.tone}">
        <span class="dot" class:pulse={status.tone === "ok"} aria-hidden="true"></span>
        <span class="clip" title={status.text}>{status.text}</span>
      </span>
    </td>
    <td class="num">{agent.elapsedMs === null ? "—" : duration(agent.elapsedMs)}</td>
    <td class="num">{agent.state === "ready" ? "—" : agent.toolCalls}</td>
    <td class="num">
      {#if agent.lastActivityAt}<span title={exact(agent.lastActivityAt)}>{ago(agent.lastActivityAt, now)}</span>{:else}—{/if}
    </td>
  </tr>
{/snippet}

<style>
  .card { padding: var(--s-4) var(--s-4) var(--s-2); min-width: 0; }
  .head { display: flex; align-items: flex-start; gap: var(--s-5); margin-bottom: var(--s-3); }
  .title { flex: 1; min-width: 0; display: grid; gap: 2px; }

  /* Produce, judge, report: done steps filled, the current one in ink, the rest hollow. */
  .steps { list-style: none; display: flex; align-items: center; flex: none; padding-top: 2px; }
  .steps li { display: flex; align-items: center; gap: var(--s-2); }
  .steps li + li::before {
    content: "";
    width: 32px;
    height: 1px;
    margin: 0 var(--s-1);
    background: var(--hairline-strong);
  }
  .marker { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--faint); flex: none; }
  .done .marker { background: var(--faint); }
  .current .marker { background: var(--ink); border-color: var(--ink); }
  .waiting .marker { border-color: var(--ink); }
  .current .t-meta, .waiting .t-meta { color: var(--ink); font-weight: 600; }

  td { vertical-align: middle; }
  .agent { width: 112px; color: var(--muted); }
  .status { display: inline-flex; align-items: center; gap: var(--s-2); min-width: 0; max-width: 100%; }
  .status.tone-done { color: var(--muted); }
  th:nth-child(3), td:nth-child(3) { width: 72px; }
  th:nth-child(4), td:nth-child(4) { width: 96px; }
  th:nth-child(5), td:nth-child(5) { width: 112px; }
  @media (max-width: 720px) {
    .head { flex-direction: column; gap: var(--s-3); }
  }
  /* Narrow: every column stays; the numbers tighten and the table scrolls if it must. */
  @media (max-width: 520px) {
    .agent { width: auto; white-space: nowrap; }
    th:nth-child(n + 3), td:nth-child(n + 3) { width: auto; }
    .steps li + li::before { width: 20px; }
  }
</style>
