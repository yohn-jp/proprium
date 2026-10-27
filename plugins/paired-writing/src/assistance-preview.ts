import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { readNarrativeScene, readText } from "./host.js";
import { PairedError } from "./types.js";
import { exactKeys, identity, record } from "./validation.js";

// Prompt text is ported from the pinned Scriptorium prompt assets. No provider is invoked.
const COMMON = "あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。";
const QA = "あなたは小説プロジェクトの設定質問窓口です。\n読み取り専用の検索ツールだけを使い、根拠を集めてから答えてください。\n引用できない主張をしてはいけません。根拠が無ければ「見つからなかった」と答えてください。\n\n最終回答は構造化出力（answer / citations / confidence）で返してください。\ncitations が空のときは answer に断定的な事実を書かず、見つからなかった旨を述べてください。\nconfidence は根拠の厚みに応じて high / medium / low を選んでください。";
function* sceneText(host:GuestHost, request:ActionRequest, sceneId:string):Generator<HostCall,{text:string;path:string;revision:string},unknown> {
  const scene = yield* readNarrativeScene(host,request,sceneId);
  const file = yield* readText(host,request,scene.manuscript_path);
  if (file.revision !== scene.manuscript_revision) throw new PairedError("snapshot_stale","Manuscript revision changed");
  return {text:file.text,path:file.path,revision:file.revision};
}

/** The same bounded local prompt can be used by the later consented QA executor. */
export function* previewQa(input:unknown,host:GuestHost,request:ActionRequest):Generator<HostCall,unknown,unknown> {
  const row=record(input,"input"); exactKeys(row,["messages","question","sceneId"],"input");
  if (row.question !== undefined && (typeof row.question !== "string" || !row.question.trim() || row.question.length>8000)) throw new PairedError("invalid_input","question is invalid");
  if (row.messages !== undefined && (!Array.isArray(row.messages) || row.messages.length<1 || row.messages.length>20 || row.messages.some(item => {
    if (!item || typeof item!=="object" || Array.isArray(item)) return true;
    const msg=item as Record<string,unknown>; return Object.keys(msg).some(key=>key!=="role"&&key!=="content") || !["user","assistant"].includes(String(msg.role)) || typeof msg.content!=="string" || msg.content.length>8000;
  }))) throw new PairedError("invalid_input","messages are invalid");
  if (!row.question && !(row.messages as Array<{role:string}>|undefined)?.some(item=>item.role==="user")) throw new PairedError("invalid_input","A user question is required");
  const file = row.sceneId === undefined ? undefined : yield* sceneText(host,request,identity(row.sceneId,"sceneId"));
  const messages = [...((row.messages ?? []) as Array<{role:"user" | "assistant";content:string}>),
    ...(typeof row.question === "string" ? [{role:"user" as const,content:row.question}] : [])];
  const system = `${COMMON}\n\n${QA}\n\n本文:\n${file?.text || "（関連シーンは指定されていません）"}\n\n読み取り専用ツールだけで事実を確認してください。回答はJSONオブジェクト1つで、answer、citations、confidenceを含めてください。citationsはツールが返した kind/id/quote の値をそのまま使い、根拠が無い回答は断定せず citations を空にしてください。confidenceは high / medium / low のいずれかです。`;
  const prompt = `${system}\n\n会話:\n${messages.map(message => `${message.role}: ${message.content}`).join("\n")}`;
  const result = {prompt,system,messages,promptVersion:"setting-qa.v1",provider_invoked:false,snapshot:request.snapshot,sources:file?[{path:file.path,revision:file.revision}]:[]};
  // Bound the serialized result including both the system prompt and displayed conversation.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 768 * 1024) throw new PairedError("capacity", "QA preview exceeds its bounded output size");
  return result;
}
