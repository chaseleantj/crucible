<script lang="ts">
  let { archiveRoot, runsRoot }: { archiveRoot: string; runsRoot: string } = $props();
</script>

<section class="state-page" aria-labelledby="empty-title">
  <h1 id="empty-title" class="t-page">No tests yet</h1>
  <p class="t-body lede">
    Crucible gives the same task to two or more agent setups, then a blind judge scores what each one made.
    Running tests and their results show up here as soon as they start.
  </p>

  <ol class="steps">
    <li>
      <span class="t-heading">Write an experiment</span>
      <code class="command">crucible init</code>
      <span class="t-meta">Writes experiment.yaml. Set its task, arms and judge.</span>
    </li>
    <li>
      <span class="t-heading">Run it</span>
      <code class="command">crucible run experiment.yaml</code>
      <span class="t-meta">Produces, judges, reports and archives in one go. Keep this page open to watch it.</span>
    </li>
  </ol>

  <dl class="t-meta roots">
    <div><dt>Results folder</dt><dd class="code">{archiveRoot}</dd></div>
    <div><dt>Runs folder</dt><dd class="code">{runsRoot}</dd></div>
  </dl>
</section>

<style>
  .steps { list-style: none; margin-top: var(--s-5); display: grid; gap: var(--s-5); counter-reset: step; }
  .steps li {
    display: grid;
    gap: var(--s-2);
    padding-left: var(--s-6);
    position: relative;
    counter-increment: step;
  }
  /* The step's number, on a key's size and type. */
  .steps li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 0;
    display: grid;
    place-items: center;
    width: var(--chip);
    height: var(--chip);
    border-radius: 50%;
    border: 1px solid var(--hairline-strong);
    font: var(--text-label);
    color: var(--muted);
  }
  .roots { margin-top: var(--s-6); display: grid; gap: var(--s-1); }
  .roots div { display: flex; gap: var(--s-3); flex-wrap: wrap; }
  .roots dt { width: 112px; }
  .roots dd { color: var(--muted); overflow-wrap: anywhere; }
</style>
