// SPDX-License-Identifier: Apache-2.0
// Best-effort activity reporting to the OpenRig daemon.
//
// Contract read from the daemon side:
//   POST <baseUrl>/api/activity/hooks
//   auth:  Authorization: Bearer <token>   OR   x-openrig-activity-token: <token>
//   turn:  {sessionName, nodeId, generation, runtime, hookEvent, subtype, occurredAt}
//   ident: {eventFamily: "session_identity", sessionName, nodeId, generation,
//           runtime, hookEvent: "SessionStart", sessionId, sessionFile, occurredAt}
// (packages/daemon/src/routes/activity.ts:74-95, :264; the payload shape is the
// one pi-runner.ts:571-581 posts; accepted hookEvent names are parsed in
// domain/agent-activity-store.ts:339-364 — UserPromptSubmit/PreToolUse => running,
// Stop/SessionEnd => idle.)
//
// {baseUrl, token} is snapshotted by the daemon each boot at
// <OPENRIG_HOME>/activity-endpoint.json (domain/activity-endpoint.ts:15-17, :67).
//
// Everything here is fire-and-forget: the seat must keep working when the
// daemon is down or the token is missing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultOpenRigHome(env = process.env) {
  return env.OPENRIG_HOME && env.OPENRIG_HOME.trim() ? env.OPENRIG_HOME.trim() : path.join(os.homedir(), ".openrig");
}

export function readActivityEndpoint(openrigHome = defaultOpenRigHome()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(openrigHome, "activity-endpoint.json"), "utf8"));
    if (typeof raw?.baseUrl === "string" && typeof raw?.token === "string") {
      return { baseUrl: raw.baseUrl, token: raw.token };
    }
    return null;
  } catch {
    return null;
  }
}

export class ActivityPoster {
  #endpoint;
  #identity;
  #fetch;
  #onError;
  #disabled;

  constructor({
    sessionName,
    nodeId = null,
    generation = null,
    runtime = "dsh",
    endpoint = null,
    fetchImpl = globalThis.fetch,
    onError = () => {},
    disabled = false,
  }) {
    this.#identity = { sessionName, nodeId, generation, runtime };
    this.#endpoint = endpoint;
    this.#fetch = fetchImpl;
    this.#onError = onError;
    this.#disabled = disabled || !endpoint || typeof fetchImpl !== "function";
  }

  get enabled() {
    return !this.#disabled;
  }

  #send(body) {
    if (this.#disabled) return;
    const url = new URL("/api/activity/hooks", this.#endpoint.baseUrl).toString();
    const request = this.#fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openrig-activity-token": this.#endpoint.token,
      },
      body: JSON.stringify({
        ...this.#identity,
        occurredAt: new Date().toISOString(),
        ...body,
      }),
    });
    // Never let a daemon problem reach the seat loop.
    Promise.resolve(request).catch((err) => this.#onError(err));
  }

  turnStart(subtype = null) {
    this.#send({ hookEvent: "UserPromptSubmit", subtype });
  }

  turnEnd(subtype = null) {
    this.#send({ hookEvent: "Stop", subtype });
  }

  /** Announce the dsh session id so the daemon can persist a resume token. */
  sessionIdentity({ sessionId, sessionFile = null }) {
    this.#send({
      eventFamily: "session_identity",
      hookEvent: "SessionStart",
      sessionId: sessionId ?? "unknown",
      sessionFile,
    });
  }

  attention(reason) {
    this.#send({ hookEvent: "Notification", subtype: reason });
  }
}
