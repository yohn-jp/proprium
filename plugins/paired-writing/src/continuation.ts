import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { PairedError } from "./types.js";

// Pure context budget ported from modules/assistant/src/continuation-context.ts.
export interface ContinuationPart { kind:"recent-sentences"|"chapter-summary"|"retrieval-hit";chars:number;tokens:number;count?:number;chapterId?:string;entityId?:string }
export interface ContinuationInput { recentSentences:readonly string[];k?:number;chapterSummary?:{chapterId:string;text:string}|null;retrievalHits?:readonly {entityId:string;text:string}[];tokenBudget?:number }
const CJK=/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
export function approximateContinuationTokens(text:string):number { let cjk=0,other=0; for(const ch of text) CJK.test(ch)?cjk++:other++; return cjk+Math.ceil(other/3); }
export function buildContinuationContext(input:ContinuationInput) {
  const k=input.k??8,budget=input.tokenBudget??12000;
  if(!Number.isSafeInteger(k)||k<0||k>40||!Number.isSafeInteger(budget)||budget<1||budget>200000) throw new PairedError("invalid_input","Continuation bounds are invalid");
  let taken=k===0?[]:input.recentSentences.slice(-k);
  while(taken.length && approximateContinuationTokens(taken.join("\n"))>budget) taken=taken.slice(1);
  const sections:string[]=[],parts:ContinuationPart[]=[]; let used=0;
  const add=(text:string,part:Omit<ContinuationPart,"tokens">)=>{const tokens=approximateContinuationTokens(text),cost=tokens+(sections.length?approximateContinuationTokens("\n\n"):0);if(used+cost>budget)return;used+=cost;sections.push(text);parts.push({...part,tokens});};
  if(taken.length){const text=taken.join("\n");add(text,{kind:"recent-sentences",count:taken.length,chars:text.length});}
  if(input.chapterSummary?.text.trim()){const text=input.chapterSummary.text.trim();add(text,{kind:"chapter-summary",chapterId:input.chapterSummary.chapterId,chars:text.length});}
  for(const hit of (input.retrievalHits??[]).slice(0,5)){const text=hit.text.trim();if(text)add(text,{kind:"retrieval-hit",entityId:hit.entityId,chars:text.length});}
  const text=sections.join("\n\n");
  return {text,manifest:{featureId:"continuation-options" as const,parts,totalChars:text.length,totalTokens:used,tokenBudget:budget,tokenCountMode:"approximate" as const}};
}
const COMMON="あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。";
const TEMPLATE="作者の手が止まった場面で、「続きの展開の方向」を 3 つ提案してください。\n各案は direction（短い方向性）と rationale（なぜ今それが効くかの理由）のみ。\n本文の文章・セリフ・地の文は一切生成しないでください。続きの原稿を書かないでください。\n方向の型の例: 会話で進める / 情景を挟む / 時間を飛ばす — 文脈に合わせて言い換えてよい。";
export function renderContinuationPrompt(text:string):string {
 const context=text.trim()?`【文脈（直近の文と章要約。これ以外は見ない）】\n${text.trim()}`:"【文脈】（空 — 一般的な展開の方向のみ提案）";
 return `${COMMON}\n\n${TEMPLATE}\n\n${context}\n\nJSONのみを返してください。スキーマ: {"options":[{"direction":"...","rationale":"..."},{"direction":"...","rationale":"..."},{"direction":"...","rationale":"..."}]}`;
}
export type ProviderGenerator=(host:GuestHost,request:ActionRequest,input:{feature:string;prompt:string;promptVersion:string;maxOutputTokens:number;sourceManifest?:unknown})=>Generator<HostCall,{text:string;provenance:{provider:string;model:string;promptVersion:string;requestId:string;untrusted:true}},unknown>;
/** A prepared context must be built from the Host-pinned workspace before this internal call. */
export function* generateContinuation(
 host:GuestHost,request:ActionRequest,prepared:ReturnType<typeof buildContinuationContext>,generateProvider:ProviderGenerator,
):Generator<HostCall,unknown,unknown> {
 const prompt=renderContinuationPrompt(prepared.text);
 const result=yield* generateProvider(host,request,{feature:"continuation-options",prompt,promptVersion:"continuation-options.v3",maxOutputTokens:1024,sourceManifest:prepared.manifest});
 let decoded:unknown; try{decoded=JSON.parse(result.text);}catch{throw new PairedError("invalid_input","Continuation provider returned invalid JSON");}
 if(!decoded||typeof decoded!=="object"||Array.isArray(decoded)||Object.keys(decoded).some(key=>key!=="options"))throw new PairedError("invalid_input","Continuation provider response is invalid");
 const options=(decoded as {options?:unknown}).options;
 if(!Array.isArray(options)||options.length!==3||options.some(item=>!item||typeof item!=="object"||Array.isArray(item)||Object.keys(item).some(key=>key!=="direction"&&key!=="rationale")||typeof item.direction!=="string"||!item.direction.trim()||item.direction.length>2000||typeof item.rationale!=="string"||!item.rationale.trim()||item.rationale.length>4000))throw new PairedError("invalid_input","Continuation requires three bounded direction and rationale pairs");
 return {options,context:prepared.manifest,provenance:result.provenance};
}
