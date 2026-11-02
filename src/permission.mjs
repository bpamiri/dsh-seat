// SPDX-License-Identifier: Apache-2.0
// Section 7's answered-permission rules, kept pure so the state machine is
// testable without a network or an agent. The runner (bin/dsh-seat) submits,
// reads and withdraws; these functions decide what a response means.

/** Prefer allow_once; allow_always only when no once option exists. */
export function selectPermitOption(options) {
  const list = Array.isArray(options) ? options : [];
  const once = list.find((option) => option?.kind === "allow_once");
  if (once?.optionId) return once.optionId;
  const always = list.find((option) => option?.kind === "allow_always");
  return always?.optionId ?? null;
}

const CANCEL_CODES = new Set([
  "stale_generation", "activity_grant_wrong_seat", "activity_grant_stale",
]);
const HOLD_CODES = new Set(["denied_by_seat", "options_unsupported"]);

function codeOf(body) { return body && typeof body.code === "string" ? body.code : null; }

/**
 * What a submit response means.
 * @returns {{kind:"ask", askId:string}
 *          |{kind:"permit", optionId:string|null, reason:string}
 *          |{kind:"refuse-hold", reason:string}
 *          |{kind:"cancel", reason:string}}
 */
export function classifySubmit(status, body) {
  if (status === 404) return { kind: "permit", optionId: null, reason: "no answered-permission path (404)" };
  const code = codeOf(body);
  if (body?.ok && typeof body.askId === "string" && body.askId) return { kind: "ask", askId: body.askId };
  if (body?.ok && (body.state === "permitted" || body.state === "answered") && body.optionId) {
    return { kind: "permit", optionId: body.optionId, reason: body.reason ?? "permitted" };
  }
  if (HOLD_CODES.has(code)) return { kind: "refuse-hold", reason: code };
  if (CANCEL_CODES.has(code)) return { kind: "cancel", reason: code };
  // duplicate_request / activity_grant_pending / activity_grant_revoked, an
  // unlisted status/code, or any other answer the contract doesn't know: permit.
  return { kind: "permit", optionId: null, reason: code ?? `status ${status}` };
}

/**
 * What a read (GET ask) means. `said` is passed through for the optional 0.7.9
 * behaviour; it never changes the outcome.
 * @returns {{kind:"pending"}
 *          |{kind:"selected", optionId:string, said?:string}
 *          |{kind:"permit", optionId:string|null, reason:string, said?:string}
 *          |{kind:"cancelled", reason:string, said?:string}
 *          |{kind:"refuse-hold", reason:string}}
 */
export function classifyRead(status, body) {
  const code = codeOf(body);
  if (HOLD_CODES.has(code)) return { kind: "refuse-hold", reason: code };
  const state = typeof body?.state === "string" ? body.state : null;
  const said = typeof body?.said === "string" && body.said.trim() ? body.said : undefined;
  if (state === "pending") return { kind: "pending" };
  if (state === "answered" || state === "permitted") {
    return body?.optionId
      ? { kind: "selected", optionId: body.optionId, ...(said ? { said } : {}) }
      : { kind: "permit", optionId: null, reason: "permit without an option", ...(said ? { said } : {}) };
  }
  if (state === "refused") return { kind: "cancelled", reason: body?.reason ?? "refused", ...(said ? { said } : {}) };
  if (state === "withdrawn" || state === "stale") return { kind: "cancelled", reason: state };
  if (CANCEL_CODES.has(code)) return { kind: "cancel", reason: code };
  // deferred, a 500, an unknown state, or no answer at all: no one can be asked.
  return { kind: "permit", optionId: null, reason: code ?? state ?? `status ${status}` };
}
