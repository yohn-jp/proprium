import assert from "node:assert/strict";
import test from "node:test";
import { HostWritingResumeStore, writingResumeScope } from "./writing-resume.js";

const workspace={provider:"local" as const,name:"Work",branch:"main",localWorkspaceId:"work"};
const scope=writingResumeScope(workspace,"author-a");
const position={scene_id:"scene-a",manuscript_path:"manuscript/custom.md",metadata_revision:"a".repeat(64),manuscript_revision:"b".repeat(64),draft_generation:null,sentence_index:2,scroll_top:123};
function storage(){const rows=new Map<string,string>();return {rows,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);}};}

test("saved resume metadata stays isolated by author, workspace, repository and branch",()=>{
 const memory=storage(),store=new HostWritingResumeStore(memory);
 store.save(scope,{position,selection:{anchor:5,head:2}});
 assert.deepEqual(store.load(scope)?.position,position);
 assert.deepEqual(store.load(scope)?.selection,{anchor:5,head:2});
 for(const other of [{...scope,author_scope:"author-b"},{...scope,workspace_id:"other"},{...scope,repository_id:42},{...scope,branch:"other"}])assert.equal(store.load(other),null);
 assert.ok(![...memory.rows.values()][0]!.includes("draft text"));
});

test("resume storage rejects Git OIDs and malformed positions instead of treating them as current SHA-256 revisions",()=>{
 const store=new HostWritingResumeStore(storage());
 assert.throws(()=>store.save(scope,{position:{...position,manuscript_revision:"a".repeat(40)},selection:null}),/revision/);
 assert.throws(()=>store.save(scope,{position:{...position,sentence_index:0},selection:null}),/position/);
 assert.throws(()=>store.save(scope,{position:{...position,scroll_top:NaN},selection:null}),/position/);
 assert.throws(()=>store.save(scope,{position,selection:{anchor:-1,head:2}}),/selection/);
});

test("malformed optional resume records do not prevent opening the editor",()=>{
 const memory=storage(),store=new HostWritingResumeStore(memory);store.save(scope,{position,selection:null});
 for(const key of memory.rows.keys())memory.rows.set(key,'{"schema":"wrong"}');
 assert.equal(store.load(scope),null);
});

test("resume projection never exports unexpected stored text or selection fields",()=>{
 const memory=storage(),store=new HostWritingResumeStore(memory);store.save(scope,{position,selection:null});
 for(const [key,raw]of memory.rows){const row=JSON.parse(raw);row.value.position.draft_text="private draft";memory.rows.set(key,JSON.stringify(row));}
 assert.deepEqual(store.load(scope)?.position,position);
});
