import assert from "node:assert/strict";
import test from "node:test";
import { fixture, newPage, ready, TEST_MS } from "./support/dashboard.js";

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

test("primary actions share ink styling and keyboard focus is visible and neutral", { skip: !ready, timeout: TEST_MS }, async (t) => {
  const { url } = await fixture(t);
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await newPage(t, { colorScheme });
    await page.goto(url);
    await page.locator("table.results .title", { hasText: "Question pages-copy" }).click();
    const report = page.getByRole("link", { name: "Open report" });
    await report.waitFor();
    const style = (element: Element) => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, color: css.color };
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

    // A click shows no ring; the keyboard does, in a neutral tone.
    await page.goto(url);
    const search = page.getByLabel("Search results");
    await search.click();
    assert.equal(await search.evaluate((input) => getComputedStyle(input).outlineStyle), "none");
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const css = getComputedStyle(document.activeElement!);
      return {
        visible: !["none", "hidden"].includes(css.outlineStyle) && Number.parseFloat(css.outlineWidth) > 0,
        color: css.outlineColor,
      };
    });
    const muted = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.color = "var(--muted)";
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    assert.deepEqual(ring, { visible: true, color: muted }, colorScheme);
  }
});
