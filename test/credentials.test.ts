import assert from "node:assert/strict";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { secondsLeft, standInToken, startBroker, tokenClaims } from "../src/credentials.js";

/** A provider that records what reached it and answers with the path it saw. */
async function fakeProvider(t: test.TestContext) {
  const seen: Array<{ path: string; authorization?: string; apiKey?: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        path: request.url ?? "",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers["x-api-key"] === "string" ? { apiKey: request.headers["x-api-key"] } : {}),
        body,
      });
      response.writeHead(200, { "content-type": "text/plain" }).end(`ok ${request.url}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/base`, seen };
}

test("the broker swaps the agent's stand-in for the real credential, and refuses anything else", async (t) => {
  const provider = await fakeProvider(t);
  let secret = "real-1";
  const broker = await startBroker({ upstream: provider.url, allow: ["/v1/messages"], secret: async () => secret });
  t.after(() => broker.close());

  const ok = await fetch(`${broker.url}/v1/messages?beta=true`, { method: "POST", headers: { authorization: `Bearer ${broker.standIn}` }, body: "hello" });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "ok /base/v1/messages?beta=true", "the upstream base path is kept");
  assert.deepEqual(provider.seen.at(-1), { path: "/base/v1/messages?beta=true", authorization: "Bearer real-1", body: "hello" });

  secret = "real-2";
  await fetch(`${broker.url}/v1/messages`, { method: "POST", headers: { "x-api-key": broker.standIn }, body: "" });
  assert.equal(provider.seen.at(-1)!.apiKey, "real-2", "the credential is read on every request, so a refresh carries through");

  const count = provider.seen.length;
  const stranger = await fetch(`${broker.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer guess" }, body: "" });
  assert.equal(stranger.status, 403, "a request without the stand-in gets nothing");
  const offPath = await fetch(`${broker.url}/api/oauth/profile`, { headers: { authorization: `Bearer ${broker.standIn}` } });
  assert.equal(offPath.status, 404, "only the provider API paths the agent needs");
  assert.equal(provider.seen.length, count, "refused requests never reach the provider");
});

test("a stand-in shaped like a signed token is replaced whole", async (t) => {
  const provider = await fakeProvider(t);
  const broker = await startBroker({ upstream: provider.url, allow: ["/"], secret: async () => "head.real.signature" });
  t.after(() => broker.close());
  const token = standInToken({ exp: 2_000_000_000, "https://api.openai.com/auth": { plan: "pro" } }, broker.standIn);
  assert.deepEqual(tokenClaims(token), { exp: 2_000_000_000, "https://api.openai.com/auth": { plan: "pro" } }, "the CLI can still read its claims");
  await fetch(`${broker.url}/backend-api/codex/responses`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "" });
  assert.equal(provider.seen.at(-1)!.authorization, "Bearer head.real.signature");
});

test("a credential that cannot be read fails the request, not the run", async (t) => {
  const provider = await fakeProvider(t);
  const broker = await startBroker({ upstream: provider.url, allow: ["/"], secret: async () => { throw new Error("login gone"); } });
  t.after(() => broker.close());
  const response = await fetch(`${broker.url}/v1/messages`, { headers: { authorization: `Bearer ${broker.standIn}` } });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /login gone/);
  assert.equal(provider.seen.length, 0);
});

test("an HTTP/2 stream is brokered too, trailers and all", async (t) => {
  const seen: Array<{ path: string; authorization?: string }> = [];
  const provider = http2.createServer();
  provider.on("stream", (stream, headers) => {
    seen.push({ path: String(headers[":path"]), ...(headers.authorization ? { authorization: String(headers.authorization) } : {}) });
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end("chunk");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => provider.close());
  const broker = await startBroker({ upstream: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, allow: ["/agent.v1."], secret: async () => "real" });
  t.after(() => broker.close());
  const client = http2.connect(broker.url);
  t.after(() => client.close());
  const call = (path: string, authorization: string) => new Promise<{ status: number; body: string; trailers: Record<string, unknown> }>((resolve, reject) => {
    const stream = client.request({ ":method": "POST", ":path": path, authorization });
    let status = 0;
    let body = "";
    let trailers: Record<string, unknown> = {};
    stream.on("response", (headers) => (status = Number(headers[":status"])));
    stream.on("trailers", (received) => (trailers = received));
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => resolve({ status, body, trailers }));
    stream.on("error", reject);
    stream.end();
  });
  const ok = await call("/agent.v1.AgentService/Run", `Bearer ${broker.standIn}`);
  assert.deepEqual({ status: ok.status, body: ok.body, grpc: ok.trailers["grpc-status"] }, { status: 200, body: "chunk", grpc: "0" });
  assert.deepEqual(seen, [{ path: "/agent.v1.AgentService/Run", authorization: "Bearer real" }]);
  assert.equal((await call("/agent.v1.AgentService/Run", "Bearer guess")).status, 403);
  assert.equal((await call("/aiserver.v1.Other/Thing", `Bearer ${broker.standIn}`)).status, 404);
  assert.equal(seen.length, 1);
});

test("an HTTPS broker presents a certificate that only its own authority vouches for", async (t) => {
  const provider = await fakeProvider(t);
  const broker = await startBroker({ upstream: provider.url, allow: ["/v1/"], secret: async () => "real", tls: true });
  t.after(() => broker.close());
  assert.match(broker.url, /^https:\/\/127\.0\.0\.1:/);
  assert.match(broker.certificateAuthority ?? "", /BEGIN CERTIFICATE/);
  const get = (ca?: string) => new Promise<number>((resolve, reject) => {
    https.get(`${broker.url}/v1/models`, { ...(ca ? { ca } : {}), headers: { authorization: `Bearer ${broker.standIn}` } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on("error", reject);
  });
  assert.equal(await get(broker.certificateAuthority), 200);
  assert.equal(provider.seen.at(-1)!.authorization, "Bearer real");
  await assert.rejects(get(), /self-signed|unable to verify|certificate/i, "nothing else trusts it");
});

test("secondsLeft reads a token's expiry and ignores anything that is not a token", () => {
  const now = 1_000_000_000_000;
  assert.equal(secondsLeft(standInToken({ exp: now / 1000 + 60 }, "x"), now), 60);
  assert.equal(secondsLeft("not-a-token"), null);
});
