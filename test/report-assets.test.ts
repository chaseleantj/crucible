import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveReportAssets, publishReportAssets, reportEvidence } from "../src/report-assets.js";

test("judge evidence survives cleanup and archives only the files its verdict references", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-report-assets-"));
  try {
    const run = join(root, "run");
    const judge = join(root, "temporary-judge");
    await mkdir(join(run, "judge"), { recursive: true });
    await mkdir(join(judge, "shots", "A"), { recursive: true });
    await mkdir(join(judge, "review"));
    await writeFile(join(judge, "shots", "A", "slide.png"), "exact screenshot bytes");
    await writeFile(join(judge, "review", "checks.json"), '{"overflow":false}');
    await writeFile(join(judge, "review", "unreferenced.txt"), "do not archive");
    const verdict = "Score 8.85.\n![slide](./shots/A/slide.png)\n[Checks](review/checks.json#result)\n[External](https://example.com)\n";
    await writeFile(join(run, "judge", "verdict.md"), verdict);
    await publishReportAssets(run, judge);
    await rm(judge, { recursive: true });
    const evidence = await reportEvidence(run, verdict);
    assert.deepEqual(evidence.warnings, []);
    assert.match(evidence.text, /^Score 8.85/);
    assert.match(evidence.text, /review-assets\/[a-f0-9]+\.png/);
    assert.match(evidence.text, /\.json#result/);
    assert.ok(evidence.text.includes("https://example.com"));
    assert.equal(await readFile(join(run, "judge", "verdict.md"), "utf8"), verdict);
    const destination = join(root, "archive");
    const replacements = await archiveReportAssets(run, destination);
    let archived = evidence.text;
    for (const [source, target] of replacements) archived = archived.replaceAll(source, target);
    assert.match(archived, /dependencies\/review-assets\//);
    assert.equal((await readdir(join(destination, "dependencies", "review-assets"))).length, 2);
    for (const [source, target] of replacements) {
      assert.deepEqual(await readFile(join(run, source)), await readFile(join(destination, target)));
    }
    const missing = replacements.keys().next().value!;
    await rm(join(run, missing));
    await assert.rejects(archiveReportAssets(run, join(root, "second-archive")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing, private, traversal, and escaping symlink evidence becomes explicit unavailability", async () => {
  const root = await mkdtemp(join(tmpdir(), "crucible-report-assets-"));
  try {
    const run = join(root, "run");
    const judge = join(root, "judge");
    await mkdir(join(run, "judge"), { recursive: true });
    await mkdir(join(judge, "review"), { recursive: true });
    await mkdir(join(judge, "input"));
    await writeFile(join(root, "secret.txt"), "private");
    await writeFile(join(judge, "input", "source.txt"), "input");
    await symlink(join(root, "secret.txt"), join(judge, "review", "escape.txt"));
    await mkdir(join(judge, ".runtime"));
    await writeFile(join(judge, ".runtime", "private.txt"), "runtime");
    await symlink(join(judge, "input", "source.txt"), join(judge, "review", "input-link.txt"));
    await symlink(join(judge, ".runtime", "private.txt"), join(judge, "review", "runtime-link.txt"));
    const refs = ["review/input-link.txt", "review/runtime-link.txt", "review/missing.png", "review/escape.txt", "../secret.txt", "%2e%2e/secret.txt", "input/source.txt"];
    const verdict = refs.map((ref) => `[evidence](${ref})`).join("\n");
    await writeFile(join(run, "judge", "verdict.md"), verdict);
    await publishReportAssets(run, judge);
    const evidence = await reportEvidence(run, verdict);
    assert.equal(evidence.warnings.length, refs.length);
    assert.equal(evidence.text, refs.map(() => "evidence (evidence unavailable)").join("\n"));
    assert.equal((await archiveReportAssets(run, join(root, "archive"))).size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
