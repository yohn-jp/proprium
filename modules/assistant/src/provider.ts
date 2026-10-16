import type { LanguageModel } from "ai";

export type AssistantProviderKind = "anthropic" | "openai-compatible";
export type AssistantModelPurpose = "quality" | "bulk";

export interface AssistantSamplingParams {
  temperature?: number;
  topP?: number;
  minP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
}

export interface AssistantModelPreset {
  id: string;
  label?: string;
  model: string;
  maxConcurrency?: number;
  sampling?: AssistantSamplingParams;
}

/** Non-secret, project-owned model preferences compatible with the source settings shape. */
export interface AssistantModelPreferences {
  defaultPresetId?: string;
  presets?: readonly AssistantModelPreset[];
  featurePresetIds?: Readonly<Record<string, string>>;
  maxConcurrentModels?: number;
}

/** Safe to return to the host UI: provider credentials and endpoint URLs are never included. */
export interface AssistantModelIdentity {
  provider: AssistantProviderKind;
  model: string;
  purpose: AssistantModelPurpose;
  sampling?: AssistantSamplingParams;
}

export interface StreamAssistantModelOptions {
  featureId: string;
  preferences?: AssistantModelPreferences;
  /** A previously resolved identity or model ID override. Provider selection still comes from env. */
  model?: AssistantModelIdentity | string;
  prompt: string;
  system?: string;
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  onText: (delta: string) => void | Promise<void>;
}

export interface StreamAssistantModelResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface ModelPreset {
  id: string;
  model: string;
  sampling?: AssistantSamplingParams;
}

const CREATIVE_SAMPLING: AssistantSamplingParams = {
  temperature: 0.75,
  minP: 0.05,
  topP: 0.9,
  repetitionPenalty: 1.08,
  presencePenalty: 0.15,
  frequencyPenalty: 0.1,
};

const STRUCTURED_SAMPLING: AssistantSamplingParams = {
  temperature: 0,
  topP: 0.1,
  presencePenalty: 0,
  frequencyPenalty: 0,
};

const REWRITE_SAMPLING: AssistantSamplingParams = {
  temperature: 0.35,
  topP: 0.8,
  repetitionPenalty: 1.05,
};

const BUILTIN_PRESETS: readonly ModelPreset[] = [
  { id: "env-default", model: "" },
  { id: "quality-flash", model: "deepseek-ai/DeepSeek-V4-Flash", sampling: CREATIVE_SAMPLING },
  { id: "quality-pro", model: "deepseek-ai/DeepSeek-V4-Pro", sampling: CREATIVE_SAMPLING },
  {
    id: "quality-pro-structured",
    model: "deepseek-ai/DeepSeek-V4-Pro",
    sampling: STRUCTURED_SAMPLING,
  },
  {
    id: "quality-pro-rewrite",
    model: "deepseek-ai/DeepSeek-V4-Pro",
    sampling: REWRITE_SAMPLING,
  },
  { id: "bulk-qwen3-4b", model: "Qwen/Qwen3-4B-Instruct-2507", sampling: STRUCTURED_SAMPLING },
];

const DEFAULT_FEATURE_PRESET_IDS: Readonly<Record<string, string>> = {
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

const QUALITY_FEATURES = new Set([
  "dialogue-sketch-turn",
  "zukan-proposal",
  "rewrite",
  "synonym-suggest",
  "speaker-attribution-llm",
  "continuation-options",
  "contradiction-check",
  "setting-qa",
]);

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function providerFromEnvironment(): AssistantProviderKind | undefined {
  const configured = nonEmpty(process.env.ARCADIA_LLM_PROVIDER);
  if (!configured || configured === "none") return undefined;
  if (configured === "anthropic" || configured === "openai-compatible") return configured;
  throw new Error(
    '[assistant] Unsupported ARCADIA_LLM_PROVIDER (expected "anthropic", "openai-compatible", or "none")',
  );
}

function purposeForFeature(featureId: string): AssistantModelPurpose {
  return QUALITY_FEATURES.has(featureId) ? "quality" : "bulk";
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function sanitizeSampling(value: unknown): AssistantSamplingParams | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const sampling: AssistantSamplingParams = {};
  const fields = [
    ["temperature", 0, 2],
    ["topP", 0, 1],
    ["minP", 0, 1],
    ["presencePenalty", -2, 2],
    ["frequencyPenalty", -2, 2],
    ["repetitionPenalty", 0, 2],
  ] as const;
  for (const [key, min, max] of fields) {
    const normalized = clampNumber(raw[key], min, max);
    if (normalized !== undefined) sampling[key] = normalized;
  }
  return Object.keys(sampling).length > 0 ? sampling : undefined;
}

function preferencesView(preferences?: AssistantModelPreferences): {
  defaultPresetId: string;
  presets: ReadonlyMap<string, ModelPreset>;
  featurePresetIds: Record<string, string>;
} {
  const rawPresets = Array.isArray(preferences?.presets) ? preferences.presets : undefined;
  const candidates: readonly AssistantModelPreset[] =
    rawPresets && rawPresets.length > 0
      ? rawPresets
      : BUILTIN_PRESETS.map((preset) => ({ ...preset }));
  const presets = new Map<string, ModelPreset>();
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      !candidate.id.trim() ||
      typeof candidate.model !== "string"
    ) {
      continue;
    }
    const id = candidate.id.trim();
    presets.set(id, {
      id,
      model: candidate.model.trim(),
      ...(candidate.sampling !== undefined
        ? { sampling: sanitizeSampling(candidate.sampling) }
        : {}),
    });
  }
  if (presets.size === 0) {
    for (const preset of BUILTIN_PRESETS) presets.set(preset.id, { ...preset });
  }

  const featurePresetIds = { ...DEFAULT_FEATURE_PRESET_IDS };
  const presetIds = new Set(presets.keys());
  if (preferences?.featurePresetIds && typeof preferences.featurePresetIds === "object") {
    for (const [featureId, presetId] of Object.entries(preferences.featurePresetIds)) {
      if (typeof presetId === "string" && presetIds.has(presetId)) {
        featurePresetIds[featureId] = presetId;
      }
    }
  }

  const requestedDefault = preferences?.defaultPresetId;
  const defaultPresetId =
    typeof requestedDefault === "string" && presetIds.has(requestedDefault)
      ? requestedDefault
      : "quality-flash";
  return { defaultPresetId, presets, featurePresetIds };
}

function modelFromPreferences(
  featureId: string,
  preferences?: AssistantModelPreferences,
): { model?: string; sampling?: AssistantSamplingParams } {
  const settings = preferencesView(preferences);
  const presetId = settings.featurePresetIds[featureId] ?? settings.defaultPresetId;
  const preset = settings.presets.get(presetId);
  const model = nonEmpty(preset?.model);
  return {
    ...(model ? { model } : {}),
    ...(preset?.sampling ? { sampling: { ...preset.sampling } } : {}),
  };
}

function resolvePurposeModel(purpose: AssistantModelPurpose): string {
  if (purpose === "quality") {
    return (
      nonEmpty(process.env.ARCADIA_ANTHROPIC_MODEL_QUALITY) ??
      nonEmpty(process.env.ARCADIA_ANTHROPIC_MODEL) ??
      "claude-opus-4-8"
    );
  }
  return nonEmpty(process.env.ARCADIA_ANTHROPIC_MODEL_BULK) ?? "claude-haiku-4-5";
}

/** Resolve a non-secret provider/model identity without initializing an SDK provider. */
export function resolveAssistantModel(
  featureId: string,
  preferences?: AssistantModelPreferences,
): AssistantModelIdentity | undefined {
  const provider = providerFromEnvironment();
  if (!provider) return undefined;

  const purpose = purposeForFeature(featureId);
  const selected = modelFromPreferences(featureId, preferences);
  const model =
    selected.model ??
    (provider === "anthropic"
      ? resolvePurposeModel(purpose)
      : nonEmpty(process.env.ARCADIA_LLM_MODEL));
  if (!model) return undefined;

  return {
    provider,
    model,
    purpose,
    ...(selected.sampling ? { sampling: selected.sampling } : {}),
  };
}

function clampOutputTokens(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("[assistant] maxOutputTokens must be a finite number");
  }
  return Math.min(32_768, Math.max(48, Math.floor(value)));
}

function samplingOptions(
  provider: AssistantProviderKind,
  sampling: AssistantSamplingParams | undefined,
  temperatureOverride: number | undefined,
): {
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  providerOptions?: { "arcadia-byok": Record<string, number> };
} {
  const result: {
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    providerOptions?: { "arcadia-byok": Record<string, number> };
  } = {};
  const temperature = clampNumber(temperatureOverride, 0, 2) ?? sampling?.temperature;
  if (temperature !== undefined) result.temperature = temperature;

  if (provider !== "openai-compatible" || !sampling) return result;
  if (sampling.topP !== undefined) result.topP = sampling.topP;
  if (sampling.presencePenalty !== undefined) result.presencePenalty = sampling.presencePenalty;
  if (sampling.frequencyPenalty !== undefined) result.frequencyPenalty = sampling.frequencyPenalty;

  const providerBody: Record<string, number> = {};
  if (sampling.minP !== undefined) providerBody.min_p = sampling.minP;
  if (sampling.repetitionPenalty !== undefined) {
    providerBody.repetition_penalty = sampling.repetitionPenalty;
  }
  if (Object.keys(providerBody).length > 0) {
    result.providerOptions = { "arcadia-byok": providerBody };
  }
  return result;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("[assistant] provider stream aborted");
}

async function createLanguageModel(identity: AssistantModelIdentity): Promise<LanguageModel> {
  if (identity.provider === "anthropic") {
    const apiKey = nonEmpty(process.env.ANTHROPIC_API_KEY);
    if (!apiKey) {
      throw new Error("[assistant] Anthropic provider selected but ANTHROPIC_API_KEY is not configured");
    }
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey })(identity.model);
  }

  const baseURL = nonEmpty(process.env.ARCADIA_LLM_BASE_URL);
  if (!baseURL) {
    throw new Error(
      "[assistant] openai-compatible provider selected but ARCADIA_LLM_BASE_URL is not configured",
    );
  }
  const apiKey = nonEmpty(process.env.ARCADIA_LLM_API_KEY);
  const cfAigToken = nonEmpty(process.env.CF_AIG_TOKEN);
  const cfAigByokAlias = nonEmpty(process.env.CF_AIG_BYOK_ALIAS);
  if (!apiKey && !cfAigToken) {
    throw new Error(
      "[assistant] openai-compatible provider needs ARCADIA_LLM_API_KEY or CF_AIG_TOKEN",
    );
  }

  const headers: Record<string, string> = {};
  if (cfAigToken) headers["cf-aig-authorization"] = `Bearer ${cfAigToken}`;
  if (cfAigByokAlias) headers["cf-aig-byok-alias"] = cfAigByokAlias;
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  return createOpenAICompatible({
    name: "arcadia-byok",
    ...(apiKey ? { apiKey } : {}),
    baseURL,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    supportsStructuredOutputs: false,
  })(identity.model);
}

/** Stream actual provider deltas; network and SDK setup happen only on this call. */
export async function streamAssistantModel(
  input: StreamAssistantModelOptions,
): Promise<StreamAssistantModelResult> {
  const provider = providerFromEnvironment();
  if (!provider) {
    throw new Error('[assistant] no model provider is configured (set ARCADIA_LLM_PROVIDER)');
  }
  const resolved = resolveAssistantModel(input.featureId, input.preferences);
  if (!resolved) {
    throw new Error(`[assistant] no model is configured for ${provider}`);
  }

  let identity = resolved;
  if (typeof input.model === "string") {
    const model = nonEmpty(input.model);
    if (model) identity = { ...resolved, model };
  } else if (input.model) {
    if (input.model.provider !== resolved.provider) {
      throw new Error("[assistant] model provider does not match ARCADIA_LLM_PROVIDER");
    }
    const model = nonEmpty(input.model.model);
    if (!model) throw new Error("[assistant] model ID is empty");
    identity = {
      ...resolved,
      model,
      ...(input.model.sampling ? { sampling: sanitizeSampling(input.model.sampling) } : {}),
    };
  }

  const ownAbort = new AbortController();
  const combinedSignal = input.signal
    ? AbortSignal.any([input.signal, ownAbort.signal])
    : ownAbort.signal;
  if (combinedSignal.aborted) throw abortError(combinedSignal);
  const model = await createLanguageModel(identity);
  const { streamText } = await import("ai");
  if (combinedSignal.aborted) throw abortError(combinedSignal);

  const streamed = streamText({
    model,
    ...(input.system !== undefined ? { system: input.system } : {}),
    prompt: input.prompt,
    maxOutputTokens: clampOutputTokens(input.maxOutputTokens),
    abortSignal: combinedSignal,
    ...samplingOptions(identity.provider, identity.sampling, input.temperature),
    maxRetries: 0,
  });

  let text = "";
  try {
    for await (const delta of streamed.textStream) {
      text += delta;
      await input.onText(delta);
      if (combinedSignal.aborted) throw abortError(combinedSignal);
    }
    if (combinedSignal.aborted) throw abortError(combinedSignal);
  } catch (error) {
    ownAbort.abort(error);
    throw error;
  }

  const usage = await streamed.usage;
  return {
    text,
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
  };
}
