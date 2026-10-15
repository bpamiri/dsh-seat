// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";

import { AcpClient, AcpError } from "../src/acp.mjs";
import { FAKE_AGENT } from "./helpers.mjs";

function start(env = {}) {
  const client = new AcpClient({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    requestTimeoutMs: 10_000,
  });
  client.start();
  return client;
}

test("initialize / session/new / prompt / close round-trip", async (t) => {
  const client = start({ FAKE_ACP_CHUNKS: "po|ng" });
  t.after(() => client.dispose());

  const init = await client.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentInfo.name, "fake-acp");

  const created = await client.newSession({ cwd: process.cwd() });
  assert.equal(created.sessionId, "session-fake-1");

  const updates = [];
  client.on("notification", ({ method, params }) => {
    if (method === "session/update") updates.push(params.update);
  });

  const result = await client.prompt({ sessionId: created.sessionId, text: "hi" });
  assert.equal(result.stopReason, "end_turn");
  assert.equal(updates.map((update) => update.content?.text ?? "").join(""), "pong");

  await client.closeSession({ sessionId: created.sessionId });
});

test("server->client session/request_permission is surfaced and the answer reaches the agent", async (t) => {
  const client = start({ FAKE_ACP_ASK_PERMISSION: "1", FAKE_ACP_CHUNKS: "done" });
  t.after(() => client.dispose());

  const seen = [];
  client.on("request", ({ method, params, respond }) => {
    seen.push({ method, title: params.toolCall.title, options: params.options.length });
    respond({ outcome: { outcome: "selected", optionId: "reject-once" } });
  });

  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: process.cwd() });
  const updates = [];
  client.on("notification", ({ method, params }) => {
    if (method === "session/update") updates.push(params.update);
  });

  await client.prompt({ sessionId, text: "go" });

  assert.deepEqual(seen, [{ method: "session/request_permission", title: "Run a dangerous command", options: 3 }]);
  assert.equal(updates.map((update) => update.content?.text ?? "").join(""), "done|permission=reject-once");
});

test("a JSON-RPC error becomes an AcpError carrying the code", async (t) => {
  const client = start();
  t.after(() => client.dispose());
  await client.initialize();

  await assert.rejects(
    () => client.request("session/does-not-exist", {}),
    (err) => err instanceof AcpError && err.code === -32601 && /no such method/.test(err.message),
  );
});

test("a failed resume is reported, not silently converted to a fresh session", async (t) => {
  const client = start({ FAKE_ACP_RESUME_FAILS: "1" });
  t.after(() => client.dispose());
  await client.initialize();

  await assert.rejects(
    () => client.resumeSession({ sessionId: "session-gone", cwd: process.cwd() }),
    (err) => err instanceof AcpError && /resume refused/.test(err.message),
  );
});

test("non-JSON output on the protocol channel is surfaced, never parsed as a frame", async (t) => {
  const client = start({ FAKE_ACP_GARBAGE: "1", FAKE_ACP_CHUNKS: "ok" });
  t.after(() => client.dispose());

  const noise = [];
  client.on("stdout", ({ line }) => noise.push(line));

  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: process.cwd() });
  await client.prompt({ sessionId, text: "go" });

  assert.equal(noise.length, 1);
  assert.match(noise[0], /not JSON/);
});

test("requests against a dead agent fail loudly instead of hanging", async (t) => {
  const client = start();
  await client.initialize();
  await client.dispose();

  await assert.rejects(
    () => client.request("session/new", { cwd: process.cwd(), mcpServers: [] }),
    (err) => err instanceof AcpError && /not running/.test(err.message),
  );
});
