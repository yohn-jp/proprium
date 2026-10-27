import {test} from "node:test";
import assert from "node:assert/strict";
import {assertValue} from "../../../app/src/browser/proprium/authoring/schema.js";
import {previewContinuation,suggestContinuation} from "../src/continuation.js";
import {previewReaderReaction,suggestReaderReaction} from "../src/reader-reaction.js";
import {CONTINUATION_PREVIEW_OUTPUT_SCHEMA,CONTINUATION_SUGGEST_OUTPUT_SCHEMA,READER_REACTION_PREVIEW_OUTPUT_SCHEMA,READER_REACTION_SUGGEST_OUTPUT_SCHEMA} from "../src/continuation-schemas.js";
const scope={workspace_id:"w",repository_id:1,branch:"main",generation:"g"};const snapshot={id:"s",local_commit:null,worktree_generation:"v",draft_generation:null};const request={scope,snapshot} as any;
const host={request(operation:string,payload:any){return(function*(){return yield {operation,payload};})();}} as any;
function* provider(_host:any,_request:any,input:any):Generator<any,any,any>{const result=input.feature==="continuation-options"?{options:[{direction:"一",rationale:"根拠"},{direction:"二",rationale:"根拠"},{direction:"三",rationale:"根拠"}]}:{questions:["疑問"],expectations:[],confusions:[]};return {text:JSON.stringify(result),provenance:{provider:"p",model:"m",promptVersion:input.promptVersion,requestId:"r",untrusted:true}};}
function run(iter:Generator<any,any,any>){let step=iter.next();while(!step.done){const call=step.value;let response:any;
 if(call.operation==="workspace.plugin.invoke"){const input=call.payload.input;if(call.payload.action_id==="research.query")response={ok:true,scope,snapshot,value:{hits:[],indexSnapshot:"s",nextCursor:null}};
 else response={ok:true,scope,snapshot,value:{items:input.parent_id?[{id:"c",kind:"chapter",metadata_path:"plot/v/chapter.yaml"}]:[{id:"v",kind:"volume",metadata_path:"plot/v/volume.yaml"}],next_cursor:null,tree_revision:"tree"}};}
 else if(call.operation==="workspace.file.list")response={entries:[],next_cursor:null};else throw new Error(`unexpected ${call.operation}`);step=iter.next(response);}return step.value;}
test("actual outputs match all four closed schemas",()=>{
 const results=[
 [CONTINUATION_PREVIEW_OUTPUT_SCHEMA,run(previewContinuation({recentSentences:["駅。"]},host,request))],
 [CONTINUATION_SUGGEST_OUTPUT_SCHEMA,run(suggestContinuation({recentSentences:["駅。"]},host,request,provider))],
 [READER_REACTION_PREVIEW_OUTPUT_SCHEMA,run(previewReaderReaction({chapterId:"c"},host,request))],
 [READER_REACTION_SUGGEST_OUTPUT_SCHEMA,run(suggestReaderReaction({chapterId:"c"},host,request,provider))],
 ] as const;
 for(const [schema,value] of results){assertValue(schema,value);assert.throws(()=>assertValue(schema,{...value,unexpected:true}));}
});
