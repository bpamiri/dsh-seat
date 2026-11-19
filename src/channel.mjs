// SPDX-License-Identifier: Apache-2.0
// OpenRig's optional run-bound native channel (harness/runner contract v0.7.19).
//
// Transport only: this module owns the wire — hello, the run-filtered SSE
// stream, per-frame custody acknowledgement, retained receipts, retries and the
// turn reports — and hands each accepted request to the runner through the
// `delivery` callbacks, which own the native effects. Nothing here writes a
// native prompt: the runner does that only after Core's durable acceptance.
//
// Why it exists: the typed path (raw mode + bracketed paste) is a shim that
// exists because there was no native channel. Frames from this channel instead
// become exactly one native prompt each. The typed path stays in place as the
// rollback; a seat that never selects `--route native` never receives a frame.
//
// Honesty rules kept here:
//   * an unsupported or malformed frame is refused before any native or typed
//     effect, and never falls back to typing;
//   * every immutable ID/payload/result is retained for this process's
//     lifetime; a duplicate frame is reconciled without a repeated effect, and
//     a conflicting reuse of an ID or sequence is refused;
//   * `409 runner_grant_unverified`, `runner_grant_pending` and
//     `runner_hello_required` are retryable and revoke nothing; a positive
//     stale/revoked refusal keeps its refusal and quarantines the channel;
//   * a delivery whose custody could not be established is reported as
//     unavailable, never silently dropped: a nudge that dies quietly is the
//     failure this channel exists to remove.

export const CHANNEL_PATH = "/api/activity/runner-channel";
export const CHANNEL_VERSION = 1;

/** Retryable refusals: the same saved receipt is posted again. */
export const RETRYABLE_CODES = new Set(["runner_hello_required", "runner_grant_pending", "runner_grant_unverified"]);

/** A positive run refusal: stop reporting for this run (the fence, not a retry). */
export function isPermanentRefusal(status, code) {
  if (RETRYABLE_CODES.has(code ?? "")) return false;
  if (status === 401 || status === 403) return true;
  return ["runner_grant_required", "runner_grant_revoked", "runner_grant_stale"].includes(code ?? "");
}

/** The largest frame the bounded SSE envelope allows without a size comment. */
const FALLBACK_FRAME_LIMIT = 6 * 1024 * 1024 + 64 * 1024;

/**
 * Read `: runner-frame-chars=<n>` and return the bound for one event.
 * `<n>` is the exact UTF-16 length of the serialized receipt in `data`.
 */
export function runnerFrameBound(buffer) {
  if (!buffer.startsWith(": runner-frame-chars=")) return { limit: FALLBACK_FRAME_LIMIT };
  const newline = buffer.indexOf("\n");
  if (newline < 0) return { limit: FALLBACK_FRAME_LIMIT };
  const header = /^: runner-frame-chars=([0-9]+)\n/.exec(buffer.slice(0, newline + 1));
  const chars = header ? Number(header[1]) : NaN;
  if (!Number.isSafeInteger(chars) || chars < 1 || chars > Number.MAX_SAFE_INTEGER - 64 * 1024) {
    throw new Error("invalid channel frame size");
  }
  return { limit: chars + 64 * 1024, chars };
}

function validFrame(raw, runId) {
  if (!raw || typeof raw !== "object") return false;
  if (raw.version !== CHANNEL_VERSION || raw.runId !== runId) return false;
  if (typeof raw.requestId !== "string" || !raw.requestId) return false;
  if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1) return false;
  if (!["input", "wake", "cancel"].includes(raw.kind)) return false;
  if (raw.kind === "cancel") {
    const target = raw.payload?.target;
    if (!target || target.runId !== raw.runId || typeof target.nativeTurnId !== "string" || !target.nativeTurnId) return false;
    return true;
  }
  const text = raw.kind === "wake" ? raw.payload?.question : raw.payload?.text;
  return typeof text === "string";
}

function immutableFrame(raw) {
  if (raw.kind === "cancel") {
    return { version: CHANNEL_VERSION, runId: raw.runId, requestId: raw.requestId, sequence: raw.sequence, kind: "cancel",
      payload: { target: { runId: raw.payload.target.runId, nativeTurnId: raw.payload.target.nativeTurnId } } };
  }
  return { version: CHANNEL_VERSION, runId: raw.runId, requestId: raw.requestId, sequence: raw.sequence, kind: raw.kind,
    payload: raw.kind === "wake" ? { question: raw.payload.question } : { text: raw.payload.text } };
}

/**
 * @param {{base?: string|null, token?: string|null, runId?: string|null,
 *          fetchImpl?: typeof fetch, streamImpl?: typeof fetch, log?: (line: string) => void,
 *          delivery: {input(frame, entry): void, wake(frame, entry): void, cancel(frame, entry, hooks): void},
 *          onUnavailable?: (reason: string) => void, reconnectMs?: number, postTimeoutMs?: number}} opts
 */
export function createNativeChannel({
  base = null, token = null, runId = null, fetchImpl = fetch, streamImpl = null, log = () => {},
  delivery, onUnavailable = () => {}, reconnectMs = 250, postTimeoutMs = 5000,
}) {
  const url = base ? `${String(base).replace(/\/+$/, "")}${CHANNEL_PATH}` : null;
  const enabled = Boolean(url && token && runId);
  const streamFetch = streamImpl ?? fetchImpl;

  /** Every immutable request this process has seen, with its result. */
  const retained = new Map();
  let quarantined = false;
  let stopped = false;
  let sequenceCursor = 0;
  let turnSequence = 0;
  let turnChain = Promise.resolve();
  let connected = false;
  let unavailableReported = false;
  const stopSignal = { aborted: false, listeners: new Set() };
  const onStop = () => { stopSignal.aborted = true; for (const listener of stopSignal.listeners) listener(); };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function call(method, body) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(postTimeoutMs),
      });
      let parsed = null;
      try { parsed = await response.json(); } catch { /* the status and code decide */ }
      return { status: response.status, body: parsed };
    } catch (error) {
      return { status: 0, body: null, error };
    }
  }

  /** POST a saved receipt until Core answers, retrying only what is retryable. */
  async function postReceipt(body) {
    if (!enabled || stopped) return false;
    for (;;) {
      const result = await call("POST", body);
      if (result.status >= 200 && result.status < 300) return true;
      if (isPermanentRefusal(result.status, result.body?.code)) {
        quarantine(`refused: ${result.body?.code ?? result.status}`);
        return false;
      }
      if (stopped) return false;
      await sleep(reconnectMs);
    }
  }

  function quarantine(reason) {
    if (quarantined) return;
    quarantined = true;
    // Every request still waiting on custody is now unavailable. Say so; do not
    // pretend it was delivered, and do not fall back to typing it.
    for (const entry of retained.values()) {
      if (entry.state === "accepted" || entry.state === "queued") {
        entry.state = "unavailable";
        deliveryUnavailable(entry);
      }
    }
    log(`native channel quarantined (${reason}); no request was delivered`);
    onUnavailable(reason);
  }

  function deliveryUnavailable(entry) {
    try { entry.onUnavailable?.(); } catch { /* the runner's own state is its own */ }
  }

  /** Tell Core what a request's native effect was; retried as a saved receipt. */
  function report(entry, type, extra = {}) {
    if (!entry || entry.state === "unavailable") return entry?.reports ?? Promise.resolve();
    const frame = entry.frame;
    entry.reports = (entry.reports ?? Promise.resolve()).then(async () => {
      if (entry.state === "unavailable") return false;
      return postReceipt({ type, runId: frame.runId, requestId: frame.requestId, sequence: frame.sequence,
        ...(entry.nativeTurnId ? { nativeTurnId: entry.nativeTurnId } : {}),
        ...(entry.acceptedTurnId ? { acceptedTurnId: entry.acceptedTurnId } : {}), ...extra });
    });
    return entry.reports;
  }

  const entryFor = (frame) => {
    const entry = {
      frame, state: "accepting", reports: Promise.resolve(), nativeTurnId: null, acceptedTurnId: null,
      submitted: false,
      markSubmitted(nativeTurnId, acceptedTurnId, extra = {}) {
        entry.nativeTurnId = nativeTurnId ?? entry.nativeTurnId;
        entry.acceptedTurnId = acceptedTurnId ?? entry.acceptedTurnId;
        if (entry.submitted) return;
        entry.submitted = true;
        entry.reports = Promise.resolve(report(entry, "submitted", extra));
      },
      /** The request's terminal outcome, exactly once. */
      result(result) {
        if (entry.state === "terminal") return entry.reports;
        entry.state = "terminal";
        entry.resultValue = result;
        return report(entry, "result", { result });
      },
      /** A pre-effect refusal: the request never touched the agent. */
      reject(reason, extra = {}) {
        if (entry.state === "terminal") return entry.reports;
        entry.state = "terminal";
        return report(entry, "rejected", { ...extra });
      },
      onUnavailable: null,
    };
    return entry;
  };

  /** Accept one SSE frame: validate, retain, acknowledge custody, then deliver. */
  async function accept(raw) {
    if (stopped || quarantined) return;
    if (!validFrame(raw, runId)) {
      // Refused before any native or typed effect, and never typed as a fallback.
      log(`ignored an invalid native frame (sequence ${raw?.sequence ?? "?"})`);
      return;
    }
    const frame = immutableFrame(raw);
    const existing = retained.get(frame.requestId);
    if (existing) {
      if (JSON.stringify(existing.frame) !== JSON.stringify(frame)) {
        log(`refused a conflicting reuse of request ${frame.requestId}`);
        return;
      }
      await existing.acceptance;
      return;
    }
    for (const other of retained.values()) {
      if (other.frame.sequence === frame.sequence) {
        log(`refused conflicting sequence ${frame.sequence}`);
        return;
      }
    }
    const entry = entryFor(frame);
    retained.set(frame.requestId, entry);
    entry.acceptance = (async () => {
      const acked = await postReceipt({ type: "ack", runId: frame.runId, requestId: frame.requestId,
        sequence: frame.sequence, state: "accepted" });
      if (!acked) return;
      entry.state = "queued";
      // Only after durable acceptance may a native effect happen.
      if (frame.kind === "cancel") delivery.cancel(frame, entry, { prepare: prepareCancellation });
      else if (frame.kind === "wake") delivery.wake(frame, entry);
      else delivery.input(frame, entry);
    })();
    await entry.acceptance;
  }

  /** Core withdraws its asks and confirms before any native abort is written. */
  async function prepareCancellation(frame) {
    for (;;) {
      const response = await call("POST", { type: "cancel-prepare", runId: frame.runId, requestId: frame.requestId, sequence: frame.sequence });
      if (isPermanentRefusal(response.status, response.body?.code)) { quarantine(`cancel-prepare refused: ${response.body?.code ?? response.status}`); return null; }
      if (response.status === 200 && response.body?.withdrawal) return response.body.withdrawal;
      if (stopped) return null;
      await sleep(reconnectMs);
    }
  }

  /** Turn reports: the named invocation Core needs for a targeted cancel. */
  function reportTurn({ nativeTurnId, state, acceptedTurnId }) {
    if (!enabled || quarantined || !nativeTurnId || !acceptedTurnId) return Promise.resolve();
    const body = { type: "turn", runId, sequence: ++turnSequence, nativeTurnId, state, acceptedTurnIds: [acceptedTurnId] };
    // Turn reports keep their own order (opened before closed) whatever the
    // network does with them.
    turnChain = turnChain.then(() => postReceipt(body));
    return turnChain;
  }

  /** Connect: hello, then the run-filtered SSE stream, reconnecting with our retained map. */
  async function connect() {
    if (!enabled) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    stopSignal.listeners.add(abort);
    let retainedHello = false;
    while (!stopped && !quarantined) {
      try {
        const hello = await call("POST", { type: "hello", version: CHANNEL_VERSION, runId, retained: retainedHello,
          capabilities: { input: true, wake: true, cancel: true } });
        if (isPermanentRefusal(hello.status, hello.body?.code)) { quarantine(`hello refused: ${hello.body?.code ?? hello.status}`); return; }
        if (hello.status !== 200) throw new Error("channel handshake unavailable");
        retainedHello = true;
        const response = await streamFetch(url, { signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, "Last-Event-ID": String(sequenceCursor) } });
        if (!response.ok) {
          const failure = await response.json().catch(() => null);
          if (isPermanentRefusal(response.status, failure?.code)) { quarantine(`stream refused: ${failure?.code ?? response.status}`); return; }
          throw new Error("channel unavailable");
        }
        if (!response.body) throw new Error("channel unavailable");
        connected = true;
        unavailableReported = false;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            buffer += String(part.value).replace(/\r/g, "");
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const bound = runnerFrameBound(buffer);
              if (end > bound.limit) throw new Error("channel frame too large");
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
              if (bound.chars !== undefined && data.length !== bound.chars) throw new Error("channel frame size mismatch");
              if (!data) continue;
              const frame = JSON.parse(data);
              if (frame.runId !== runId || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1) throw new Error("invalid channel frame");
              sequenceCursor = Math.max(sequenceCursor, frame.sequence);
              void accept(frame).catch(() => {});
            }
            if (buffer.length > runnerFrameBound(buffer).limit) throw new Error("channel frame too large");
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (error) {
        connected = false;
        // A connection that drops does not retract custody: the retained map
        // keeps every receipt, and the runner's requests stay as they were.
        if (!stopped && !unavailableReported) {
          unavailableReported = true;
          onUnavailable(`channel disconnected: ${error?.message ?? error}`);
        }
      }
      if (!stopped && !quarantined) await sleep(reconnectMs);
    }
  }

  return {
    get enabled() { return enabled; },
    get quarantined() { return quarantined; },
    get connected() { return connected; },
    get retained() { return retained; },
    get cursor() { return sequenceCursor; },
    accept,
    connect,
    reportTurn,
    prepareCancellation,
    postReceipt,
    stop() { stopped = true; onStop(); },
    drain(ms = 1500) {
      const pending = [...retained.values()].map((entry) => entry.reports).filter(Boolean);
      let timer;
      return Promise.race([Promise.allSettled(pending),
        new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
        .finally(() => clearTimeout(timer));
    },
  };
}
