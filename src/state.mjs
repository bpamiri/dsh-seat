// SPDX-License-Identifier: Apache-2.0
// Runner state sidecar — the daemon's authoritative liveness source for a
// runner-hosted seat.
//
// Mirrors OpenRig's pi-runner contract
// (packages/daemon/src/adapters/pi-runner-protocol.ts:35-43): the adapter NEVER
// reads pane heuristics for readiness, only the runner-authored sidecar, and
// every write is stamped with the launch-attempt id so a stale artifact from a
// previous runner instance can never be mistaken for this one's truth.

import fs from "node:fs";
import path from "node:path";

/** Path shape: <stateRoot>/<sessionName>/runner-state.json */
export function sidecarPath({ stateRoot, sessionName }) {
  return seatFile({ stateRoot, sessionName }, "runner-state.json");
}

/** Another file in the seat's state directory: <stateRoot>/<sessionName>/<file>. */
export function seatFile({ stateRoot, sessionName }, file) {
  return path.join(stateRoot, sanitizeSessionName(sessionName), file);
}

/** A seat session name is `<member>@<rig>`; keep it a single safe path segment. */
export function sanitizeSessionName(sessionName) {
  return String(sessionName).replace(/[^A-Za-z0-9._@-]+/g, "_");
}

export function writeSidecar(filePath, state) {
  writeJsonAtomic(filePath, state);
}

/** Replace a JSON file whole (tmp + rename), readable only by the seat's user. */
export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Append one record as a JSON line; a new file is readable only by the seat's user. */
export function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readSidecar(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}
