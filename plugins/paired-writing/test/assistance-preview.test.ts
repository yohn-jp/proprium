import { test } from "node:test";
import assert from "node:assert/strict";
import { previewQa } from "../src/assistance-preview.js";
import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";

const scope = {workspace_id:"w",repository_id:1,branch:"main",generation:"g"};
const snapshot = {id:"s",local_commit:null,worktree_generation:"v",draft_generation:null};
const request = {schema_version:1,request_id:"r",plugin_id:"proprium.paired-writing",action_id:"paired.qa.preview",scope,snapshot,input:{},deadline_ms:30000} as ActionRequest;
const host: GuestHost = { request(operation, payload) { return (function* () { return yield {operation,payload}; })() as never; } };
function run(generator: Generator<HostCall, unknown, unknown>): {value:any;calls:string[]} {
  let next = generator.next(); const calls:string[]=[];
  while (!next.done) {
    const call = next.value; calls.push(call.operation);
    assert.notEqual(call.operation,"provider.request");
    let value:unknown;
    if (call.operation === "workspace.plugin.invoke") {
      const action = call.payload.action_id;
      value = {ok:true,scope,snapshot,value:action === "proprium.narrative.scene.open"
        ? {scene:{id:"s1",metadata_path:"scene.yaml",metadata_revision:"meta"},manuscript_path:"scene.md",manuscript_revision:"rev"}
        : {scene_id:"s1",title:"Scene",metadata_revision:"meta",manuscript_path:"scene.md",manuscript_revision:"rev"}};
    } else if (call.operation === "workspace.file.read") {
      const bytes = [...new TextEncoder().encode("第一文。第二文。")];
      value = {revision:"rev",total_bytes:bytes.length,offset:0,bytes,next_offset:null};
    } else throw new Error(`unexpected operation ${call.operation}`);
    next = generator.next(value);
  }
  return {value:next.value,calls};
}
test("QA preview reads the pinned selected scene without provider calls", () => {
  const result=run(previewQa({question:"誰？",sceneId:"s1"},host,request));
  assert.match(result.value.prompt,/第一文。第二文。/u);
  assert.equal(result.value.provider_invoked,false);
  assert.deepEqual(result.value.sources,[{path:"scene.md",revision:"rev"}]);
});
test("QA preview rejects missing user input and unknown fields", () => {
  assert.throws(()=>run(previewQa({messages:[{role:"assistant",content:"hello"}]},host,request)),{code:"invalid_input"});
  assert.throws(()=>run(previewQa({question:"Q",extra:true},host,request)),{code:"invalid_input"});
});
