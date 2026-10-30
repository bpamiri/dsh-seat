// SPDX-License-Identifier: Apache-2.0
// Map OpenRig's declared model onto dsh's advertised ACP config option.
//
// dsh's model value is opaque: JSON.stringify([provider, model]). OpenRig
// declares provider/id (or a bare id). The resolver accepts, in order:
//   * an exact advertised value or choice name;
//   * the exact opaque selector dsh advertises;
//   * a bare model id that matches one advertised model id;
//   * provider/id where the advertised provider is an exact or substring match
//     and the model id is unique (dsh's provider is "deepseek-official", while
//     OpenRig users commonly write "deepseek").
// Anything else is an error naming what dsh advertised. The runner reports that
// error in the pane and leaves dsh's own default; it never sends a raw value.

export function flattenModelChoices(configOptions) {
  const option = Array.isArray(configOptions) ? configOptions.find((entry) => entry?.id === "model") : undefined;
  const choices = [];
  const walk = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node && Array.isArray(node.options)) walk(node.options);
      else if (node && typeof node.value === "string") {
        choices.push({ value: node.value, ...(typeof node.name === "string" ? { name: node.name } : {}) });
      }
    }
  };
  walk(option?.options);
  return { option, choices };
}

export function parseModelSelector(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    if (typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    if (!parsed[0].trim() || !parsed[1].trim()) return null;
    return [parsed[0], parsed[1]];
  } catch {
    return null;
  }
}

export function modelChoiceLabel(choice) {
  return choice.name?.trim() || parseModelSelector(choice.value)?.[1] || choice.value;
}

export function advertisedModels(choices) {
  return choices.map(modelChoiceLabel).join(", ");
}

/**
 * @returns {{ok: true, value: string, label: string} | {ok: false, error: string}}
 */
export function resolveModelChoice(configOptions, declared) {
  const wanted = typeof declared === "string" ? declared.trim() : "";
  if (!wanted) return { ok: false, error: "no model was declared" };
  const { option, choices } = flattenModelChoices(configOptions);
  if (!option) return { ok: false, error: "the agent advertises no model option" };
  if (choices.length === 0) return { ok: false, error: "the agent advertises no selectable model values" };

  const lower = wanted.toLowerCase();
  const direct = choices.find((choice) => choice.value === wanted || choice.name?.trim().toLowerCase() === lower);
  if (direct) return { ok: true, value: direct.value, label: modelChoiceLabel(direct) };

  // An already-opaque selector is accepted only when dsh advertises exactly it.
  const declaredTuple = parseModelSelector(wanted);
  if (declaredTuple) {
    const exact = choices.find((choice) => {
      const tuple = parseModelSelector(choice.value);
      return tuple?.[0] === declaredTuple[0] && tuple?.[1] === declaredTuple[1];
    });
    if (exact) return { ok: true, value: exact.value, label: modelChoiceLabel(exact) };
    return { ok: false, error: `model "${wanted}" is not available; advertised: ${advertisedModels(choices)}` };
  }

  const slash = wanted.indexOf("/");
  const provider = slash > 0 ? wanted.slice(0, slash) : "";
  const modelId = slash > 0 ? wanted.slice(slash + 1) : wanted;
  const byModel = choices.filter((choice) => {
    const tuple = parseModelSelector(choice.value);
    return tuple ? tuple[1] === modelId : choice.name?.trim() === modelId;
  });
  if (byModel.length === 0) {
    return { ok: false, error: `model "${wanted}" is not available; advertised: ${advertisedModels(choices)}` };
  }
  const byProvider = provider
    ? byModel.filter((choice) => {
      const tuple = parseModelSelector(choice.value);
      if (!tuple) return false;
      const advertised = tuple[0].toLowerCase();
      const asked = provider.toLowerCase();
      return advertised === asked || advertised.includes(asked) || asked.includes(advertised);
    })
    : byModel;
  const chosen = byProvider.length === 1 ? byProvider[0] : byModel.length === 1 ? byModel[0] : undefined;
  if (chosen) return { ok: true, value: chosen.value, label: modelChoiceLabel(chosen) };
  return { ok: false, error: `model "${wanted}" matches more than one advertised model; advertised: ${advertisedModels(byModel)}` };
}
