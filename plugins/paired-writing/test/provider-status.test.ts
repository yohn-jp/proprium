import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";

test("provider status reports unconfigured broker and real local alternatives without network", () => {
  guest.initialize({pluginId:"proprium.paired-writing",version:"0.1.0",workspaceId:"work"});
  try {
    let result=JSON.parse(guest.invoke(JSON.stringify({schema_version:1,request_id:"status",plugin_id:"proprium.paired-writing",action_id:"paired.provider.status",scope:{workspace_id:"work",repository_id:null,branch:"main",generation:"g"},snapshot:{id:"s",local_commit:null,worktree_generation:"g",draft_generation:null},input:{},deadline_ms:30000})));
    assert.equal(result.kind,"host_call");
    assert.equal(result.operation,"workspace.capabilities.query");
    assert.deepEqual(result.payload,{capability_id:"provider.request"});
    result=JSON.parse(guest.invoke(JSON.stringify({kind:"host_response",call_id:result.call_id,ok:true,value:{available:false,provider_ids:[],reason:"No Host provider is configured"}})));
    assert.equal(result.ok,false);
    assert.equal(result.error.code,"provider_unavailable");
    assert.equal(result.error.details.local_features.rewrite,true);
    assert.equal(result.error.details.local_features.qa_preview,true);
  } finally { guest.dispose(); }
});
