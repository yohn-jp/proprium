import type { ActionDescriptor, SurfaceDeclaration } from '../../../app/src/browser/proprium/authoring/types.js';
import type { Handler } from '../../shared/guest.js';
import { ASPECT_PREVIEW_INPUT_SCHEMA, ASPECT_PREVIEW_OUTPUT_SCHEMA, ASPECT_REVIEW_INPUT_SCHEMA, ASPECT_REVIEW_OUTPUT_SCHEMA, CONTRADICTION_INPUT_SCHEMA, CONTRADICTION_OUTPUT_SCHEMA, SPEAKER_INPUT_SCHEMA, SPEAKER_OUTPUT_SCHEMA, USAGE_HISTORY_INPUT_SCHEMA, USAGE_HISTORY_OUTPUT_SCHEMA, projectContradictionResult, projectUsageResult } from './adapter-schemas.js';
import { delegateAspect, delegateSpeaker, gatherContradictionEvidence, gatherTextEvidence, judgeContradiction, type AspectRequest, type ContradictionProvider, type SpeakerRequest } from './assistance-adapters.js';
import { readHostUsage, resolveUsageHistory, type UsageHistoryQuery } from './usage-history.js';
import { PairedError } from './types.js';
import { exactKeys, record } from './validation.js';

const descriptor = (action_id:string,input_schema:ActionDescriptor['input_schema'],output_schema:ActionDescriptor['output_schema'],required_capabilities:string[]):ActionDescriptor => ({
 plugin_id:'proprium.paired-writing',action_id,schema_version:1,effect:'read',input_schema,output_schema,required_capabilities,callers:['ui','mcp','plugin'],requires_user_gesture:false,
});
export const descriptors:ActionDescriptor[] = [
 descriptor('paired.history.usage.read',USAGE_HISTORY_INPUT_SCHEMA,USAGE_HISTORY_OUTPUT_SCHEMA,['workspace.file.read']),
 descriptor('paired.contradictions.verdict',CONTRADICTION_INPUT_SCHEMA,CONTRADICTION_OUTPUT_SCHEMA,['workspace.file.read','workspace.plugin.invoke']),
 descriptor('paired.speaker.attribute',SPEAKER_INPUT_SCHEMA,SPEAKER_OUTPUT_SCHEMA,['workspace.plugin.invoke']),
 descriptor('paired.aspect.review',ASPECT_REVIEW_INPUT_SCHEMA,ASPECT_REVIEW_OUTPUT_SCHEMA,['workspace.plugin.invoke']),
 descriptor('paired.aspect.preview',ASPECT_PREVIEW_INPUT_SCHEMA,ASPECT_PREVIEW_OUTPUT_SCHEMA,['workspace.plugin.invoke']),
];

/** Provider execution remains Host-mediated; absent evidence does not invoke the provider. */
export function handlers(provider:ContradictionProvider):Record<string,Handler> {
 return {
  'paired.history.usage.read': function* (input,request,host) {
   const value=record(input,'input'); exactKeys(value,['limit','month','cursor','source'],'input');
   const query=value as unknown as UsageHistoryQuery;
   const result=yield* resolveUsageHistory(host,request,query,q=>readHostUsage(host,q));
   return projectUsageResult(result);
  },
  'paired.aspect.review': function* (input,request,host) { return yield* delegateAspect(host,request,input as unknown as AspectRequest); },
  'paired.aspect.preview': function* (input,request,host) { return yield* delegateAspect(host,request,input as unknown as AspectRequest,true); },
  'paired.speaker.attribute': function* (input,request,host) { return yield* delegateSpeaker(host,request,input as unknown as SpeakerRequest); },
  'paired.contradictions.verdict': function* (input,request,host) {
   const value=record(input,'input'); exactKeys(value,['candidateId','candidateText'],'input');
   if ((typeof value.candidateId === 'string') === (typeof value.candidateText === 'string')) throw new PairedError('invalid_input','Exactly one contradiction candidate is required');
   let citations:Record<string,unknown>[]; let source:'semantic.candidates'|'research.query'|'local.lexical'; let candidate:{candidateId?:string;candidateText?:string;candidateContext?:string}; let provenance:unknown;
   if (typeof value.candidateId==='string') {
    const evidence=yield* gatherContradictionEvidence(host,request,value.candidateId);
    citations=evidence.citations.map(item=>({...item})); source='semantic.candidates';
    const raw=evidence.candidate as unknown as Record<string,unknown> | null;
    candidate={candidateId:value.candidateId,...(typeof raw?.suspicion==='string'?{candidateContext:raw.suspicion}:{})};
    provenance={source,diagnostic:evidence.diagnostic??null};
   } else {
    const evidence=yield* gatherTextEvidence(host,request,value.candidateText as string);
    citations=evidence.citations.map(item=>({...item}));
    const p=evidence.provenance as {source?:unknown}; source=p?.source==='research.query'?'research.query':'local.lexical';
    candidate={candidateText:value.candidateText as string}; provenance=evidence.provenance;
   }
   try { return projectContradictionResult(yield* judgeContradiction(host,request,candidate,citations as Array<{path:string;revision:string;quote:string}>,provenance,provider),source); }
   catch(error) {
    const code=error && typeof error==='object' && 'code' in error ? error.code : undefined;
    if (code!=='provider_unavailable') throw error;
    return projectContradictionResult({verdict:'insufficient',reason:'判断用のプロバイダーを利用できません。根拠を確認してください。',quotes:[],citations,provenance:{provider:null},diagnostic:'provider_unavailable'},source);
   }
  },
 };
}

const form = (id:string,title:string,fieldId:string,label:string,action_id:string,input_template:Record<string,unknown>,max_length=256) => ({
 id,type:'form',title,fields:[{id:fieldId,type:'string',label,required:true,max_length}],submit:{action_id,input_template},
});
const table = (id:string,title:string,key:string,columns:Array<{key:string;label:string}>) => ({id,type:'table',title,rows:{data_key:`last_action_result.${key}`},columns});
const detail = (id:string,title:string,fields:Array<{key:string;label:string}>) => ({id,type:'detail',title,value:{data_key:'last_action_result'},fields});
const panel = (id:string,title:string,tabs:Array<{id:string;title:string;body:Record<string,unknown>}>):SurfaceDeclaration => ({id,kind:'panel',title,context:{label:'現在の保存済みスナップショットを使用します。'},body:{id:`${id}-tabs`,type:'tabs',tabs}});
export const surfaces:SurfaceDeclaration[] = [
 panel('paired.usage-history','Usage history',[
  {id:'usage-load',title:'Read',body:{id:'usage-history-load',type:'table',title:'Usage events',load_action:{action_id:'paired.history.usage.read',input_template:{limit:50}},rows:{data_key:'last_action_result.events'},next_action:{action_id:'paired.history.usage.read',input_template:{limit:50,cursor:{data_key:'last_action_result.nextCursor'}}},next_action_when:{data_key:'last_action_result.nextCursor'},columns:[{key:'startedAt',label:'Time'},{key:'feature',label:'Feature'},{key:'provider',label:'Provider'},{key:'model',label:'Model'},{key:'state',label:'State'}]}},
  {id:'usage-aggregates',title:'Totals',body:table('usage-history-totals','Monthly totals','aggregates',[{key:'month',label:'Month'},{key:'calls',label:'Calls'},{key:'inputTokens',label:'Input tokens'},{key:'outputTokens',label:'Output tokens'}])},
  {id:'usage-status',title:'Source',body:detail('usage-history-source','History source',[{key:'legacyPath',label:'Preserved source'},{key:'legacyRevision',label:'Revision'},{key:'hasHostHistory',label:'Host history available'},{key:'hostHistoryComplete',label:'Host history complete'},{key:'historyWarning',label:'Warning'},{key:'nextCursor',label:'Next cursor'}])},
 ]),
 panel('paired.contradiction-review','Contradiction review',[
  {id:'contradiction-text',title:'Text',body:form('contradiction-text-form','Review candidate text','candidate_text','Candidate text','paired.contradictions.verdict',{candidateText:{data_key:'form.candidate_text'}},8000)},
  {id:'contradiction-id',title:'Candidate',body:form('contradiction-id-form','Review Semantic candidate','candidate_id','Candidate ID','paired.contradictions.verdict',{candidateId:{data_key:'form.candidate_id'}})},
  {id:'contradiction-result',title:'Verdict',body:detail('contradiction-verdict','Tentative verdict',[{key:'verdict',label:'Verdict'},{key:'reason',label:'Reason'},{key:'diagnostic',label:'Diagnostic'},{key:'provenance.source',label:'Evidence source'}])},
  {id:'contradiction-citations',title:'Evidence',body:table('contradiction-evidence','Verified citations','citations',[{key:'path',label:'Path'},{key:'revision',label:'Revision'},{key:'quote',label:'Exact quote'}])},
 ]),
 panel('paired.aspect-review','Chapter aspects',[
  {id:'aspect-review',title:'Review',body:form('aspect-review-form','Review chapter','chapter_id','Chapter ID','paired.aspect.review',{chapterId:{data_key:'form.chapter_id'}},128)},
  {id:'aspect-preview',title:'Preview',body:form('aspect-preview-form','Preview chapter review','chapter_id','Chapter ID','paired.aspect.preview',{chapterId:{data_key:'form.chapter_id'}},128)},
  {id:'aspect-findings',title:'Findings',body:table('aspect-findings-table','Chapter findings','findings',[{key:'aspectLabel',label:'Aspect'},{key:'finding',label:'Finding'},{key:'quote',label:'Quote'}])},
  {id:'aspect-prompt',title:'Prompt',body:detail('aspect-preview-detail','Local preview',[{key:'chapterId',label:'Chapter'},{key:'prompt',label:'Prompt'},{key:'providerInvoked',label:'Provider invoked'}])},
 ]),
 panel('paired.speaker-review','Speaker attribution',[
  {id:'speaker-request',title:'Request',body:form('speaker-request-form','Attribute saved scene','scene_id','Scene ID','paired.speaker.attribute',{scene_id:{data_key:'form.scene_id'}})},
  {id:'speaker-results',title:'Results',body:table('speaker-results-table','Attributions','attributions',[{key:'sentence_index',label:'Sentence'},{key:'text',label:'Text'},{key:'speaker_entity_id',label:'Speaker'},{key:'confidence',label:'Confidence'}])},
 ]),
];
