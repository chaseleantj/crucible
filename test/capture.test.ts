import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { archiveRun } from "../src/archive.js";
import { captureRun } from "../src/capture.js";
import { reportRun } from "../src/report.js";
import { chromiumMissing } from "./support/browser.js";
import { prepareUnjudged } from "./support/unjudged.js";

test("the runner's capture pictures each arm's changed pages", { skip: chromiumMissing() }, async (t) => {
  const { run } = await prepareUnjudged(t, {
    "index.html": "<!doctype html><title>Arm</title><h1>An arm's page</h1>\n",
    "about.html": "<!doctype html><title>About</title><p>Second page</p>\n",
    "NOTES.txt": "Notes\n",
  });
  const index = await captureRun(run);
  assert.equal(index.skipped, undefined);
  assert.equal(index.capturedBy, "runner");
  for (const label of ["plain", "fancy"]) {
    const shots = index.arms[label]!;
    assert.deepEqual(shots.map((shot) => shot.page), ["about.html", "index.html"]);
    const page = shots.find((shot) => shot.page === "index.html")!;
    assert.equal(page.artifact, "index.html");
    assert.equal(page.desktop, `shots/${label}/02-index-desktop.png`);
    assert.equal(page.phone, `shots/${label}/02-index-phone.png`);
    assert.equal(page.error, undefined);
    assert.ok((await readFile(join(run.runDir, page.desktop!))).length > 0);
    assert.deepEqual(index.omitted[label], ["NOTES.txt"]);
  }
});

test("SVG and Markdown get captures and remain archived beyond the four-page capture limit", { skip: chromiumMissing() }, async (t) => {
  const outputs = {
    "01-icon.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="30" fill="teal"/></svg>',
    "02-notes.md": "# Useful notes\n\n| Check | Result |\n| --- | --- |\n| Build | Passed |\n",
    "03-guide.markdown": "# A guide\n\nReadable prose.",
    "04-more.md": "# More\n",
    "05-last.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="orange"/></svg>',
  };
  const { run, paths } = await prepareUnjudged(t, outputs, "[{label: solo}]");
  const index = await captureRun(run);
  assert.equal(index.skipped, undefined);
  assert.equal(index.arms.solo?.length, 4);
  assert.deepEqual(index.omitted.solo, ["05-last.svg"]);
  for (const shot of index.arms.solo!) {
    assert.equal(shot.error, undefined);
    assert.ok(shot.desktop && shot.phone);
    assert.ok((await readFile(join(run.runDir, shot.desktop))).length > 1000);
    if (/\.md|\.markdown/.test(shot.page)) assert.equal(shot.rendered, "markdown");
  }
  await reportRun(run);
  const destination = await archiveRun(run, paths.archiveRoot);
  for (const [file, source] of Object.entries(outputs)) {
    assert.equal(await readFile(join(destination, "outputs", "solo", file), "utf8"), source);
  }
});

test("a capture pictures the arm that changed a page and says the other changed none", { skip: chromiumMissing() }, async (t) => {
  const { run } = await prepareUnjudged(t, (label) => (label === "plain"
    ? { "NOTES.txt": "Notes only\n" }
    : { "index.html": "<!doctype html><title>Fancy</title><h1>A page</h1>\n" }));
  const index = await captureRun(run);
  assert.equal(index.skipped, undefined);
  assert.deepEqual(index.arms.fancy!.map((shot) => shot.page), ["index.html"]);
  assert.deepEqual(index.arms.plain, []);
  assert.deepEqual(index.omitted.plain, ["NOTES.txt"]);
  assert.deepEqual(index.omitted.fancy, []);

  await reportRun(run);
  const markdown = await readFile(join(run.runDir, "report.md"), "utf8");
  assert.match(markdown, /fancy, `index.html`/);
  assert.match(markdown, /plain: nothing pictured/);
});
