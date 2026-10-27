import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertSafeSchema,assertValue} from '../../../app/src/browser/proprium/authoring/schema.js';
import {USAGE_HISTORY_INPUT_SCHEMA,USAGE_HISTORY_OUTPUT_SCHEMA,projectUsageResult,ASPECT_REVIEW_INPUT_SCHEMA,ASPECT_REVIEW_OUTPUT_SCHEMA,ASPECT_PREVIEW_OUTPUT_SCHEMA,SPEAKER_INPUT_SCHEMA,SPEAKER_OUTPUT_SCHEMA,CONTRADICTION_INPUT_SCHEMA,CONTRADICTION_OUTPUT_SCHEMA} from '../src/adapter-schemas.js';
import {readUsagePage,readHostUsage} from '../src/usage-history.js';
test('closed schemas admit real normalized usage DTO and reject undeclared fields',()=>{
 for(const schema of [USAGE_HISTORY_INPUT_SCHEMA,USAGE_HISTORY_OUTPUT_SCHEMA,ASPECT_REVIEW_INPUT_SCHEMA,ASPECT_REVIEW_OUTPUT_SCHEMA,ASPECT_PREVIEW_OUTPUT_SCHEMA,SPEAKER_INPUT_SCHEMA,SPEAKER_OUTPUT_SCHEMA,CONTRADICTION_INPUT_SCHEMA,CONTRADICTION_OUTPUT_SCHEMA]) assertSafeSchema(schema);
 assertValue(USAGE_HISTORY_INPUT_SCHEMA,{limit:20});assert.throws(()=>assertValue(USAGE_HISTORY_INPUT_SCHEMA,{limit:20,secret:'x'}));
 const result=readUsagePage({legacyText:'{"ts":"2026-10-01T00:00:00Z","feature":"rewrite","model":"m"}',legacyRevision:'abc',limit:20});
 const dto=projectUsageResult({...result,legacyPath:'meta/scriptorium/modules/assistant/usage.jsonl',hostHistoryComplete:false});assertValue(USAGE_HISTORY_OUTPUT_SCHEMA,dto);assert.equal(dto.aggregates[0]?.byFeature[0]?.feature,'rewrite');
});
test('usage capability query returns unconfigured status rather than fabricated complete history',()=>{
 const host:any={request(operation:string,payload:unknown){return(function*(){return yield {operation,payload};})();}};
 const iter=readHostUsage(host,{});const call=iter.next();assert.equal(call.value.operation,'workspace.capabilities.query');assert.deepEqual(call.value.payload,{capability_id:'provider.usage.v1'});const result=iter.next({available:false});assert.equal(result.done,true);assert.deepEqual(result.value,{events:[],complete:false,available:false});
});
test('usage capability exposes bounded Host rows and preserves partial status',()=>{
 const host:any={request(operation:string,payload:unknown){return(function*(){return yield {operation,payload};})();}};
 const iter=readHostUsage(host,{month:'2026-10'});iter.next();const result=iter.next({available:true,events:[{id:'h'}],complete:false});assert.deepEqual(result.value,{events:[{id:'h'}],complete:false,available:true});
 const tooMany=readHostUsage(host,{});tooMany.next();assert.throws(()=>tooMany.next({available:true,events:Array(1001).fill({}),complete:true}),/malformed/i);
});
test('public contradiction projection strips internal provenance and unknown citation fields', async()=>{
 const {projectContradictionResult}=await import('../src/adapter-schemas.js');
 const result=projectContradictionResult({verdict:'insufficient',reason:'none',quotes:[],citations:[],provenance:{source:{private:'ignored'},provider:null},diagnostic:'no_verified_evidence'},'local.lexical');
 assertValue(CONTRADICTION_OUTPUT_SCHEMA,result);assert.deepEqual(result.provenance,{source:'local.lexical',provider:null});
});
test('delegated action schemas match signed owner declarations',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const [plugin,id,input,output] of [['diagnostics','proprium.diagnostics.chapter.aspects.review.v1',ASPECT_REVIEW_INPUT_SCHEMA,ASPECT_REVIEW_OUTPUT_SCHEMA],['speaker','speaker.attribute',SPEAKER_INPUT_SCHEMA,SPEAKER_OUTPUT_SCHEMA]] as const){
  const manifest=JSON.parse(await readFile(new URL(`../../${plugin}/plugin.json`,import.meta.url),'utf8'));const action=manifest.actions.find((a:{action_id:string})=>a.action_id===id);assert.deepEqual(input,action.input_schema);assert.deepEqual(output,action.output_schema);
 }
});
