import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import type { AssistantModelSettings } from "./model-settings.js";
import { readWorkspaceSettings } from "./settings.js";
import { PairedError } from "./types.js";
import { record } from "./validation.js";
import { sha256 } from "./sha256.js";

export interface ProviderGenerationInput {
  feature: string;
  prompt: string;
  promptVersion: string;
  maxOutputTokens: number;
  sourceManifest?: unknown;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}
export interface ProviderGenerationResult {
  text: string;
  provenance: { provider: string; model: string; promptVersion: string; requestId: string; untrusted: true };
}

/** Model aliases never select endpoints or credentials; the Host owns both. */
export function* generateProvider(host: GuestHost, request: ActionRequest, input: ProviderGenerationInput): Generator<HostCall, ProviderGenerationResult, unknown> {
  if (!input.prompt || !input.promptVersion || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 4096) {
    throw new PairedError("invalid_input", "Provider prompt or output budget is invalid");
  }
  const status = record(yield* host.request("workspace.capabilities.query", { capability_id: "provider.request" }), "Host provider status");
  if (status.available !== true || !Array.isArray(status.providers)) throw new PairedError("provider_unavailable", "No configured Host provider is available; local previews remain available");
  if (!request.idempotency_key) throw new PairedError("invalid_input", "Provider generation requires a stable Host idempotency key");
  const settings = (yield* readWorkspaceSettings({}, host, request)) as { effective: AssistantModelSettings };
  const presetId = settings.effective.featurePresetIds[input.feature] ?? settings.effective.defaultPresetId;
  const preset = settings.effective.presets.find(item => item.id === presetId);
  if (!preset) throw new PairedError("unsupported_format", "The selected model preset is missing");
  const providers = status.providers.filter(value => value && typeof value === "object" && !Array.isArray(value)) as Array<{ provider_id?: unknown; models?: Array<{ model_id?: unknown }> }>;
  const matches = providers.filter(provider => typeof provider.provider_id === "string" && Array.isArray(provider.models) && provider.models.some(model => model.model_id === preset.model));
  if (matches.length !== 1) throw new PairedError("provider_unavailable", "The Host has no unique configured provider for this model alias");
  const providerId = matches[0]!.provider_id as string;
  const requestId = sha256(new TextEncoder().encode(JSON.stringify([request.plugin_id, request.action_id, request.idempotency_key, input.feature])));
  const result = record(yield* host.request("provider.request", {
    request_id: requestId, provider_id: providerId, model_id: preset.model, purpose: input.feature,
    payload: { prompt: input.prompt, prompt_version: input.promptVersion, max_output_tokens: input.maxOutputTokens,
      ...(input.messages ? { messages: input.messages } : {}) },
    source_manifest: input.sourceManifest && typeof input.sourceManifest === "object" && !Array.isArray(input.sourceManifest)
      ? { ...input.sourceManifest, scope: request.scope, snapshot: request.snapshot }
      : { scope: request.scope, snapshot: request.snapshot, feature: input.feature, ...(Array.isArray(input.sourceManifest) ? { sources: input.sourceManifest } : {}) },
    max_output_bytes: Math.min(512 * 1024, Math.max(16 * 1024, input.maxOutputTokens * 64)),
  }), "Host provider response");
  const scope = record(result.scope, "provider scope"), snapshot = record(result.snapshot, "provider snapshot");
  if (result.untrusted !== true || result.request_id !== requestId || result.provider_id !== providerId || result.model_id !== preset.model ||
      JSON.stringify([scope.workspace_id,scope.repository_id,scope.branch,scope.generation]) !== JSON.stringify([request.scope.workspace_id,request.scope.repository_id,request.scope.branch,request.scope.generation]) ||
      JSON.stringify([snapshot.id,snapshot.local_commit,snapshot.worktree_generation,snapshot.draft_generation,snapshot.remote_commit??null]) !==
        JSON.stringify([request.snapshot.id,request.snapshot.local_commit,request.snapshot.worktree_generation,request.snapshot.draft_generation,request.snapshot.remote_commit??null])) {
    throw new PairedError("snapshot_stale", "Provider output is not bound to this request and snapshot");
  }
  const output = result.output;
  const text = typeof output === "string" ? output : output && typeof output === "object" && !Array.isArray(output) && typeof (output as {text?:unknown}).text === "string"
    ? (output as {text:string}).text : JSON.stringify(output);
  if (typeof text !== "string" || !text.length) throw new PairedError("invalid_input", "Provider returned no output");
  return { text, provenance: { provider: providerId, model: preset.model, promptVersion: input.promptVersion, requestId, untrusted: true } };
}
