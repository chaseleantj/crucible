import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveInside, serveOutputs } from "../src/serve.js";
import { tempDirectory } from "./support/files.js";

async function outputs(t: test.TestContext): Promise<string> {
  const inputDir = await tempDirectory(t, "crucible-serve-");
  for (const letter of ["A", "B"]) {
    await mkdir(join(inputDir, letter, "assets"), { recursive: true });
    await writeFile(join(inputDir, letter, "index.html"), `<h1>${letter}</h1>`);
    await writeFile(join(inputDir, letter, "assets", "app.js"), `console.log("${letter}")`);
  }
  return inputDir;
}

test("each output is served from its own free port and the bytes are the judged files", async (t) => {
  const inputDir = await outputs(t);
  const servers = await serveOutputs(inputDir, ["A", "B"]);
  try {
    assert.equal(servers.served.length, 2);
    assert.notEqual(servers.served[0]!.url, servers.served[1]!.url);
    for (const { name: letter, url } of servers.served) {
      assert.equal(await (await fetch(url)).text(), `<h1>${letter}</h1>`);
      const script = await fetch(new URL("assets/app.js", url));
      assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(await script.text(), `console.log("${letter}")`);
      assert.equal((await fetch(new URL("missing.html", url))).status, 404);
      assert.equal((await fetch(new URL("..%2f..%2fetc%2fpasswd", url))).status, 404);
    }
  } finally {
    await servers.close();
  }
  await assert.rejects(fetch(servers.served[0]!.url));
});

test("requests stay inside the output folder", () => {
  assert.equal(resolveInside("/out/A", "/index.html"), "/out/A/index.html");
  assert.equal(resolveInside("/out/A", "/"), "/out/A");
  assert.equal(resolveInside("/out/A", "/../B/index.html"), "/out/A/B/index.html");
  assert.equal(resolveInside("/out/A", "/%00"), null);
});
