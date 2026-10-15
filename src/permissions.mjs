// SPDX-License-Identifier: Apache-2.0
// Launch posture -> dsh sandbox/approval mode, and posture -> ACP permission answer.
//
// Posture vocabulary and its meaning come from OpenRig:
//   floor | auto | full_bypass
// (packages/daemon/src/domain/runtime-adapter.ts:17, and adapters/yolo-mode.ts
// maps builtin policies: builtin:yolo -> full_bypass, builtin:auto -> auto,
// every other builtin -> floor.)
//
// dsh exposes two independent knobs, bundled by named presets
// (dsh-base/cordis.patch.yml:250-270):
//   sandbox:  read-only | workspace-write | danger-full-access
//   approval: ask | never
// The only launch-time selector is the env var DSH_PERMISSION_MODE, which sets
// both. ACP `session/request_permission` is the one channel that can answer an
// escalation automatically, which is what this module decides.

/** OpenRig launch postures. */
export const POSTURES = ["floor", "auto", "full_bypass"];

export function normalizePosture(value) {
  if (value === undefined || value === null || value === "") return "floor";
  const normalized = String(value).trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "fullbypass" || normalized === "full_bypass" || normalized === "yolo") return "full_bypass";
  if (normalized === "auto") return "auto";
  if (normalized === "floor") return "floor";
  throw new Error(`unknown posture "${value}" (expected one of: ${POSTURES.join(", ")})`);
}

/**
 * The DSH_PERMISSION_MODE the runner exports to the dsh child.
 *
 * floor/auto -> workspace-write: the seat may edit its workspace, and anything
 * beyond it is denied (approval `ask` with no answerer fails closed — the
 * daemon's floor semantics). full_bypass -> danger-full-access: sandbox permits
 * everything and approval becomes `never`.
 */
export function permissionModeForPosture(posture) {
  return normalizePosture(posture) === "full_bypass" ? "danger-full-access" : "workspace-write";
}

function selected(option) {
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

const cancelled = () => ({ outcome: { outcome: "cancelled" } });

/**
 * Decide a `session/request_permission` from the seat's posture.
 *
 * floor       — refuse the escalation; the agent continues inside its sandbox.
 * auto        — allow this one escalation.
 * full_bypass — allow, preferring a standing allow so the seat stops asking.
 *
 * Always answers with one of the server's own options, or `cancelled`, so the
 * agent is never left waiting on a human that is not there.
 */
export function permissionDecision(options, posture) {
  const list = Array.isArray(options) ? options : [];
  const byKind = (kind) => list.find((option) => option && option.kind === kind);
  const mode = normalizePosture(posture);

  if (mode === "full_bypass") {
    const option = byKind("allow_always") ?? byKind("allow_once");
    return option ? selected(option) : cancelled();
  }
  if (mode === "auto") {
    const option = byKind("allow_once") ?? byKind("allow_always");
    return option ? selected(option) : cancelled();
  }
  const option = byKind("reject_once") ?? byKind("reject_always");
  return option ? selected(option) : cancelled();
}

/** One-line, human-readable description of a permission request for the pane. */
export function describePermission(params) {
  const toolCall = params?.toolCall ?? {};
  const title = toolCall.title ?? toolCall.kind ?? toolCall.toolCallId ?? "tool call";
  return String(title);
}

/** One-line description of the decision, for the pane. */
export function describeDecision(decision, options) {
  if (decision.outcome.outcome === "cancelled") return "cancelled (no matching option)";
  const option = (options ?? []).find((candidate) => candidate.optionId === decision.outcome.optionId);
  return option ? `${option.kind} (${option.name ?? option.optionId})` : String(decision.outcome.optionId);
}
