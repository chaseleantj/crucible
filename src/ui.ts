import { execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "./errors.js";
import { isFile, isReallyWithin, isWithin, listDirs } from "./scan-files.js";
import { contentType, resolveInside } from "./serve.js";
import { DeleteError, deleteEach, scanExperiments, storeRoots, type StoreRoots } from "./store.js";
import { dashboardKey, dashboardLoginUrl } from "./ui-key.js";
import { ARTIFACT_VIEW_FLAG as VIEWER_FLAG, artifactPage } from "./artifact-view.js";

/**
 * `crucible ui`: the dashboard's built assets, a JSON API over the store, and
 * the files under the archive and runs folders. It binds to loopback only and
 * answers only requests addressed to itself, so neither another machine nor a
 * web page the user visits can read the archive or delete from it. The pages
 * under /files were written by agents, so they run sandboxed, in an origin of
 * their own, and cannot act as the dashboard either.
 *
 * A sandboxed page's own module scripts and fetches are cross-origin to it,
 * so file responses allow the opaque origin, "null", which any sandboxed
 * frame on any site shares. What keeps those sites out is the files path:
 * /files/<token>/<absolute path>, with a token per archive entry or run
 * record, made from a secret the server keeps and handed out only by the
 * API, which answers the dashboard's own origin alone. A page can read the
 * token in its own address, so it can read its own entry and nothing else;
 * its content policy keeps it from sending what it read anywhere.
 */
export const DEFAULT_UI_PORT = 8300;

/** The build output of ui/, next to the compiled CLI. */
export const UI_ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");

/**
 * Public CDNs outputs load libraries and web fonts from, as plain GETs of
 * published files: three.js from the first three, type from the rest. They
 * are the only hosts an output may reach.
 */
const SCRIPT_CDNS = "https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com";
const FONT_HOSTS = "https://fonts.googleapis.com https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com";

/**
 * Sent with every file. The sandbox lets scripts, forms, and popups run, but
 * without allow-same-origin the page gets an opaque origin, so the API is
 * another site to it. The rest keeps what the page reads on this machine:
 * it loads and fetches only from this server (its own entry, by the token)
 * and inline or data: sources, plus the CDNs above; forms submit nowhere.
 * A page opened in a tab can still navigate itself away, which no policy of
 * its own can stop; the dashboard's frames cannot (DASHBOARD_POLICY).
 */
export const FILE_POLICY = [
  "sandbox allow-scripts allow-popups allow-forms",
  "default-src 'self' data: blob:",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob: ${SCRIPT_CDNS}`,
  `style-src 'self' 'unsafe-inline' data: blob: ${FONT_HOSTS}`,
  `font-src 'self' data: blob: ${FONT_HOSTS}`,
  "connect-src 'self' data: blob:",
  "form-action 'none'",
].join("; ");

/**
 * Sent with the dashboard's own page: its frames may show only this
 * server's pages, so an output in the viewer cannot navigate itself, and
 * whatever it read, to another site.
 */
const DASHBOARD_POLICY = "frame-src 'self'";

/**
 * An HTML file asked for with this query parameter, as the dashboard's
 * viewer does, gets VIEWER_BRIDGE injected.
 */
export { VIEWER_FLAG };

/**
 * The one part of the viewer that runs inside an output page, and the
 * fragile one: it tells the dashboard, the page's parent, when Escape was
 * pressed and the page did not use it itself, which files the page asked
 * for and could not load, so the viewer can say why a page looks broken,
 * and when the left or right arrow was pressed; and it replays an arrow the
 * dashboard sends, so synced decks turn together. A replayed key is
 * untrusted, which most decks do not check. It relies on the page not
 * replacing these listeners' targets and on its first bytes being HTML; a
 * page that navigates within the frame loses it, as the flag does not
 * travel with links.
 */
const VIEWER_BRIDGE = `<script>/* crucible viewer bridge */(function () {
  var post = function (message) { message.crucible = true; parent.postMessage(message, "*"); };
  var turns = { ArrowLeft: 1, ArrowRight: 1 };
  addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !event.defaultPrevented && !event.repeat) post({ type: "escape" });
    // A page turn pressed here, so the dashboard can turn its neighbours; a replayed one is not passed on.
    if (turns[event.key] && event.isTrusted && !event.repeat) post({ type: "turn", key: event.key });
  });
  // A page turn from the dashboard, replayed where the page listens for keys.
  addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.crucible !== true || data.type !== "turn" || !turns[data.key]) return;
    var target = document.activeElement || document.body || document.documentElement;
    ["keydown", "keyup"].forEach(function (type) {
      target.dispatchEvent(new KeyboardEvent(type, { key: data.key, code: data.key, bubbles: true, cancelable: true }));
    });
  });
  addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) post({ type: "missing", url: String(target.src || target.href) });
  }, true);
  addEventListener("securitypolicyviolation", function (event) { post({ type: "blocked", url: event.blockedURI }); });
})();</script>`;

/** The page with the bridge first, after any doctype so the page keeps its standards mode. */
function withViewerBridge(page: Buffer): Buffer {
  // Latin-1 maps every byte to one character, so a page in any encoding survives the round trip.
  const text = page.toString("latin1");
  const doctype = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(text)?.[0] ?? "";
  return Buffer.from(doctype + VIEWER_BRIDGE + text.slice(doctype.length), "latin1");
}

/**
 * Every action carries this header. A page elsewhere, sandboxed outputs
 * included, cannot send it without a CORS preflight, which this server never
 * grants.
 */
export const ACTION_HEADER = "x-crucible";

/** The cookie that holds the dashboard key. */
const KEY_COOKIE = "crucible_key";

function cookie(request: IncomingMessage, name: string): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [found, ...value] = part.trim().split("=");
    if (found === name) return value.join("=");
  }
  return null;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Room for a delete of every run in a large archive, by path. */
const MAX_BODY_BYTES = 1024 * 1024;

/** `crucible ui [--port N] [--no-open]`: serve until interrupted. */
export async function uiCommand(args: string[]): Promise<void> {
  let port = DEFAULT_UI_PORT;
  let open = true;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--no-open") open = false;
    else if (option === "--port") {
      port = Number(args[++index]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError("--port requires a port number");
    } else throw new UserError(`Unknown option: ${option}`);
  }
  if (!isFile(join(UI_ASSETS, "index.html"))) throw new UserError("The dashboard is not built; run npm run build");
  const { archiveRoot, runsRoot } = storeRoots();
  const server = createUiServer({ archiveRoot, runsRoot });
  try {
    await listenUi(server, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new UserError(`Port ${port} is in use; crucible ui may already be running there. Pass --port to use another.`);
    }
    throw error;
  }
  const url = dashboardLoginUrl(`http://127.0.0.1:${port}`);
  process.stdout.write(`Dashboard: ${url}\nResults: ${archiveRoot}\nRuns: ${runsRoot}\nPress Ctrl-C to stop.\n`);
  if (open) execFile("open", [url]);
}

export interface UiOptions extends StoreRoots {
  assetsDir?: string;
  /** The key a browser signs in with; this machine's own unless a test gives one. */
  key?: string;
  /** Shows a path in Finder; replaced in tests. */
  reveal?: (path: string) => Promise<void>;
}

export function createUiServer(options: UiOptions): Server {
  const files = fileTokens(randomBytes(32));
  const key = options.key ?? dashboardKey();
  const server = createServer((request, response) => {
    handle(options, key, files, server, request, response).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    });
  });
  return server;
}

export function listenUi(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      const address = server.address();
      done(typeof address === "object" && address ? address.port : port);
    });
  });
}

async function handle(options: UiOptions, key: string, files: FileTokens, server: Server, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { pathname, searchParams } = new URL(request.url ?? "/", "http://localhost");
  if (!addressedToUs(server, request, pathname)) {
    sendJson(response, 403, { error: "This server only answers requests from its own page." });
    return;
  }
  // Signing in: the key becomes a cookie scripts cannot read and other sites
  // cannot send, and leaves the address bar. The fragment, the route, survives.
  if (request.method === "GET" && searchParams.has("key")) {
    if (!sameSecret(searchParams.get("key") ?? "", key)) {
      sendJson(response, 403, { error: "That is not this dashboard's key. Open it with crucible ui." });
      return;
    }
    response.writeHead(303, { Location: pathname, "Set-Cookie": `${KEY_COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`, "Cache-Control": "no-store" }).end();
    return;
  }
  // The data and every action need the key. The page itself and its assets
  // hold nothing, and output files carry tokens that only the data hands out.
  if ((pathname.startsWith("/api/") || request.method === "POST") && !sameSecret(cookie(request, KEY_COOKIE) ?? "", key)) {
    sendJson(response, 401, { error: "Open the dashboard with crucible ui, which signs this browser in." });
    return;
  }
  const roots = { archiveRoot: resolve(options.archiveRoot), runsRoot: resolve(options.runsRoot) };

  if (request.method === "POST") {
    if (request.headers[ACTION_HEADER] !== "1") {
      sendJson(response, 403, { error: "Actions come from the dashboard page only." });
      return;
    }
    const body = await readJsonBody(request);
    if (pathname === "/api/delete") {
      const items = body?.items;
      if (!Array.isArray(items) || items.length === 0 || !items.every((item) => Array.isArray(item) && item.every((path) => typeof path === "string"))) {
        sendJson(response, 400, { error: "Name what to delete as a list of selections, each a list of absolute paths." });
        return;
      }
      // Each selection goes or stays whole; the answer says which, in order.
      const outcomes = deleteEach(roots, items as string[][], { dryRun: body?.dryRun === true });
      sendJson(response, 200, { results: outcomes.map((outcome) => ("error" in outcome ? { error: deleteMessage(outcome.error) } : outcome)) });
      return;
    }
    const target = typeof body?.path === "string" ? body.path : null;
    if (!target) {
      sendJson(response, 400, { error: "Name the file or folder by its absolute path." });
      return;
    }
    if (pathname === "/api/reveal") {
      const file = containedPath(roots, target);
      if (!file) {
        sendJson(response, 404, { error: "That file is no longer in the results or runs folder." });
        return;
      }
      await (options.reveal ?? revealInFinder)(file);
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: "Unknown action." });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (pathname === "/api/experiments") {
    sendJson(response, 200, { ...roots, files: files.prefixes(roots), experiments: scanExperiments(roots) });
    return;
  }
  if (pathname.startsWith("/files/")) {
    const [, , token = "", ...rest] = pathname.split("/");
    const file = requestedFile(roots, `/${rest.join("/")}`);
    const scope = file && fileScope(roots, file);
    const served = scope && files.opens(token, scope) ? indexed(file) : null;
    const viewed = served !== null && searchParams.has(VIEWER_FLAG);
    const presentation = viewed ? await artifactPage(served) : null;
    if (presentation !== null) {
      sendHtml(request, response, withViewerBridge(Buffer.from(presentation)), { "Content-Security-Policy": FILE_POLICY, "Access-Control-Allow-Origin": "null" });
      return;
    }
    const bridged = viewed && contentType(served).startsWith("text/html");
    sendFile(request, response, served, { "Content-Security-Policy": FILE_POLICY, "Access-Control-Allow-Origin": "null" }, bridged ? withViewerBridge : undefined);
    return;
  }
  const assets = options.assetsDir ?? UI_ASSETS;
  const asset = resolveInside(assets, pathname === "/" ? "/index.html" : pathname);
  sendFile(request, response, asset && indexed(asset), { "Content-Security-Policy": DASHBOARD_POLICY });
}

interface FileTokens {
  /** Scope folder to the relative URL its files are served under, for every scope there is now. */
  prefixes(roots: StoreRoots): Record<string, string>;
  /** Whether a token is the one for this scope. */
  opens(token: string, scope: string): boolean;
}

/** One token per scope, derived from the server's secret, so none is stored. */
function fileTokens(secret: Buffer): FileTokens {
  const tokenOf = (scope: string) => createHmac("sha256", secret).update(scope).digest("hex").slice(0, 32);
  return {
    prefixes: (roots) => Object.fromEntries([roots.archiveRoot, roots.runsRoot].flatMap((root) =>
      listDirs(root).map((name) => [join(root, name), `files/${tokenOf(join(root, name))}`]))),
    opens: (token, scope) => {
      const given = Buffer.from(token);
      return given.length === 32 && timingSafeEqual(given, Buffer.from(tokenOf(scope)));
    },
  };
}

/**
 * What a token opens: the archive entry or run record a file is in, the
 * first folder below its root, and only when the file really is in it, so a
 * link cannot reach a neighbour. Null for a file directly in a root.
 */
function fileScope(roots: StoreRoots, file: string): string | null {
  // The deeper root first, in case one holds the other.
  const root = [roots.archiveRoot, roots.runsRoot].sort((a, b) => b.length - a.length).find((base) => isWithin(base, file));
  if (!root) return null;
  const [first, ...below] = relative(root, file).split(sep);
  const scope = join(root, first!);
  return below.length > 0 && isReallyWithin(scope, file) ? scope : null;
}

/**
 * The Host header names this server, and a browser's Origin, when it sends
 * one, is this server's page. That rules out DNS rebinding and cross-site
 * form posts; `curl` from the same machine sends no Origin and is allowed.
 * A sandboxed page's opaque origin, "null", may only read files.
 */
function addressedToUs(server: Server, request: IncomingMessage, pathname: string): boolean {
  const ours = ourHosts(server);
  if (!ours.has(request.headers.host ?? "")) return false;
  const origin = request.headers.origin;
  if (origin === undefined || ours.has(origin.replace(/^http:\/\//, ""))) return true;
  return origin === "null" && (request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/files/");
}

function ourHosts(server: Server): Set<string> {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

/** The file an encoded absolute path names, when it is inside a root. */
function requestedFile(roots: StoreRoots, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.includes("\0") ? null : containedPath(roots, resolve("/", decoded));
}

/**
 * An absolute path inside the archive or runs folder, once links are
 * resolved; null for anything else, or anything missing.
 */
export function containedPath(roots: StoreRoots, target: string): string | null {
  const file = resolve(target);
  return [roots.archiveRoot, roots.runsRoot].some((root) => isReallyWithin(root, file)) ? file : null;
}

/** A folder stands for its index.html. */
function indexed(file: string): string | null {
  try {
    const info = statSync(file);
    if (info.isFile()) return file;
    if (info.isDirectory() && statSync(join(file, "index.html")).isFile()) return join(file, "index.html");
  } catch {
    // Missing: the caller answers 404.
  }
  return null;
}

/** A file as it is on disk, or as `rewrite` makes it. */
function sendFile(request: IncomingMessage, response: ServerResponse, file: string | null, headers: Record<string, string> = {}, rewrite?: (body: Buffer) => Buffer): void {
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  const body = rewrite ? rewrite(readFileSync(file)) : null;
  response.writeHead(200, {
    ...headers,
    "Content-Type": contentType(file),
    "Content-Length": body?.length ?? statSync(file).size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD" || body) {
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

function sendHtml(request: IncomingMessage, response: ServerResponse, body: Buffer, headers: Record<string, string>): void {
  response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(text);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (!request.headers["content-type"]?.startsWith("application/json")) return null;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The store's refusal, in the dashboard's words. */
function deleteMessage(error: DeleteError): string {
  switch (error.reason) {
    case "active":
      return "This run still has agents at work. Stop it with crucible stop, then delete it.";
    case "unavailable":
      return "This is no longer in the results or runs folder. Refresh the page and try again.";
    default:
      return error.message;
  }
}

function revealInFinder(path: string): Promise<void> {
  return new Promise((done, fail) => execFile("open", ["-R", path], (error) => (error ? fail(error) : done())));
}
