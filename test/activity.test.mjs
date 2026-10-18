// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";

import { ActivityPoster } from "../src/activity.mjs";

const ENDPOINT = { baseUrl: "http://127.0.0.1:7433", token: "t0k" };

/** A poster whose fetch records each request. */
function recordingPoster(options = {}) {
  const requests = [];
  const poster = new ActivityPoster({
    sessionName: "dev1-dsh@rig",
    runtime: "dsh",
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
    ...options,
  });
  return { poster, requests };
}

test("posts go to the hooks route with the token, stamped with the seat identity", async () => {
  const { poster, requests } = recordingPoster({ endpoint: ENDPOINT });
  poster.turnStart();
  poster.setIdentity({ nodeId: "n1", generation: "g1" });
  poster.turnEnd();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:7433/api/activity/hooks");
  assert.equal(requests[0].headers["x-openrig-activity-token"], "t0k");
  assert.deepEqual([requests[0].body.hookEvent, requests[0].body.generation], ["UserPromptSubmit", null]);
  assert.deepEqual([requests[1].body.hookEvent, requests[1].body.nodeId, requests[1].body.generation], ["Stop", "n1", "g1"]);
  assert.equal(requests[1].body.sessionName, "dev1-dsh@rig");
  assert.equal(requests[1].body.runtime, "dsh");
});

test("an endpoint found after start turns posting on, unless the seat opted out", () => {
  const late = recordingPoster({ endpoint: null });
  assert.equal(late.poster.enabled, false);
  late.poster.turnStart();
  late.poster.setEndpoint(ENDPOINT);
  assert.equal(late.poster.enabled, true);
  late.poster.turnEnd();
  assert.deepEqual(late.requests.map((request) => request.body.hookEvent), ["Stop"]);

  const optedOut = recordingPoster({ endpoint: null, disabled: true });
  optedOut.poster.setEndpoint(ENDPOINT);
  optedOut.poster.turnEnd();
  assert.equal(optedOut.poster.enabled, false);
  assert.deepEqual(optedOut.requests, []);
});
