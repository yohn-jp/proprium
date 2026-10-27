import { test } from 'node:test'; import assert from 'node:assert/strict';
import { delegateAspect, delegateSpeaker, gatherContradictionEvidence } from '../src/assistance-adapters.js';
import type { ActionRequest } from '../../../app/src/browser/proprium/authoring/types.js'; import type { GuestHost } from '../../shared/guest.js';
const scope={workspace_id:'w',repository_id:1,branch:'main',generation:'g'}; const snapshot={id:'s',local_commit:null,worktree_generation:'v',draft_generation:null};
const request={schema_version:1,request_id:'r',plugin_id:'proprium.paired-writing',action_id:'x',scope,snapshot,input:{},deadline_ms:30000} as ActionRequest;
const host:GuestHost={request(operation,payload){return (function*(){return yield {operation,payload};})() as never;}};
test('aspect and speaker adapters invoke the registered owner action at the same scope',()=>{
 const aspect=delegateAspect(host,request,{chapterId:'c'},true);let a=aspect.next();assert.equal(a.value.payload.action_id,'proprium.diagnostics.chapter.aspects.preview.v1');assert.deepEqual(a.value.payload.input,{chapterId:'c'});assert.deepEqual(aspect.next({ok:true,scope,snapshot,value:{prompt:'p'}}).value,{prompt:'p'});
 const speaker=delegateSpeaker(host,request,{scene_id:'s'});const b=speaker.next();assert.equal(b.value.payload.action_id,'speaker.attribute');assert.equal(b.value.payload.plugin_id,'proprium.speaker');
});
test('contradiction candidate evidence is re-read and only exact current quotes are returned',()=>{
 const iter=gatherContradictionEvidence(host,request,'id');let step=iter.next();assert.equal(step.value.payload.action_id,'proprium.semantic.contradictions.candidates');
 const rev='a'.repeat(64),e={sceneId:'s',sentenceIndex:0,quote:'北',path:'manuscript/a.md',revision:rev,start:1,end:2};
 step=iter.next({ok:true,scope,snapshot,value:{candidates:[{id:'id',evidenceA:e,evidenceB:e}],nextCursor:null,complete:true}});assert.equal(step.value.operation,'workspace.file.read');
 const bytes=[...new TextEncoder().encode('駅北口')];step=iter.next({revision:rev,offset:0,total_bytes:bytes.length,bytes,next_offset:null});assert.equal(step.value.operation,'workspace.file.read');
 step=iter.next({revision:rev,offset:0,total_bytes:bytes.length,bytes,next_offset:null});assert.equal(step.done,true);assert.equal((step.value as any).citations.length,2);
});
test('stale contradiction quote is rejected rather than presented as evidence',()=>{
 const iter=gatherContradictionEvidence(host,request,'id');iter.next();const rev='a'.repeat(64),e={sceneId:'s',sentenceIndex:0,quote:'南',path:'a.md',revision:rev,start:1,end:2};iter.next({ok:true,scope,snapshot,value:{candidates:[{id:'id',evidenceA:e,evidenceB:e}],nextCursor:null,complete:true}});const bytes=[...new TextEncoder().encode('駅北口')];assert.throws(()=>iter.next({revision:rev,offset:0,total_bytes:bytes.length,bytes,next_offset:null}),/evidence/i);
});
test('free-text contradiction evidence uses bounded Research and verifies its exact source', async()=>{
 const { gatherTextEvidence }=await import('../src/assistance-adapters.js');const iter=gatherTextEvidence(host,request,'駅');let step=iter.next();assert.equal(step.value.payload.action_id,'research.query');const rev='a'.repeat(64);
 step=iter.next({ok:true,scope,snapshot,value:{hits:[{kind:'document',path:'manuscript/a.md',title:'a',fileRevision:rev,matchRanges:[{start:0,end:1}]}],indexSnapshot:'s',nextCursor:null,query:'駅',mode:'lexical',coverage:{documents:1,bytes:9}}});
 const bytes=[...new TextEncoder().encode('駅は北')];step=iter.next({revision:rev,offset:0,total_bytes:bytes.length,bytes,next_offset:null});assert.equal(step.done,true);assert.equal((step.value as any).citations[0].quote,'駅');
});
