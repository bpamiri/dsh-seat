// SPDX-License-Identifier: Apache-2.0
// The environment the dsh agent child gets: a baseline allowlist, DSH_HOME, and
// (when the declared model names a provider) that provider's key. Nothing else
// crosses — in particular not OPENRIG_ACTIVITY_HOOK_TOKEN or other OpenRig
// variables, which the agent's own shell would otherwise inherit.

export const BASELINE_ENV_VARS = [
  "PATH", "HOME", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR",
];

export const PROVIDER_ENV_VARS = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function providerFromModel(model) {
  const trimmed = typeof model === "string" ? model.trim() : "";
  const slash = trimmed.indexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : null;
}

export function buildAgentEnv(source = {}, { model = null } = {}) {
  const env = {};
  for (const name of BASELINE_ENV_VARS) {
    if (typeof source[name] === "string") env[name] = source[name];
  }
  if (typeof source.DSH_HOME === "string" && source.DSH_HOME.trim()) env.DSH_HOME = source.DSH_HOME;
  const providerVar = PROVIDER_ENV_VARS[providerFromModel(model) ?? ""];
  if (providerVar && typeof source[providerVar] === "string") env[providerVar] = source[providerVar];
  return env;
}
