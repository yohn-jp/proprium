import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { HOST_OPERATIONS } from "../../shared/operations.js";
import { readText } from "./host.js";
import { applyAssistantSettingsPatch, parseSettings, builtinAssistantSettings, ASSISTANT_SETTINGS_PATH } from "./model-settings.js";
import { exactKeys, record } from "./validation.js";
import { PairedError } from "./types.js";
import { sha256 } from "./sha256.js";

const FIELDS = ["defaultPresetId", "presets", "featurePresetIds", "maxConcurrentModels", "totalCuBudget", "modelCuWeights"] as const;
function recognized(raw: unknown): Record<string, unknown> {
  const input = record(raw, "settings");
  return Object.fromEntries(FIELDS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

export function* readWorkspaceSettings(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  exactKeys(record(input, "input"), [], "input");
  let revision: string | null = null;
  let workspace = builtinAssistantSettings();
  let workspaceFields: Record<string, unknown> = {};
  try {
    const file = yield* readText(host, request, ASSISTANT_SETTINGS_PATH);
    revision = file.revision;
    try { workspaceFields = recognized(JSON.parse(file.text)); workspace = parseSettings(workspaceFields); }
    catch { throw new PairedError("unsupported_format", "Workspace model settings are invalid", { path: ASSISTANT_SETTINGS_PATH }); }
  } catch (error) {
    if ((error as { code?: string })?.code !== "file_not_found") throw error;
  }
  const local = yield* host.request<{ found: boolean; value?: unknown }>(HOST_OPERATIONS.preferencesRead, { key: "model-settings", schema_version: 1 });
  if (!local || typeof local.found !== "boolean") throw new PairedError("storage_unknown", "Host returned invalid local preferences");
  let override: Record<string, unknown> = {};
  let effective = workspace;
  if (local.found) {
    try { override = recognized(local.value); effective = applyAssistantSettingsPatch(workspace, override); }
    catch { throw new PairedError("unsupported_format", "Local model preferences are invalid"); }
  }
  const provenance = Object.fromEntries(FIELDS.map(key => [key, Object.hasOwn(override, key) ? "local" : Object.hasOwn(workspaceFields, key) ? "workspace" : "default"]));
  const safeLocal = Object.fromEntries(FIELDS.filter(key => Object.hasOwn(override, key)).map(key => [key, effective[key]]));
  return { workspace: { revision, settings: workspace }, local: safeLocal, effective, provenance };
}

/** Replace top-level JSON values without reserializing unrelated author data. */
function patchJson(source: string, updates: Record<string, unknown>): string {
  let position = 0;
  const whitespace = () => { while (/\s/u.test(source[position] ?? "") && position < source.length) position++; };
  const stringEnd = () => {
    position++;
    while (position < source.length) {
      if (source[position] === "\\") { position += 2; continue; }
      if (source[position++] === '"') return;
    }
    throw new PairedError("unsupported_format", "Unterminated settings JSON string");
  };
  whitespace();
  if (source[position++] !== "{") throw new PairedError("unsupported_format", "Settings must be an object");
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const seen = new Set<string>();
  whitespace();
  while (source[position] !== "}") {
    if (source[position] !== '"') throw new PairedError("unsupported_format", "Invalid settings object");
    const keyStart = position; stringEnd();
    const key = JSON.parse(source.slice(keyStart, position)) as string;
    if (seen.has(key)) throw new PairedError("unsupported_format", "Duplicate settings key");
    seen.add(key); whitespace();
    if (source[position++] !== ":") throw new PairedError("unsupported_format", "Invalid settings object");
    whitespace(); const start = position; let depth = 0;
    while (position < source.length) {
      const ch = source[position];
      if (ch === '"') { stringEnd(); continue; }
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") { if (depth === 0) break; depth--; }
      else if (ch === "," && depth === 0) break;
      position++;
    }
    let end = position; while (end > start && /\s/u.test(source[end - 1]!)) end--;
    if (Object.hasOwn(updates, key)) edits.push({ start, end, text: JSON.stringify(updates[key]) });
    whitespace(); if (source[position] === ",") { position++; whitespace(); } else break;
  }
  if (source[position] !== "}") throw new PairedError("unsupported_format", "Invalid settings object");
  const missing = Object.keys(updates).filter(key => !seen.has(key));
  if (missing.length) edits.push({ start: position, end: position, text: `${seen.size ? "," : ""}\n${missing.map(key => `  ${JSON.stringify(key)}: ${JSON.stringify(updates[key])}`).join(",\n")}\n` });
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}

export function* proposeWorkspaceSettings(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  const args = record(input, "input"); exactKeys(args, ["patch", "expectedRevision"], "input");
  const patch = record(args.patch, "patch"); exactKeys(patch, FIELDS, "patch");
  if (!Object.keys(patch).length) throw new PairedError("invalid_input", "Settings patch is empty");
  if (patch.presets !== undefined) {
    if (!Array.isArray(patch.presets)) throw new PairedError("invalid_input", "presets must be an array");
    for (const entry of patch.presets) {
      const preset = record(entry, "preset"); exactKeys(preset, ["id", "label", "model", "maxConcurrency", "sampling"], "preset");
      if (preset.sampling !== undefined) exactKeys(record(preset.sampling, "sampling"), ["temperature", "topP", "minP", "presencePenalty", "frequencyPenalty", "repetitionPenalty"], "sampling");
    }
  }
  if (args.expectedRevision !== null && typeof args.expectedRevision !== "string") throw new PairedError("invalid_input", "Expected revision must be a string or null");
  if (!request.idempotency_key) throw new PairedError("invalid_input", "Host idempotency key is required");
  let source = ""; let revision: string | null = null; let raw: Record<string, unknown> = {};
  let current = builtinAssistantSettings();
  try {
    const file = yield* readText(host, request, ASSISTANT_SETTINGS_PATH); source = file.text; revision = file.revision;
    try { raw = record(JSON.parse(source), "settings"); current = parseSettings(recognized(raw)); }
    catch { throw new PairedError("unsupported_format", "Workspace model settings are invalid", { path: ASSISTANT_SETTINGS_PATH }); }
  } catch (error) { if ((error as { code?: string })?.code !== "file_not_found") throw error; }
  if (revision !== args.expectedRevision) throw new PairedError("snapshot_stale", "Workspace settings changed since they were read", { path: ASSISTANT_SETTINGS_PATH });
  let next: ReturnType<typeof builtinAssistantSettings>;
  try { next = applyAssistantSettingsPatch(current, patch); }
  catch (error) { throw new PairedError("invalid_input", error instanceof Error ? error.message : "Invalid settings patch"); }
  const updates = Object.fromEntries(Object.keys(patch).map(key => [key, next[key as keyof typeof next]]));
  if (Array.isArray(updates.presets) && Array.isArray(raw.presets)) {
    updates.presets = updates.presets.map((preset: Record<string, unknown>) => {
      const prior = (raw.presets as Array<Record<string, unknown>>).find(item => item && item.id === preset.id);
      const result = { ...prior, ...preset };
      if (prior?.sampling && typeof prior.sampling === "object" && !Array.isArray(prior.sampling) && preset.sampling && typeof preset.sampling === "object" && !Array.isArray(preset.sampling)) {
        result.sampling = { ...prior.sampling as Record<string, unknown>, ...preset.sampling as Record<string, unknown> };
      }
      return result;
    });
  }
  const content = new TextEncoder().encode(source ? patchJson(source, updates) : `${JSON.stringify(next, null, 2)}\n`);
  if (content.byteLength > 128 * 1024) throw new PairedError("capacity", "Settings exceed the Host proposal limit");
  const id = `paired-settings-${sha256(new TextEncoder().encode(JSON.stringify([request.scope.workspace_id, request.scope.generation, request.idempotency_key])))}`;
  const changeset = { id, idempotency_key: request.idempotency_key, scope: request.scope, snapshot: request.snapshot,
    title: "Update workspace model settings", reason: "Author-requested nonsecret workspace defaults",
    read_set: [{ path: ASSISTANT_SETTINGS_PATH, revision }], units: [{ id: `${id}-unit`, label: "Workspace settings", depends_on: [], operations: [{ id: `${id}-write`, kind: revision === null ? "create" : "replace", path: ASSISTANT_SETTINGS_PATH, expected_revision: revision, content: Array.from(content) }] }], evidence: [] };
  const receipt = yield* host.request<{ proposal_id: string }>(HOST_OPERATIONS.propose, { changeset });
  if (!receipt || typeof receipt.proposal_id !== "string") throw new PairedError("storage_unknown", "Host did not return a proposal receipt");
  return { proposal_id: receipt.proposal_id, change_set_id: id, status: "proposed", expectedRevision: revision };
}
