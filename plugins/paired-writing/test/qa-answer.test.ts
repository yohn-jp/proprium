import { test } from "node:test";
import assert from "node:assert/strict";
import { answerQa, QA_ANSWER_OUTPUT_SCHEMA } from "../src/qa-answer.js";
import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
const scope={workspace_id:"w",repository_id:1,branch:"main",generation:"g"};
const snapshot={id:"s",local_commit:null,worktree_generation:"v",draft_generation:null};
const request={schema_version:1,request_id:"r",plugin_id:"proprium.paired-writing",action_id:"paired.qa.answer",scope,snapshot,input:{},deadline_ms:30000} as ActionRequest;
const host:GuestHost={request(operation,payload){return (function*(){return yield {operation,payload};})() as never;}};
const revision="a".repeat(64);
function run(input:unknown, hits:unknown[], actual="駅は北にある。",rev=revision) {
  const iter=answerQa(input,host,request); let step=iter.next(); const calls:string[]=[];
  while(!step.done){const call=step.value;calls.push(call.operation);let value:unknown;
    if(call.operation==="workspace.plugin.invoke") {assert.equal(call.payload.action_id,"research.query"); value={ok:true,scope,snapshot,value:{hits,indexSnapshot:"s",nextCursor:null,query:"駅",mode:"lexical",coverage:{documents:1,bytes:24}}};}
    else if(call.operation==="workspace.file.read") {const bytes=[...new TextEncoder().encode(actual)];value={revision:rev,offset:0,total_bytes:bytes.length,bytes,next_offset:null};}
    else throw new Error(`Unexpected ${call.operation}`);
    step=iter.next(value);
  }
  return {value:step.value as any,calls};
}
test("QA answers with exact snapshot-revalidated excerpts and no provider",()=>{
 const hit={kind:"document",path:"notes.md",title:"Notes",fileRevision:revision,snippet:"駅",matchRanges:[{start:0,end:1}],navigationSpan:{path:"notes.md",revision,start:0,end:1}};
 const result=run({question:"駅"},[hit]);assert.equal(result.value.confidence,"low");assert.equal(result.value.citations[0].quote,"駅");assert.equal(result.value.citations[0].revision,revision);assert.match(result.value.answer,/駅/u);assert.ok(!result.calls.includes("provider.request"));
});
test("QA expresses uncertainty when no source matches",()=>{const result=run({question:"駅"},[]);assert.deepEqual(result.value.citations,[]);assert.equal(result.value.confidence,"low");assert.match(result.value.answer,/見つかりません/u);});
test("QA rejects stale source revisions",()=>{const hit={kind:"document",path:"notes.md",title:"Notes",fileRevision:revision,snippet:"駅",matchRanges:[{start:0,end:1}]};assert.throws(()=>run({question:"駅"},[hit],"駅は北にある。","b".repeat(64)),{code:"snapshot_stale"});});
test("QA rejects a match range outside the pinned source",()=>{const hit={kind:"document",path:"notes.md",title:"Notes",fileRevision:revision,matchRanges:[{start:0,end:500}]};assert.throws(()=>run({question:"駅"},[hit]),{code:"snapshot_stale"});});
test("long questions are searched in full bounded segments",()=>{
 const question="駅".repeat(8000), segments:string[]=[]; const iter=answerQa({question},host,request);let step=iter.next();
 while(!step.done){const c=step.value;if(c.operation!=="workspace.plugin.invoke")throw new Error("unexpected operation");segments.push(String((c.payload.input as any).query));step=iter.next({ok:true,scope,snapshot,value:{hits:[],indexSnapshot:"s",nextCursor:null}});}
 assert.equal(segments.join(""),question);assert.ok(segments.every(s=>s.length<=512));
});
test("Research unavailable falls back to bounded local saved files",()=>{
 const iter=answerQa({question:"駅"},host,request);let step=iter.next();let result:unknown;
 while(!step.done){const c=step.value;if(c.operation==="workspace.plugin.invoke")result={ok:false,error:{code:"dependency_unavailable",message:"unavailable"},scope,snapshot};
 else if(c.operation==="workspace.file.list")result={entries:[{path:"manuscript/a.md",revision,byte_length:6}],next_cursor:null};
 else if(c.operation==="workspace.file.read") {const bytes=[...new TextEncoder().encode("駅前")];result={revision,offset:0,total_bytes:bytes.length,bytes,next_offset:null};}
 else throw new Error(`unexpected ${c.operation}`);step=iter.next(result);}
 assert.equal((step.value as any).citations[0].quote,"駅");assert.equal((step.value as any).provenance.source,"local.lexical");
});

test("QA output satisfies its closed Host action schema",async()=>{
 const {assertValue}=await import("../../../app/src/browser/proprium/authoring/schema.js");
 assertValue(QA_ANSWER_OUTPUT_SCHEMA,run({question:"駅"},[]).value);
 assert.throws(()=>assertValue(QA_ANSWER_OUTPUT_SCHEMA,{...run({question:"駅"},[]).value,extra:true}));
});
