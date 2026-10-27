import { test } from "node:test";
import assert from "node:assert/strict";
import { previewQa } from "../src/assistance-preview.js";
import { guest } from "../guest.js";
import { readFile } from "node:fs/promises";
import { assertValue } from "../../../app/src/browser/proprium/authoring/schema.js";
import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";

const scope = {workspace_id:"w",repository_id:1,branch:"main",generation:"g"};
const snapshot = {id:"s",local_commit:null,worktree_generation:"v",draft_generation:null};
const request = {schema_version:1,request_id:"r",plugin_id:"proprium.paired-writing",action_id:"paired.qa.preview",scope,snapshot,input:{},deadline_ms:30000} as ActionRequest;
const host: GuestHost = { request(operation, payload) { return (function* () { return yield {operation,payload}; })() as never; } };
test("the signed QA preview action reaches the guest and returns its declared closed output", async () => {
  guest.initialize({pluginId:request.plugin_id,version:"0.1.0",workspaceId:scope.workspace_id});
  try {
    const result=JSON.parse(guest.invoke(JSON.stringify({...request,snapshot:{...snapshot,remote_commit:"c".repeat(40)},input:{question:"誰が駅にいる？"}})));
    assert.equal(result.ok,true);
    const manifest=JSON.parse(await readFile(new URL("../plugin.json",import.meta.url),"utf8"));
    const action=manifest.actions.find((a:{action_id:string})=>a.action_id==="paired.qa.preview");
    assert.ok(action);
    assertValue(action.output_schema,result.value);
    assert.match(result.value.prompt,/誰が駅にいる？/u);
    assert.equal(result.value.provider_invoked,false);
  } finally { guest.dispose(); }
});
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
test("QA preview includes each conversation turn and the current question", () => {
  const first=run(previewQa({messages:[{role:"user",content:"古い質問"},{role:"assistant",content:"先の回答"}],question:"新しい質問"},host,request)).value;
  const second=run(previewQa({messages:[{role:"user",content:"古い質問"},{role:"assistant",content:"先の回答"}],question:"別の質問"},host,request)).value;
  assert.match(first.prompt,/古い質問/u); assert.match(first.prompt,/先の回答/u); assert.match(first.prompt,/新しい質問/u);
  assert.notEqual(first.prompt,second.prompt);
  assert.deepEqual(first.messages,[{role:"user",content:"古い質問"},{role:"assistant",content:"先の回答"},{role:"user",content:"新しい質問"}]);
});
test("QA preview rejects an oversized assembled request without truncation", () => {
  const largeHost: GuestHost = { request(operation, payload) { return (function* () { return yield {operation,payload}; })() as never; } };
  const generator=previewQa({question:"質問",sceneId:"s1"},largeHost,request);
  let next=generator.next();
  while(!next.done) {
    const call=next.value;
    if(call.operation === "workspace.plugin.invoke") next=generator.next({ok:true,scope,snapshot,value:call.payload.action_id === "proprium.narrative.scene.open" ? {scene:{id:"s1",metadata_path:"scene.yaml",metadata_revision:"meta"},manuscript_path:"scene.md",manuscript_revision:"rev"} : {scene_id:"s1",title:"Scene",metadata_revision:"meta",manuscript_path:"scene.md",manuscript_revision:"rev"}});
    else if(call.operation === "workspace.file.read") {
      const text="文".repeat(300000), bytes=[...new TextEncoder().encode(text)];
      assert.throws(()=>generator.next({revision:"rev",total_bytes:bytes.length,offset:0,bytes,next_offset:null}),{code:"capacity"});
      return;
    } else throw new Error(`unexpected operation ${call.operation}`);
  }
  assert.fail("Expected oversized prompt to be rejected");
});
