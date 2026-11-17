// SPDX-License-Identifier: Apache-2.0
// Run-bound observation reports (harness/runner contract v0.7.18 §4).
//
// An observation-only POST to the same activity endpoint, from the run-bound
// credential, carries facts the runner actually observed: the model the agent
// accepted, and the context ACP reported. It is separate from activity and
// identity: no hookEvent, no eventFamily, its own sequence, and OpenRig shows
// the result as "runner-reported" — never as something OpenRig verified.
//
// Rules this module keeps:
//   * a report needs a run id (OPENRIG_RUN_ID) and a hook token; without them
//     the reporter is inert and sends nothing (the unbound install-token path
//     gains no run-authority claim);
//   * retrying a report reuses its sequence, timestamp and payload, so the
//     daemon returns the original receipt instead of recording a new one;
//   * 409 `runner_observation_unverified` is retryable as-is: nothing is
//     revoked and the same report is retried;
//   * `runner_observation_unavailable` means the run is positively stale or has
//     no bound session: reporting stops for this run, and no state is invented;
//   * any other refusal retires that report (the sequence is burnt, so a later
//     report cannot conflict with it) and is surfaced, never retried blindly;
//   * unchanged facts are not repeated; a stale-but-unchanged fact is renewed
//     on request (a new sequence and sample time) rather than by high-rate
//     sampling.

/** Refusal codes with a specific meaning for observation reporting. */
export const OBSERVATION_UNVERIFIED = "runner_observation_unverified";
export const OBSERVATION_UNAVAILABLE = "runner_observation_unavailable";
/** Run binding not settled yet (contract §4): retry the same report. */
export const GRANT_PENDING = "activity_grant_pending";
export const GRANT_UNVERIFIED = "activity_grant_unverified";

/** How old an accepted fact may be before a deliberate renewal reposts it. */
export const RENEW_AFTER_MS = 5 * 60_000;
const RETRY_DELAY_MS = 400;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `provider/model` from dsh's opaque `["provider","model"]` selector. */
export function modelIdFromSelector(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return `${parsed[0]}/${parsed[1]}`;
    }
  } catch { /* not a selector */ }
  return null;
}

/**
 * The model the AGENT says is current, read from a `session/set_config_option`
 * reply (dsh returns `{configOptions}`). This is the accepted model, which is
 * not necessarily the value the runner asked for. No model value in the reply
 * means there is nothing honest to report.
 */
export function modelIdFromConfigReply(reply) {
  const options = Array.isArray(reply?.configOptions) ? reply.configOptions : null;
  if (!options) return null;
  const model = options.find((option) => option?.id === "model");
  const current = typeof model?.currentValue === "string" ? model.currentValue : null;
  if (!current) return null;
  const selector = modelIdFromSelector(current);
  if (selector) return selector;
  // A plain (non-selector) current value is still the agent's own word for its
  // current model; report it verbatim rather than dropping the fact.
  return current.trim() || null;
}

/** Codes that mean "not now": the same report is retried unchanged. */
const RETRYABLE_CODES = new Set([OBSERVATION_UNVERIFIED, GRANT_PENDING, GRANT_UNVERIFIED]);

function cleanContext(context) {
  if (!context) return null;
  const usedTokens = Number.isFinite(context.usedTokens) ? Math.trunc(context.usedTokens) : null;
  const windowTokens = Number.isFinite(context.windowTokens) ? Math.trunc(context.windowTokens) : null;
  if (usedTokens === null && windowTokens === null) return null;
  // A used count without a capacity stays a reported count; report both when
  // both are known so occupancy is legitimate rather than inferred.
  return { ...(usedTokens !== null ? { usedTokens } : {}), ...(windowTokens !== null ? { windowTokens } : {}) };
}

/**
 * @param {{base?: string|null, token?: string|null, runId?: string|null,
 *          fetchImpl?: typeof fetch, now?: () => Date, timeoutMs?: number,
 *          renewAfterMs?: number, maxAttempts?: number, retryDelayMs?: number,
 *          log?: (message: string) => void}} opts
 */
export function createObservationReporter({
  base = null,
  token = null,
  runId = null,
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = 2000,
  renewAfterMs = RENEW_AFTER_MS,
  maxAttempts = MAX_ATTEMPTS,
  retryDelayMs = RETRY_DELAY_MS,
  log = () => {},
} = {}) {
  const enabled = Boolean(base && token && runId);
  const url = enabled ? `${String(base).replace(/\/$/, "")}/api/activity/hooks` : null;

  let known = {};          // facts the runner has observed so far
  let accepted = {};       // facts last accepted by the daemon
  let acceptedAt = 0;      // when `accepted` was accepted (ms)
  let sequence = 0;        // observation ordering is separate from activity
  let stopped = false;     // `runner_observation_unavailable`, or a hard stop
  let chain = Promise.resolve();
  let sent = 0;            // accepted reports (test/observability aid)

  const identical = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function payloadFor(seq, sample, occurredAt) {
    return { runId, sequence: seq, occurredAt, observations: sample };
  }

  async function sendOnce(payload) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { kind: "retry", reason: `unreachable: ${error?.message ?? error}` };
    }
    let body = null;
    try { body = await response.json(); } catch { /* the status and code decide */ }
    const code = typeof body?.code === "string" ? body.code : null;
    if (response.ok) return { kind: "accepted", receipt: body };
    if (code === OBSERVATION_UNAVAILABLE) return { kind: "unavailable", reason: code };
    if (RETRYABLE_CODES.has(code)) return { kind: "retry", reason: code };
    return { kind: "refused", reason: code ?? `status ${response.status}` };
  }

  async function deliver(sample) {
    if (!enabled || stopped) return;
    if (sample.model === undefined && sample.context === undefined) return;
    const seq = ++sequence;
    const occurredAt = now().toISOString();
    const payload = payloadFor(seq, sample, occurredAt);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Every attempt sends the identical payload: same sequence, timestamp and
      // body, so a receipt is returned rather than a second fact recorded.
      const outcome = await sendOnce(payload);
      if (outcome.kind === "accepted") {
        // Merge, so a model report and a context report each keep the other's
        // last accepted value.
        accepted = { ...accepted, ...sample };
        acceptedAt = now().getTime();
        sent += 1;
        return;
      }
      if (outcome.kind === "unavailable") {
        stopped = true;
        log(`observation reporting stopped: ${outcome.reason}`);
        return;
      }
      if (outcome.kind === "refused") {
        // Burnt sequence: the next report uses a fresh one, so it cannot be a
        // conflicting reuse of this payload.
        log(`observation refused (${outcome.reason}); not retried`);
        return;
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs);
    }
    log(`observation not accepted after ${maxAttempts} attempts`);
  }

  /** Merge observed facts and report what changed (or renew a stale fact). */
  function report(facts, { force = false } = {}) {
    if (!enabled || stopped) return chain;
    const next = { ...known };
    if (facts.model !== undefined) next.model = facts.model;
    if (facts.context !== undefined) next.context = facts.context;
    known = next;

    const changed = {};
    if (next.model !== undefined && !identical(next.model, accepted.model)) changed.model = next.model;
    if (next.context !== undefined && !identical(next.context, accepted.context)) changed.context = next.context;
    const stale = acceptedAt === 0 || now().getTime() - acceptedAt >= renewAfterMs;
    if (Object.keys(changed).length === 0 && !(force && stale)) return chain;

    // Unchanged-but-stale facts are renewed deliberately, with a new sequence
    // and sample time; the payload carries the current values, not history.
    const sample = Object.keys(changed).length > 0 ? changed : next;
    chain = chain.then(() => deliver(sample)).catch(() => {});
    return chain;
  }

  return {
    get enabled() { return enabled; },
    get stopped() { return stopped; },
    get sent() { return sent; },
    get lastAccepted() { return accepted; },
    /** The model the agent accepted; the caller only calls this on success. */
    model(id) { return report({ model: { id } }); },
    /** ACP `usage_update` used/size, as a count or (with both) occupancy. */
    context(context) {
      const cleaned = cleanContext(context);
      if (!cleaned) return chain;
      return report({ context: cleaned });
    },
    /**
     * Repost known facts if they would otherwise go stale at a turn boundary —
     * and, before anything has been accepted, retry the facts a refusal (or a
     * not-yet-settled run binding) left unsent, so the first model report is
     * never lost for the run.
     */
    renewIfStale() {
      if (!enabled || stopped) return chain;
      const fresh = acceptedAt !== 0 && now().getTime() - acceptedAt < renewAfterMs;
      if (fresh) return chain;
      return report({}, { force: true });
    },
    /** Never report again (agent exit, shutdown): no new facts, no fabrication. */
    stop() { stopped = true; },
    drain(ms = 1500) {
      let timer;
      return Promise.race([
        chain.catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
      ]).finally(() => clearTimeout(timer));
    },
  };
}
