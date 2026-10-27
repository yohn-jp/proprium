import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { PairedError } from "./types.js";
import { captureContext } from "./context.js";
import { invokeAction, readNarrativeScene, readText } from "./host.js";
import { prepareReaderReaction, type ReaderSummary } from "./reader-reaction.js";
import { exactKeys, finiteInteger, identity, record } from "./validation.js";

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
/** Browser-safe sentence segmentation copied from the source core-shared contract. */
export interface SentenceOffset { start: number; end: number }
interface SentenceSegment { text: string; start: number; end: number }

const OPEN_BRACKETS = new Set(["「", "『"]);
const CLOSE_BRACKETS = new Set(["」", "』"]);

function bracketDepth(text: string, endExclusive: number): number {
  let depth = 0;
  for (let i = 0; i < endExclusive; i++) {
    const ch = text[i]!;
    if (OPEN_BRACKETS.has(ch)) depth++;
    else if (CLOSE_BRACKETS.has(ch)) depth = Math.max(0, depth - 1);
  }
  return depth;
}

function splitAtClosingBrackets(line: string, lineStart: number, seg: SentenceSegment): SentenceSegment[] {
  const relStart = seg.start - lineStart;
  const relEnd = seg.end - lineStart;
  const out: SentenceSegment[] = [];
  let depth = bracketDepth(line, relStart);
  let chunkStart = relStart;
  for (let i = relStart; i < relEnd; i++) {
    const ch = line[i]!;
    if (OPEN_BRACKETS.has(ch)) {
      if (depth === 0 && i > chunkStart) {
        out.push({ text: line.slice(chunkStart, i), start: lineStart + chunkStart, end: lineStart + i });
        chunkStart = i;
      }
      depth++;
    } else if (CLOSE_BRACKETS.has(ch)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        const end = i + 1;
        out.push({ text: line.slice(chunkStart, end), start: lineStart + chunkStart, end: lineStart + end });
        chunkStart = end;
      }
    }
  }
  if (chunkStart < relEnd) out.push({ text: line.slice(chunkStart, relEnd), start: lineStart + chunkStart, end: seg.end });
  return out.length > 0 ? out : [seg];
}

function splitLineWithSegmenter(line: string, lineStart: number): SentenceSegment[] {
  if (line.length === 0) return [{ text: "", start: lineStart, end: lineStart }];
  const segmenter = new Intl.Segmenter("ja", { granularity: "sentence" });
  const raw: SentenceSegment[] = [];
  for (const { segment, index } of segmenter.segment(line)) {
    raw.push({ text: segment, start: lineStart + index, end: lineStart + index + segment.length });
  }
  if (raw.length === 0) return splitAtClosingBrackets(line, lineStart, { text: line, start: lineStart, end: lineStart + line.length });
  const merged: SentenceSegment[] = [];
  let acc = raw[0]!;
  for (let i = 1; i < raw.length; i++) {
    if (bracketDepth(line, acc.end - lineStart) > 0) {
      acc = { text: line.slice(acc.start - lineStart, raw[i]!.end - lineStart), start: acc.start, end: raw[i]!.end };
    } else {
      merged.push(acc);
      acc = raw[i]!;
    }
  }
  merged.push(acc);
  return merged.flatMap((seg) => splitAtClosingBrackets(line, lineStart, seg));
}

function splitIntoSentenceSegments(text: string): SentenceSegment[] {
  const segments: SentenceSegment[] = [];
  let lineStart = 0;
  let justSplit = false;
  for (let i = 0; i <= text.length; i++) {
    const atNewline = i < text.length && text[i] === "\n";
    const atEnd = i === text.length;
    if (!atNewline && !atEnd) continue;
    const lineEnd = i;
    if (lineEnd > lineStart) {
      segments.push(...splitLineWithSegmenter(text.slice(lineStart, lineEnd), lineStart));
      justSplit = true;
    } else if (atNewline && !justSplit) {
      segments.push({ text: "", start: lineEnd, end: lineEnd });
    }
    if (atEnd) lineStart = text.length;
    else {
      lineStart = i + 1;
      justSplit = false;
    }
  }
  segments.push({ text: text.slice(lineStart), start: lineStart, end: text.length });
  return segments;
}

export function splitIntoSentences(text: string): string[] {
  return splitIntoSentenceSegments(text).map((segment) => segment.text);
}


interface SourceFile {path:string;revision:string}
interface ContinuationPreview {prompt:string;promptVersion:string;provider_invoked:false;snapshot:ActionRequest["snapshot"];manifest:ReturnType<typeof buildContinuationContext>["manifest"];sources:SourceFile[];diagnostics:string[]}
/** Resolve exact Host snapshot context before constructing the source prompt. */
export function* previewContinuation(input:unknown,host:GuestHost,request:ActionRequest):Generator<HostCall,ContinuationPreview,unknown> {
 const row=record(input,"input");exactKeys(row,["sceneId","chapterId","recentSentences","explicitDraft","k","tokenBudget"],"input");
 const k=row.k===undefined?8:finiteInteger(row.k,"k",0,40),budget=row.tokenBudget===undefined?12000:finiteInteger(row.tokenBudget,"tokenBudget",1,200000);
 if(row.recentSentences!==undefined&&(!Array.isArray(row.recentSentences)||row.recentSentences.length>1000||row.recentSentences.some(item=>typeof item!=="string"||item.length>8000)))throw new PairedError("invalid_input","recentSentences are invalid");
 if(row.explicitDraft!==undefined&&row.sceneId===undefined)throw new PairedError("invalid_input","Explicit draft requires a scene");
 const sources:SourceFile[]=[],diagnostics:string[]=[];let chapterId=row.chapterId===undefined?undefined:identity(row.chapterId,"chapterId");let sceneBody:string|undefined;
 if(row.sceneId!==undefined){
  const sceneId=identity(row.sceneId,"sceneId");
  if(row.explicitDraft!==undefined){
   const context=yield* captureContext({target:{sceneId},include:["scene","saved_manuscript","draft"],shareDraft:row.explicitDraft},host,request);
   const draft=context.parts.find(part=>part.kind==="draft");if(!draft||draft.truncated)throw new PairedError("capacity","Explicit draft is unavailable or exceeds the continuation context limit");
   sceneBody=draft.content;for(const part of context.parts)if(part.path&&part.revision)sources.push({path:part.path,revision:part.revision});
   const scene=yield* readNarrativeScene<{scene_id:string;metadata_revision:string;manuscript_path:string;manuscript_revision:string;chapter:{id:string}}>(host,request,sceneId);chapterId??=scene.chapter.id;
  }else{
   const scene=yield* readNarrativeScene<{scene_id:string;metadata_revision:string;manuscript_path:string;manuscript_revision:string;chapter:{id:string}}>(host,request,sceneId);
   const file=yield* readText(host,request,scene.manuscript_path);if(file.revision!==scene.manuscript_revision)throw new PairedError("snapshot_stale","Scene manuscript changed");
   sceneBody=file.text;chapterId??=scene.chapter.id;sources.push({path:scene.metadata_path,revision:scene.metadata_revision},{path:file.path,revision:file.revision});
  }
 }
 const recent=(row.explicitDraft!==undefined ? splitIntoSentences(sceneBody??"").map(item=>item.trim()).filter(Boolean).slice(-12) : Array.isArray(row.recentSentences)&&row.recentSentences.length ? row.recentSentences as string[] : sceneBody===undefined ? [] : splitIntoSentences(sceneBody).map(item=>item.trim()).filter(Boolean));
 let chapterSummary:{chapterId:string;text:string}|undefined;
 if(chapterId){
  const chapterResult=(yield* prepareReaderReaction({chapterId},host,request)) as {summaries:ReaderSummary[];diagnostics:Array<{chapterId:string;code:string}>};
  const summary=chapterResult.summaries.find(item=>item.chapterId===chapterId);
  if(summary){chapterSummary={chapterId,text:summary.summaryLines.join("\n")};sources.push({path:summary.path,revision:summary.revision},...summary.source_files,...summary.context_files,...summary.child_summary_files);}
  for(const entry of chapterResult.diagnostics.filter(item=>item.chapterId===chapterId))diagnostics.push(entry.code);
 }
 const retrievalHits:Array<{entityId:string;text:string}>=[];const query=recent.slice(-3).join(" ").trim();
 if(query){
  if(query.length>512)diagnostics.push("retrieval_query_too_long");
  else try{
   const page=yield* invokeAction<{indexSnapshot:string;hits:Array<{kind:string;path:string;fileRevision:string;matchRanges:Array<{start:number;end:number}>}>}>(host,request,"proprium.research","research.query",{query,mode:"lexical",limit:5,includeTerms:false});
   if(!page||page.indexSnapshot!==request.snapshot.id||!Array.isArray(page.hits)||page.hits.length>5)throw new PairedError("snapshot_stale","Research evidence is not current");
   for(const hit of page.hits){if(hit.kind!=="document"||!hit.matchRanges?.length)continue;const span=hit.matchRanges[0]!;const file=yield* readText(host,request,hit.path);
    if(file.revision!==hit.fileRevision||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start||span.end>file.text.length||span.end-span.start>1024)throw new PairedError("snapshot_stale","Research evidence changed");
    retrievalHits.push({entityId:hit.path,text:file.text.slice(span.start,span.end)});sources.push({path:file.path,revision:file.revision});}
  }catch(error){
   const code=error && typeof error==="object" && "code" in error ? error.code : undefined;
   if(typeof code==="string" && ["dependency_unavailable","plugin_unavailable"].includes(code))diagnostics.push("research_unavailable");else throw error;
  }
 }
 const prepared=buildContinuationContext({recentSentences:recent,k,tokenBudget:budget,...(chapterSummary ? {chapterSummary} : {}),retrievalHits});const prompt=renderContinuationPrompt(prepared.text);
 if(new TextEncoder().encode(JSON.stringify({prompt,manifest:prepared.manifest,sources,diagnostics})).byteLength>768*1024)throw new PairedError("capacity","Continuation preview exceeds its output limit");
 return {prompt,promptVersion:"continuation-options.v3",provider_invoked:false,snapshot:request.snapshot,manifest:prepared.manifest,sources,diagnostics};
}
export function* suggestContinuation(input:unknown,host:GuestHost,request:ActionRequest,provider:ProviderGenerator):Generator<HostCall,unknown,unknown>{
 const preview=yield* previewContinuation(input,host,request);
 const result=yield* provider(host,request,{feature:"continuation-options",prompt:preview.prompt,promptVersion:preview.promptVersion,maxOutputTokens:1024,sourceManifest:{manifest:preview.manifest,sources:preview.sources,diagnostics:preview.diagnostics}});
 let decoded:unknown;try{decoded=JSON.parse(result.text);}catch{throw new PairedError("invalid_input","Continuation provider returned invalid JSON");}
 if(!decoded||typeof decoded!=="object"||Array.isArray(decoded)||Object.keys(decoded).some(key=>key!=="options"))throw new PairedError("invalid_input","Continuation provider response is invalid");
 const options=(decoded as {options?:unknown}).options;
 if(!Array.isArray(options)||options.length!==3||options.some(item=>!item||typeof item!=="object"||Array.isArray(item)||Object.keys(item).some(key=>key!=="direction"&&key!=="rationale")||typeof item.direction!=="string"||!item.direction.trim()||item.direction.length>2000||typeof item.rationale!=="string"||!item.rationale.trim()||item.rationale.length>4000))throw new PairedError("invalid_input","Continuation requires three bounded direction and rationale pairs");
 return {options,manifest:preview.manifest,sources:preview.sources,diagnostics:preview.diagnostics,snapshot:request.snapshot,provenance:result.provenance};
}
