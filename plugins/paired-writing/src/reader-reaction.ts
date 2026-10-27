import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import type { ProviderGenerator } from "./continuation.js";
import { PairedError } from "./types.js";

export interface ReaderSummary {chapterId:string;summaryLines:readonly string[];path:string;revision:string}
const COMMON="あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。";
/** Port of the pinned first-read-reaction-v3 template; callers supply verified accepted summaries. */
export function renderReaderReactionPrompt(chapterId:string,summaries:readonly Pick<ReaderSummary,"chapterId"|"summaryLines">[]):string {
 const blocks=summaries.map(item=>`chapter_id: ${item.chapterId}\n${item.summaryLines.map(line=>`- ${line}`).join("\n")}`).join("\n\n")||"(要約なし)";
 return `${COMMON}\n\nあなたは初読の読者です。以下はこれまでに読んだ章の要約だけです。\n後続の章の知識は持っていません。\nいま読んだ章: ${chapterId}\n累積要約:\n${blocks}\n初読の読者が抱く疑問・期待・混乱を挙げてください。\n\nJSONのみを返してください。スキーマ: {"questions":["..."],"expectations":["..."],"confusions":["..."]}`;
}
/** This internal adapter requires callers to verify summary freshness before invocation. */
export function* generateReaderReaction(host:GuestHost,request:ActionRequest,chapterId:string,summaries:readonly ReaderSummary[],generateProvider:ProviderGenerator):Generator<HostCall,unknown,unknown> {
 if(!chapterId||chapterId.length>256||summaries.length>256)throw new PairedError("invalid_input","Reader reaction context is invalid");
 const prompt=renderReaderReactionPrompt(chapterId,summaries);
 if(new TextEncoder().encode(prompt).byteLength>512*1024)throw new PairedError("capacity","Reader reaction context is too large");
 const response=yield* generateProvider(host,request,{feature:"first-read-reaction",prompt,promptVersion:"first-read-reaction-v3",maxOutputTokens:1024,sourceManifest:summaries.map(({chapterId,path,revision})=>({chapterId,path,revision}))});
 let raw:unknown;try{raw=JSON.parse(response.text);}catch{throw new PairedError("invalid_input","Reader reaction provider returned invalid JSON");}
 if(!raw||typeof raw!=="object"||Array.isArray(raw)||Object.keys(raw).some(key=>!["questions","expectations","confusions"].includes(key)))throw new PairedError("invalid_input","Reader reaction provider response is invalid");
 const value=raw as Record<string,unknown>;
 for(const key of ["questions","expectations","confusions"]) if(!Array.isArray(value[key])||(value[key] as unknown[]).length>32||(value[key] as unknown[]).some(item=>typeof item!=="string"||item.length>4000))throw new PairedError("invalid_input",`Reader reaction ${key} is invalid`);
 return {...value,sources:summaries.map(({chapterId,path,revision})=>({chapterId,path,revision})),provenance:response.provenance};
}
