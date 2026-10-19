// SPDX-License-Identifier: Apache-2.0
// What a seat sends to DeepSeek beyond its model requests, and how the runner
// keeps that to the minimum by default.
//
// dsh ships three upload paths that are on unless a deployment turns them off
// (dsh-base/cordis.patch.yml), each seen live against dsh 0.2.1-rc.2:
//
//   session-log-deepseek    `enabled: true` — on every official DeepSeek API
//                           request, attaches the next suffix of the canonical
//                           session log as the `dsh_session_log` body field
//                           (docs/deepseek-llm-api-wire-extensions.md). Re-enabling
//                           it later uploads the backlog recorded while it was off.
//   plugin-package-inventory-deepseek
//                           `enabled: true` — on every official request, the name
//                           and version of each active plugin package as
//                           `dsh_plugin_packages`, for DeepSeek's diagnostics; it
//                           names any private or in-house plugin a seat runs.
//   session-telemetry-otel  mode FEEDBACK_ONLY — explicit feedback releases the
//                           session prefix to DeepSeek's OTel collector. A non-empty
//                           DSH_TELEMETRY_DISABLED opts the process out; config
//                           cannot disable that row, and `.env` files reject DSH_*.
//
// The runner owns the child's environment, so it switches telemetry off unless
// the operator has expressed a choice. The two request fields are config, so
// they belong in the seat home's patch (scripts/make-seat-home.sh writes it);
// the runner only checks for them and says so in the pane when either is on.

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
 *
 * It also names the seat for the agent's own `rig` calls. Without
 * OPENRIG_SESSION_NAME a `rig send` from inside the seat reaches its peer as
 * "<unknown sender>", because the pane is a node process and the CLI cannot
 * infer which seat it is. The runner's --session-name is the seat's canonical
 * address, so it always wins over an inherited value. OPENRIG_URL is filled in
 * from the daemon endpoint only when the operator hasn't set one.
 *
 * With `scrub`, the child starts from an allowlist instead of the operator's
 * whole environment (see childEnvAllowlist). dsh's shell tool inherits this
 * environment, so anything that crosses here — an API key exported in the pane's
 * shell, a cloud token — is readable by the agent's own commands.
 */
export function dshChildEnv(env, {
  dshHome,
  permissionMode,
  sessionName = null,
  openrigUrl = null,
  scrub = false,
  passEnv = [],
  model = null,
}) {
  const hasUrl = typeof env.OPENRIG_URL === "string" && env.OPENRIG_URL.trim() !== "";
  const base = scrub ? pickEnv(env, childEnvAllowlist({ passEnv, model })) : env;
  return {
    ...base,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: permissionMode,
    ...(telemetryChosen(env) ? {} : { DSH_TELEMETRY_DISABLED: "1" }),
    ...(sessionName ? { OPENRIG_SESSION_NAME: sessionName } : {}),
    ...(!hasUrl && openrigUrl ? { OPENRIG_URL: openrigUrl } : {}),
  };
}

/** What every scrubbed child keeps: a working shell and locale. */
export const BASELINE_ENV_VARS = ["PATH", "HOME", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR"];

/**
 * OpenRig identity and instance routing, so `rig whoami` / `rig send` from inside
 * the seat resolve to this seat on this daemon. Arbitrary OPENRIG_* settings and
 * the hook token are not forwarded.
 */
export const OPENRIG_ENV_VARS = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
];

/** The operator's own telemetry choice for dsh (see telemetryChosen). */
export const DSH_CHOICE_VARS = ["DSH_TELEMETRY_DISABLED", "DSH_TELEMETRY_MODE"];

/**
 * Provider keys dsh's bundled providers read when the seat home has no
 * `.credentials.yaml`. One crosses only when --model names its provider
 * (`deepseek/...`); adding a provider here is a reviewed change, because the key
 * becomes readable by every command the agent runs.
 */
export const PROVIDER_ENV_VARS = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** An environment variable name the runner will accept for --pass-env. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The provider segment of a `provider/id` model value, if any. */
export function providerFromModel(model) {
  const trimmed = typeof model === "string" ? model.trim() : "";
  const slash = trimmed.indexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : null;
}

/** The names a scrubbed child keeps, in a stable order. */
export function childEnvAllowlist({ passEnv = [], model = null } = {}) {
  const names = [...BASELINE_ENV_VARS, ...OPENRIG_ENV_VARS, ...DSH_CHOICE_VARS, ...passEnv];
  const providerVar = PROVIDER_ENV_VARS[providerFromModel(model) ?? ""];
  if (providerVar) names.push(providerVar);
  return [...new Set(names)];
}

function pickEnv(env, names) {
  const picked = {};
  for (const name of names) {
    if (typeof env[name] === "string") picked[name] = env[name];
  }
  return picked;
}

/** The request fields a seat home can switch off, by their dsh row id. */
export const UPLOAD_ROWS = [
  { id: "session-log-deepseek", label: "the session log" },
  { id: "plugin-package-inventory-deepseek", label: "the plugin package list" },
];

/**
 * Read one patch file's verdict on an upload row.
 * @returns {boolean|null} true = disabled, false = enabled, null = row absent.
 *
 * Deliberately a narrow, line-based reading rather than a YAML parser (the
 * runner stays dependency-free): it looks for a top-level `- id: <rowId>` row
 * and, inside it, a row-level `disabled: true` or an `enabled: false` directly
 * under the row's `config:` — not one nested deeper, which would belong to
 * some sub-feature. It only decides whether to print a note, never what dsh
 * does; anything it cannot read counts as upload on.
 */
export function uploadRowVerdict(patchText, rowId) {
  const lines = String(patchText).split(/\r?\n/);
  const escaped = rowId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rowStart = new RegExp(`^- id:\\s*['"]?${escaped}['"]?\\s*(#.*)?$`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!rowStart.test(lines[i])) continue;
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

export const sessionLogVerdict = (patchText) => uploadRowVerdict(patchText, "session-log-deepseek");

/**
 * The upload rows this seat home leaves on. The home-level patch outranks the
 * profile's own patch (dsh apps/cli/reference/README.md); a row neither
 * mentions keeps dsh's default, which is on.
 */
export function uploadsLeftOn({ dshHome, profile }) {
  const patches = [];
  for (const file of [path.join(dshHome, "cordis.patch.yml"), path.join(dshHome, "profiles", profile, "cordis.patch.yml")]) {
    try {
      patches.push(fs.readFileSync(file, "utf8"));
    } catch {
      /* no patch at this layer */
    }
  }
  return UPLOAD_ROWS.filter(({ id }) => {
    for (const text of patches) {
      const verdict = uploadRowVerdict(text, id);
      if (verdict !== null) return !verdict;
    }
    return true;
  });
}

/** Whether this seat home turns the session-log upload off. */
export function sessionLogUploadDisabled({ dshHome, profile }) {
  return !uploadsLeftOn({ dshHome, profile }).some(({ id }) => id === "session-log-deepseek");
}
