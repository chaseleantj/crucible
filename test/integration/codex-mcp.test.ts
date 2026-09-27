import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { codexMcpArguments } from "../../src/adapters.js";
import { tempDirectory } from "../support/files.js";

const exec = promisify(execFile);

test("Codex parses MCP overrides with the exact server name and literal arguments", async (t) => {
  const dir = await tempDirectory(t, "crucible-mcp-cli-");
  const server = { command: "/path with spaces/tool", args: ['a"b', "", "line\nnext"], env: { TOKEN: "test-only-value" } };
  const { stdout } = await exec("codex", [...codexMcpArguments({ agent: "codex", timeoutMs: 1000, mcpServers: { smoke_test: server } }), "mcp", "get", "smoke_test", "--json"], {
    env: { ...process.env, CODEX_HOME: dir }, timeout: 15000,
  });
  const actual = JSON.parse(stdout);
  assert.equal(actual.name, "smoke_test");
  assert.equal(actual.transport.command, server.command);
  assert.deepEqual(actual.transport.args, server.args);
  assert.deepEqual(actual.transport.env, server.env);
});
