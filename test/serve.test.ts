import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveInside, serveOutputs } from "../src/serve.js";

async function outputs(): Promise<string> {
  const inputDir = await mkdtemp(join(tmpdir(), "crucible-serve-"));
  for (const letter of ["A", "B"]) {
    await mkdir(join(inputDir, letter, "assets"), { recursive: true });
    await writeFile(join(inputDir, letter, "index.html"), `<h1>${letter}</h1>`);
    await writeFile(join(inputDir, letter, "assets", "app.js"), `console.log("${letter}")`);
  }
  return inputDir;
}

test("each output is served from its own free port and the bytes are the judged files", async () => {
  const inputDir = await outputs();
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

test("a stale server on a busy port cannot answer for an output", async () => {
  // The bug: `python3 -m http.server 8801 &` on a port an earlier run still
  // held failed silently, and the judge scored that run's pages. Port 0 asks
  // the kernel for a free one, so a squatter never receives the request.
  const squatter = createServer((_request, response) => response.end("STALE"));
  await new Promise<void>((done) => squatter.listen(0, "127.0.0.1", done));
  const inputDir = await outputs();
  const servers = await serveOutputs(inputDir, ["A"]);
  try {
    assert.equal(await (await fetch(servers.served[0]!.url)).text(), "<h1>A</h1>");
  } finally {
    await servers.close();
    squatter.close();
  }
});

test("requests stay inside the output folder", () => {
  assert.equal(resolveInside("/out/A", "/index.html"), "/out/A/index.html");
  assert.equal(resolveInside("/out/A", "/"), "/out/A");
  assert.equal(resolveInside("/out/A", "/../B/index.html"), "/out/A/B/index.html");
  assert.equal(resolveInside("/out/A", "/%00"), null);
});
