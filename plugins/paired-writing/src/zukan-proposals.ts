import type { ActionRequest } from '../../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../../shared/guest.js';
import { invokeAction, readNarrativeScene, readText } from './host.js';
import { PairedError } from './types.js';
import { exactKeys, finiteInteger, identity, record } from './validation.js';

type SourceSpan = {path:string;revision:string;start:number;end:number;quote:string};
function revision(value:unknown,label:string):string { const result=identity(value,label,64);if(!/^[a-f0-9]{64}$/u.test(result))throw new PairedError('invalid_input',`${label} must be a SHA-256 revision`);return result; }
function proposalText(value:unknown,label:string,max:number):string {const result=identity(value,label,max);if(!result.trim())throw new PairedError('invalid_input',`${label} must not be blank`);return result;}
/** Explicitly submit one author-selected, revalidated suggestion through Knowledge's proposal action. */
export function* proposeZukanSuggestion(input:unknown,host:GuestHost,request:ActionRequest):Generator<HostCall,unknown,unknown> {
  const row=record(input,'input');exactKeys(row,['source','sourceId','sourceRevision','sourceRange','targetEntityId','targetEntityRevision','blockPath','proposedText','kind','confidence','evidence'],'input');
  if(!request.idempotency_key)throw new PairedError('invalid_input','Zukan proposal requires an idempotency key');
  if(row.source!=='manuscript'&&row.source!=='sandbox')throw new PairedError('invalid_input','source must be manuscript or sandbox');
  const sourceId=identity(row.sourceId,'sourceId'), sourceRevision=revision(row.sourceRevision,'sourceRevision'), targetEntityId=identity(row.targetEntityId,'targetEntityId'), expectedEntityRevision=revision(row.targetEntityRevision,'targetEntityRevision');
  const blockPath=identity(row.blockPath,'blockPath',128);if(!/^(?:lead\.(?:0|[1-9]\d*)|sections\.(?:0|[1-9]\d*)\.body\.(?:0|[1-9]\d*))$/u.test(blockPath))throw new PairedError('invalid_input','blockPath is not an accepted note block');
  const proposedText=proposalText(row.proposedText,'proposedText',4000);
  if(!['fact','dynamic','habit'].includes(String(row.kind))||!['high','low'].includes(String(row.confidence)))throw new PairedError('invalid_input','Suggestion kind or confidence is invalid');
  if(row.source==='manuscript'&&(row.kind!=='fact'||row.confidence!=='low'||row.sourceRange!==undefined))throw new PairedError('invalid_input','Manuscript suggestions must be low-confidence facts without a turn range');
  if(!Array.isArray(row.evidence)||row.evidence.length<1||row.evidence.length>64)throw new PairedError('invalid_input','One to 64 evidence spans are required');
  const spans:SourceSpan[]=row.evidence.map(raw=>{const e=record(raw,'evidence');exactKeys(e,['path','revision','start','end','quote'],'evidence');const path=identity(e.path,'evidence path',4096),rev=revision(e.revision,'evidence revision'),start=finiteInteger(e.start,'start',0),end=finiteInteger(e.end,'end',start+1),quote=proposalText(e.quote,'quote',1024);if(end-start!==quote.length)throw new PairedError('invalid_input','Evidence range does not match quote length');return {path,revision:rev,start,end,quote};});
  if(!spans.some(span=>span.quote.includes(proposedText)))throw new PairedError('invalid_input','Suggestion text must be grounded in an exact evidence quote');
  const entity=yield* invokeAction<{entity:unknown}>(host,request,'proprium.knowledge','knowledge.entities.get',{id:targetEntityId});const target=record(entity?.entity,'target entity');
  if(target.id!==targetEntityId||target.fileRevision!==expectedEntityRevision)throw new PairedError('snapshot_stale','Target entity revision changed');
  const targetFile=yield* readText(host,request,identity(target.filePath,'target path',4096));if(targetFile.revision!==expectedEntityRevision)throw new PairedError('snapshot_stale','Target source revision changed');
  let sourcePath:string, sourceRange:{start:number;end:number}|undefined;
  if(row.source==='manuscript') {
    const scene=yield* readNarrativeScene(host,request,sourceId);sourcePath=scene.manuscript_path;
    if(scene.manuscript_revision!==sourceRevision)throw new PairedError('snapshot_stale','Manuscript revision changed');
  } else {
    const inputRange=record(row.sourceRange,'sourceRange');exactKeys(inputRange,['start','end'],'sourceRange');const start=finiteInteger(inputRange.start,'start',0),end=finiteInteger(inputRange.end,'end',start);if(end-start+1>80)throw new PairedError('capacity','Sandbox range exceeds 80 turns');sourceRange={start,end};
    const result=yield* invokeAction<{entity:unknown}>(host,request,'proprium.knowledge','knowledge.entities.get',{id:sourceId});const sketch=record(result?.entity,'sketch');
    if(sketch.id!==sourceId||sketch.type!=='dialogue_sketch'||sketch.fileRevision!==sourceRevision)throw new PairedError('snapshot_stale','Dialogue sketch changed');
    sourcePath=identity(sketch.filePath,'sketch path',4096);const raw=record(sketch.raw,'sketch source');
    if(!Array.isArray(raw.lines)||end>=raw.lines.length||!Array.isArray(raw.participantEntityIds)||!raw.participantEntityIds.includes(targetEntityId))throw new PairedError('snapshot_stale','Sketch participants or selected range changed');
    const transcript=raw.lines.slice(start,end+1).map(line=>{const item=record(line,'sketch line');return typeof item.text==='string'?item.text:'';}).join('\n');
    if(spans.some(span=>!transcript.includes(span.quote)))throw new PairedError('snapshot_stale','Evidence is outside the selected sketch turns');
  }
  if(spans.some(span=>span.path!==sourcePath||span.revision!==sourceRevision))throw new PairedError('snapshot_stale','Evidence is not bound to the selected source');
  const file=yield* readText(host,request,sourcePath);if(file.revision!==sourceRevision||spans.some(span=>file.text.slice(span.start,span.end)!==span.quote))throw new PairedError('snapshot_stale','Evidence quote or source revision changed');
  return yield* invokeAction(host,request,'proprium.knowledge','knowledge.suggestions.create',{entityId:targetEntityId,expectedEntityRevision,blockPath,proposedText,source:row.source==='sandbox'?'dialogue-sketch':'manuscript',sourceId,sourceRevision,...(sourceRange?{sourceRange}:{}),kind:row.kind,confidence:row.confidence,evidence:spans.map(span=>({quote:span.quote,...(row.source==='manuscript'?{sceneId:sourceId}:{})}))});
}
