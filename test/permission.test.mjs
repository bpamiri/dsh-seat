// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { classifyRead, classifySubmit, selectPermitOption } from "../src/permission.mjs";

const options = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

test("permit option: allow_once before allow_always, null when neither", () => {
  assert.equal(selectPermitOption(options), "allow-once");
  assert.equal(selectPermitOption([options[1], options[2]]), "allow-always");
  assert.equal(selectPermitOption([options[2]]), null);
});

test("submit: 404, permit, ask and the refusal table", () => {
  assert.equal(classifySubmit(404, { ok: false, code: "not_found" }).kind, "permit");
  assert.deepEqual(classifySubmit(200, { ok: true, askId: "ask-1", created: true }), { kind: "ask", askId: "ask-1" });
  assert.deepEqual(classifySubmit(200, { ok: true, state: "permitted", optionId: "allow-once" }),
    { kind: "permit", optionId: "allow-once", reason: "permitted" });
  for (const code of ["denied_by_seat", "options_unsupported"]) {
    assert.deepEqual(classifySubmit(409, { code }), { kind: "refuse-hold", reason: code });
  }
  for (const code of ["stale_generation", "activity_grant_wrong_seat", "activity_grant_stale"]) {
    assert.deepEqual(classifySubmit(409, { code }), { kind: "cancel", reason: code });
  }
  for (const code of ["duplicate_request", "activity_grant_pending", "activity_grant_revoked", "unlisted"]) {
    assert.equal(classifySubmit(409, { code }).kind, "permit", code);
  }
  assert.equal(classifySubmit(500, { code: "internal_error" }).kind, "permit");
});

test("read: pending / answered / permitted / refused / withdrawn / stale / deferred", () => {
  assert.deepEqual(classifyRead(200, { state: "pending" }), { kind: "pending" });
  assert.deepEqual(classifyRead(200, { state: "answered", optionId: "reject" }),
    { kind: "selected", optionId: "reject" });
  assert.deepEqual(classifyRead(200, { state: "permitted", optionId: "allow-once", said: "only notes" }),
    { kind: "selected", optionId: "allow-once", said: "only notes" });
  assert.deepEqual(classifyRead(200, { state: "refused", reason: "said_no" }),
    { kind: "cancelled", reason: "said_no" });
  assert.deepEqual(classifyRead(200, { state: "withdrawn" }), { kind: "cancelled", reason: "withdrawn" });
  assert.deepEqual(classifyRead(200, { state: "stale" }), { kind: "cancelled", reason: "stale" });
  assert.equal(classifyRead(200, { state: "deferred" }).kind, "permit");
  assert.equal(classifyRead(500, { code: "internal_error" }).kind, "permit");
  assert.deepEqual(classifyRead(409, { code: "activity_grant_stale" }), { kind: "cancel", reason: "activity_grant_stale" });
  assert.deepEqual(classifyRead(409, { code: "denied_by_seat" }), { kind: "refuse-hold", reason: "denied_by_seat" });
});
