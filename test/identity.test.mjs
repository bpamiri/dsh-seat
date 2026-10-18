// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";

import { CLAIM_HINT, resolveSeatIdentity } from "../src/identity.mjs";

const BASE = "http://127.0.0.1:7433";

/** A fake daemon: path -> {status, body}, recording every URL asked for. */
function fakeDaemon(routes) {
  const asked = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    asked.push(parsed);
    const route = routes[parsed.pathname] ?? { status: 404, body: { error: "not found" } };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    };
  };
  return { fetchImpl, asked };
}

test("the claim hint OpenRig types after adoption is recognised", () => {
  // packages/daemon/src/domain/claim-service.ts:196
  assert.match('--- OpenRig: You have been adopted into rig "dsh-scratch" as scratch.dev1-dsh. Run: rig whoami --json ---', CLAIM_HINT);
  assert.doesNotMatch("please adopt this approach", CLAIM_HINT);
});

test("resolves the node from whoami and the newest generation from the tenures ledger", async () => {
  const daemon = fakeDaemon({
    "/api/whoami": { status: 200, body: { identity: { nodeId: "node/1", rigName: "dsh-scratch", memberId: "dev1-dsh" } } },
    "/api/telemetry/v1/nodes/node%2F1/tenures": {
      status: 200,
      body: {
        rows: [
          { generationOrdinal: "1", generationUuid: "gen-old" },
          { generationOrdinal: "3", generationUuid: "gen-new" },
          { generationOrdinal: "2", generationUuid: "gen-mid" },
        ],
      },
    },
  });
  const found = await resolveSeatIdentity({ baseUrl: BASE, sessionName: "dev1-dsh@dsh-scratch", fetchImpl: daemon.fetchImpl });

  assert.deepEqual(found, {
    ok: true,
    nodeId: "node/1",
    generation: "gen-new",
    rigName: "dsh-scratch",
    memberId: "dev1-dsh",
    reason: null,
  });
  assert.equal(daemon.asked[0].searchParams.get("sessionName"), "dev1-dsh@dsh-scratch");
  assert.equal(daemon.asked[0].searchParams.get("compact"), "1");
  assert.equal(daemon.asked[1].pathname, "/api/telemetry/v1/nodes/node%2F1/tenures");
});

test("with the node already known, only its generation is looked up", async () => {
  const daemon = fakeDaemon({
    "/api/telemetry/v1/nodes/node%2F9/tenures": { status: 200, body: { rows: [{ generationOrdinal: "4", generationUuid: "gen-4" }] } },
  });
  const found = await resolveSeatIdentity({ baseUrl: BASE, sessionName: "x@y", nodeId: "node/9", fetchImpl: daemon.fetchImpl });
  assert.equal(found.ok, true);
  assert.equal(found.nodeId, "node/9");
  assert.equal(found.generation, "gen-4");
  assert.deepEqual(daemon.asked.map((url) => url.pathname), ["/api/telemetry/v1/nodes/node%2F9/tenures"]);
});

test("an unbound pane is 'not-adopted', and an ambiguous name says so", async () => {
  const unbound = fakeDaemon({ "/api/whoami": { status: 404, body: { error: "not found" } } });
  assert.deepEqual(await resolveSeatIdentity({ baseUrl: BASE, sessionName: "x@y", fetchImpl: unbound.fetchImpl }), {
    ok: false,
    reason: "not-adopted",
  });

  const ambiguous = fakeDaemon({ "/api/whoami": { status: 409, body: { error: "ambiguous" } } });
  const result = await resolveSeatIdentity({ baseUrl: BASE, sessionName: "x@y", fetchImpl: ambiguous.fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ambiguous/);
});

test("a node without a readable tenure resolves with no generation, and says why", async () => {
  const daemon = fakeDaemon({
    "/api/whoami": { status: 200, body: { identity: { nodeId: "n1" } } },
    "/api/telemetry/v1/nodes/n1/tenures": { status: 200, body: { rows: [] } },
  });
  const found = await resolveSeatIdentity({ baseUrl: BASE, sessionName: "x@y", fetchImpl: daemon.fetchImpl });
  assert.equal(found.ok, true);
  assert.equal(found.nodeId, "n1");
  assert.equal(found.generation, null);
  assert.match(found.reason, /no occupant tenure/);

  const broken = fakeDaemon({
    "/api/whoami": { status: 200, body: { identity: { nodeId: "n1" } } },
    "/api/telemetry/v1/nodes/n1/tenures": { status: 503, body: { code: "telemetry_read_unavailable" } },
  });
  const partial = await resolveSeatIdentity({ baseUrl: BASE, sessionName: "x@y", fetchImpl: broken.fetchImpl });
  assert.equal(partial.generation, null);
  assert.match(partial.reason, /tenures HTTP 503/);
});

test("a daemon that is down or silent is a reason, never a throw", async () => {
  const refused = await resolveSeatIdentity({
    baseUrl: BASE,
    sessionName: "x@y",
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7433");
    },
  });
  assert.deepEqual(refused, { ok: false, reason: "connect ECONNREFUSED 127.0.0.1:7433" });

  const silent = await resolveSeatIdentity({
    baseUrl: BASE,
    sessionName: "x@y",
    timeoutMs: 20,
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  assert.deepEqual(silent, { ok: false, reason: "daemon did not answer in time" });
});
