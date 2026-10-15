// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sidecarPath, sanitizeSessionName, writeSidecar, readSidecar } from "../src/state.mjs";

test("sidecar path mirrors the pi-runner layout: <stateRoot>/<sessionName>/runner-state.json", () => {
  const root = "/tmp/openrig-state";
  assert.equal(
    sidecarPath({ stateRoot: root, sessionName: "dev1-dsh@wheels-team" }),
    path.join(root, "dev1-dsh@wheels-team", "runner-state.json"),
  );
});

test("sanitizeSessionName keeps a seat name a single safe path segment", () => {
  assert.equal(sanitizeSessionName("dev1-dsh@wheels-team"), "dev1-dsh@wheels-team");
  assert.equal(sanitizeSessionName("weird name/with:chars"), "weird_name_with_chars");
});

test("writeSidecar is atomic and round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-state-"));
  const file = sidecarPath({ stateRoot: dir, sessionName: "seat@rig" });
  writeSidecar(file, { ready: true, launchId: "L1", sessionId: "session-1" });

  assert.deepEqual(readSidecar(file), { ready: true, launchId: "L1", sessionId: "session-1" });
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp.")),
    [],
    "no temporary files are left behind",
  );
});

test("readSidecar is honest about a missing or corrupt sidecar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-seat-state-"));
  assert.equal(readSidecar(path.join(dir, "nope.json")), null);
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, "{ not json");
  assert.equal(readSidecar(corrupt), null);
});
