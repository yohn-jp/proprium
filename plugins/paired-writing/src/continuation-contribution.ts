import type { ActionDescriptor, ActionRequest, SurfaceDeclaration } from "../../../app/src/browser/proprium/authoring/types.js";
import type { Handler } from "../../shared/guest.js";
import { previewContinuation, suggestContinuation, type ProviderGenerator } from "./continuation.js";
import { previewReaderReaction, suggestReaderReaction } from "./reader-reaction.js";
import { CONTINUATION_PREVIEW_OUTPUT_SCHEMA, CONTINUATION_SUGGEST_OUTPUT_SCHEMA, READER_REACTION_PREVIEW_OUTPUT_SCHEMA, READER_REACTION_SUGGEST_OUTPUT_SCHEMA } from "./continuation-schemas.js";

const str=(maxLength:number,minLength=0)=>({type:"string",minLength,maxLength});
const bounded=(minimum:number,maximum:number)=>({type:"integer",minimum,maximum});
const draft={type:"object",additionalProperties:false,properties:{
 document_path:str(4096,1),revision:str(256,1),base_snapshot:str(256,1),base_scene_revision:str(256,1),draft_generation:str(256,1),confirmed:{const:true},
},required:["document_path","revision","base_snapshot","base_scene_revision","draft_generation","confirmed"]};
const continuationInput={type:"object",additionalProperties:false,properties:{
 sceneId:str(256,1),chapterId:str(256,1),recentSentences:{type:"array",maxItems:1000,items:str(8000)},
 explicitDraft:draft,k:bounded(0,40),tokenBudget:bounded(1,200000),
},required:[]};
const reactionInput={type:"object",additionalProperties:false,properties:{chapterId:str(256,1)},required:["chapterId"]};
const baseCapabilities=["workspace.file.read","workspace.plugin.invoke"];
const continuationCapabilities=[...baseCapabilities,"workspace.derived.cache"];
const providerCapabilities=["plugin.preferences","workspace.capabilities.query","provider.request"];
function descriptor(action_id:string,input_schema:ActionDescriptor["input_schema"],output_schema:ActionDescriptor["output_schema"],required_capabilities:string[]):ActionDescriptor {
 return {plugin_id:"proprium.paired-writing",action_id,schema_version:1,effect:"read",input_schema,output_schema,required_capabilities,callers:["ui","mcp","plugin"],requires_user_gesture:false};
}
export const descriptors:ActionDescriptor[]=[
 descriptor("paired.continuation.preview",continuationInput,CONTINUATION_PREVIEW_OUTPUT_SCHEMA,continuationCapabilities),
 descriptor("paired.continuation.suggest",continuationInput,CONTINUATION_SUGGEST_OUTPUT_SCHEMA,[...continuationCapabilities,...providerCapabilities]),
 descriptor("paired.reader.reaction.preview",reactionInput,READER_REACTION_PREVIEW_OUTPUT_SCHEMA,baseCapabilities),
 descriptor("paired.reader.reaction.suggest",reactionInput,READER_REACTION_SUGGEST_OUTPUT_SCHEMA,[...baseCapabilities,...providerCapabilities]),
];

const ref=(data_key:string)=>({data_key});
const continuationFields=[
 {id:"scene_id",type:"string",label:"シーン ID",required:true,max_length:256},
 {id:"chapter_id",type:"string",label:"章 ID（任意）",required:false,max_length:256},
 {id:"k",type:"integer",label:"直近の文数（0〜40）",required:false},
 {id:"token_budget",type:"integer",label:"概算トークン上限（1〜200000）",required:false},
];
const continuationBinding=(action_id:string)=>({action_id,input_template:{sceneId:ref("form.scene_id"),chapterId:ref("form.chapter_id"),k:ref("form.k"),tokenBudget:ref("form.token_budget")}});
const reactionFields=[{id:"chapter_id",type:"string",label:"章 ID",required:true,max_length:256}];
const reactionBinding=(action_id:string)=>({action_id,input_template:{chapterId:ref("form.chapter_id")}});
const detail=(id:string,title:string,fields:Array<{key:string;label:string}>)=>({id,type:"detail",title,value:ref("last_action_result"),fields});
const numbered=(key:string,label:string)=>Array.from({length:32},(_,index)=>({key:`${key}.${index}`,label:`${label} ${index+1}`}));

export const surfaces:SurfaceDeclaration[]=[
 {id:"paired-continuation",kind:"panel",title:"続きの方向",context:{label:"固定 snapshot の文脈と続きの方向"},body:{id:"paired_continuation_tabs",type:"tabs",tabs:[
  {id:"continuation_preview_form_tab",title:"プレビュー",body:{id:"continuation_preview_form",type:"form",title:"続きの文脈を確認",description:"保存済み本文と検証済みの要約・検索結果を使い、送信前にプロンプトを確認します。",fields:continuationFields,submit:continuationBinding("paired.continuation.preview")}},
  {id:"continuation_preview_result_tab",title:"文脈",body:detail("continuation_preview_result","送信前のプレビュー",[{key:"prompt",label:"プロンプト"},{key:"manifest.totalTokens",label:"概算トークン"},{key:"manifest.tokenBudget",label:"トークン上限"},{key:"manifest.tokenCountMode",label:"計測方法"}])},
  {id:"continuation_suggest_form_tab",title:"方向を提案",body:{id:"continuation_suggest_form",type:"form",title:"続きの方向を提案",description:"プロバイダーへの送信には Host の別途確認が必要です。",fields:continuationFields,submit:continuationBinding("paired.continuation.suggest")}},
  {id:"continuation_suggestions_tab",title:"候補",body:{id:"continuation_suggestions",type:"list",title:"続きの方向",items:ref("last_action_result.options"),primary:"direction",secondary:"rationale"}},
  {id:"continuation_sources_tab",title:"参照",body:{id:"continuation_sources",type:"list",title:"参照したファイルと revision",items:ref("last_action_result.sources"),primary:"path",secondary:"revision"}},
 ]}},
 {id:"paired-reader-reaction",kind:"panel",title:"初読の反応",context:{label:"承認済み章要約に基づく反応"},body:{id:"paired_reader_tabs",type:"tabs",tabs:[
  {id:"reader_preview_form_tab",title:"プレビュー",body:{id:"reader_preview_form",type:"form",title:"初読の文脈を確認",description:"対象章までの最新と確認できる承認済み要約だけを使用します。",fields:reactionFields,submit:reactionBinding("paired.reader.reaction.preview")}},
  {id:"reader_preview_result_tab",title:"文脈",body:detail("reader_preview_result","送信前のプレビュー",[{key:"prompt",label:"プロンプト"},{key:"promptVersion",label:"プロンプト版"}])},
  {id:"reader_summaries_tab",title:"参照要約",body:{id:"reader_summaries",type:"list",title:"使用する章要約",items:ref("last_action_result.summaries"),primary:"chapterId",secondary:"path"}},
  {id:"reader_diagnostics_tab",title:"要約の状態",body:{id:"reader_diagnostics",type:"list",title:"使用できない要約",items:ref("last_action_result.diagnostics"),primary:"chapterId",secondary:"code"}},
  {id:"reader_suggest_form_tab",title:"反応を提案",body:{id:"reader_suggest_form",type:"form",title:"初読の反応を提案",description:"プロバイダーへの送信には Host の別途確認が必要です。",fields:reactionFields,submit:reactionBinding("paired.reader.reaction.suggest")}},
  {id:"reader_questions_tab",title:"疑問",body:detail("reader_questions","読者の疑問",numbered("questions","疑問"))},
  {id:"reader_expectations_tab",title:"期待",body:detail("reader_expectations","読者の期待",numbered("expectations","期待"))},
  {id:"reader_confusions_tab",title:"混乱",body:detail("reader_confusions","読者の混乱",numbered("confusions","混乱"))},
  {id:"reader_sources_tab",title:"参照",body:{id:"reader_sources",type:"list",title:"参照した章要約",items:ref("last_action_result.sources"),primary:"path",secondary:"revision"}},
 ]}},
];

export function handlers(provider:ProviderGenerator):Record<string,Handler> {
 return {
  "paired.continuation.preview":(input,context,host)=>previewContinuation(input,host,context as ActionRequest),
  "paired.continuation.suggest":(input,context,host)=>suggestContinuation(input,host,context as ActionRequest,provider),
  "paired.reader.reaction.preview":(input,context,host)=>previewReaderReaction(input,host,context as ActionRequest),
  "paired.reader.reaction.suggest":(input,context,host)=>suggestReaderReaction(input,host,context as ActionRequest,provider),
 };
}
