import { CONTRACT_VERSION, type ModuleContext, type ModuleDefinition, type ModuleManifest } from "@scriptorium/contracts";
import { createAssistantActions, createRewriteStreamHttpContribution } from "./actions.js";

export const assistantManifest: ModuleManifest = {
  id: "assistant",
  version: "0.1.0",
  contractVersion: CONTRACT_VERSION,
  dependencies: ["story", "nlp", "diagnostics", "semantic", "speaker"],
  provides: [],
  requires: [],
  optionalRequires: ["host.model-usage"],
  serverEntry: "./dist/index.js",
  browserEntry: "./dist/browser.js",
  statePaths: ["meta/scriptorium/modules/assistant"],
  locality: "optional-external",
};

/** Assistant provider clients stay lazy; activation registers actions and route only. */
export async function createModule(moduleContext: ModuleContext): Promise<ModuleDefinition> {
  return {
    manifest: assistantManifest,
    actions: createAssistantActions(moduleContext),
    ui: [
      { id: "assistant.settings", module: "assistant", slot: "settings", title: "LLM モデル・利用状況", action: "assistant.settings.read" },
      { id: "assistant.rewrite", module: "assistant", slot: "dock", title: "ストリーミング言い換え", action: "assistant.rewrite" },
      { id: "assistant.summaries", module: "assistant", slot: "dock", title: "シーン・章の要約", action: "assistant.summary.scene" },
      { id: "assistant.qa", module: "assistant", slot: "dock", title: "作品設定への質問", action: "assistant.qa" },
      { id: "assistant.continuation", module: "assistant", slot: "dock", title: "続きを考える", action: "assistant.continuation" },
      { id: "assistant.aspect-review", module: "assistant", slot: "review", title: "章の観点レビュー", action: "assistant.aspect.review" },
      { id: "assistant.dialogue", module: "assistant", slot: "dock", title: "対話スケッチ", action: "assistant.dialogue.topics" },
      { id: "assistant.reader-reaction", module: "assistant", slot: "review", title: "初読レポート", action: "assistant.reader.reaction" },
      { id: "assistant.proposals", module: "assistant", slot: "review", title: "執筆支援の変更案", action: "assistant.stateEvents.draft" },
    ],
    http: [createRewriteStreamHttpContribution(moduleContext)],
    async dispose() {},
  };
}

export { createAssistantActions, createRewriteStreamHttpContribution } from "./actions.js";
export { createAssistantMigrationProducer } from "./migration.js";
export {
  applyAssistantSettingsPatch,
  ASSISTANT_FEATURE_IDS,
  ASSISTANT_SETTINGS_PATH,
  builtinAssistantSettings,
  readAssistantSettings,
  serializeAssistantSettings,
  type AssistantModelSettings,
  type AssistantModelPreset,
  type AssistantSampling,
} from "./model-settings.js";
export {
  resolveAssistantModel,
  streamAssistantModel,
  type AssistantModelIdentity,
  type AssistantModelPreferences,
  type AssistantModelPreset as ProviderModelPreset,
  type AssistantModelPurpose,
  type AssistantProviderKind,
  type AssistantSamplingParams,
  type StreamAssistantModelOptions,
  type StreamAssistantModelResult,
} from "./provider.js";
