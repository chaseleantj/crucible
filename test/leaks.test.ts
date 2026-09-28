import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sha256File } from "../src/files.js";
import { collectForbiddenHashes, matchesIdentity, omitSkillPathEchoes, scanFiles } from "../src/leaks.js";
import type { ForbiddenIdentity } from "../src/types.js";
import { tempDirectory } from "./support/files.js";

test("leak matching flags the distinctive identity, not raw slug terms", () => {
  const candidate: ForbiddenIdentity = { label: "candidate slug", value: "peak-canvas", kind: "identifier" };
  assert.equal(matchesIdentity("A WebGL project using three.js", candidate), false);
  assert.equal(matchesIdentity("Load peak-canvas for this work", candidate), true);
  assert.equal(matchesIdentity("not-peak-canvas-extra", candidate), false);
});

test("judge copies drop skill-folder path echoes and keep prose leaks", async (t) => {
  const root = await tempDirectory(t);
  const identities: ForbiddenIdentity[] = [{ label: "candidate slug", value: "peak-canvas", kind: "identifier" }];
  await mkdir(join(root, "captures"), { recursive: true });
  await writeFile(join(root, "index.html"), "<canvas></canvas>\n");
  await writeFile(join(root, "verify.mjs"), "import { helper } from '../.context/skills/peak-canvas/scripts/lib.mjs';\n");
  await writeFile(join(root, "README.md"), "This used the peak-canvas skill.\n");
  const removed = await omitSkillPathEchoes(root, identities);
  assert.deepEqual(removed, ["verify.mjs"]);
  const findings = await scanFiles(root, ["README.md", "index.html"], identities, new Set());
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.path, "README.md");
});

test("a candidate dependency that is a single file is hashed like a folder of them", async (t) => {
  const root = await tempDirectory(t);
  const candidate = join(root, "tone-skill");
  await mkdir(join(root, "crafts"), { recursive: true });
  await mkdir(candidate, { recursive: true });
  await writeFile(join(candidate, "SKILL.md"), "---\nname: tone-skill\ndescription: d\n---\n\n# Tone\n");
  const craft = join(root, "crafts", "writing.md");
  await writeFile(craft, "Write plainly.\n");
  const hashes = await collectForbiddenHashes(candidate, [craft]);
  assert.ok(hashes.has(await sha256File(craft)), "a file dependency contributes its own hash");
  assert.ok(hashes.has(await sha256File(join(candidate, "SKILL.md"))));
});
