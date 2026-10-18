// SPDX-License-Identifier: Apache-2.0
// What a seat sends to DeepSeek beyond its model requests, and how the runner
// keeps that to the minimum by default.
//
// dsh ships two upload paths that are on unless a deployment turns them off
// (dsh-base/cordis.patch.yml):
//
//   session-log-deepseek    `enabled: true` — on every official DeepSeek API
//                           request, attaches the next suffix of the canonical
//                           session log as the `dsh_session_log` body field
//                           (docs/deepseek-llm-api-wire-extensions.md). Re-enabling
//                           it later uploads the backlog recorded while it was off.
//   session-telemetry-otel  mode FEEDBACK_ONLY — explicit feedback releases the
//                           session prefix to DeepSeek's OTel collector. A non-empty
//                           DSH_TELEMETRY_DISABLED opts the process out; config
//                           cannot disable that row, and `.env` files reject DSH_*.
//
// The runner owns the child's environment, so it switches telemetry off unless
// the operator has expressed a choice. The session-log upload is config, so it
// belongs in the seat home's patch (scripts/make-seat-home.sh writes it); the
// runner only checks for it and says so in the pane when it is missing.

import fs from "node:fs";
import path from "node:path";

/** True when the operator has already chosen a telemetry setting for dsh. */
export function telemetryChosen(env) {
  return ["DSH_TELEMETRY_DISABLED", "DSH_TELEMETRY_MODE"].some(
    (name) => typeof env[name] === "string" && env[name].trim() !== "",
  );
}

/**
 * The environment the runner hands the dsh child: the operator's environment,
 * the seat's home and permission mode, and telemetry off unless the operator
 * chose otherwise.
 */
export function dshChildEnv(env, { dshHome, permissionMode }) {
  return {
    ...env,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: permissionMode,
    ...(telemetryChosen(env) ? {} : { DSH_TELEMETRY_DISABLED: "1" }),
  };
}

/**
 * Read one patch file's verdict on the session-log upload row.
 * @returns {boolean|null} true = disabled, false = enabled, null = row absent.
 *
 * Deliberately a narrow, line-based reading rather than a YAML parser (the
 * runner stays dependency-free): it looks for a top-level `- id:
 * session-log-deepseek` row and, inside it, a row-level `disabled: true` or an
 * `enabled: false` directly under the row's `config:` — not one nested deeper,
 * which would belong to some sub-feature. It only decides whether to print a
 * note, never what dsh does; anything it cannot read counts as upload on.
 */
export function sessionLogVerdict(patchText) {
  const lines = String(patchText).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^- id:\s*['"]?session-log-deepseek['"]?\s*(#.*)?$/.test(lines[i])) continue;
    let inConfig = false;
    let childIndent = null;
    for (let j = i + 1; j < lines.length && !/^-\s/.test(lines[j]); j += 1) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= 2) {
        // A key of the row itself ("- " puts them at column 2).
        if (/^\s*disabled:\s*true\b/.test(line)) return true;
        inConfig = /^\s*config:\s*(#.*)?$/.test(line);
        childIndent = null;
        continue;
      }
      if (!inConfig) continue;
      childIndent ??= indent;
      if (indent === childIndent && /^\s*enabled:\s*false\b/.test(line)) return true;
    }
    return false;
  }
  return null;
}

/**
 * Whether this seat home turns the session-log upload off. The home-level
 * patch outranks the profile's own patch (dsh apps/cli/reference/README.md).
 */
export function sessionLogUploadDisabled({ dshHome, profile }) {
  for (const file of [path.join(dshHome, "cordis.patch.yml"), path.join(dshHome, "profiles", profile, "cordis.patch.yml")]) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const verdict = sessionLogVerdict(text);
    if (verdict !== null) return verdict;
  }
  return false;
}
