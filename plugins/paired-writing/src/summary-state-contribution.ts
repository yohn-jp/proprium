import type { ActionDescriptor, ActionRequest, SurfaceDeclaration } from "../../../app/src/browser/proprium/authoring/types.js";
import type { Handler } from "../../shared/guest.js";
import { previewSummary, proposeSummary, suggestSummary } from "./summaries.js";
import { previewStateEvents, proposeStateEvent, suggestStateEvents, type GenerateProvider } from "./state-events.js";
import { PairedError } from "./types.js";

// Finite JSON value grammar for provider-authored records and the Host-owned receipt.
const scalar = { anyOf: [{ type: "null" }, { type: "boolean" }, { type: "number" }, { type: "string", maxLength: 8192 }] };
const defs: Record<string, unknown> = { value0: scalar };
for (let level = 1; level <= 6; level++) defs[`value${level}`] = { anyOf: [
  scalar, { type: "array", items: { $ref: `#/$defs/value${level - 1}` }, maxItems: 1024 },
  { type: "object", patternProperties: { "^(?!(?:__proto__|prototype|constructor)$)[\\s\\S]{1,256}$": { $ref: `#/$defs/value${level - 1}` } }, additionalProperties: false, maxProperties: 256 },
] };
const anyRecord = { type: "object", patternProperties: { "^(?!(?:__proto__|prototype|constructor)$)[\\s\\S]{1,256}$": { $ref: "#/$defs/value5" } }, additionalProperties: false, maxProperties: 256 };
const text = (maxLength = 256, minLength = 1) => ({ type: "string", minLength, maxLength });
const array = (items: unknown, maxItems: number, minItems = 0) => ({ type: "array", items, minItems, maxItems });
const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const nullable = (value: unknown) => ({ anyOf: [value, { type: "null" }] });
const schema = (value: Record<string, unknown>) => ({ ...value, $defs: defs });
const hash = { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" };
const path = text(4096);
const snapshot = object({ id: text(256), local_commit: nullable(text(64)), worktree_generation: text(256), draft_generation: nullable(text(256)), remote_commit: nullable(text(64)) }, ["id", "local_commit", "worktree_generation", "draft_generation"]);
const source = object({ path, revision: hash });
const read = object({ path, revision: nullable(hash) });
const citation = object({ path, revision: hash, sceneId: text(256) });
const summary = object({ summaryLines: array(text(8192, 1), 3, 3), characters: array(text(8192, 0), 100), stateChanges: array(text(8192, 0), 100) }, ["summaryLines"]);
const child = object({ id: text(), sourceHash: hash, summary, cached: { type: "boolean" }, provenance: anyRecord });
const diagnostic = object({ code: text(128), severity: { const: "warning" }, sceneId: text(), message: text(4096) });
const scope = { enum: ["scene", "chapter"] };
const summaryRead = schema(object({ scope, targetId: text(), expectedSnapshot: text() }));
const summaryPreview = schema(object({ scope, targetId: text(), snapshot, provider_invoked: { const: false }, children: array(object({ id: text(), sourceHash: hash, cached: { type: "boolean" }, prompt: text(786432, 0) }), 30), diagnostics: array(diagnostic, 30), expectedFileRevisions: array(read, 1024), chapterPrompt: nullable(text(786432, 0)) }));
const summarySuggest = schema(object({ scope, targetId: text(), summary, sourceHash: hash, children: array(child, 30), cached: { type: "boolean" }, citations: array(citation, 30, 1), diagnostics: array(diagnostic, 30), expectedFileRevisions: array(read, 1024), provenance: anyRecord }, ["scope", "targetId", "summary", "sourceHash", "cached", "citations", "diagnostics", "expectedFileRevisions", "provenance"]));
const summaryPropose = schema(object({ scope, targetId: text(), expectedFileRevisions: array(read, 1024, 1), summary, citations: array(citation, 30, 1), sourceHash: hash, provenance: anyRecord, children: array(child, 30) }, ["scope", "targetId", "expectedFileRevisions", "summary", "citations", "sourceHash", "provenance"]));
const summaryReceipt = schema(object({ proposal_id: text(), change_set_id: text(), status: { const: "proposed" }, paths: array(path, 31, 1), sourceHash: hash }));
const evidence = object({ path, revision: hash, start: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, end: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, quote: text(4096) });
const candidate = object({ kind: { enum: ["location", "acquaintance", "ownership", "knowledge"] }, target: text(4096), operation: text(4096), before: nullable(anyRecord), after: nullable(anyRecord), object: nullable(text(4096)), payload: anyRecord, evidence, confidence: { const: 0.5 } });
const statePreview = schema(object({ prompt: text(786432, 0), promptVersion: text(256), provider_invoked: { const: false }, sources: array(source, 1024) }));
const stateSuggest = schema(object({ sceneId: text(), events: array(candidate, 20), diagnostics: array(object({ code: text(128), index: { type: "integer", minimum: 0, maximum: 19 }, message: text(4096) }), 20), citations: array(source, 1024), provenance: anyRecord }));
const stateInput = schema(object({ sceneId: text() }));
const statePropose = schema(object({ sceneId: text(), candidate }));
const stateReceipt = schema(object({ stateProposalId: text(), proposalId: text() }));
const descriptor = (action_id: string, effect: "read" | "propose", input_schema: Record<string, unknown>, output_schema: Record<string, unknown>, required_capabilities: string[], callers: Array<"ui" | "mcp" | "plugin"> = ["ui", "mcp", "plugin"]): ActionDescriptor => ({
  plugin_id: "proprium.paired-writing", action_id, schema_version: 1, effect, input_schema, output_schema,
  required_capabilities, callers, requires_user_gesture: false,
});
const readCapabilities = ["workspace.file.read", "workspace.plugin.invoke"];
export const summaryStateDescriptors: ActionDescriptor[] = [
  descriptor("paired.summary.workspace", "read", schema(object({})), schema(object({ snapshot_id: text() })), [], ["ui"]),
  descriptor("paired.summary.preview", "read", summaryRead, summaryPreview, readCapabilities),
  descriptor("paired.summary.suggest", "read", summaryRead, summarySuggest, [...readCapabilities, "workspace.capabilities.query", "plugin.preferences"]),
  descriptor("paired.summary.propose", "propose", summaryPropose, summaryReceipt, [...readCapabilities, "workspace.change.propose", "workspace.change.timestamp"]),
  descriptor("paired.state-events.preview", "read", stateInput, statePreview, readCapabilities),
  descriptor("paired.state-events.suggest", "read", stateInput, stateSuggest, [...readCapabilities, "workspace.capabilities.query", "plugin.preferences"]),
  { ...descriptor("paired.state-events.propose", "propose", statePropose, stateReceipt, [...readCapabilities, "workspace.change.propose", "workspace.change.timestamp"], ["ui"]), requires_user_gesture: true },
];

const key = (data_key: string) => ({ data_key });
const binding = (action_id: string, input_template: Record<string, unknown>) => ({ action_id, input_template });
const titleField = { id: "target_id", label: "シーンまたは章の ID", type: "string", required: true, max_length: 256 };
const scopeField = { id: "scope", label: "要約の範囲", type: "enum", required: true, options: [{ value: "scene", label: "シーン" }, { value: "chapter", label: "章" }] };
const lines = { id: "lines", label: "要約（3行）", type: "ordered-list", required: true, initial_value: key("last_action_result.summary.summaryLines") };
const summaryProposalBase = { targetId: key("last_action_result.targetId"), expectedFileRevisions: key("last_action_result.expectedFileRevisions"), citations: key("last_action_result.citations"), sourceHash: key("last_action_result.sourceHash"), provenance: key("last_action_result.provenance") };
export const summaryStateSurfaces: SurfaceDeclaration[] = [
  { id: "paired.summary", kind: "panel", title: "シーン・章の要約", context: { workspace: true }, body: {
    id: "paired-summary-tabs", type: "tabs", title: "シーン・章の要約", load_actions: [{ key: "summary_snapshot", ...binding("paired.summary.workspace", {}) }], tabs: [
      { id: "summary-preview", title: "プレビュー", body: { id: "summary-preview-form", type: "form", title: "要約対象", description: "読み込むで現在のスナップショットを固定し、入力内容と送信予定の文章を確認します。", fields: [scopeField, titleField], submit: binding("paired.summary.preview", { scope: key("form.scope"), targetId: key("form.target_id"), expectedSnapshot: key("load.summary_snapshot.snapshot_id") }), submit_when: key("load.summary_snapshot.snapshot_id"), unavailable_message: "先に読み込んでください。" } },
      { id: "summary-context", title: "送信内容", body: { id: "summary-prompt-list", type: "list", title: "シーンごとの文脈", items: key("last_action_result.children"), primary: "id", secondary: "prompt" } },
      { id: "summary-generate", title: "生成", body: { id: "summary-generate-form", type: "form", title: "要約候補を生成", description: "プレビューした範囲を使用します。プロバイダーへの送信には Host の同意が必要です。", fields: [], submit: binding("paired.summary.suggest", { scope: key("last_action_result.scope"), targetId: key("last_action_result.targetId"), expectedSnapshot: key("last_action_result.snapshot.id") }), submit_when: key("last_action_result.snapshot.id"), unavailable_message: "先にプレビューしてください。" } },
      { id: "summary-scene-propose", title: "シーン要約を提案", body: { id: "summary-scene-form", type: "form", title: "シーン要約を確認", description: "生成候補を編集し、Host の変更レビューへ送ります。", fields: [lines, { id: "characters", label: "登場人物（1行1件）", type: "ordered-list", initial_value: key("last_action_result.summary.characters") }, { id: "state_changes", label: "状態変化（1行1件）", type: "ordered-list", initial_value: key("last_action_result.summary.stateChanges") }], submit: binding("paired.summary.propose", { scope: "scene", ...summaryProposalBase, summary: { summaryLines: key("form.lines"), characters: key("form.characters"), stateChanges: key("form.state_changes") } }), submit_when: key("last_action_result.expectedFileRevisions"), unavailable_message: "先にシーン要約を生成してください。" } },
      { id: "summary-chapter-propose", title: "章要約を提案", body: { id: "summary-chapter-form", type: "form", title: "章要約を確認", description: "子要約と章要約を同じ変更単位としてレビューします。候補の sourceHash は生成元の検証用で、提案後の記録には子要約の最終ハッシュも含まれます。", fields: [lines], submit: binding("paired.summary.propose", { scope: "chapter", ...summaryProposalBase, summary: { summaryLines: key("form.lines") }, children: key("last_action_result.children") }), submit_when: key("last_action_result.children"), unavailable_message: "先に章要約を生成してください。" } },
      { id: "summary-receipt", title: "提案", body: { id: "summary-receipt-detail", type: "detail", title: "提案済み変更", value: key("last_action_result"), fields: [{ key: "proposal_id", label: "提案 ID" }, { key: "paths", label: "変更先" }, { key: "sourceHash", label: "確定する元データのハッシュ" }] } },
    ] } },
  { id: "paired.state-events", kind: "panel", title: "状態変化の候補", context: { workspace: true }, body: { id: "paired-state-events-tabs", type: "tabs", title: "状態変化の候補", tabs: [
    { id: "state-preview", title: "プレビュー", body: { id: "state-preview-form", type: "form", title: "送信内容を確認", fields: [{ id: "scene_id", label: "シーン ID", type: "string", required: true, max_length: 256 }], submit: binding("paired.state-events.preview", { sceneId: key("form.scene_id") }) } },
    { id: "state-prompt", title: "文脈", body: { id: "state-preview-detail", type: "detail", title: "送信予定の文脈", value: key("last_action_result"), fields: [{ key: "prompt", label: "文脈" }, { key: "sources", label: "参照元" }] } },
    { id: "state-generate", title: "候補を生成", body: { id: "state-generate-form", type: "form", title: "状態変化を抽出", description: "候補は未確定です。プロバイダーへの送信には Host の同意が必要です。", fields: [{ id: "scene_id", label: "シーン ID", type: "string", required: true, max_length: 256 }], submit: binding("paired.state-events.suggest", { sceneId: key("form.scene_id") }) } },
    { id: "state-candidates", title: "候補", body: { id: "state-candidates-list", type: "list", title: "提案する候補を選択", description: "選択した候補は Knowledge の未確定提案となり、Host でレビューします。", items: key("last_action_result.events"), primary: "target", secondary: "operation", item_action: binding("paired.state-events.propose", { sceneId: key("last_action_result.sceneId"), candidate: key("item") }) } },
    { id: "state-receipt", title: "提案", body: { id: "state-receipt-detail", type: "detail", title: "提案済み変更", value: key("last_action_result"), fields: [{ key: "proposalId", label: "Host 提案 ID" }, { key: "stateProposalId", label: "状態提案 ID" }] } },
  ] } },
];

export function summaryStateHandlers(generate: GenerateProvider): Record<string, Handler> {
  return {
    "paired.summary.workspace": (_input, context) => ({ snapshot_id: (context as ActionRequest).snapshot.id }),
    "paired.summary.preview": (input, context, host) => previewSummary(input, host, context as ActionRequest),
    "paired.summary.suggest": (input, context, host) => suggestSummary(input, host, context as ActionRequest, generate),
    "paired.summary.propose": (input, context, host) => proposeSummary(input, host, context as ActionRequest),
    "paired.state-events.preview": (input, context, host) => previewStateEvents(input, host, context as ActionRequest),
    "paired.state-events.suggest": (input, context, host) => suggestStateEvents(input, host, context as ActionRequest, generate),
    "paired.state-events.propose": function* (input, context, host) {
      const result = (yield* proposeStateEvent(input, host, context as ActionRequest)) as { stateProposalId?: unknown; proposalId?: unknown };
      if (typeof result?.stateProposalId !== "string" || typeof result.proposalId !== "string") throw new PairedError("storage_unknown", "Knowledge did not return proposal identities");
      return { stateProposalId: result.stateProposalId, proposalId: result.proposalId };
    },
  };
}
