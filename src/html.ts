import { describeCost } from "./cost.js";
import type { PageShot, RunResult } from "./types.js";
import { isJudged, topScorer } from "./verdict.js";

export interface ReportHtmlInput {
  result: RunResult;
  /** The judge's verdict.md, rendered in full below the structured summary; null when the run was not judged. */
  verdict: string | null;
  setup: string[];
  integrity: string[];
}

/** Said wherever the runner's own pictures are shown, since it opened the pages as files. */
export const RUNNER_CAPTURE_NOTE = "These pictures were taken by the runner from each arm's files served as a static site. A page that needs a build or its own server first does not look here the way it would when running.";

/** Said by every form of the report of a run with no judge, so they cannot disagree. */
export const NOT_JUDGED_NOTE = "This run was not judged: its experiment set judge: none. There is no winner, no score, and no ranking, only what each arm produced and what it cost.";

/**
 * One self-contained page per run: the verdict at a glance, the score table,
 * the arms' pages side by side, then the judge's full prose. Images are
 * referenced by the relative paths the shot index records, so the file works
 * in the run directory and in an archive alike.
 */
export function renderReportHtml({ result, verdict, setup, integrity }: ReportHtmlInput): string {
  const labels = result.arms.map((arm) => arm.label);
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  const judged = isJudged(result);
  const headline = describeOutcome(result);
  const guess = !judged
    ? ""
    : result.arms.length < 2
      ? "One arm ran alone, so the judge scored it against the rubric rather than picking a winner."
      : result.referenceGuess.arm === null
        ? "The judge could not tell which output was the control arm."
        : `The judge took ${result.referenceGuess.arm} for the control arm at ${percent(result.referenceGuess.confidence)} confidence — ${result.referenceGuess.correct ? "correct" : "wrong"}.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(result.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <p class="eyebrow">A/B test · <code>${escape(result.runId)}</code> · ${escape(result.reportedAt.slice(0, 10))}${result.series ? ` · series ${escape(result.series)}` : ""}</p>
  <h1>${escape(result.name)}</h1>
  <p class="task">${escape(result.task)}</p>
</header>

<section class="verdict">
  <h2>${escape(headline)}</h2>
  ${judged ? `<p class="totals">
    ${labels.map((label) => `<span${result.winner === label ? ' class="winner"' : ""}>${escape(label)} <b>${result.totals[label]!.toFixed(2)}</b></span>`).join("\n    ")}
    <span class="confidence">judge confidence ${percent(result.confidence)}</span>
  </p>
  ${result.summary ? `<p class="summary">${escape(result.summary)}</p>` : ""}` : `<p class="summary">${escape(NOT_JUDGED_NOTE)}</p>`}
</section>

${judged ? `<section>
  <h2>Scores</h2>
  <table>
    <thead><tr><th>Criterion</th><th class="num">Weight</th>${labels.map((label) => `<th class="num">${escape(label)}</th>`).join("")}</tr></thead>
    <tbody>
      ${result.scores.map((score) => `<tr><td>${escape(score.criterion)}</td><td class="num">${score.weight}</td>${labels.map((label) => `<td class="num">${score.scores[label]}</td>`).join("")}</tr>`).join("\n      ")}
    </tbody>
    <tfoot><tr><td>Weighted total</td><td></td>${labels.map((label) => `<td class="num">${result.totals[label]!.toFixed(2)}</td>`).join("")}</tr></tfoot>
  </table>
</section>` : ""}

${renderShots(result)}

<section>
  <h2>Setup</h2>
  <ul>
    ${setup.map((line) => `<li>${inline(line)}</li>`).join("\n    ")}
    ${labels.map((label) => `<li>${escape(label)}: ${escape(describeCost(result.cost[label] ?? null))}</li>`).join("\n    ")}
  </ul>
  ${guess ? `<p>${escape(guess)}</p>` : ""}
</section>

${verdict === null ? "" : `<section class="prose">
  <h2>Judge's verdict</h2>
  ${renderMarkdown(verdict)}
</section>`}

<section>
  <h2>Integrity</h2>
  <ul>
    ${integrity.map((line) => `<li>${inline(line)}</li>`).join("\n    ")}
  </ul>
</section>
</body>
</html>
`;
}

/**
 * The verdict in a phrase, used by every form of the report so they cannot
 * disagree. An unjudged run has no outcome to describe, only outputs. A negative
 * margin means the judge named an arm that did not score highest; the phrase
 * says so rather than reading "won by -0.30". A null margin is a single arm
 * scored against the rubric, with nothing to win against.
 */
export function describeOutcome(result: RunResult): string {
  if (!isJudged(result)) return "Not judged";
  if (result.margin === null) {
    const total = result.totals[result.winner];
    return total === undefined ? "Scored alone" : `${result.winner} scored ${total.toFixed(2)}`;
  }
  if (result.winner === "tie") return "Tie";
  if (result.margin >= 0) return `${result.winner} won by ${result.margin.toFixed(2)}`;
  return `${result.winner} won on the judge's call, ${Math.abs(result.margin).toFixed(2)} behind ${topScorer(result.totals, result.winner)}`;
}

function renderShots(result: RunResult): string {
  const { shots } = result;
  if (!shots) return "";
  if (shots.skipped) return `<section><h2>Pages</h2><p class="note">${escape(shots.skipped)}</p></section>`;
  const labels = result.arms.map((arm) => arm.label);
  const pages = [...new Set(labels.flatMap((label) => (shots.arms[label] ?? []).map((shot) => shot.page)))];
  const byPage = (label: string, page: string) => (shots.arms[label] ?? []).find((shot) => shot.page === page);
  const omitted = labels
    .filter((label) => (shots.omitted[label] ?? []).length > 0)
    .map((label) => `${label} also changed ${shots.omitted[label]!.map((page) => `<code>${escape(page)}</code>`).join(", ")}, not pictured.`);
  const renderedFrom = (page: string) => labels.some((label) => byPage(label, page)?.rendered === "markdown")
    ? " — rendered from Markdown by the runner"
    : "";
  return `<section class="pages">
  <h2>Pages</h2>
  ${shots.capturedBy === "runner" ? `<p class="note">${escape(RUNNER_CAPTURE_NOTE)}</p>` : ""}
  ${pages.map((page) => `<figure>
    <figcaption><code>${escape(page)}</code>${escape(renderedFrom(page))}</figcaption>
    <div class="panels">
      ${labels.map((label) => renderShot(label, byPage(label, page))).join("\n      ")}
    </div>
  </figure>`).join("\n  ")}
  ${omitted.length > 0 ? `<p class="note">${omitted.join(" ")}</p>` : ""}
</section>`;
}

function renderShot(label: string, shot: PageShot | undefined): string {
  if (!shot) return `<div class="arm"><h3>${escape(label)}</h3><p class="note">Not produced by this arm.</p></div>`;
  const image = (path: string | null, kind: string) => path
    ? `<a href="${escape(path)}" class="${kind}"><img src="${escape(path)}" alt="${escape(`${label}, ${shot.page}, ${kind}`)}" loading="lazy"></a>`
    : `<p class="note">${kind} capture failed${shot.error ? `: ${escape(shot.error)}` : ""}.</p>`;
  return `<div class="arm">
        <h3>${escape(label)}</h3>
        ${image(shot.desktop, "desktop")}
        ${image(shot.phone, "phone")}
      </div>`;
}

/**
 * Enough Markdown for a judge's verdict: headings, paragraphs, lists, pipe
 * tables, fenced code, block quotes, and inline emphasis, code and links.
 * Anything else is a paragraph, which is what it would have been anyway.
 */
export function renderMarkdown(markdown: string, headingShift = 1): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") { index += 1; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { html.push("<hr>"); index += 1; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) code.push(lines[index]!), index += 1;
      index += 1;
      html.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // The verdict sits under the report's own h2, so its headings step down
      // one level; a standalone document keeps its own.
      const level = Math.min(heading[1]!.length + headingShift, 6);
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[] = [];
      while (index < lines.length && lines[index]!.startsWith("|")) rows.push(lines[index]!), index += 1;
      html.push(renderTable(rows));
      continue;
    }
    const list = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[index]!);
        if (item) { items.push(item[3]!); index += 1; continue; }
        // A wrapped list item continues on an indented line.
        if (items.length > 0 && /^\s+\S/.test(lines[index]!)) { items[items.length - 1] += ` ${lines[index]!.trim()}`; index += 1; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index]!.startsWith(">")) quote.push(lines[index]!.replace(/^>\s?/, "")), index += 1;
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"), headingShift)}</blockquote>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "" && !/^(#{1,6}\s|```|\||\s*([-*]|\d+\.)\s|>|-{3,}\s*$)/.test(lines[index]!)) paragraph.push(lines[index]!.trim()), index += 1;
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return html.join("\n");
}

function renderTable(rows: string[]): string {
  const cells = (row: string) => row.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
  const isRule = (row: string) => /^\|?\s*:?-{2,}/.test(row) && cells(row).every((cell) => /^:?-+:?$/.test(cell));
  const [head, ...rest] = rows;
  const body = rest.filter((row) => !isRule(row));
  const numeric = (cell: string) => /^-?[\d.]+%?$/.test(cell);
  const render = (row: string, tag: "th" | "td") => `<tr>${cells(row).map((cell) => `<${tag}${numeric(cell) ? ' class="num"' : ""}>${inline(cell)}</${tag}>`).join("")}</tr>`;
  return `<table><thead>${render(head!, "th")}</thead><tbody>${body.map((row) => render(row, "td")).join("")}</tbody></table>`;
}

/** Inline Markdown on already-escaped text: bold, emphasis, code, links. */
function inline(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_link, label: string, href: string) => safeHref(href) ? `<a href="${href}">${label}</a>` : label);
}

/**
 * Link targets come from agents' prose: web and mail links, relative paths,
 * and anchors only, never javascript: or data:. Browsers drop control
 * characters before reading a scheme, so this does too.
 */
function safeHref(href: string): boolean {
  const target = href.replace(/[\u0000-\u0020]/g, "");
  return /^(https?|mailto):/i.test(target) || !/^[a-z][a-z0-9+.-]*:/i.test(target);
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const STYLE = `
  :root { color-scheme: light; --ink: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --ground: #fff; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; padding: 48px 32px 96px; max-width: 1120px; color: var(--ink); background: var(--ground); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header, section { margin-bottom: 48px; }
  h1 { font-size: 30px; line-height: 1.2; letter-spacing: -0.01em; margin: 8px 0 12px; max-width: 32ch; }
  h2 { font-size: 20px; line-height: 1.25; margin: 0 0 16px; }
  h3 { font-size: 14px; margin: 0 0 8px; color: var(--muted); font-weight: 600; }
  .prose h3, .prose h4, .prose h5, .prose h6 { color: var(--ink); font-size: 16px; margin: 28px 0 8px; }
  p, li { max-width: 72ch; }
  .eyebrow, .note, .task, figcaption { color: var(--muted); }
  .eyebrow { font-size: 13px; margin: 0; }
  .task { margin: 0; }
  code { font: 13px ui-monospace, "SF Mono", Menlo, monospace; }
  pre { padding: 12px 16px; border: 1px solid var(--line); border-radius: 6px; overflow: auto; }
  .verdict h2 { font-size: 26px; }
  .totals { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; margin: 0 0 12px; max-width: none; }
  .totals b { font-variant-numeric: tabular-nums; }
  .totals .winner { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 6px; }
  .totals .confidence { color: var(--muted); }
  .summary { font-size: 17px; }
  table { border-collapse: collapse; width: 100%; max-width: 72ch; font-variant-numeric: tabular-nums; }
  th, td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 13px; }
  tfoot td { font-weight: 600; border-bottom: none; }
  .num { text-align: right; }
  .prose table { width: auto; max-width: 100%; }
  figure { margin: 0 0 40px; }
  figcaption { margin-bottom: 12px; }
  /* Panels keep a readable width and wrap into rows, so six arms stay legible instead of shrinking to thumbnails. */
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px; }
  .arm img { display: block; width: 100%; border: 1px solid var(--line); border-radius: 4px; }
  .arm a { display: block; }
  .arm .phone { width: 34%; margin-top: 16px; }
  .arm .desktop img { max-height: 900px; object-fit: cover; object-position: top; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; max-width: 72ch; }
  blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 2px solid var(--line); color: var(--muted); }
  ul, ol { padding-left: 24px; }
  a { color: inherit; }
  @media (max-width: 720px) { body { padding: 24px 16px 64px; } .panels { grid-template-columns: 1fr; } }
`;
