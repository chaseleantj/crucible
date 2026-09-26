import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type IncomingHttpHeaders, request as httpRequest } from "node:http";
import { FILE_POLICY, containedPath, createUiServer, listenUi } from "../src/ui.js";

function result(runId: string) {
  return {
    runId, name: `Question ${runId}`, series: null, task: "Write a page.", reportedAt: "2026-01-01T00:00:00Z", environment: "clean",
    arms: [{ label: "a", candidate: null, replaces: null }, { label: "b", candidate: null, replaces: null }],
    producers: { a: { agent: "claude", model: null, effort: null }, b: { agent: "claude", model: null, effort: null } },
    cost: {}, warnings: [], shots: null,
    judgeAgent: { agent: "claude", model: null, effort: null }, winner: "a", confidence: 0.7, totals: { a: 8, b: 6 }, margin: 2,
    scores: [{ criterion: "clarity", weight: 1, scores: { a: 8, b: 6 } }],
    referenceGuess: { arm: null, confidence: 0.5, correct: null }, summary: "A was clearer.",
  };
}

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "crucible-ui-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const archiveRoot = join(base, "archive");
  const runsRoot = join(base, "runs");
  const assetsDir = join(base, "assets");
  const entry = join(archiveRoot, "first");
  await mkdir(join(entry, "outputs", "a"), { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(entry, "result.json"), JSON.stringify(result("ab-00000001")));
  await writeFile(join(entry, "report.html"), "<p>report</p>");
  await writeFile(join(entry, "outputs", "a", "index.html"), "<p>a</p>");
  await writeFile(join(entry, "outputs", "a", "answer.md"), "# Answer");
  await writeFile(join(assetsDir, "index.html"), "<p>dashboard</p>");
  await writeFile(join(base, "secret.txt"), "secret");
  await symlink(join(base, "secret.txt"), join(entry, "leak.txt"));
  // A neighbouring entry, and a link into it from the first.
  const neighbour = join(archiveRoot, "second");
  await mkdir(neighbour, { recursive: true });
  await writeFile(join(neighbour, "notes.txt"), "neighbour");
  await symlink(join(neighbour, "notes.txt"), join(entry, "neighbour.txt"));
  await writeFile(join(archiveRoot, "README.md"), "# Archive");

  const revealed: string[] = [];
  const server = createUiServer({ archiveRoot, runsRoot, assetsDir, reveal: async (path) => void revealed.push(path) });
  const port = await listenUi(server, 0);
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const { files } = await (await fetch(url("/api/experiments"))).json() as { files: Record<string, string> };
  /** A file's URL path under one folder's prefix, the first entry's unless named. */
  const file = (path: string, folder = entry) => `/${files[folder]}${path}`;
  return { base, archiveRoot, runsRoot, entry, neighbour, port, revealed, url, file, files };
}

/** A request with headers fetch will not let a page set, like a foreign Host, Origin, or Referer. */
function rawResponse(port: number, path: string, headers: Record<string, string>, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders }>((done, fail) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      response.resume();
      done({ status: response.statusCode ?? 0, headers: response.headers });
    });
    request.on("error", fail);
    request.end(body);
  });
}

const raw = async (...args: Parameters<typeof rawResponse>) => (await rawResponse(...args)).status;

/** An action as the dashboard sends it. */
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Crucible": "1", ...headers }, body: JSON.stringify(body) });

test("serves the dashboard and the store's snapshot with its roots", async (t) => {
  const { archiveRoot, runsRoot, url } = await fixture(t);
  assert.equal(await (await fetch(url("/"))).text(), "<p>dashboard</p>");
  const snapshot = await (await fetch(url("/api/experiments"))).json();
  assert.equal(snapshot.archiveRoot, archiveRoot);
  assert.equal(snapshot.runsRoot, runsRoot);
  assert.deepEqual(snapshot.experiments.questions.map((question: { title: string }) => question.title), ["Question ab-00000001"]);
  assert.equal((await fetch(url("/missing.js"))).status, 404);
});

test("serves files under the roots, so a report's relative links resolve", async (t) => {
  const { entry, url, file } = await fixture(t);
  const report = await fetch(url(file(`${entry}/report.html`)));
  assert.equal(report.status, 200);
  assert.equal(report.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await (await fetch(url(file(`${entry}/outputs/a/`)))).text(), "<p>a</p>");
  const markdown = await fetch(url(file(`${entry}/outputs/a/answer.md`)));
  assert.equal(markdown.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("refuses files outside the roots, through links, or via encoded traversal", async (t) => {
  const { base, archiveRoot, entry, url, file } = await fixture(t);
  assert.equal((await fetch(url(file(`${base}/secret.txt`)))).status, 404);
  assert.equal((await fetch(url(file(`${archiveRoot}/README.md`)))).status, 404, "a file directly in a root is in no entry");
  assert.equal((await fetch(url(file(`${entry}/leak.txt`)))).status, 404);
  assert.equal((await fetch(url(file(`${entry}/..%2f..%2fsecret.txt`)))).status, 404);
  assert.equal((await fetch(url(file(`${entry}/%00`)))).status, 404);
  assert.equal((await fetch(url(file("/etc/passwd")))).status, 404);
});

test("containedPath accepts only real paths inside a root", async (t) => {
  const { base, archiveRoot, runsRoot, entry } = await fixture(t);
  const roots = { archiveRoot, runsRoot };
  assert.equal(containedPath(roots, join(entry, "report.html")), join(entry, "report.html"));
  assert.equal(containedPath(roots, archiveRoot), null);
  assert.equal(containedPath(roots, join(archiveRoot, "..", "secret.txt")), null);
  assert.equal(containedPath(roots, join(entry, "leak.txt")), null);
  assert.equal(containedPath(roots, join(base, "archive-sibling", "x")), null);
  assert.equal(containedPath(roots, join(entry, "missing")), null);
});

test("answers only requests addressed to itself", async (t) => {
  const { port, entry } = await fixture(t);
  assert.equal(await raw(port, "/api/experiments", { Host: "evil.example" }), 403);
  assert.equal(await raw(port, "/api/experiments", { Host: `localhost:${port}` }), 200);
  const body = JSON.stringify({ items: [[entry]] });
  const json = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Crucible": "1" };
  assert.equal(await raw(port, "/api/delete", { ...json, Origin: "http://evil.example" }, "POST", body), 403);
  assert.equal(existsSync(entry), true);
});

test("reveal shows contained paths only", async (t) => {
  const { base, entry, url, revealed } = await fixture(t);
  assert.equal((await post(url("/api/reveal"), { path: entry })).status, 200);
  assert.equal((await post(url("/api/reveal"), { path: join(base, "secret.txt") })).status, 404);
  assert.equal((await post(url("/api/reveal"), {})).status, 400);
  assert.deepEqual(revealed, [entry]);
});

test("delete removes selections through the store, each whole or not at all, and says which", async (t) => {
  const { base, archiveRoot, runsRoot, entry, url } = await fixture(t);
  const results = async (body: unknown) => {
    const response = await post(url("/api/delete"), body);
    assert.equal(response.status, 200);
    return ((await response.json()) as { results: Array<{ deleted?: string[]; error?: string }> }).results;
  };
  for (const malformed of [{ path: entry }, { items: [] }, { items: [entry] }, { items: [[1]] }]) {
    assert.equal((await post(url("/api/delete"), malformed)).status, 400, JSON.stringify(malformed));
  }
  assert.equal((await fetch(url("/api/delete"), { method: "POST", headers: { "X-Crucible": "1" }, body: JSON.stringify({ items: [[entry]] }) })).status, 400);

  const record = join(runsRoot, "ab-00000001");
  await mkdir(record);
  await writeFile(join(record, "state.json"), JSON.stringify({ runId: "ab-00000001", state: "reported", updatedAt: "2026-01-01T00:00:00Z", producers: { p1: { state: "done", toolCalls: 0 } } }));
  await writeFile(join(record, "resolved-config.json"), JSON.stringify({ name: "Run", arms: [{ label: "a" }], producer: { timeoutMs: 1 }, judge: { timeoutMs: 1 } }));

  // A dry run names what would go, the run record too, and removes nothing.
  const checked = await results({ items: [[entry], [join(base, "secret.txt")], [archiveRoot]], dryRun: true });
  assert.deepEqual(checked[0], { deleted: [entry, record] });
  assert.match(checked[1]!.error!, /no longer in the results or runs folder/);
  assert.ok(checked[2]!.error);
  assert.ok(existsSync(entry) && existsSync(record));

  const done = await results({ items: [[join(base, "secret.txt")], [entry]] });
  assert.ok(done[0]!.error);
  assert.deepEqual(done[1], { deleted: [entry, record] });
  assert.equal(existsSync(entry) || existsSync(record), false);
  assert.equal(existsSync(join(base, "secret.txt")), true);
});

test("every file runs sandboxed in an opaque origin and may reach only this server, so an output page cannot act as the dashboard or send what it reads away", async (t) => {
  const { entry, url, file } = await fixture(t);
  for (const path of ["report.html", "outputs/a/", "outputs/a/answer.md"]) {
    const response = await fetch(url(file(`${entry}/${path}`)));
    assert.equal(response.headers.get("content-security-policy"), FILE_POLICY, path);
  }
  const directives = new Map(FILE_POLICY.split("; ").map((directive) => [directive.split(" ")[0], directive]));
  assert.equal(directives.get("sandbox"), "sandbox allow-scripts allow-popups allow-forms");
  assert.equal(directives.get("connect-src"), "connect-src 'self' data: blob:");
  assert.equal(directives.get("form-action"), "form-action 'none'");
  assert.match(directives.get("default-src")!, /^default-src 'self' data: blob:$/);
});

test("actions need the dashboard's header, which a page elsewhere cannot send without a preflight", async (t) => {
  const { entry, port, url } = await fixture(t);
  const bare = await fetch(url("/api/delete"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [[entry]] }) });
  assert.equal(bare.status, 403);
  assert.equal((await fetch(url("/api/reveal"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: entry }) })).status, 403);
  assert.equal(existsSync(entry), true);
  // What a sandboxed output page sends: its opaque origin.
  const sandboxed = { Host: `127.0.0.1:${port}`, Origin: "null" };
  assert.equal(await raw(port, "/api/delete", { ...sandboxed, "Content-Type": "application/json", "X-Crucible": "1" }, "POST", JSON.stringify({ items: [[entry]] })), 403);
  assert.equal(await raw(port, "/api/experiments", sandboxed), 403);
  assert.equal(await raw(port, "/api/delete", sandboxed, "OPTIONS"), 403);
  assert.equal(existsSync(entry), true);
});

test("files are served only under their own folder's token, which the API hands to its own page", async (t) => {
  const { entry, neighbour, port, url, file, files } = await fixture(t);
  assert.deepEqual(Object.keys(files).sort(), [entry, neighbour]);
  assert.match(files[entry]!, /^files\/[0-9a-f]{32}$/);
  assert.notEqual(files[entry], files[neighbour]);
  assert.equal((await fetch(url(`/files${entry}/report.html`))).status, 404, "the bare path does not serve");
  assert.equal((await fetch(url(`/files/${"0".repeat(32)}${entry}/report.html`))).status, 404, "nor a made-up token");
  assert.equal((await fetch(url(`/files/%C3%A9${"0".repeat(30)}${entry}/report.html`))).status, 404, "nor one of another length in bytes");
  // An output page knows its own token; it opens that entry and no other.
  assert.equal((await fetch(url(file(`${neighbour}/notes.txt`, neighbour)))).status, 200);
  assert.equal((await fetch(url(file(`${neighbour}/notes.txt`)))).status, 404, "an entry's token does not open its neighbour");
  assert.equal((await fetch(url(file(`${entry}/neighbour.txt`)))).status, 404, "nor does a link into it");
  // A sandboxed page's own module scripts arrive from its opaque origin.
  const sandboxed = await rawResponse(port, file(`${entry}/outputs/a/index.html`), { Host: `127.0.0.1:${port}`, Origin: "null" });
  assert.equal(sandboxed.status, 200);
  assert.equal(sandboxed.headers["access-control-allow-origin"], "null");
  assert.equal(await raw(port, "/api/experiments", { Host: `127.0.0.1:${port}`, Origin: "null" }), 403, "while the secret stays with the dashboard");
});

test("the viewer's bridge goes into HTML asked for with its flag, after the doctype, and nowhere else", async (t) => {
  const { entry, url, file } = await fixture(t);
  await writeFile(join(entry, "outputs", "a", "deck.html"), "<!DOCTYPE html>\n<p>caf\xe9</p>", "latin1");
  const plain = await fetch(url(file(`${entry}/outputs/a/deck.html`)));
  assert.equal(await plain.text(), "<!DOCTYPE html>\n<p>caf�</p>", "untouched without the flag");
  const bridged = await fetch(url(`${file(`${entry}/outputs/a/deck.html`)}?crucible-viewer`));
  const bytes = Buffer.from(await bridged.arrayBuffer());
  assert.equal(Number(bridged.headers.get("content-length")), bytes.length);
  const text = bytes.toString("latin1");
  assert.match(text, /^<!DOCTYPE html><script>\/\* crucible viewer bridge \*\//);
  assert.ok(text.endsWith("</script>\n<p>caf\xe9</p>"), "the page's own bytes follow, whatever their encoding");
  assert.equal(await (await fetch(url(`${file(`${entry}/outputs/a/answer.md`)}?crucible-viewer`))).text(), "# Answer", "only HTML");
  assert.equal(bridged.headers.get("content-security-policy"), FILE_POLICY);
  assert.equal((await fetch(url("/"))).headers.get("content-security-policy"), "frame-src 'self'", "the dashboard frames only its own server's pages");
});

test("the viewer shows an SVG centred on a page of its own, and the file itself without the flag", async (t) => {
  const { entry, url, file } = await fixture(t);
  await writeFile(join(entry, "outputs", "a", "cup icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'/>");
  const bare = await fetch(url(file(`${entry}/outputs/a/cup icon.svg`)));
  assert.equal(bare.headers.get("content-type"), "image/svg+xml");
  const viewed = await fetch(url(`${file(`${entry}/outputs/a/cup icon.svg`)}?crucible-viewer`));
  assert.match(viewed.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(viewed.headers.get("content-security-policy"), FILE_POLICY);
  const page = await viewed.text();
  assert.match(page, /^<!doctype html><script>\/\* crucible viewer bridge \*\//, "the bridge still reports Escape");
  assert.match(page, /<img src="\.\/cup%20icon\.svg"/, "the image is the same file, beside the page");
});
