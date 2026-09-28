import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, newPage, ready, TEST_MS } from "./support/dashboard.js";

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
  await page.addInitScript(() => {
    const json = Response.prototype.json;
    Response.prototype.json = async function () {
      const snapshot = await json.call(this);
      if (snapshot.experiments?.questions.some((question: { key: string }) => question.key === "ghost")) {
        // The next task runs after the application's JSON promise continuations.
        setTimeout(() => document.documentElement.dataset.staleProcessed = "true", 0);
      }
      return snapshot;
    };
  });
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
  await page.waitForFunction(() => document.documentElement.dataset.staleProcessed === "true");
  assert.equal(calls, 2);
  assert.equal(await page.getByText("Ghost question").count(), 0);
});

test("the list pages from controls above it and keeps its page in the address", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, { extra: 23 });
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

test("the table filters, sorts from its headers, and keeps both in the address", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, { series: true, wide: true });
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
  const { url } = await fixture(t, { extra: 23 });
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
  const { url } = await fixture(t, { series: true });
  const page = await newPage(t);
  await page.goto(`${url}#/q/the-series`);
  const plot = page.getByRole("img", { name: /^Score by arm across 3 runs/ });
  await plot.waitFor();
  assert.match(await plot.getAttribute("aria-label") ?? "", /a: mean 7\.60; b: mean 8\.50, leading/);
  assert.equal(await plot.locator("circle.dot").count(), 6, "a dot per run per arm");
  assert.equal(await plot.locator("circle.ring").count(), 2, "the run shown is ringed in each arm");
  assert.equal(await plot.locator("line.mean").count(), 2);
  assert.equal(await page.locator("tr.total td").first().textContent(), "Mean");

  // j steps to the next run, in place.
  const shown = () => page.locator("tr.current a.pick").textContent();
  const first = await shown();
  await page.keyboard.press("j");
  await page.waitForFunction((before) => document.querySelector("tr.current a.pick")?.textContent !== before, first);
  assert.notEqual(await shown(), first);
});

test("seven arms scroll sideways under pinned headers, four at a time", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, { wide: true });
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
  assert.equal(await page.locator("table.best tr.total td.lead").textContent(), "7.80");
  assert.equal(await page.locator("table.best tr.delta td").last().textContent(), "+1.80");
});

test("the date filter keeps rows by their newest run, combines with search, lives in the address, and clears", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, { extra: 23, series: true, wide: true });
  const page = await newPage(t);
  await page.clock.setFixedTime(new Date("2026-09-27T12:00:00Z"));
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
  const { url } = await fixture(t, { extra: 23 });
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
  const { archiveRoot, runsRoot, url } = await fixture(t, { busy: true });
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
