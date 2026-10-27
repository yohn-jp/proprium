import {test} from "node:test";
import assert from "node:assert/strict";
import {renderReaderReactionPrompt} from "../src/reader-reaction.js";
test("reader reaction prompt preserves supplied chapter order and exact summary text",()=>{
 const prompt=renderReaderReactionPrompt("c2",[{chapterId:"c1",summaryLines:["一章"]},{chapterId:"c2",summaryLines:["二章"]}]);
 assert.match(prompt,/いま読んだ章: c2/u);assert.match(prompt,/chapter_id: c1\n- 一章\n\nchapter_id: c2\n- 二章/u);
});
import {sha256} from "../src/sha256.js";
import {prepareReaderReaction} from "../src/reader-reaction.js";
import type { GuestHost } from "../../shared/guest.js";
const scope={workspace_id:"w",repository_id:1,branch:"main",generation:"g"};
const snapshot={id:"s",local_commit:null,worktree_generation:"v",draft_generation:null};
const request={schema_version:1,request_id:"r",plugin_id:"proprium.paired-writing",action_id:"paired.reader.reaction.preview",scope,snapshot,input:{},deadline_ms:30000} as any;
const host:GuestHost={request(operation,payload){return(function*(){return yield {operation,payload};})() as never;}};
test("reaction preview verifies accepted source revision metadata without reading manuscripts",()=>{
 const rev="a".repeat(64), summary="b".repeat(64), hash=sha256(new TextEncoder().encode(JSON.stringify([["s1",rev]]))), yaml=`id: c1\nsourceHash: ${hash}\nsummaryLines:\n  - 要約\nchildren:\n  - id: s1\n    metadata_path: plot/v/scenes/s1.yaml\n    metadata_revision: ${rev}\n    manuscript_path: manuscript/a.md\n    manuscript_revision: ${rev}\nsource_files:\n  - path: plot/v/scenes/s1.yaml\n    revision: ${rev}\n  - path: manuscript/a.md\n    revision: ${rev}\n`;
 const iter=prepareReaderReaction({chapterId:"c1"},host,request);let step=iter.next();let reads:string[]=[];
 while(!step.done){const call=step.value;let value:any;
  if(call.operation==="workspace.plugin.invoke"){const parent=(call.payload.input as any).parent_id;value={ok:true,scope,snapshot,value:{items:parent === "c1" ? [{id:"s1",kind:"scene",metadata_path:"plot/v/scenes/s1.yaml",metadata_revision:rev,manuscript_path:"manuscript/a.md"}] : parent ? [{id:"c1",kind:"chapter",metadata_path:"plot/v/chapter.yaml"}] : [{id:"v1",kind:"volume",metadata_path:"plot/v/volume.yaml"}],next_cursor:null,tree_revision:"tree"}};}
  else if(call.operation==="workspace.file.list")value={entries:[{path:"plot/v/chapter-summary.yaml",revision:summary},{path:"manuscript/a.md",revision:rev},{path:"plot/v/scenes/s1.yaml",revision:rev}],next_cursor:null};
  else if(call.operation==="workspace.file.read"){const path=String(call.payload.path);reads.push(path);const bytes=[...new TextEncoder().encode(yaml)];value={revision:summary,offset:0,total_bytes:bytes.length,bytes,next_offset:null};}
  else throw new Error(`Unexpected ${call.operation}`);step=iter.next(value);
 }
 assert.deepEqual(reads,["plot/v/chapter-summary.yaml"]);assert.match((step.value as any).prompt,/要約/u);
});
test("legacy FNV-only summary is reported unverified and never used as context",()=>{
 const rev="a".repeat(64),body="id: c1\nsummaryLines:\n  - 不明な要約\nsourceHash: deadbeef\n";
 const iter=prepareReaderReaction({chapterId:"c1"},host,request);let step=iter.next();
 while(!step.done){const c=step.value;let v:any;
  if(c.operation==="workspace.plugin.invoke"){const parent=(c.payload.input as any).parent_id;v={ok:true,scope,snapshot,value:{items:parent?[{id:"c1",kind:"chapter",metadata_path:"plot/v/chapter.yaml"}]:[{id:"v1",kind:"volume",metadata_path:"plot/v/volume.yaml"}],next_cursor:null,tree_revision:"tree"}};}
  else if(c.operation==="workspace.file.list")v={entries:[{path:"plot/v/chapter-summary.yaml",revision:rev}],next_cursor:null};
  else if(c.operation==="workspace.file.read"){const bytes=[...new TextEncoder().encode(body)];v={revision:rev,offset:0,total_bytes:bytes.length,bytes,next_offset:null};}
  else throw new Error("unexpected operation");step=iter.next(v);
 }
 assert.doesNotMatch((step.value as any).prompt,/不明な要約/u);assert.deepEqual((step.value as any).diagnostics,[{chapterId:"c1",code:"summary_unverified"}]);
});
