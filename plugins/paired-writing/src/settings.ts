import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { HOST_OPERATIONS } from "../../shared/operations.js";
import { readText } from "./host.js";
import { applyAssistantSettingsPatch, parseSettings, builtinAssistantSettings, ASSISTANT_SETTINGS_PATH } from "./model-settings.js";
import { exactKeys, record } from "./validation.js";
import { PairedError } from "./types.js";

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
