// SPDX-License-Identifier: Apache-2.0
// The environment the dsh agent child gets.
//
// It keeps the baseline shell, OpenRig's identity/routing variables (so a
// `rig whoami` / `rig send` from inside the seat resolves to the seat), dsh's
// own telemetry choice (off unless the operator chose otherwise), the seat's
// DSH_HOME, and only the declared provider's key. It never inherits
// OPENRIG_ACTIVITY_HOOK_TOKEN or the runner-only launch-record/attempt/resume
// variables.
import {
  BASELINE_ENV_VARS, DSH_CHOICE_VARS, OPENRIG_ENV_VARS, PROVIDER_ENV_VARS, telemetryChosen,
} from "./privacy.mjs";

/**
 * The provider key a declared model needs. OpenRig users write `deepseek/...`
 * or `deepseek-official/...`, and dsh also accepts a bare model id; both name
 * the same provider. Unknown bare ids infer only the families this runner
 * documents (deepseek, anthropic, openai, openrouter).
 */
export function providerKeyForModel(model) {
  const raw = typeof model === "string" ? model.trim() : "";
  const slash = raw.indexOf("/");
  let provider = slash > 0 ? raw.slice(0, slash).toLowerCase() : "";
  if (!provider) {
    const id = raw.toLowerCase();
    if (id.startsWith("deepseek")) provider = "deepseek";
    else if (id.startsWith("claude") || id.startsWith("anthropic")) provider = "anthropic";
    else if (/^(gpt|o[1-9]|openai)/.test(id)) provider = "openai";
    else if (id.startsWith("openrouter")) provider = "openrouter";
  }
  if (provider === "deepseek-official") provider = "deepseek";
  return PROVIDER_ENV_VARS[provider] ?? null;
}

/**
 * @param {Record<string, string|undefined>} source
 * @param {{model?: string|null, dshHome: string}} opts
 */
export function buildAgentEnv(source = {}, { model = null, dshHome } = {}) {
  const env = {};
  for (const name of [...BASELINE_ENV_VARS, ...OPENRIG_ENV_VARS, ...DSH_CHOICE_VARS]) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  env.DSH_HOME = dshHome;
  if (!telemetryChosen(source)) env.DSH_TELEMETRY_DISABLED = "1";
  if (typeof source.DSH_PERMISSION_MODE === "string" && source.DSH_PERMISSION_MODE.trim()) {
    env.DSH_PERMISSION_MODE = source.DSH_PERMISSION_MODE;
  }
  const providerVar = providerKeyForModel(model);
  if (providerVar && typeof source[providerVar] === "string") env[providerVar] = source[providerVar];
  return env;
}
