// Agents never hold a real credential. Each agent gets a random stand-in, and
// this broker, running in the runner process outside the sandbox, swaps the
// stand-in for the real credential on the way to the provider. A prompt-
// injected agent can spend the run's API budget, as any agent can, but it has
// nothing to steal: the real token never enters its environment, its files, or
// its memory.
import { execFile } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplexPair } from "node:stream";
import { promisify } from "node:util";

export interface BrokerOptions {
  /** Host interface reachable through the guest relay; loopback for host-only tests. */
  bindHost?: string;
  /** The provider the requests go on to, with any base path, e.g. https://api.anthropic.com. */
  upstream: string;
  /** Paths that go to another host of the same provider, by prefix. */
  routes?: Array<{ prefix: string; upstream: string }>;
  /** Serve HTTPS with a certificate of Crucible's own, for a CLI that refuses a plain-http backend. */
  tls?: boolean;
  /** Request paths the agent may use, as prefixes of the path it sends. */
  allow: string[];
  /** The real credential, read on every request so a refresh by the user's own CLI carries through. */
  secret: () => Promise<string>;
  /** Where each request is noted, by method, path, and status only. */
  logFile?: string;
}

export interface Broker {
  /** Where the agent sends its requests: http://127.0.0.1:<port>. */
  url: string;
  /** The stand-in the agent presents in place of the credential. */
  standIn: string;
  /** With `tls`, the certificate authority the agent has to trust, as PEM. */
  certificateAuthority?: string;
  close(): Promise<void>;
}

const execFileAsync = promisify(execFile);

interface LocalCertificate { authority: string; key: string; cert: string }
let localCertificate: Promise<LocalCertificate> | undefined;

/**
 * A certificate authority and a certificate for 127.0.0.1 and localhost, made
 * once per runner. The private keys exist on disk only while openssl writes
 * them; the runner keeps them in memory, and the agent is given the
 * authority's certificate alone.
 */
function brokerCertificate(): Promise<LocalCertificate> {
  localCertificate ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "crucible-broker-"));
    const file = (name: string) => join(dir, name);
    const openssl = (args: string[]) => execFileAsync("/usr/bin/openssl", args, { cwd: dir, timeout: 15_000 });
    try {
      // RSA and SHA-256: macOS's LibreSSL signs with SHA-1 by default and
      // writes EC keys with explicit curve parameters, both of which clients refuse.
      const curve = ["-newkey", "rsa:2048", "-nodes", "-sha256"];
      await openssl(["req", "-x509", ...curve, "-keyout", file("ca.key"), "-out", file("ca.pem"), "-days", "7", "-subj", "/CN=Crucible credential broker", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
      await openssl(["req", ...curve, "-keyout", file("leaf.key"), "-out", file("leaf.csr"), "-subj", "/CN=127.0.0.1"]);
      await writeFile(file("ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n");
      await openssl(["x509", "-req", "-in", file("leaf.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca.key"), "-CAcreateserial", "-sha256", "-out", file("leaf.pem"), "-days", "7", "-extfile", file("ext")]);
      const [authority, key, cert] = await Promise.all([readFile(file("ca.pem"), "utf8"), readFile(file("leaf.key"), "utf8"), readFile(file("leaf.pem"), "utf8")]);
      if (!new X509Certificate(cert).checkIssued(new X509Certificate(authority))) throw new Error("the broker certificate was not issued by its authority");
      return { authority, key, cert };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return localCertificate;
}

/** Headers that belong to one connection and are never forwarded. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "http2-settings"]);

type Headers = Record<string, string | string[] | undefined>;

/**
 * Speaks HTTP/1.1 and HTTP/2 on one loopback port, since CLIs use both: Cursor
 * sends its account calls over HTTP/1.1 and streams its chat over HTTP/2.
 */
export async function startBroker(options: BrokerOptions): Promise<Broker> {
  const standIn = `crucible-${randomBytes(24).toString("hex")}`;
  const tokenAround = new RegExp(`[^\\s,]*${standIn}[^\\s,]*`, "g");
  // Each upstream host keeps its own connections.
  const targets = new Map<string, { url: URL; basePath: string; transport: typeof http | typeof https; agent: http.Agent; session: http2.ClientHttp2Session | null }>();
  const target = (path: string) => {
    const address = options.routes?.find((route) => path.startsWith(route.prefix))?.upstream ?? options.upstream;
    let found = targets.get(address);
    if (!found) {
      const url = new URL(address);
      // A plain-http upstream is a gateway the user named in ANTHROPIC_BASE_URL or a test's fake provider.
      const transport = url.protocol === "http:" ? http : https;
      found = { url, basePath: url.pathname.replace(/\/$/, ""), transport, agent: new transport.Agent({ keepAlive: true }), session: null };
      targets.set(address, found);
    }
    return found;
  };
  const note = (line: string) => options.logFile ? appendFile(options.logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }).catch(() => {}) : Promise.resolve();

  /**
   * The request's headers with the stand-in replaced, or why it is refused.
   * Only the agent this broker serves holds the stand-in; anything else on
   * this machine that finds the port gets nothing.
   */
  async function admit(path: string, incoming: Headers): Promise<{ headers: Headers } | { status: number; why: string }> {
    let secret: string;
    try {
      secret = await options.secret();
    } catch (error) {
      return { status: 503, why: `no credential: ${error instanceof Error ? error.message : error}` };
    }
    const headers: Headers = {};
    let presented = false;
    for (const [name, value] of Object.entries(incoming)) {
      if (HOP_BY_HOP.has(name) || name.startsWith(":") || value === undefined) continue;
      if (typeof value === "string" && value.includes(standIn)) {
        // The whole token that carries the stand-in, so a stand-in shaped
        // like a signed token ("Bearer head.claims.<stand-in>") is replaced
        // by the real token, not spliced into it.
        headers[name] = value.replace(tokenAround, () => secret);
        presented = true;
      } else {
        headers[name] = value;
      }
    }
    if (!presented) return { status: 403, why: "request did not carry this agent's stand-in credential" };
    if (!options.allow.some((prefix) => path.startsWith(prefix))) return { status: 404, why: "path is not one this agent's provider API needs" };
    return { headers };
  }

  const http1 = http.createServer(async (request, response) => {
    const path = request.url ?? "/";
    const admitted = await admit(path, request.headers);
    if ("why" in admitted) {
      void note(`refused ${request.method} ${path.split("?")[0]}: ${admitted.why}`);
      request.resume();
      response.writeHead(admitted.status, { "content-type": "text/plain" }).end(`crucible credential broker: ${admitted.why}\n`);
      return;
    }
    const to = target(path);
    const forward = to.transport.request({
      protocol: to.url.protocol,
      hostname: to.url.hostname,
      port: to.url.port || (to.url.protocol === "http:" ? 80 : 443),
      method: request.method,
      path: `${to.basePath}${path}`,
      headers: { ...admitted.headers, host: to.url.host },
      agent: to.agent,
    }, (reply) => {
      void note(`${request.method} ${path.split("?")[0]} ${reply.statusCode}`);
      const replyHeaders = Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
      response.writeHead(reply.statusCode ?? 502, replyHeaders);
      reply.pipe(response);
    });
    forward.on("error", (error) => {
      void note(`upstream error on ${request.method} ${path.split("?")[0]}: ${error.message}`);
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end();
    });
    // An agent that hangs up mid-stream takes its upstream request with it.
    response.on("close", () => { if (!response.writableFinished) forward.destroy(); });
    request.pipe(forward);
  });
  // Model responses stream for minutes.
  http1.requestTimeout = 0;
  http1.keepAliveTimeout = 60_000;

  // One HTTP/2 session per upstream host, reopened when the provider closes it.
  const upstreamSession = (to: ReturnType<typeof target>) => {
    if (!to.session || to.session.closed || to.session.destroyed) {
      to.session = http2.connect(to.url.origin);
      to.session.on("error", () => {});
    }
    return to.session;
  };
  const http2Sessions = new Set<http2.ServerHttp2Session>();
  const http2Server = http2.createServer();
  http2Server.on("session", (incoming) => {
    http2Sessions.add(incoming);
    incoming.on("close", () => http2Sessions.delete(incoming));
  });
  http2Server.on("stream", async (stream, incoming) => {
    const method = String(incoming[":method"] ?? "GET");
    const path = String(incoming[":path"] ?? "/");
    const admitted = await admit(path, incoming);
    if (stream.destroyed) return;
    if ("why" in admitted) {
      void note(`refused ${method} ${path.split("?")[0]}: ${admitted.why}`);
      stream.respond({ ":status": admitted.status, "content-type": "text/plain" });
      stream.end(`crucible credential broker: ${admitted.why}\n`);
      return;
    }
    let forward: http2.ClientHttp2Stream;
    try {
      const to = target(path);
      forward = upstreamSession(to).request({ ...admitted.headers, ":method": method, ":path": `${to.basePath}${path}`, ":scheme": to.url.protocol.slice(0, -1), ":authority": to.url.host });
    } catch (error) {
      void note(`upstream error on ${method} ${path.split("?")[0]}: ${error instanceof Error ? error.message : error}`);
      stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      return;
    }
    // Streaming RPCs end with trailers that carry their status.
    let trailers: http2.OutgoingHttpHeaders = {};
    forward.on("trailers", (received) => {
      trailers = Object.fromEntries(Object.entries(received).filter(([name]) => !name.startsWith(":"))) as http2.OutgoingHttpHeaders;
    });
    forward.on("response", (received) => {
      void note(`${method} ${path.split("?")[0]} ${received[":status"]}`);
      const replyHeaders = Object.fromEntries(Object.entries(received).filter(([name]) => !HOP_BY_HOP.has(name)));
      stream.respond(replyHeaders, { waitForTrailers: true });
      forward.pipe(stream);
    });
    stream.on("wantTrailers", () => stream.sendTrailers(trailers));
    forward.on("error", (error) => {
      void note(`upstream error on ${method} ${path.split("?")[0]}: ${error.message}`);
      if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    });
    stream.on("error", () => forward.close(http2.constants.NGHTTP2_CANCEL));
    stream.on("close", () => { if (!forward.closed) forward.close(http2.constants.NGHTTP2_CANCEL); });
    stream.pipe(forward);
  });

  // One port for both: an HTTP/2 client opens with its connection preface.
  // Over TLS the broker speaks HTTP/1.1 alone, which is all Codex needs.
  const certificate = options.tls ? await brokerCertificate() : null;
  const sockets = new Set<net.Socket>();
  const front = certificate ? https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) => http1.emit("request", request, response)) : net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => {
      if (chunk.toString("latin1", 0, 14) !== "PRI * HTTP/2.0") {
        socket.pause();
        socket.unshift(chunk);
        http1.emit("connection", socket);
        socket.resume();
        return;
      }
      // The HTTP/2 server reads a real socket's handle directly, past any
      // bytes put back on it, so it gets a stream fed the preface first.
      const [inner, outer] = duplexPair();
      outer.write(chunk);
      socket.pipe(outer).pipe(socket);
      socket.on("close", () => inner.destroy());
      http2Server.emit("connection", inner);
    });
  });
  await new Promise<void>((resolve, reject) => {
    front.once("error", reject);
    front.listen(0, options.bindHost ?? "127.0.0.1", () => resolve());
  });
  if (certificate) {
    const tlsFront = front as https.Server;
    tlsFront.requestTimeout = 0;
    tlsFront.on("connection", (socket: net.Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
  }
  // Never the reason a test run or a finished runner stays alive.
  front.unref();
  const { port } = front.address() as AddressInfo;
  return {
    url: `${certificate ? "https" : "http"}://127.0.0.1:${port}`,
    standIn,
    ...(certificate ? { certificateAuthority: certificate.authority } : {}),
    close: async () => {
      for (const to of targets.values()) {
        to.agent.destroy();
        to.session?.destroy();
      }
      for (const incoming of http2Sessions) incoming.destroy();
      http1.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => front.close(() => resolve()));
    },
  };
}

/** The claims of a JSON web token, unverified; null when it is not one. */
export function tokenClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * An unsigned token carrying the given claims, for a CLI that reads its login
 * token's claims (plan, account, expiry) before it sends it. Its signature
 * part is the stand-in, which the broker replaces with the real token whole.
 */
export function standInToken(claims: Record<string, unknown>, standIn: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.${standIn}`;
}

/** Seconds from now until a token's `exp` claim; null when it has none. */
export function secondsLeft(token: string, now = Date.now()): number | null {
  const exp = tokenClaims(token)?.exp;
  return typeof exp === "number" ? exp - now / 1000 : null;
}
