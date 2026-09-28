import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, newPage, ready, TEST_MS, elsewhere } from "./support/dashboard.js";

test("an output page runs its own scripts in an opaque origin, reads only its own entry, and can send nothing away", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const away = await elsewhere(t);
  const { archiveRoot, url, files } = await fixture(t, { hostile: away.url });
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

test("a capture opens its arm's page live: keys reach the page, arms switch on the same page, Escape closes, and the page reaches nothing", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const away = await elsewhere(t);
  const { url } = await fixture(t, { decks: true, away: away.url });
  const page = await newPage(t);
  const viewer = page.locator("dialog.viewer");
  const frame = (arm: string) => page.frameLocator(`dialog.viewer iframe[src*="/outputs/${arm}/"]`);
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
  assert.equal(await frame("b").locator("title").textContent(), "blocked", "its report home was refused, and the viewer said so");
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

test("live, synced decks turn together: from the page's arrows, and from an arrow pressed in one of them", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t, { decks: true });
  const page = await newPage(t);
  const frame = (arm: string) => page.frameLocator(`.compare iframe[src*="/outputs/${arm}/"]`);
  const slide = (arm: string, text: string) => frame(arm).getByText(text, { exact: true }).waitFor();
  await page.goto(`${url}#/q/ab-00000002/ab-00000002`);
  await page.getByRole("button", { name: "Live page", exact: true }).click();
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
