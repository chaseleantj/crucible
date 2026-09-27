import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { writeJson } from "../src/json.js";
import { publishShots, readShotIndex } from "../src/shots.js";
import { prepareFixture } from "./support/run.js";

test("the judge's pictures are published under the arm labels, and what it could not picture is said", async (t) => {
  const { run, root } = await prepareFixture(t);
  const [first, second] = Object.keys(run.assignment.arms) as [string, string];
  const mapping = { A: second, B: first };
  const judgeDir = join(root, "judge");
  for (const letter of ["A", "B"]) await mkdir(join(judgeDir, "shots", letter), { recursive: true });
  await writeFile(join(judgeDir, "shots", "A", "01-index-desktop.png"), "A desktop\n");
  await writeFile(join(judgeDir, "shots", "A", "01-index-phone.png"), "A phone\n");
  await writeFile(join(judgeDir, "shots", "B", "index-desktop.png"), "B desktop\n");
  await writeFile(join(root, "elsewhere.png"), "not the judge's\n");
  await mkdir(join(run.runDir, "shots"), { recursive: true });
  await writeFile(join(run.runDir, "shots", "stale.png"), "from an earlier judging\n");
  await writeJson(join(judgeDir, "shots", "index.json"), {
    arms: {
      A: [{ page: "index.html", desktop: "shots/A/01-index-desktop.png", phone: "shots/A/01-index-phone.png" }],
      B: [
        { page: "index.html", desktop: "shots/B/index-desktop.png", phone: null, error: "phone: the page never finished loading" },
        { page: "NOTES.md", desktop: "../elsewhere.png", phone: "shots/B/gone.png", rendered: "markdown" },
      ],
    },
    omitted: { A: [], B: ["about.html"] },
  });

  const index = await publishShots(run, judgeDir, mapping);
  assert.equal(index.skipped, undefined);
  const [firstLabel, secondLabel] = [run.assignment.arms[first]!, run.assignment.arms[second]!];
  // A's pictures land under the arm it stood for, renamed the runner's way.
  assert.deepEqual(index.arms[secondLabel], [{ page: "index.html", desktop: `shots/${secondLabel}/01-index-desktop.png`, phone: `shots/${secondLabel}/01-index-phone.png` }]);
  assert.equal(await readFile(join(run.runDir, `shots/${secondLabel}/01-index-desktop.png`), "utf8"), "A desktop\n");
  // The judge's own error is kept; a picture outside its folder or missing is named, not copied.
  const [page, notes] = index.arms[firstLabel]!;
  assert.deepEqual(page, { page: "index.html", desktop: `shots/${firstLabel}/01-index-desktop.png`, phone: null, error: "phone: the page never finished loading" });
  assert.equal(notes?.rendered, "markdown");
  assert.equal(notes?.desktop, null);
  assert.equal(notes?.phone, null);
  assert.match(notes?.error ?? "", /outside shots\/B.*gone\.png is missing/);
  assert.deepEqual(index.omitted[firstLabel], ["about.html"]);
  assert.deepEqual(await readShotIndex(run.runDir), index);
  await assert.rejects(stat(join(run.runDir, "shots", "stale.png")), /ENOENT/);
});

test("a judge that wrote no pictures leaves a reason, not a failure", async (t) => {
  const { run, root } = await prepareFixture(t);
  const [first, second] = Object.keys(run.assignment.arms) as [string, string];
  const judgeDir = join(root, "judge");
  await mkdir(judgeDir, { recursive: true });
  assert.equal((await publishShots(run, judgeDir, { A: first, B: second })).skipped, "The judge wrote no screenshot index");
  await writeJson(join(judgeDir, "shots", "index.json"), { arms: { A: [], B: [] }, omitted: { A: [], B: [] } });
  assert.equal((await publishShots(run, judgeDir, { A: first, B: second })).skipped, "The judge pictured no pages");
});
