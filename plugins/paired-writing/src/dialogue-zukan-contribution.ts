import type { ActionDescriptor, SurfaceDeclaration } from '../../../app/src/browser/proprium/authoring/types.js';
import type { Handler } from '../../shared/guest.js';
import { previewDialogueTopics, previewDialogueTurns, suggestDialogueTopics, suggestDialogueTurns, type DialogueGenerate } from './dialogue.js';
import { previewZukan, suggestZukan } from './zukan.js';
import { suggestSynonyms } from './synonym-generation.js';
import { proposeZukanSuggestion } from './zukan-proposals.js';
import { PairedError } from './types.js';

const str=(maxLength:number,minLength=1)=>({type:'string',minLength,maxLength});
const integer=(minimum:number,maximum:number)=>({type:'integer',minimum,maximum});
const array=(items:unknown,minItems:number,maxItems:number)=>({type:'array',items,minItems,maxItems});
const obj=(properties:Record<string,unknown>,required:string[]=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const id=str(256), short=str(8000), revision=str(64), path=str(4096), prompt=str(768000,0);
const span=obj({path,revision,start:integer(0,16777216),end:integer(1,16777216),quote:str(8000)});
const proposalSpan=obj({path,revision,start:integer(0,16777216),end:integer(1,16777216),quote:str(1024)});
const source=obj({path,revision,quote:str(8000,0)});
const sourceRevision=obj({path,revision});
const snapshot=obj({id,local_commit:{type:['string','null'],maxLength:256},worktree_generation:id,draft_generation:{type:['string','null'],maxLength:256},remote_commit:{type:['string','null'],maxLength:256}},['id','local_commit','worktree_generation','draft_generation']);
const provenance=obj({provider:id,model:id,promptVersion:id,requestId:id,untrusted:{const:true}});
const topic=obj({title:str(512),situation:str(2000)});
const line=obj({speakerEntityId:id,text:str(8000)});
const formLine=obj({speaker_id:id,text:str(8000)});
const inputLine={oneOf:[line,formLine]};
const participants=array(id,1,8);
const topicInput=obj({participantEntityIds:array(id,2,8)});
const turnInput={...obj({participantEntityIds:participants,precedingLines:array(inputLine,0,80),speakerEntityId:id,lineCount:integer(1,30),sketchId:id,topic:str(2000),situation:str(2000)},['participantEntityIds']),oneOf:[{required:['speakerEntityId'],not:{required:['lineCount']}},{required:['lineCount'],not:{required:['speakerEntityId']}}]};
const dialogueBase={prompt,promptVersion:id,participantEntityIds:participants,citations:array(source,0,100),knowledge:{enum:['available','unavailable']},provider_invoked:{type:'boolean'},snapshot};
const topicsOutput=obj({...dialogueBase,topics:array(topic,3,5),model:id,provider:id,provenance},['prompt','promptVersion','participantEntityIds','citations','knowledge','provider_invoked','snapshot']);
const turnsOutput=obj({...dialogueBase,lineCount:integer(1,30),speakerEntityId:id,sketchId:id,lines:array(line,1,30),model:id,provider:id,provenance},['prompt','promptVersion','participantEntityIds','citations','knowledge','provider_invoked','snapshot','lineCount']);
const turnRange=obj({start:integer(0,1000000),end:integer(0,1000000)});
const zukanInput={...obj({source:{enum:['manuscript','sandbox']},entityId:id,blockPath:str(128),prompt:str(4000),sourceSessionId:id,turnRange},['source']),oneOf:[{required:['entityId'],not:{required:['sourceSessionId']}},{required:['sourceSessionId'],not:{required:['entityId']}}]};
const suggestion=obj({targetEntityId:id,targetEntityRevision:revision,kind:{enum:['fact','dynamic','habit']},blockPath:str(128),proposedText:str(4000),evidence:array(span,1,64),confidence:{enum:['low','high']}});
const zukanBase={source:{enum:['manuscript','sandbox']},entityId:id,targetRevision:revision,blockPath:str(128),sourceSessionId:id,turnRange,participants,prompt,promptVersion:id,evidence:array(span,0,80),sourceRevisions:array(sourceRevision,0,160),coverage:{enum:['partial','complete']},provider_invoked:{type:'boolean'},snapshot};
const zukanOutput=obj({...zukanBase,suggestion,suggestions:array(obj({suggestion}),0,32),diagnostics:array(str(512),0,32),model:id,provider:id,provenance},['source','prompt','promptVersion','evidence','sourceRevisions','coverage','provider_invoked','snapshot']);
const synonymEntry=obj({original:str(256),sentence:short,reason:str(512)},['original','sentence']);
const synonymInput=obj({suggestions:array(synonymEntry,1,8)});
const synonymResult=obj({term:str(256),sentence:short,reason:str(512),candidates:array(str(256),3,5),prompt,model:id,provider:id,promptVersion:id,citations:array(source,0,0),provenance},['term','sentence','candidates','prompt','model','provider','promptVersion','citations','provenance']);
const synonymOutput=obj({suggestions:array(synonymResult,1,8)});
const proposalInput=obj({source:{enum:['manuscript','sandbox']},sourceId:id,sourceRevision:revision,sourceRange:turnRange,targetEntityId:id,targetEntityRevision:revision,blockPath:str(128),proposedText:str(4000),kind:{enum:['fact','dynamic','habit']},confidence:{enum:['low','high']},evidence:array(proposalSpan,1,64)},['source','sourceId','sourceRevision','targetEntityId','targetEntityRevision','blockPath','proposedText','kind','confidence','evidence']);
const proposalOutput=obj({suggestionId:id,proposalId:id,proposalStatus:str(128)});
const readCaps=['workspace.file.read','workspace.plugin.invoke'];
const generateCaps=[...readCaps,'plugin.preferences','workspace.capabilities.query','provider.request'];
const descriptor=(action_id:string,input_schema:Record<string,unknown>,output_schema:Record<string,unknown>,required_capabilities:string[],effect:'read'|'propose'='read'):ActionDescriptor=>({plugin_id:'proprium.paired-writing',action_id,schema_version:1,effect,input_schema,output_schema,required_capabilities,callers:['ui','mcp','plugin'],requires_user_gesture:false});
export const descriptors:ActionDescriptor[]=[
 descriptor('paired.dialogue.topics.preview',topicInput,{...topicsOutput,properties:{...topicsOutput.properties,provider_invoked:{const:false}}},readCaps),descriptor('paired.dialogue.topics.suggest',topicInput,{...topicsOutput,properties:{...topicsOutput.properties,provider_invoked:{const:true}},required:[...topicsOutput.required,'topics','model','provider','provenance']},generateCaps),
 descriptor('paired.dialogue.turn.preview',{...turnInput,required:['participantEntityIds','speakerEntityId']},{...turnsOutput,properties:{...turnsOutput.properties,provider_invoked:{const:false}}},readCaps),descriptor('paired.dialogue.turns.preview',{...turnInput,required:['participantEntityIds','lineCount']},{...turnsOutput,properties:{...turnsOutput.properties,provider_invoked:{const:false}}},readCaps),descriptor('paired.dialogue.turns.suggest',turnInput,{...turnsOutput,properties:{...turnsOutput.properties,provider_invoked:{const:true}},required:[...turnsOutput.required,'lines','model','provider','provenance']},generateCaps),
 descriptor('paired.zukan.sandbox.preview',obj({sketchId:id,turnRange},['sketchId']),{...zukanOutput,properties:{...zukanOutput.properties,provider_invoked:{const:false}}},readCaps),
 descriptor('paired.zukan.preview',zukanInput,{...zukanOutput,properties:{...zukanOutput.properties,provider_invoked:{const:false}}},readCaps),descriptor('paired.zukan.suggest',zukanInput,{...zukanOutput,properties:{...zukanOutput.properties,provider_invoked:{const:true}},required:[...zukanOutput.required,'diagnostics','model','provider','provenance'],oneOf:[{required:['suggestion'],not:{required:['suggestions']}},{required:['suggestions'],not:{required:['suggestion']}}]},generateCaps),
 descriptor('paired.synonyms.suggest',synonymInput,synonymOutput,generateCaps),descriptor('paired.zukan.propose',proposalInput,proposalOutput,[...readCaps,'workspace.change.propose'],'propose'),
];
function normalizeTurn(input: Record<string,unknown>):Record<string,unknown> { return Array.isArray(input.precedingLines) ? {...input,precedingLines:input.precedingLines.map(value=>{ if (!value || typeof value !== 'object' || Array.isArray(value)) return value; const row=value as Record<string,unknown>; return 'speaker_id' in row ? {speakerEntityId:row.speaker_id,text:row.text} : row; })} : input; }
export function handlers(generate:DialogueGenerate):Record<string,Handler> { return {
 'paired.dialogue.topics.preview':(input,request,host)=>previewDialogueTopics(input,host,request),
 'paired.dialogue.topics.suggest':(input,request,host)=>suggestDialogueTopics(input,host,request,generate),
 'paired.dialogue.turn.preview':(input,request,host)=>previewDialogueTurns(normalizeTurn(input),host,request),
 'paired.dialogue.turns.preview':(input,request,host)=>previewDialogueTurns(normalizeTurn(input),host,request),
 'paired.dialogue.turns.suggest':(input,request,host)=>suggestDialogueTurns(normalizeTurn(input),host,request,generate),
 'paired.zukan.sandbox.preview':function*(input,request,host) { const result=yield* previewZukan({source:'sandbox',sourceSessionId:input.sketchId,...(input.turnRange === undefined ? {} : {turnRange:input.turnRange})},host,request); const {participantRevisions: _internal,...output}=result; return output; },
 'paired.zukan.preview':function*(input,request,host) { const result=yield* previewZukan(input,host,request); const {participantRevisions: _internal,...output}=result; return output; },
 'paired.zukan.suggest':function*(input,request,host) { const result=yield* suggestZukan(input,host,request,generate); const {participantRevisions: _internal,...output}=result; return output; },
 'paired.synonyms.suggest':(input,request,host)=>suggestSynonyms(input,host,request,generate),
 'paired.zukan.propose':function*(input,request,host) { const result=(yield* proposeZukanSuggestion(input,host,request)) as Record<string,unknown>;if(typeof result.suggestionId!=='string'||typeof result.proposalId!=='string'||typeof result.proposalStatus!=='string')throw new PairedError('unsupported_format','Knowledge proposal receipt is malformed');return {suggestionId:result.suggestionId,proposalId:result.proposalId,proposalStatus:result.proposalStatus}; },
}; }

const ref=(data_key:string)=>({data_key});
const field=(id:string,label:string,type:'string'|'integer'|'ordered-list',required=false,max_length?:number)=>({id,label,type,required,...(max_length?{max_length}:{})});
const form=(id:string,title:string,fields:unknown[],action_id:string,input_template:Record<string,unknown>)=>({id,type:'form',title,fields,submit:{action_id,input_template}});
const details=(id:string,title:string,fields:Array<[string,string]>)=>({id,type:'detail',title,value:ref('last_action_result'),fields:fields.map(([key,label])=>({key,label}))});
const list=(id:string,title:string,key:string,primary:string,secondary:string)=>({id,type:'list',title,items:ref(key),primary,secondary});
const tab=(id:string,title:string,body:Record<string,unknown>)=>({id,title,body});
const panel=(id:string,title:string,tabs:unknown[]):SurfaceDeclaration=>({id,kind:'panel',title,context:{},body:{id:`${id}.tabs`,type:'tabs',title,tabs}});
const idsField=()=>field('participants','Participant IDs (one per line)','ordered-list',true);
const precedingField=()=>({id:'preceding_lines',label:'Earlier dialogue',type:'record-list',required:false,max_items:80,fields:[field('speaker_id','Speaker ID','string',true,256),field('text','Line','string',true,8000)]});
// Record-list row keys must be canonical action keys; UI IDs remain Host-valid lowercase.
// The separate typed forms below avoid silently transforming IDs or source evidence.
const topicForm=(id:string,title:string,action:string)=>form(id,title,[idsField()],action,{participantEntityIds:ref('form.participants')});
const turnFields=(single:boolean)=>[idsField(),precedingField(),...(single?[field('speaker_id','Selected speaker ID','string',true,256)]:[field('line_count','Number of lines (1–30)','integer',true)]),field('sketch_id','Saved sketch ID (optional)','string',false,256),field('topic','Topic (optional)','string',false,2000),field('situation','Situation (optional)','string',false,2000)];
const turnForm=(id:string,title:string,action:string,single:boolean)=>form(id,title,turnFields(single),action,{participantEntityIds:ref('form.participants'),precedingLines:ref('form.preceding_lines'),...(single?{speakerEntityId:ref('form.speaker_id')}:{lineCount:ref('form.line_count')}),sketchId:ref('form.sketch_id'),topic:ref('form.topic'),situation:ref('form.situation')});
const manuscriptFields=()=>[field('entity_id','Target entity ID','string',true,256),field('block_path','Notes block path (optional)','string',false,128),field('instruction','Additional instruction (optional)','string',false,4000)];
const manuscriptForm=(id:string,title:string,action:string)=>form(id,title,manuscriptFields(),action,{source:'manuscript',entityId:ref('form.entity_id'),blockPath:ref('form.block_path'),prompt:ref('form.instruction')});
const sandboxFields=()=>[field('sketch_id','Saved sketch ID','string',true,256),field('start','First turn (zero based)','integer',true),field('end','Last turn (inclusive)','integer',true)];
const sandboxForm=(id:string,title:string,action:string)=>form(id,title,sandboxFields(),action,{source:'sandbox',sourceSessionId:ref('form.sketch_id'),turnRange:{start:ref('form.start'),end:ref('form.end')}});
export const surfaces:SurfaceDeclaration[]=[
 panel('paired.dialogue-topics','Dialogue topics',[
  tab('topics-preview','Preview',topicForm('topics-preview-form','Preview topics','paired.dialogue.topics.preview')),
  tab('topics-generate','Suggest',topicForm('topics-suggest-form','Generate topic candidates','paired.dialogue.topics.suggest')),
  tab('topics-prompt','Prompt',details('topics-prompt-detail','Exact topic prompt',[['prompt','Prompt'],['knowledge','Knowledge'],['provider_invoked','Provider invoked']])),
  tab('topics-results','Candidates',list('topics-results-list','Topic candidates','last_action_result.topics','title','situation')),
 ]),
 panel('paired.dialogue-turns','Dialogue turns',[
  tab('turn-single-preview','Preview one',turnForm('turn-single-preview-form','Preview one turn','paired.dialogue.turn.preview',true)),
  tab('turn-multi-preview','Preview several',turnForm('turn-multi-preview-form','Preview turns','paired.dialogue.turns.preview',false)),
  tab('turn-single-generate','Suggest one',turnForm('turn-single-generate-form','Generate one turn','paired.dialogue.turns.suggest',true)),
  tab('turn-multi-generate','Suggest several',turnForm('turn-multi-generate-form','Generate turns','paired.dialogue.turns.suggest',false)),
  tab('turn-prompt','Prompt',details('turn-prompt-detail','Exact dialogue prompt',[['prompt','Prompt'],['knowledge','Knowledge'],['provider_invoked','Provider invoked']])),
  tab('turn-results','Lines',list('turn-results-list','Suggested lines','last_action_result.lines','text','speakerEntityId')),
 ]),
 panel('paired.zukan-manuscript','Manuscript note suggestions',[
  tab('manuscript-preview','Preview',manuscriptForm('manuscript-preview-form','Preview manuscript evidence','paired.zukan.preview')),
  tab('manuscript-generate','Suggest',manuscriptForm('manuscript-generate-form','Generate note suggestion','paired.zukan.suggest')),
  tab('manuscript-prompt','Prompt',details('manuscript-prompt-detail','Exact prompt and scope',[['prompt','Prompt'],['coverage','Evidence coverage'],['provider_invoked','Provider invoked']])),
  tab('manuscript-result','Candidate',details('manuscript-result-detail','Tentative evidence-backed suggestion',[['suggestion.targetEntityId','Entity'],['suggestion.blockPath','Notes block'],['suggestion.proposedText','Suggested text'],['suggestion.evidence.0.quote','Evidence quote'],['suggestion.evidence.0.path','Evidence path'],['coverage','Coverage']])),
  tab('manuscript-propose','Propose',form('manuscript-propose-form','Send selected candidate to review',[field('source_id','Source scene ID','string',true,256)],'paired.zukan.propose',{source:'manuscript',sourceId:ref('form.source_id'),sourceRevision:ref('last_action_result.suggestion.evidence.0.revision'),targetEntityId:ref('last_action_result.suggestion.targetEntityId'),targetEntityRevision:ref('last_action_result.suggestion.targetEntityRevision'),blockPath:ref('last_action_result.suggestion.blockPath'),proposedText:ref('last_action_result.suggestion.proposedText'),kind:ref('last_action_result.suggestion.kind'),confidence:ref('last_action_result.suggestion.confidence'),evidence:[ref('last_action_result.suggestion.evidence.0')]})),
  tab('manuscript-receipt','Receipt',details('manuscript-receipt-detail','Pending review',[['suggestionId','Suggestion ID'],['proposalId','Proposal ID'],['proposalStatus','Status']])),
 ]),
 panel('paired.zukan-sandbox','Dialogue note suggestions',[
  tab('sandbox-preview','Preview',sandboxForm('sandbox-preview-form','Preview selected sketch turns','paired.zukan.preview')),
  tab('sandbox-generate','Suggest',sandboxForm('sandbox-generate-form','Generate note suggestions','paired.zukan.suggest')),
  tab('sandbox-prompt','Prompt',details('sandbox-prompt-detail','Exact sketch prompt',[['prompt','Prompt'],['coverage','Evidence coverage'],['provider_invoked','Provider invoked']])),
  tab('sandbox-results','Candidates',{id:'sandbox-results-list',type:'list',title:'Select a candidate to propose for review',items:ref('last_action_result.suggestions'),primary:'suggestion.proposedText',secondary:'suggestion.evidence.0.quote',item_action:{action_id:'paired.zukan.propose',input_template:{source:'sandbox',sourceId:ref('last_action_result.sourceSessionId'),sourceRevision:ref('item.suggestion.evidence.0.revision'),sourceRange:ref('last_action_result.turnRange'),targetEntityId:ref('item.suggestion.targetEntityId'),targetEntityRevision:ref('item.suggestion.targetEntityRevision'),blockPath:ref('item.suggestion.blockPath'),proposedText:ref('item.suggestion.proposedText'),kind:ref('item.suggestion.kind'),confidence:ref('item.suggestion.confidence'),evidence:ref('item.suggestion.evidence')}}}),
  tab('sandbox-first','First candidate',details('sandbox-first-detail','First suggestion and source',[['suggestions.0.suggestion.targetEntityId','Entity'],['suggestions.0.suggestion.blockPath','Notes block'],['suggestions.0.suggestion.proposedText','Suggested text'],['suggestions.0.suggestion.evidence.0.quote','Evidence quote'],['suggestions.0.suggestion.evidence.0.path','Evidence path']])),
  tab('sandbox-receipt','Receipt',details('sandbox-receipt-detail','Pending review',[['suggestionId','Suggestion ID'],['proposalId','Proposal ID'],['proposalStatus','Status']])),
 ]),
 panel('paired.synonyms-generation','Synonym suggestions',[
  tab('synonym-form','Suggest',form('synonym-form-body','Generate alternatives',[{id:'suggestions',type:'record-list',label:'Word and sentence',required:true,min_items:1,max_items:1,fields:[field('original','Original term','string',true,256),field('sentence','Sentence containing term','string',true,8000),field('reason','Reason (optional)','string',false,512)]}],'paired.synonyms.suggest',{suggestions:ref('form.suggestions')})),
  tab('synonym-results','Results',list('synonym-results-list','Suggested terms','last_action_result.suggestions','term','sentence')),
  tab('synonym-first','Alternatives',details('synonym-first-detail','First result alternatives',[['suggestions.0.term','Original'],['suggestions.0.candidates.0','Alternative 1'],['suggestions.0.candidates.1','Alternative 2'],['suggestions.0.candidates.2','Alternative 3'],['suggestions.0.candidates.3','Alternative 4'],['suggestions.0.candidates.4','Alternative 5'],['suggestions.0.provider','Provider'],['suggestions.0.model','Model']])),
 ]),
];
