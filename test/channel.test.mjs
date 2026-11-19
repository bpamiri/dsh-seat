// SPDX-License-Identifier: Apache-2.0
// The run-bound native channel (contract v0.7.19): framing, custody before any
// native effect, retained receipts, retryable vs permanent refusals, turn
// reports, the refusal-before-effect rule, and the delivery-failure surface.
import test from "node:test";
import assert from "node:assert/strict";

import { CHANNEL_PATH, createNativeChannel, isPermanentRefusal, runnerFrameBound } from "../src/channel.mjs";

const BASE = "http://127.0.0.1:7551";
const RUN = "run-chan-1";

/** A scripted fetch: responses in order, and a recording of every call. */
function scripted(replies = [], { stream } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? "GET", url, headers: init.headers ?? {}, body });
    const reply = replies.length ? replies[Math.min(calls.filter((c) => (c.method ?? "GET") === (init.method ?? "GET")).length - 1, replies.length - 1)] : { status: 200, body: { ok: true } };
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body, body: null };
  };
  const streamImpl = stream ?? (async () => ({ ok: false, status: 503, json: async () => ({ code: "unavailable" }), body: null }));
  return { fetchImpl, streamImpl, calls };
}

function harness({ replies = [], stream, delivery } = {}) {
  const { fetchImpl, streamImpl, calls } = scripted(replies, { stream });
  const logs = [];
  const unavailable = [];
  const channel = createNativeChannel({
    base: BASE, token: "oag_run_token", runId: RUN, fetchImpl, streamImpl,
    log: (line) => logs.push(line), onUnavailable: (reason) => unavailable.push(reason),
    delivery: delivery ?? { input() {}, wake() {}, cancel() {} },
    reconnectMs: 1,
  });
  return { channel, calls, logs, unavailable };
}

const frame = (over = {}) => ({ version: 1, runId: RUN, requestId: "req-1", sequence: 1, kind: "input", payload: { text: "hello" }, ...over });

/** An SSE body that emits the given frames, then closes. */
function sse(frames, { chars = true, extraComment } = {}) {
  const chunks = [];
  for (const item of frames) {
    const data = JSON.stringify(item);
    chunks.push(`${chars ? `: runner-frame-chars=${data.length}\n` : ""}${extraComment ? `: ${extraComment}\n` : ""}data: ${data}\n\n`);
  }
  let index = 0;
  return {
    ok: true, status: 200,
    body: {
      pipeThrough() {
        return {
          getReader: () => ({
            read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
            cancel: async () => {},
          }),
        };
      },
    },
  };
}

test("frame framing: runner-frame-chars bounds the event and is checked exactly", () => {
  const data = JSON.stringify(frame());
  assert.deepEqual(runnerFrameBound(`: runner-frame-chars=${data.length}\ndata: ${data}\n\n`).chars, data.length);
  assert.equal(runnerFrameBound("data: {}\n\n").chars, undefined, "no comment falls back to the bounded envelope");
  assert.throws(() => runnerFrameBound(": runner-frame-chars=0\ndata: {}\n\n"), /invalid channel frame size/);
});

test("a frame is delivered only after custody is acknowledged, and turn reports carry a native id", async () => {
  const seen = [];
  const { channel, calls } = harness({ delivery: { input: (f, e) => { seen.push(f); e.markSubmitted("dsh-prompt-1", "1"); }, wake() {}, cancel() {} } });
  await channel.accept(frame());
  assert.equal(seen.length, 1, "the frame reached delivery once");
  const posts = calls.filter((call) => call.method === "POST").map((call) => call.body.type);
  assert.deepEqual(posts, ["ack", "submitted"]);
  assert.equal(calls[0].url, `${BASE}${CHANNEL_PATH}`);
  assert.equal(calls[0].body.state, "accepted");
  assert.equal(calls[1].body.nativeTurnId, "dsh-prompt-1");
});

test("a duplicate frame is reconciled without a repeated native effect; a conflicting reuse is refused", async () => {
  let delivered = 0;
  const { channel, calls } = harness({ delivery: { input: () => { delivered += 1; }, wake() {}, cancel() {} } });
  await channel.accept(frame());
  await channel.accept(frame());
  assert.equal(delivered, 1, "the same immutable request is never delivered twice");
  assert.equal(calls.filter((call) => call.body?.type === "ack").length, 1);

  await channel.accept(frame({ payload: { text: "different text" } }));
  assert.equal(delivered, 1, "a conflicting payload for the same request ID has no effect");

  await channel.accept(frame({ requestId: "req-2", sequence: 1 }));
  assert.equal(delivered, 1, "a conflicting sequence is refused");
});

test("an invalid or foreign frame is refused before any effect", async () => {
  let effects = 0;
  const { channel } = harness({ delivery: { input: () => { effects += 1; }, wake() {}, cancel() {} } });
  await channel.accept(frame({ runId: "other-run" }));
  await channel.accept(frame({ version: 2 }));
  await channel.accept(frame({ kind: "shell" }));
  await channel.accept(frame({ kind: "input", payload: {} }));
  await channel.accept(frame({ kind: "wake", payload: { question: 5 } }));
  await channel.accept(frame({ kind: "cancel", payload: { target: { runId: RUN } } }));
  await channel.accept(frame({ sequence: 0 }));
  assert.equal(effects, 0, "nothing was delivered, and nothing was typed as a fallback");
});

test("runner_grant_unverified / pending / hello-required retry the saved receipt; a permanent refusal quarantines", async () => {
  // ack refused twice with retryable codes, then accepted.
  let ackAttempts = 0;
  const replies = [
    { status: 409, body: { code: "runner_grant_unverified" } },
    { status: 409, body: { code: "runner_grant_pending" } },
    { status: 200, body: { ok: true } },
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? "GET", body });
    if (init.method === "POST") {
      const reply = replies[Math.min(ackAttempts, replies.length - 1)];
      ackAttempts += 1;
      calls[calls.length - 1].replyCode = reply.body?.code ?? "accepted";
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const channel = createNativeChannel({ base: BASE, token: "t", runId: RUN, fetchImpl,
    streamImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: "unavailable" }), body: null }),
    reconnectMs: 1, delivery: { input() { calls.push({ delivered: true }); }, wake() {}, cancel() {} } });
  await channel.accept(frame());
  assert.equal(calls.filter((call) => call.delivered).length, 1, "delivery happened after the retries");
  assert.deepEqual(calls.filter((call) => call.replyCode).map((call) => call.replyCode),
    ["runner_grant_unverified", "runner_grant_pending", "accepted"]);

  // A positive revocation quarantines and reports the requests it could not deliver.
  const unavailable = [];
  const revoked = async (url, init) => (init.method === "POST"
    ? { ok: false, status: 401, json: async () => ({ code: "runner_grant_revoked" }) }
    : { ok: true, status: 200, json: async () => ({}) });
  const quarantined = createNativeChannel({ base: BASE, token: "t", runId: RUN, fetchImpl: revoked,
    streamImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: "unavailable" }), body: null }),
    reconnectMs: 1, onUnavailable: (reason) => unavailable.push(reason),
    delivery: { input() {}, wake() {}, cancel() {} } });
  await quarantined.accept(frame());
  assert.equal(quarantined.quarantined, true);
  assert.match(unavailable.join("\n"), /runner_grant_revoked/);
});

test("turn reports post opened and closed with the accepted turn id", async () => {
  const { channel, calls } = harness();
  await channel.reportTurn({ nativeTurnId: "dsh-prompt-1", state: "opened", acceptedTurnId: "1" });
  await channel.reportTurn({ nativeTurnId: "dsh-prompt-1", state: "closed", acceptedTurnId: "1" });
  const turns = calls.filter((call) => call.body?.type === "turn").map((call) => call.body);
  assert.deepEqual(turns.map((t) => [t.state, t.nativeTurnId, t.acceptedTurnIds]), [["opened", "dsh-prompt-1", ["1"]], ["closed", "dsh-prompt-1", ["1"]]]);
  assert.deepEqual(turns.map((t) => t.sequence), [1, 2]);
});

test("a channel that drops mid-run reports unavailable instead of looking idle", async () => {
  let attempt = 0;
  const streamImpl = async () => {
    attempt += 1;
    if (attempt === 1) return sse([frame()]);
    throw new Error("connection reset");
  };
  const { channel, unavailable } = harness({ stream: streamImpl, delivery: { input() {}, wake() {}, cancel() {} } });
  const connecting = channel.connect();
  await new Promise((resolve) => setTimeout(resolve, 60));
  channel.stop();
  await connecting;
  assert.ok(unavailable.length >= 1, "the drop was surfaced");
  assert.match(unavailable.join("\n"), /disconnected/);
});

test("hello advertises explicit capabilities for what this implementation does", async () => {
  const { channel, calls } = harness();
  const connecting = channel.connect();
  await new Promise((resolve) => setTimeout(resolve, 40));
  channel.stop();
  await connecting;
  const hello = calls.find((call) => call.body?.type === "hello");
  assert.ok(hello, "a hello was posted");
  assert.deepEqual(hello.body.capabilities, { input: true, wake: true, cancel: true });
  assert.equal(hello.body.version, 1);
  assert.equal(hello.body.runId, RUN);
  assert.equal(hello.body.retained, false, "first hello: nothing retained yet");
});

test("a rejected receipt nests its detail under result, and a cancel submission carries one", async () => {
  // Core validates the body: `kind`, `reason` and `applied` at the top level are
  // a 400 forever, so the shape is pinned here.
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? "GET", body });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const channel = createNativeChannel({ base: BASE, token: "t", runId: RUN, fetchImpl,
    streamImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: "unavailable" }), body: null }),
    reconnectMs: 1, delivery: { input() {}, wake() {}, cancel(frame, entry) {
      entry.markSubmitted("dsh-prompt-1", "1", { result: { kind: "cancel", outcome: "requested", confirmed: false, operationAccepted: false } });
      entry.reject("cancellation_in_progress");
    } } });
  await channel.accept(frame({ kind: "cancel", payload: { target: { runId: RUN, nativeTurnId: "dsh-prompt-1" } } }));
  await channel.drain(500);
  const rejected = calls.map((call) => call.body).find((body) => body?.type === "rejected");
  assert.ok(rejected, "a rejected receipt was posted");
  assert.equal(rejected.kind, undefined, "kind is not a top-level field");
  assert.deepEqual(rejected.result, { kind: "cancel", reason: "cancellation_in_progress", applied: false });
  const submitted = calls.map((call) => call.body).find((body) => body?.type === "submitted");
  assert.deepEqual(submitted.result, { kind: "cancel", outcome: "requested", confirmed: false, operationAccepted: false });
});

test("a 400 invalid receipt is permanent: it is not retried, and the entry is retired", async () => {
  let posts = 0;
  const fetchImpl = async (url, init) => {
    if ((init.method ?? "GET") === "POST") {
      posts += 1;
      return { ok: false, status: 400, json: async () => ({ code: "invalid_runner_result" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const channel = createNativeChannel({ base: BASE, token: "t", runId: RUN, fetchImpl,
    streamImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: "unavailable" }), body: null }),
    reconnectMs: 1, delivery: { input() {}, wake() {}, cancel() {} } });
  await channel.accept(frame());
  assert.equal(posts, 1, "a malformed receipt is posted once, not retried");
  assert.equal(channel.quarantined, true);
});
