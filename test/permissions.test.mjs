// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePosture,
  permissionModeForPosture,
  permissionDecision,
  describeDecision,
} from "../src/permissions.mjs";

const OPTIONS = [
  { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject-once", kind: "reject_once", name: "Reject" },
];

test("normalizePosture accepts OpenRig's vocabulary and yolo alias", () => {
  assert.equal(normalizePosture(undefined), "floor");
  assert.equal(normalizePosture("floor"), "floor");
  assert.equal(normalizePosture("AUTO"), "auto");
  assert.equal(normalizePosture("full_bypass"), "full_bypass");
  assert.equal(normalizePosture("full-bypass"), "full_bypass");
  assert.equal(normalizePosture("yolo"), "full_bypass");
  assert.throws(() => normalizePosture("reckless"), /unknown posture/);
});

test("permissionModeForPosture maps the floor to workspace-write and bypass to danger-full-access", () => {
  assert.equal(permissionModeForPosture("floor"), "workspace-write");
  assert.equal(permissionModeForPosture("auto"), "workspace-write");
  assert.equal(permissionModeForPosture("full_bypass"), "danger-full-access");
});

test("floor refuses escalation using the server's own reject option", () => {
  assert.deepEqual(permissionDecision(OPTIONS, "floor"), {
    outcome: { outcome: "selected", optionId: "reject-once" },
  });
});

test("auto allows the single escalation", () => {
  assert.deepEqual(permissionDecision(OPTIONS, "auto"), {
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
});

test("full_bypass prefers a standing allow", () => {
  assert.deepEqual(permissionDecision(OPTIONS, "full_bypass"), {
    outcome: { outcome: "selected", optionId: "allow-always" },
  });
});

test("a posture with no matching option answers cancelled rather than hanging", () => {
  const allowOnly = OPTIONS.filter((option) => option.kind.startsWith("allow"));
  assert.deepEqual(permissionDecision(allowOnly, "floor"), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(permissionDecision([], "auto"), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(permissionDecision(undefined, "full_bypass"), { outcome: { outcome: "cancelled" } });
});

test("describeDecision names the answered option", () => {
  assert.equal(describeDecision(permissionDecision(OPTIONS, "floor"), OPTIONS), "reject_once (Reject)");
  assert.equal(describeDecision({ outcome: { outcome: "cancelled" } }, OPTIONS), "cancelled (no matching option)");
});
