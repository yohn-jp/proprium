import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { readWorkspaceSettings } from "./settings.js";
import { PairedError } from "./types.js";
import { exactKeys, identity, record } from "./validation.js";
import type { AssistantModelSettings } from "./model-settings.js";

export function* previewSynonyms(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  const args = record(input, "input"); exactKeys(args, ["original", "sentence", "reason"], "input");
  const original = identity(args.original, "original", 256);
  const sentence = identity(args.sentence, "sentence", 8000);
  if (!original.trim() || !sentence.includes(original)) throw new PairedError("invalid_input", "sentence must contain the original term");
  const reason = args.reason === undefined ? undefined : identity(args.reason, "reason", 512);
  const settings = (yield* readWorkspaceSettings({}, host, request)) as { effective: AssistantModelSettings; workspace: { revision: string | null } };
  const presetId = settings.effective.featurePresetIds["synonym-suggest"] ?? settings.effective.defaultPresetId;
  const model = settings.effective.presets.find(preset => preset.id === presetId)?.model ?? "";
  const prompt = [
    "あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。",
    [reason ? `提案理由: ${reason}（地の文・セリフの言い換え候補として自然な語を選ぶ）` : "小説の地の文またはセリフで使える言い換え表現を提案する",
      "対象語句と文全体の意味・文体を保ち、言い換え語句を3〜5個出してください。",
      `対象語句: ${original}`, `文: ${sentence}`, '\n\nJSONのみを返してください。スキーマ: {"candidates":["...","...","..."]}'].join("\n"),
  ].join("\n\n");
  return { prompt, promptVersion: "synonym-suggest@2", presetId, model, provider_invoked: false, settings_revision: settings.workspace.revision };
}
