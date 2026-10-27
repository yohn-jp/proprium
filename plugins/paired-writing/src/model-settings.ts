export const ASSISTANT_SETTINGS_PATH = "meta/scriptorium/modules/assistant/model-settings.json";

export interface AssistantSampling {
  temperature?: number;
  topP?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

export interface AssistantModelPreset {
  id: string;
  label: string;
  model: string;
  maxConcurrency?: number;
  sampling?: AssistantSampling;
}

export interface AssistantModelSettings {
  defaultPresetId: string;
  presets: AssistantModelPreset[];
  featurePresetIds: Record<string, string>;
  maxConcurrentModels?: number;
  totalCuBudget?: number;
  modelCuWeights?: Record<string, number>;
}

export const ASSISTANT_FEATURE_IDS = [
  "dialogue-sketch-turn", "dialogue-sketch", "zukan-proposal", "scene-summary", "chapter-summary",
  "rewrite", "synonym-suggest", "speaker-attribution-llm", "continuation-options", "contradiction-check",
  "state-event-draft", "first-read-reaction", "setting-qa",
] as const;

const DEFAULT_FEATURE_PRESET_IDS: Record<string, string> = {
  "dialogue-sketch-turn": "quality-pro",
  "dialogue-sketch": "quality-pro-structured",
  "zukan-proposal": "quality-pro-structured",
  "scene-summary": "bulk-qwen3-4b",
  "chapter-summary": "bulk-qwen3-4b",
  rewrite: "quality-pro-rewrite",
  "synonym-suggest": "quality-pro-rewrite",
  "speaker-attribution-llm": "quality-pro-structured",
  "continuation-options": "quality-flash",
  "contradiction-check": "quality-pro-structured",
  "state-event-draft": "bulk-qwen3-4b",
  "first-read-reaction": "quality-flash",
  "setting-qa": "quality-pro",
};

const DEFAULT_SETTINGS: AssistantModelSettings = {
  defaultPresetId: "quality-flash",
  presets: [
    { id: "env-default", label: "環境変数デフォルト", model: "" },
    { id: "quality-flash", label: "DeepSeek V4 Flash（軽量・対話向け）", model: "deepseek-ai/DeepSeek-V4-Flash", sampling: { temperature: 0.75, minP: 0.05, topP: 0.9, repetitionPenalty: 1.08, presencePenalty: 0.15, frequencyPenalty: 0.1 } },
    { id: "quality-pro", label: "DeepSeek V4 Pro（高品質・創作）", model: "deepseek-ai/DeepSeek-V4-Pro", sampling: { temperature: 0.75, minP: 0.05, topP: 0.9, repetitionPenalty: 1.08, presencePenalty: 0.15, frequencyPenalty: 0.1 } },
    { id: "quality-pro-structured", label: "DeepSeek V4 Pro（構造化・要約）", model: "deepseek-ai/DeepSeek-V4-Pro", sampling: { temperature: 0, topP: 0.1, presencePenalty: 0, frequencyPenalty: 0 } },
    { id: "quality-pro-rewrite", label: "DeepSeek V4 Pro（言い換え）", model: "deepseek-ai/DeepSeek-V4-Pro", sampling: { temperature: 0.35, topP: 0.8, repetitionPenalty: 1.05 } },
    { id: "bulk-qwen3-4b", label: "Qwen3 4B（一括・構造化）", model: "Qwen/Qwen3-4B-Instruct-2507", maxConcurrency: 2, sampling: { temperature: 0, topP: 0.1, presencePenalty: 0, frequencyPenalty: 0 } },
  ],
  featurePresetIds: { ...DEFAULT_FEATURE_PRESET_IDS },
  maxConcurrentModels: 1,
  totalCuBudget: 4,
  modelCuWeights: {
    "deepseek-ai/DeepSeek-V4-Pro": 2,
    "deepseek-ai/DeepSeek-V4-Flash": 1,
    "Qwen/Qwen3-4B-Instruct-2507": 1,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeModelId(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  return normalized.length <= 512 &&
    !/^https?:\/\//iu.test(normalized) &&
    !/(?:api[_-]?key|access[_-]?token|secret)\s*[:=]/iu.test(normalized) &&
    !/^(?:sk|pk|ghp|gho|github_pat|xox[baprs])-[-A-Za-z0-9_]{16,}$/iu.test(normalized) &&
    !/[\x00-\x1f\x7f]/u.test(normalized);
}

function cloneDefault(): AssistantModelSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AssistantModelSettings;
}

function clampSampling(value: unknown): AssistantSampling | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("Sampling must be an object");
  const result: AssistantSampling = {};
  const bounds: Record<keyof AssistantSampling, [number, number]> = {
    temperature: [0, 2], topP: [0, 1], minP: [0, 1], presencePenalty: [-2, 2], frequencyPenalty: [-2, 2], repetitionPenalty: [0, 2],
  };
  for (const [key, [minimum, maximum]] of Object.entries(bounds) as Array<[keyof AssistantSampling, [number, number]]>) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum) throw new TypeError("Sampling value is outside its allowed range");
    result[key] = candidate;
  }
  return Object.keys(result).length ? result : {};
}

export function parseSettings(value: unknown): AssistantModelSettings {
  if (!isRecord(value)) throw Object.assign(new TypeError("Assistant model settings must be a JSON object"), { code: "assistant_settings_invalid" });
  const presetsRaw = Array.isArray(value.presets) ? value.presets : [];
  if (!presetsRaw.length || presetsRaw.length > 32) throw Object.assign(new TypeError("Assistant settings must contain 1 to 32 model presets"), { code: "assistant_settings_invalid" });
  const presets = presetsRaw.map((item, index): AssistantModelPreset => {
    if (!isRecord(item) || typeof item.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(item.id) ||
        typeof item.label !== "string" || !item.label.trim() || item.label.length > 128 ||
        typeof item.model !== "string" || item.model.length > 512 || !isSafeModelId(item.model)) {
      throw Object.assign(new TypeError(`Assistant model preset ${index + 1} is invalid`), { code: "assistant_settings_invalid" });
    }
    const preset: AssistantModelPreset = { id: item.id, label: item.label.trim(), model: item.model.trim() };
    if (item.maxConcurrency !== undefined) {
      if (!Number.isSafeInteger(item.maxConcurrency) || (item.maxConcurrency as number) < 1 || (item.maxConcurrency as number) > 8) throw new TypeError("Preset maxConcurrency must be between 1 and 8");
      preset.maxConcurrency = item.maxConcurrency as number;
    }
    const sampling = clampSampling(item.sampling);
    if (sampling) preset.sampling = sampling;
    return preset;
  });
  if (new Set(presets.map((item) => item.id)).size !== presets.length) throw new TypeError("Assistant model preset IDs must be unique");
  const ids = new Set(presets.map((item) => item.id));
  if (typeof value.defaultPresetId !== "string" || !ids.has(value.defaultPresetId)) throw new TypeError("defaultPresetId must name an existing preset");
  const featurePresetIds: Record<string, string> = {};
  if (isRecord(value.featurePresetIds)) {
    for (const [feature, presetId] of Object.entries(value.featurePresetIds)) {
      if (!(ASSISTANT_FEATURE_IDS as readonly string[]).includes(feature) || typeof presetId !== "string" || !ids.has(presetId)) throw new TypeError(`Invalid assistant feature preset mapping: ${feature}`);
      featurePresetIds[feature] = presetId;
    }
  }
  for (const [feature, presetId] of Object.entries(DEFAULT_FEATURE_PRESET_IDS)) if (!featurePresetIds[feature] && ids.has(presetId)) featurePresetIds[feature] = presetId;
  const settings: AssistantModelSettings = { defaultPresetId: value.defaultPresetId, presets, featurePresetIds };
  if (value.maxConcurrentModels !== undefined) {
    if (!Number.isSafeInteger(value.maxConcurrentModels) || (value.maxConcurrentModels as number) < 1 || (value.maxConcurrentModels as number) > 8) throw new TypeError("maxConcurrentModels must be between 1 and 8");
    settings.maxConcurrentModels = value.maxConcurrentModels as number;
  }
  if (value.totalCuBudget !== undefined) {
    if (!Number.isSafeInteger(value.totalCuBudget) || (value.totalCuBudget as number) < 1 || (value.totalCuBudget as number) > 64) throw new TypeError("totalCuBudget must be between 1 and 64");
    settings.totalCuBudget = value.totalCuBudget as number;
  }
  if (isRecord(value.modelCuWeights)) {
    const weights: Record<string, number> = {};
    if (Object.keys(value.modelCuWeights).length > 256) throw new TypeError("Too many model weights");
    for (const [model, weight] of Object.entries(value.modelCuWeights)) {
      if (!model || !isSafeModelId(model) || model.length > 256 || typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 1 || weight > 64) throw new TypeError(`Invalid CU weight for model ${model}`);
      weights[model] = weight;
    }
    settings.modelCuWeights = weights;
  }
  return settings;
}

export function applyAssistantSettingsPatch(current: AssistantModelSettings, patchValue: unknown): AssistantModelSettings {
  if (!isRecord(patchValue)) throw new TypeError("settings patch must be an object");
  const allowed = new Set(["defaultPresetId", "featurePresetIds", "presets", "maxConcurrentModels", "totalCuBudget", "modelCuWeights"]);
  if (Object.keys(patchValue).some((key) => !allowed.has(key))) throw new TypeError("settings patch contains an unsupported or secret field");
  const next: Record<string, unknown> = { ...current, ...patchValue };
  if (isRecord(patchValue.featurePresetIds)) next.featurePresetIds = { ...current.featurePresetIds, ...patchValue.featurePresetIds };
  if (isRecord(patchValue.modelCuWeights)) next.modelCuWeights = { ...current.modelCuWeights, ...patchValue.modelCuWeights };
  return parseSettings(next);
}

export function serializeAssistantSettings(settings: AssistantModelSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function builtinAssistantSettings(): AssistantModelSettings { return cloneDefault(); }
