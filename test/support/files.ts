import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { removeTree } from "../../src/files.js";

export async function tempDirectory(t: TestContext, prefix = "crucible-test-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => removeTree(root));
  return root;
}
