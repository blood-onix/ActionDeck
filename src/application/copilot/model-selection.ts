/**
 * Pure model-selection policy for ActionDeck's quick Copilot features.
 *
 * The `actiondeck.ai.model` setting is either "auto" (default) or a model id /
 * family / display name. "auto" prefers Copilot's own Auto router when it is
 * exposed to extensions, then a fast, inexpensive model (quick explanations do
 * not need a frontier model and every extension request costs the user premium
 * requests), then any Copilot model, then any model at all.
 */

export interface ChatModelInfo {
  readonly id: string;
  readonly family: string;
  readonly name: string;
  readonly vendor: string;
}

export interface ModelSelection<T extends ChatModelInfo> {
  readonly model: T;
  /** Set when the configured model could not be honoured. */
  readonly note?: string;
}

export const AUTO_MODEL_PREFERENCE = "auto";

const FAST_MODEL_PATTERN = /\b(haiku|mini|flash|nano|lite)\b/i;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function matchesPreference(model: ChatModelInfo, preference: string): boolean {
  const wanted = normalize(preference);
  return [model.id, model.family, model.name].some((value) => normalize(value) === wanted);
}

function selectAuto<T extends ChatModelInfo>(models: readonly T[]): T | undefined {
  const copilot = models.filter((model) => model.vendor === "copilot");
  const pool = copilot.length > 0 ? copilot : models;
  return (
    pool.find((model) => matchesPreference(model, AUTO_MODEL_PREFERENCE)) ??
    pool.find((model) => FAST_MODEL_PATTERN.test(model.family) || FAST_MODEL_PATTERN.test(model.name)) ??
    pool[0]
  );
}

export function selectPreferredModel<T extends ChatModelInfo>(
  models: readonly T[],
  preference: string | undefined,
): ModelSelection<T> | undefined {
  if (models.length === 0) return undefined;
  const wanted = preference?.trim();
  if (wanted && normalize(wanted) !== AUTO_MODEL_PREFERENCE) {
    const exact = models.find((model) => matchesPreference(model, wanted));
    if (exact) return { model: exact };
    const fallback = selectAuto(models);
    if (!fallback) return undefined;
    return {
      model: fallback,
      note: `Configured model "${wanted}" is not available; used ${fallback.name} instead.`,
    };
  }
  const auto = selectAuto(models);
  return auto ? { model: auto } : undefined;
}
