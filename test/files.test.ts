import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { gitignoreFilter, removeLinks } from "../src/files.js";
import { tempDirectory } from "./support/files.js";

test("links and special files an agent leaves in its output are removed, never followed", async (t) => {
  const root = await tempDirectory(t, "crucible-links-");
  const secret = join(root, "secret");
  await writeFile(secret, "keep out\n");
  const output = join(root, "source");
  await mkdir(join(output, "deep"), { recursive: true });
  await mkdir(join(output, "node_modules", "x"), { recursive: true });
  await writeFile(join(output, "index.html"), "<p>work</p>");
  await symlink(secret, join(output, "deep", "stolen.txt"));
  await symlink(secret, join(output, "node_modules", "x", "link"));
  spawnSync("/usr/bin/mkfifo", [join(output, "pipe")]);
  assert.deepEqual((await removeLinks(output)).sort(), ["deep/stolen.txt", "pipe"]);
  assert.equal(await readFile(join(output, "index.html"), "utf8"), "<p>work</p>");
  assert.equal(await readFile(secret, "utf8"), "keep out\n", "the link's target is untouched");
  assert.ok((await lstat(join(output, "node_modules", "x", "link"))).isSymbolicLink(), "installed packages are not the arm's output");
});

test("the gitignore matcher reads the patterns projects actually write", async (t) => {
  const root = await tempDirectory(t);
  await writeFile(join(root, ".gitignore"), ["# build output", "dist/", "*.log", "!kept.log", "/tmp-cache", "site/**/generated", "", "  spaced.txt  "].join("\n"));
  const ignores = await gitignoreFilter(root);
  assert.equal(ignores("dist/index.html"), true);
  assert.equal(ignores("site/dist/assets/app.js"), true);
  assert.equal(ignores("dist", true), true);
  // `dist/` is a directory rule, so a file of that name is not covered.
  assert.equal(ignores("dist"), false);
  assert.equal(ignores("build.log"), true);
  assert.equal(ignores("docs/build.log"), true);
  assert.equal(ignores("kept.log"), false);
  assert.equal(ignores("tmp-cache/x"), true);
  assert.equal(ignores("site/tmp-cache/x"), false);
  assert.equal(ignores("site/a/b/generated/page.html"), true);
  assert.equal(ignores("spaced.txt"), true);
  assert.equal(ignores("src/index.ts"), false);
  // A project with no rules covers nothing.
  assert.equal((await gitignoreFilter(join(root, "nowhere")))("dist/index.html"), false);
});
