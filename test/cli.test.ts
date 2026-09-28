import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempDirectory } from "./support/files.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const execFileAsync = promisify(execFile);

async function crucible(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

test("init writes the starter experiment once and refuses to overwrite it", async (t) => {
  const root = await tempDirectory(t, "crucible-cli-");
  const first = await crucible(["init"], {}, root);
  assert.equal(first.code, 0, first.stderr);
  assert.match(await readFile(join(root, "experiment.yaml"), "utf8"), /^name: /);
  const second = await crucible(["init"], {}, root);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already exists/);
});

test("check fails on a broken entry, and config and list read the configured roots", async (t) => {
  const root = await tempDirectory(t, "crucible-cli-");
  await mkdir(join(root, "archive", "broken"), { recursive: true });
  await writeFile(join(root, "archive", "broken", "README.md"), "A note.\n");
  await writeFile(join(root, "config.yaml"), `archiveRoot: ./archive\nrunsRoot: ./runs\n`);
  // Blank overrides are ignored, so a caller's own CRUCIBLE_*_ROOT cannot leak in.
  const env = { CRUCIBLE_CONFIG: join(root, "config.yaml"), CRUCIBLE_ARCHIVE_ROOT: "", CRUCIBLE_RUNS_ROOT: "" };

  const check = await crucible(["check"], env, root);
  assert.equal(check.code, 1);
  assert.match(check.stderr, /broken: Missing file: result\.json/);
  assert.match(check.stdout, /Checked 1 entries; 2 problems/);

  const missing = await crucible(["check", join(root, "nowhere"), join(root, "config.yaml")], env, root);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /nowhere: does not exist/);
  assert.match(missing.stderr, /config\.yaml: not a folder/);

  const config = await crucible(["config"], env, root);
  assert.match(config.stdout, new RegExp(`archiveRoot +${join(root, "archive")} +config file`));
  assert.match(config.stdout, /skills\.root .* default/);

  const list = await crucible(["list", "--json"], env, root);
  assert.equal(JSON.parse(list.stdout).root, join(root, "archive"));
});
