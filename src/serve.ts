import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { UserError } from "./errors.js";
import { listFiles } from "./files.js";
import { isWithin } from "./scan-files.js";

/**
 * The runner serves each output itself, on a port the kernel picks, and checks
 * the bytes it serves are the copied files before anything opens a URL. A judge
 * that started `python3 -m http.server 8801 &` with its output discarded never
 * learned the bind had failed, and photographed whatever an earlier run had
 * left listening there. These servers live in the runner process, so they end
 * with the caller whatever process group its shells used. The folder names are
 * anonymous letters when the judge reads the outputs and arm labels when the
 * runner captures them.
 */
export interface ServedOutput {
  name: string;
  root: string;
  url: string;
}

export interface OutputServers {
  served: ServedOutput[];
  close(): Promise<void>;
}

/** Markdown opens as readable text rather than a download. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

/** The Content-Type every server here sends for a file. */
export function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export async function serveOutputs(inputDir: string, names: string[]): Promise<OutputServers> {
  const servers: Server[] = [];
  const served: ServedOutput[] = [];
  const close = async () => {
    await Promise.all(servers.map((server) => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    })));
  };
  try {
    for (const name of names) {
      const root = join(inputDir, name);
      const server = await listen(staticServer(root));
      servers.push(server);
      const url = `http://127.0.0.1:${port(server)}/`;
      await verifyServed(root, url);
      served.push({ name, root, url });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { served, close };
}

function staticServer(root: string): Server {
  return createServer((request, response) => {
    handle(root, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}

async function handle(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  const file = resolveInside(root, new URL(request.url ?? "/", "http://localhost").pathname);
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  let target = file;
  let info = await stat(target).catch(() => null);
  if (info?.isDirectory()) {
    target = join(target, "index.html");
    info = await stat(target).catch(() => null);
  }
  if (!info?.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType(target),
    "Content-Length": info.size,
    "Cache-Control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(target);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

/** The requested path as a file under root, or null when it escapes. */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const file = resolve(base, `.${normalize(`/${decoded}`)}`);
  return file === base || isWithin(base, file) ? file : null;
}

function listen(server: Server): Promise<Server> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      done(server);
    });
  });
}

function port(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new UserError("Output server did not report a port");
  return address.port;
}

/**
 * One file fetched back through the URL and compared byte for byte with the
 * judged copy on disk. Port 0 makes a collision impossible, but a proxy, a
 * firewall, or a wrong root would still leave the judge scoring the wrong
 * bytes, and this is the cheapest place to notice.
 */
async function verifyServed(root: string, url: string): Promise<void> {
  const files = await listFiles(root);
  const sample = files.find((path) => /\.html?$/i.test(path)) ?? files[0];
  if (!sample) return;
  const response = await fetch(new URL(sample.split(sep).map(encodeURIComponent).join("/"), url));
  if (!response.ok) throw new UserError(`Output server at ${url} answered ${response.status} for ${sample}`);
  const [expected, actual] = await Promise.all([readFile(join(root, sample)), response.arrayBuffer()]);
  if (!expected.equals(Buffer.from(actual))) throw new UserError(`Output server at ${url} served different bytes than ${join(root, sample)}`);
}
