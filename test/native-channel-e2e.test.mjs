// SPDX-License-Identifier: Apache-2.0
// Native channel end-to-end, against the real runner entry and a controlled SSE
// stand-in for Core: input becomes exactly one native prompt, a wake is answered
// only by its own prompt's text, a named cancel reports requested first and
// cancelled only on the agent's own stop reason, a stale target is not-this-turn,
// and a channel that fails is reported instead of looking idle.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "dsh-seat");
const fake = join(here, "contract-fake-agent.mjs");
const RUN = "run-native-e2e";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(25);
  }
}

/** A stand-in Core: POST receipts, and a GET stream the test pushes frames into. */
async function standIn(t, {
  refuseAckWith = null, delayAckSequence = null, prepareConfirmedAfter = 0, validate = true,
} = {}) {
  const posts = [];
  const rejectedPosts = [];
  const frames = [];
  const waiters = new Set();
  const prepCalls = [];
  // The shape rules Core enforces (runner-channel.ts): a result is required for
  // rejected/completed and for a cancel's submitted, and it must be nested.
  const validateReceipt = (body) => {
    if (body.type === "hello") return body.version === 1 ? null : "invalid_runner_hello";
    if (body.type === "turn") return typeof body.nativeTurnId === "string" ? null : "invalid_runner_turn";
    if (!["ack", "submitted", "rejected", "result"].includes(body.type)) return "invalid_runner_receipt";
    if (body.type === "ack") return body.state === "accepted" ? null : "invalid_runner_receipt";
    if (body.type === "rejected" || body.type === "result" || (body.type === "submitted" && body.result !== undefined)) {
      const result = body.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) return "invalid_runner_result";
      if (result.kind === "cancel") {
        if (typeof result.outcome !== "string" || typeof result.confirmed !== "boolean") return "invalid_runner_result";
        if (body.type === "submitted") {
          if (!prepCalls.at(-1)?.confirmed) return "runner_withdrawal_unconfirmed";
          if (result.outcome !== "requested" || result.confirmed !== false) return "invalid_runner_result";
        }
        if (result.confirmed !== (result.outcome === "cancelled")) return "invalid_runner_result";
      }
      if (body.type === "rejected" && result.kind !== "cancel"
        && (typeof result.reason !== "string" || !result.reason)) return "invalid_runner_result";
      if (result.ownershipUnknown !== undefined
        && (result.kind !== "wake" || result.completion !== "unknown" || result.answer !== null)) return "invalid_runner_result";
      if (result.kind === "wake" && body.type === "result"
        && (result.completion !== "completed" && result.answer !== null)) return "invalid_runner_result";
    }
    if (body.type === "submitted" && body.result === undefined && ["input", "wake"].includes(body.result?.kind)) return null;
    return null;
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.url !== "/api/activity/runner-channel") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const pump = () => {
          while (frames.length) {
            const item = frames.shift();
            const data = JSON.stringify(item);
            res.write(`: runner-frame-chars=${data.length}\ndata: ${data}\n\n`);
          }
        };
        pump();
        waiters.add(pump);
        // The request stream ends immediately for a GET; the response closing is
        // what ends this subscriber. Removing on req close would drop the pump.
        res.on("close", () => waiters.delete(pump));
        return;
      }
      const body = raw ? JSON.parse(raw) : {};
      if (body.type === "cancel-prepare") {
        prepCalls.push({ confirmed: prepCalls.length >= prepareConfirmedAfter });
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ withdrawal: { confirmed: prepCalls.at(-1).confirmed } }));
        return;
      }
      posts.push({ type: body.type, body });
      const problem = validate ? validateReceipt(body) : null;
      if (problem) {
        rejectedPosts.push({ type: body.type, code: problem, body });
        res.writeHead(problem === "runner_withdrawal_unconfirmed" ? 409 : 400, { "content-type": "application/json" })
          .end(JSON.stringify({ code: problem }));
        return;
      }
      if (body.type === "ack" && refuseAckWith) {
        res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ code: refuseAckWith }));
        return;
      }
      if (body.type === "ack" && delayAckSequence && body.sequence === delayAckSequence) {
        setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })); }, 300);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    posts,
    push(frame) { frames.push({ version: 1, runId: RUN, ...frame }); for (const pump of waiters) pump(); },
    ofType: (type) => posts.filter((post) => post.type === type).map((post) => post.body),
    rejectedPosts,
    prepCalls,
  };
}

function startRunner(t, { base, agentArgs = [], runId = RUN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-seat-native-"));
  const log = join(dir, "agent.jsonl");
  const record = join(dir, "record.json");
  const child = spawn(process.execPath, [
    bin, "--agent-command", `${process.execPath} ${fake} --log ${log} --mode native ${agentArgs.map((a) => `'${a}'`).join(" ")}`,
  ], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(dir, "dsh-home"),
      OPENRIG_URL: base, OPENRIG_ACTIVITY_HOOK_TOKEN: "oag_native_token",
      ...(runId ? { OPENRIG_RUN_ID: runId } : {}),
      OPENRIG_SESSION_NAME: "native@rig", OPENRIG_NODE_ID: "node-native", OPENRIG_RUNTIME: "dsh",
      OPENRIG_OCCUPANT_GENERATION: "gen-native", OPENRIG_LAUNCH_RESULT: record, OPENRIG_LAUNCH_ATTEMPT: "a1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  t.after(() => { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  return { child, dir, log, record, out: () => out };
}
const prompts = (path) => {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry.method === "session/prompt").map((entry) => entry.params.prompt.map((part) => part.text).join(""));
  } catch { return []; }
};

test("native input reaches the agent as exactly one prompt, and is acknowledged", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]), "no hello");
  core.push({ requestId: "req-input-1", sequence: 1, kind: "input", payload: { text: "one native message" } });
  assert.ok(await waitFor(() => prompts(run.log)[0]), "the native input never became a prompt");
  assert.deepEqual(prompts(run.log), ["one native message"], "exactly one prompt, byte for byte");
  assert.ok(await waitFor(() => core.ofType("ack").length === 1), "custody was not acknowledged");
  assert.ok(await waitFor(() => core.ofType("submitted").length === 1), "the submission was not reported");
  const submitted = core.ofType("submitted")[0];
  assert.equal(submitted.nativeTurnId, "dsh-prompt-1");
  const turns = core.ofType("turn").map((turn) => turn.state);
  assert.deepEqual(turns, ["opened", "closed"], "the invocation was reported opened then closed");
});

test("a wake is answered only by its own dedicated prompt's text", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-wake-1", sequence: 1, kind: "wake", payload: { question: "WAKE:are you there?" } });
  const result = await waitFor(() => core.ofType("result").find((r) => r.result?.kind === "wake"));
  assert.ok(result, `no wake result; pane: ${run.out()}`);
  assert.deepEqual(result.result, { kind: "wake", answer: "answer WAKE:are you there?", nativeTurnId: "dsh-prompt-1", completion: "completed" });
  assert.equal(prompts(run.log).length, 1, "the wake is one dedicated prompt");
});

test("a named cancel is requested first, and cancelled only on the agent's stop reason", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-hold-1", sequence: 1, kind: "input", payload: { text: "please HOLD" } });
  assert.ok(await waitFor(() => prompts(run.log)[0]), "the holding prompt never started");
  assert.ok(await waitFor(() => core.ofType("turn").some((turn) => turn.state === "opened")), "no opened turn report");
  const opened = core.ofType("turn").find((turn) => turn.state === "opened");
  core.push({ requestId: "req-cancel-1", sequence: 2, kind: "cancel", payload: { target: { runId: RUN, nativeTurnId: opened.nativeTurnId } } });
  const submitted = await waitFor(() => core.ofType("submitted").find((post) => post.result?.kind === "cancel"));
  assert.ok(submitted, `no cancel submission; pane: ${run.out()}`);
  assert.deepEqual(submitted.result, { kind: "cancel", outcome: "requested", confirmed: false, operationAccepted: false });
  const result = await waitFor(() => core.ofType("result").find((post) => post.result?.kind === "cancel"));
  assert.ok(result, "no cancel result");
  assert.deepEqual(result.result, { kind: "cancel", outcome: "cancelled", confirmed: true });
  assert.ok(core.prepCalls.length >= 1, "cancel-prepare was not posted");
});

test("a cancel for a target this runner does not have is not-this-turn", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-cancel-x", sequence: 1, kind: "cancel", payload: { target: { runId: RUN, nativeTurnId: "dsh-prompt-999" } } });
  const result = await waitFor(() => core.ofType("result").find((post) => post.result?.kind === "cancel"));
  assert.ok(result, `no cancel result; pane: ${run.out()}`);
  assert.deepEqual(result.result, { kind: "cancel", outcome: "not-this-turn", confirmed: false });
});

test("an unacknowledged delivery is reported unavailable, and is never typed as a fallback", async (t) => {
  // Every ack is refused with a permanent code: the run authority is gone.
  const core = await standIn(t, { refuseAckWith: "runner_grant_revoked" });
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-lost-1", sequence: 1, kind: "input", payload: { text: "must not be typed" } });
  assert.ok(await waitFor(() => /native channel quarantined/.test(run.out())), `no quarantine line; pane: ${run.out()}`);
  await sleep(200);
  assert.deepEqual(prompts(run.log), [], "nothing was written to the agent");
  assert.equal(core.ofType("submitted").length, 0, "nothing was claimed as submitted");
  assert.match(run.out(), /no request was delivered/);
});

test("without a run id nothing connects, so typed seats are unaffected", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base, runId: null });
  assert.ok(await waitFor(() => run.record && existsSyncSafe(run.record)), "no launch record");
  await sleep(150);
  assert.equal(core.posts.length, 0, "no channel post without a run-bound credential");
  assert.equal(core.ofType("hello").length, 0);
});
function existsSyncSafe(path) { try { readFileSync(path); return true; } catch { return false; } }

test("a failed wake is failed with no answer: partial text is never promoted", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-wake-fail", sequence: 1, kind: "wake", payload: { question: "WAKE:FAIL" } });
  const result = await waitFor(() => core.ofType("result").find((post) => post.result?.kind === "wake"));
  assert.ok(result, `no wake result; pane: ${run.out()}`);
  assert.equal(result.result.completion, "failed", "a failed prompt is failed, not completed");
  assert.equal(result.result.answer, null, "partial text must never become an answer");
  assert.doesNotMatch(JSON.stringify(result.result), /partial-text-before-error/);
});

test("a wake whose agent exits mid-turn reports a failed/unknown completion with no answer", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-wake-exit", sequence: 1, kind: "wake", payload: { question: "WAKE:EXIT" } });
  const result = await waitFor(() => core.ofType("result").find((post) => post.result?.kind === "wake"), 10000);
  assert.ok(result, `no wake result; pane: ${run.out()}`);
  assert.ok(["failed", "unknown"].includes(result.result.completion), `completion was ${result.result.completion}`);
  assert.equal(result.result.answer, null);
  assert.doesNotMatch(JSON.stringify(result.result), /partial-text-before-exit/);
});

test("cancel-prepare polls while Core's withdrawal is unconfirmed, then proceeds", async (t) => {
  const core = await standIn(t, { prepareConfirmedAfter: 3 });
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-hold-2", sequence: 1, kind: "input", payload: { text: "please HOLD" } });
  assert.ok(await waitFor(() => prompts(run.log)[0]));
  const opened = await waitFor(() => core.ofType("turn").find((turn) => turn.state === "opened"));
  core.push({ requestId: "req-cancel-2", sequence: 2, kind: "cancel", payload: { target: { runId: RUN, nativeTurnId: opened.nativeTurnId } } });
  const submitted = await waitFor(() => core.ofType("submitted").find((post) => post.result?.kind === "cancel"));
  assert.ok(submitted, `cancel never proceeded after an unconfirmed withdrawal; pane: ${run.out()}`);
  assert.ok(core.prepCalls.length >= 4, `expected repeated preparation, saw ${core.prepCalls.length}`);
  assert.ok(core.prepCalls.slice(0, 3).every((call) => call.confirmed === false), "the first polls were unconfirmed");
  assert.deepEqual(core.rejectedPosts, [], "no malformed receipt was posted");
});

test("a pre-effect rejection is posted with the result nested, as Core validates it", async (t) => {
  const core = await standIn(t);
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-reject-1", sequence: 1, kind: "input", payload: { text: "please REJECT" } });
  const rejected = await waitFor(() => core.ofType("rejected")[0]);
  assert.ok(rejected, `no rejected receipt; pane: ${run.out()}`);
  assert.deepEqual(Object.keys(rejected).sort(),
    ["acceptedTurnId", "nativeTurnId", "requestId", "result", "runId", "sequence", "type"]);
  assert.equal(rejected.kind, undefined, "kind belongs under result, not at the top level");
  assert.deepEqual(rejected.result, { kind: "input", reason: "native_prompt_rejected", applied: false });
  assert.deepEqual(core.rejectedPosts, [], "Core accepted the rejected receipt");
});

test("delivery follows sequence order even when a lower ack arrives last", async (t) => {
  const core = await standIn(t, { delayAckSequence: 1 });
  const run = startRunner(t, { base: core.base });
  assert.ok(await waitFor(() => core.ofType("hello")[0]));
  core.push({ requestId: "req-first", sequence: 1, kind: "input", payload: { text: "FIRST" } });
  core.push({ requestId: "req-second", sequence: 2, kind: "input", payload: { text: "SECOND" } });
  assert.ok(await waitFor(() => prompts(run.log).length === 2, 10000), `pane: ${run.out()}`);
  assert.deepEqual(prompts(run.log), ["FIRST", "SECOND"], "run-local sequence order, not ack arrival order");
});
