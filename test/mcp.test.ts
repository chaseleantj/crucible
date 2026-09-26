import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeMcpServers, codexMcpArguments } from "../src/adapters.js";
import { agentIdentity, describeToolSetup, loadConfig, producerFor } from "../src/config.js";

test("explicit MCP config merges by server, preserves literal values, and reports names only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crucible-mcp-"));
  try {
    const path = join(dir, "experiment.json");
    const shared = { old: { command: "shared" }, blender: { command: "old", env: { OLD: "old" } } };
    const server = { command: "/path with spaces/uvx", args: ["", "a\\b", 'a"b', "line\nnext"], env: { TOKEN: "private-token" } };
    const input = {
      name: "mcp", source: { path: ".", include: ["*"] }, task: "create a cube",
      producer: { agent: "codex", mcpServers: shared },
      arms: [{}, { producer: { mcpServers: { blender: server } } }],
      judge: { agent: "codex", rubric: "rubric.md" },
    };
    await writeFile(path, JSON.stringify(input));
    const config = await loadConfig(path);
    const producer = producerFor(config.producer, config.arms[1]!);
    assert.deepEqual(producer.mcpServers, { blender: server, old: shared.old });
    assert.deepEqual(agentIdentity(producer).mcpServers, ["blender", "old"]);
    assert.ok(!JSON.stringify(describeToolSetup("arm", agentIdentity(producer))).includes("private-token"));
    const args = codexMcpArguments(producer);
    assert.equal(args[0], "-c");
    assert.ok(args[1]!.includes('mcp_servers.blender='));
    assert.ok(args[1]!.includes('"TOKEN" = "private-token"'));
    assert.ok(args[1]!.includes("startup_timeout_sec = 60"));
    assert.ok(args[1]!.includes("required = true"));
    assert.ok(args[1]!.includes(JSON.stringify(server.args)));
    assert.deepEqual(codexMcpArguments({ agent: "codex", timeoutMs: 1 }), []);
    for (const invalid of [
      { blender: { command: "uvx", url: "https://example.com" } },
      { blender: { command: "uvx", args: [3] } },
      { "bad.name": { command: "uvx" } },
      { blender: { command: "uvx", env: { HOME: "/real/home" } } },
    ]) {
      await writeFile(path, JSON.stringify({ ...input, producer: { agent: "codex", mcpServers: invalid } }));
      await assert.rejects(loadConfig(path), /mcpServers/);
    }
    await writeFile(path, JSON.stringify({ ...input, producer: { agent: "claude", mcpServers: shared } }));
    const claude = await loadConfig(path);
    assert.deepEqual(claudeMcpServers(producerFor(claude.producer, claude.arms[0]!)), {
      old: { type: "stdio", command: "shared" },
      blender: { type: "stdio", command: "old", env: { OLD: "old" } },
    });
    assert.deepEqual(claudeMcpServers({ agent: "claude", timeoutMs: 1 }), {});
    await writeFile(path, JSON.stringify({ ...input, producer: { agent: "cursor", mcpServers: shared } }));
    await assert.rejects(loadConfig(path), /cursor/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Codex parses MCP overrides with the exact server name and literal arguments", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "crucible-mcp-cli-"));
  try {
    const server = { command: "/path with spaces/tool", args: ['a"b', "", "line\nnext"], env: { TOKEN: "test-only-value" } };
    let stdout: string;
    try {
      ({ stdout } = await exec("codex", [...codexMcpArguments({ agent: "codex", timeoutMs: 1000, mcpServers: { smoke_test: server } }), "mcp", "get", "smoke_test", "--json"], {
        env: { ...process.env, CODEX_HOME: dir }, timeout: 15000,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("Codex CLI not installed"); return; }
      throw error;
    }
    const actual = JSON.parse(stdout);
    assert.equal(actual.name, "smoke_test");
    assert.equal(actual.transport.command, server.command);
    assert.deepEqual(actual.transport.args, server.args);
    assert.deepEqual(actual.transport.env, server.env);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
