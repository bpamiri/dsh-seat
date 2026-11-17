// SPDX-License-Identifier: Apache-2.0
// Run-bound observation reports (contract v0.7.18 §4): shape, receipts/retries,
// the refusal codes, and change-only/renewal behaviour. A recording fetch stands
// in for the daemon, so no port is opened.
import test from "node:test";
import assert from "node:assert/strict";

import {
  GRANT_PENDING, GRANT_UNVERIFIED, OBSERVATION_UNAVAILABLE, OBSERVATION_UNVERIFIED, RENEW_AFTER_MS,
  createObservationReporter, modelIdFromConfigReply, modelIdFromSelector,
} from "../src/observation.mjs";

const BASE = "http://127.0.0.1:7441";

/** A fetch whose replies are scripted per call. */
function scriptedFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  return { fetchImpl, calls };
}

const ok = (receipt = { ok: true, runId: "run-1", sequence: 1 }) => ({ status: 200, body: receipt });
const refusal = (status, code) => ({ status, body: { ok: false, code } });

function reporter(fetchImpl, over = {}) {
  const logs = [];
  const instance = createObservationReporter({
    base: BASE, token: "run-token", runId: "run-1", fetchImpl,
    retryDelayMs: 1, renewAfterMs: RENEW_AFTER_MS, now: () => new Date("2026-11-17T12:00:00.000Z"),
    log: (line) => logs.push(line), ...over,
  });
  return { instance, logs };
}

test("model id comes from dsh's opaque selector, and only a real selector", () => {
  assert.equal(modelIdFromSelector("[\"deepseek-official\",\"deepseek-v4-pro\"]"), "deepseek-official/deepseek-v4-pro");
  assert.equal(modelIdFromSelector("\"plain\""), null);
  assert.equal(modelIdFromSelector("not json"), null);
});

test("the accepted model comes from the reply's currentValue, never from what was sent", () => {
  // dsh returns {configOptions} for set_config_option; its model currentValue is
  // the agent's own statement of its current model.
  assert.equal(modelIdFromConfigReply({ configOptions: [{ id: "model", currentValue: "[\"acme-normalised\",\"acme-model-x\"]" }] }),
    "acme-normalised/acme-model-x");
  assert.equal(modelIdFromConfigReply({ configOptions: [{ id: "model", currentValue: "plain-model" }] }), "plain-model");
  // Nothing to report when the reply does not name a model.
  assert.equal(modelIdFromConfigReply({}), null);
  assert.equal(modelIdFromConfigReply(undefined), null);
  assert.equal(modelIdFromConfigReply({ configOptions: [] }), null);
  assert.equal(modelIdFromConfigReply({ configOptions: [{ id: "reasoning_effort", currentValue: "high" }] }), null);
});

test("report shape: observation-only body to the activity endpoint with the run credential", async () => {
  const { fetchImpl, calls } = scriptedFetch([ok()]);
  const { instance } = reporter(fetchImpl);
  await instance.model("deepseek-official/deepseek-v4-pro");
  await instance.drain();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/api/activity/hooks`);
  assert.equal(calls[0].headers.authorization, "Bearer run-token");
  assert.deepEqual(calls[0].body, {
    runId: "run-1",
    sequence: 1,
    occurredAt: "2026-11-17T12:00:00.000Z",
    observations: { model: { id: "deepseek-official/deepseek-v4-pro" } },
  });
  assert.equal("hookEvent" in calls[0].body, false, "an observation report carries no hookEvent");
  assert.equal("eventFamily" in calls[0].body, false, "an observation report carries no eventFamily");
  assert.equal("sessionName" in calls[0].body, false, "an observation report is not an activity post");
});

test("context reports usedTokens with windowTokens, and a bare count when there is no capacity", async () => {
  const { fetchImpl, calls } = scriptedFetch([ok(), ok()]);
  const { instance } = reporter(fetchImpl);
  await instance.context({ usedTokens: 1000, windowTokens: 1000000 });
  await instance.drain();
  assert.deepEqual(calls[0].body.observations, { context: { usedTokens: 1000, windowTokens: 1000000 } });

  const second = scriptedFetch([ok()]);
  const other = reporter(second.fetchImpl).instance;
  await other.context({ usedTokens: 42 });
  await other.drain();
  assert.deepEqual(second.calls[0].body.observations, { context: { usedTokens: 42 } }, "no capacity is not invented");
});

test("a report retried after a transport failure reuses its sequence, time and payload", async () => {
  const { fetchImpl, calls } = scriptedFetch([new Error("ECONNRESET"), ok()]);
  const { instance } = reporter(fetchImpl);
  await instance.model("p/m");
  await instance.drain();

  assert.equal(calls.length, 2, "the report was retried once");
  assert.deepEqual(calls[1].body, calls[0].body, "the retry is byte-identical");
  assert.equal(calls[1].body.sequence, calls[0].body.sequence);
  assert.equal(instance.sent, 1, "only one report was accepted");
});

test("runner_observation_unverified is retried as-is, and nothing is revoked", async () => {
  const { fetchImpl, calls } = scriptedFetch([refusal(409, OBSERVATION_UNVERIFIED), ok()]);
  const { instance, logs } = reporter(fetchImpl);
  await instance.context({ usedTokens: 5, windowTokens: 10 });
  await instance.drain();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, calls[0].body, "retry keeps the original sequence and payload");
  assert.equal(instance.stopped, false, "an unverified binding does not stop reporting");
  assert.equal(instance.sent, 1);
  assert.deepEqual(logs, [], "a retryable refusal is not logged as a failure");
});

test("runner_observation_unavailable stops reporting and invents nothing", async () => {
  const { fetchImpl, calls } = scriptedFetch([refusal(409, OBSERVATION_UNAVAILABLE), ok()]);
  const { instance, logs } = reporter(fetchImpl);
  await instance.model("p/m");
  await instance.drain();
  assert.equal(calls.length, 1, "an unavailable run is not retried");
  assert.equal(instance.stopped, true);
  assert.equal(instance.sent, 0, "no state was fabricated");

  await instance.context({ usedTokens: 1, windowTokens: 2 });
  await instance.drain();
  assert.equal(calls.length, 1, "later reports stop after runner_observation_unavailable");
  assert.match(logs.join("\n"), /stopped/);
});

test("a conflicting sequence refusal is not retried, and the next report uses a fresh sequence", async () => {
  const { fetchImpl, calls } = scriptedFetch([refusal(409, "runner_observation_conflict"), ok()]);
  const { instance, logs } = reporter(fetchImpl);
  await instance.model("p/m");
  await instance.drain();
  assert.equal(calls.length, 1, "a conflict is not retried with the same payload");
  assert.match(logs.join("\n"), /refused/);

  await instance.context({ usedTokens: 7, windowTokens: 70 });
  await instance.drain();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.sequence > calls[0].body.sequence, "the burnt sequence is not reused for a different payload");
  assert.equal(instance.sent, 1);
});

test("activity_grant_pending and activity_grant_unverified are retried unchanged", async () => {
  for (const code of [GRANT_PENDING, GRANT_UNVERIFIED]) {
    const { fetchImpl, calls } = scriptedFetch([refusal(409, code), ok()]);
    const { instance, logs } = reporter(fetchImpl);
    await instance.model("p/m");
    await instance.drain();
    assert.equal(calls.length, 2, `${code} is retried`);
    assert.deepEqual(calls[1].body, calls[0].body, `${code} reuses the identical payload`);
    assert.equal(instance.stopped, false, `${code} does not stop reporting`);
    assert.equal(instance.sent, 1);
    assert.deepEqual(logs, [], `${code} is not logged as a failure`);
  }
});

test("a first model report refused by a settling binding is not lost for the run", async () => {
  // The binding is still activating on the first report: every attempt is
  // refused, so nothing was accepted (acceptedAt === 0). The next turn boundary
  // must retry, not early-return because nothing is accepted yet.
  const { fetchImpl, calls } = scriptedFetch([refusal(409, GRANT_PENDING), refusal(409, GRANT_PENDING), refusal(409, GRANT_PENDING), ok()]);
  const { instance } = reporter(fetchImpl);
  await instance.model("p/m");
  await instance.drain();
  assert.equal(calls.length, 3, "the first report used its attempts");
  assert.equal(instance.sent, 0);

  await instance.renewIfStale();
  await instance.drain();
  assert.equal(calls.length, 4, "a refused first report is re-attempted rather than lost");
  assert.equal(instance.sent, 1);
  assert.deepEqual(calls[3].body.observations, { model: { id: "p/m" } });
  assert.ok(calls[3].body.sequence > calls[0].body.sequence, "the retry uses a fresh sequence");
});

test("unchanged facts are not repeated, but a stale fact is renewed once", async () => {
  let clock = Date.parse("2026-11-17T12:00:00.000Z");
  const { fetchImpl, calls } = scriptedFetch([ok(), ok()]);
  const { instance } = reporter(fetchImpl, { now: () => new Date(clock), renewAfterMs: 60_000 });
  await instance.model("p/m");
  await instance.drain();
  await instance.model("p/m");
  await instance.drain();
  assert.equal(calls.length, 1, "an unchanged fact is not re-sent inside the window");

  clock += 60_001;
  await instance.renewIfStale();
  await instance.drain();
  assert.equal(calls.length, 2, "a stale fact is renewed deliberately");
  assert.equal(calls[1].body.sequence, 2);
  assert.deepEqual(calls[1].body.observations, { model: { id: "p/m" } });
});

test("without a run id (unbound install-token launch) nothing is reported", async () => {
  const { fetchImpl, calls } = scriptedFetch([ok()]);
  const { instance } = reporter(fetchImpl, { runId: null });
  assert.equal(instance.enabled, false);
  await instance.model("p/m");
  await instance.context({ usedTokens: 1, windowTokens: 2 });
  await instance.drain();
  assert.equal(calls.length, 0);
});

test("after stop, no further reports are sent", async () => {
  const { fetchImpl, calls } = scriptedFetch([ok()]);
  const { instance } = reporter(fetchImpl);
  instance.stop();
  await instance.model("p/m");
  await instance.drain();
  assert.equal(calls.length, 0);
});
