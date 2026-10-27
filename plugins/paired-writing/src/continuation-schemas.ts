/** Closed output contracts for the four Paired continuation and reader actions. */
const string = (maxLength:number, minLength=0) => ({type:"string",minLength,maxLength} as const);
const integer = (minimum:number,maximum:number) => ({type:"integer",minimum,maximum} as const);
const closed = (properties:Record<string,unknown>, required:readonly string[]) => ({type:"object",additionalProperties:false,properties,required} as const);
const array = (items:unknown,maxItems:number,minItems=0) => ({type:"array",items,minItems,maxItems} as const);
const file = closed({path:string(1024,1),revision:string(256,1)},["path","revision"]);
export const PAIRED_CONTINUATION_SNAPSHOT_SCHEMA = closed({
 id:string(256,1),local_commit:{type:["string","null"],maxLength:256},worktree_generation:string(256),
 draft_generation:{type:["string","null"],maxLength:256},remote_commit:{type:["string","null"],maxLength:256},
},["id","local_commit","worktree_generation","draft_generation"]);
const provenance = closed({provider:string(256,1),model:string(1024,1),promptVersion:string(256,1),requestId:string(256,1),untrusted:{const:true}},["provider","model","promptVersion","requestId","untrusted"]);
const part = closed({kind:{enum:["recent-sentences","chapter-summary","retrieval-hit"]},chars:integer(0,2000000),tokens:integer(0,200000),count:integer(0,40),chapterId:string(256,1),entityId:string(1024,1)},["kind","chars","tokens"]);
const manifest = closed({featureId:{const:"continuation-options"},parts:array(part,7),totalChars:integer(0,2000000),totalTokens:integer(0,200000),tokenBudget:integer(1,200000),tokenCountMode:{const:"approximate"}},["featureId","parts","totalChars","totalTokens","tokenBudget","tokenCountMode"]);
const sources=array(file,42000);
const continuationDiagnostics=array(string(128,1),10000);
const reactionDiagnostic=closed({chapterId:string(256,1),code:{enum:["summary_missing","summary_invalid","summary_unverified","summary_stale"]}},["chapterId","code"]);
const reactionDiagnostics=array(reactionDiagnostic,10000);
const sourceFiles=array(file,30000);
const contextFiles=array(file,1000);
const childSummaryFiles=array(file,10000);
const summary=closed({chapterId:string(256,1),summaryLines:array(string(4000),12,1),path:string(1024,1),revision:string(256,1),source_files:sourceFiles,context_files:contextFiles,child_summary_files:childSummaryFiles},["chapterId","summaryLines","path","revision","source_files","context_files","child_summary_files"]);
const reactionSource=closed({chapterId:string(256,1),path:string(1024,1),revision:string(256,1),source_files:sourceFiles,context_files:contextFiles,child_summary_files:childSummaryFiles},["chapterId","path","revision","source_files","context_files","child_summary_files"]);
export const CONTINUATION_PREVIEW_OUTPUT_SCHEMA = closed({
 prompt:string(786432),promptVersion:{const:"continuation-options.v3"},provider_invoked:{const:false},snapshot:PAIRED_CONTINUATION_SNAPSHOT_SCHEMA,
 manifest,sources,diagnostics:continuationDiagnostics,
},["prompt","promptVersion","provider_invoked","snapshot","manifest","sources","diagnostics"]);
export const CONTINUATION_SUGGEST_OUTPUT_SCHEMA = closed({
 options:array(closed({direction:string(2000,1),rationale:string(4000,1)},["direction","rationale"]),3,3),
 manifest,sources,diagnostics:continuationDiagnostics,snapshot:PAIRED_CONTINUATION_SNAPSHOT_SCHEMA,provenance,
},["options","manifest","sources","diagnostics","snapshot","provenance"]);
export const READER_REACTION_PREVIEW_OUTPUT_SCHEMA = closed({
 prompt:string(524288),promptVersion:{const:"first-read-reaction-v3"},provider_invoked:{const:false},snapshot:PAIRED_CONTINUATION_SNAPSHOT_SCHEMA,
 summaries:array(summary,10000),diagnostics:reactionDiagnostics,
},["prompt","promptVersion","provider_invoked","snapshot","summaries","diagnostics"]);
export const READER_REACTION_SUGGEST_OUTPUT_SCHEMA = closed({
 questions:array(string(4000),32),expectations:array(string(4000),32),confusions:array(string(4000),32),
 sources:array(reactionSource,10000),provenance,snapshot:PAIRED_CONTINUATION_SNAPSHOT_SCHEMA,diagnostics:reactionDiagnostics,
},["questions","expectations","confusions","sources","provenance","snapshot","diagnostics"]);
