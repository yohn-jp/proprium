import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUsagePage } from '../src/usage-history.js';

test('history normalizes preserved legacy lines and host events without leaking unknown fields', () => {
  const text = '{"ts":"2026-10-01T12:00:00Z","feature":"rewrite","model":"local","inputTokens":12,"durationMs":300,"future":{"secret":true}}\r\ninvalid\n';
  const host = [{id:'h1',feature:'summary',provider:'host',model:'m',startedAt:'2026-10-02T00:00:00Z',completedAt:'2026-10-02T00:00:01Z',state:'completed',outputTokens:5,private:'omit'}];
  const page = readUsagePage({legacyText:text,legacyRevision:'rev',hostEvents:host,hostAvailable:true,limit:10});
  assert.equal(page.total,2); assert.equal(page.events[0]?.id,'h1'); assert.equal(page.events[1]?.inputTokens,12);
  assert.equal('future' in page.events[1]!,false); assert.equal('private' in page.events[0]!,false);
  assert.equal(page.aggregates['2026-10']?.calls,2); assert.equal(page.legacyRevision,'rev');
  assert.match(text,/future/);
});

test('history cursor binds the result and month; changed input is rejected', () => {
  const text = [1,2,3].map(n=>JSON.stringify({ts:`2026-10-0${n}T00:00:00Z`,feature:'rewrite',model:'m'})).join('\n');
  const first=readUsagePage({legacyText:text,legacyRevision:'r',limit:1,month:'2026-10'});
  assert.ok(first.nextCursor);
  const next=readUsagePage({legacyText:text,legacyRevision:'r',limit:1,month:'2026-10',cursor:first.nextCursor!});
  assert.notEqual(next.events[0]?.id,first.events[0]?.id);
  assert.throws(()=>readUsagePage({legacyText:text+'\n',legacyRevision:'r2',limit:1,month:'2026-10',cursor:first.nextCursor!}),/cursor/i);
});
test('resolver reads only requested preserved source through pinned list and read, without implicit archive merge', async () => {
 const {resolveUsageHistory}=await import('../src/usage-history.js'); const snapshot={id:'s',local_commit:null,worktree_generation:'g',draft_generation:null};
 const request={snapshot} as any;const host:any={request(operation:string,payload:any){return(function*(){return yield {operation,payload};})();}};
 const run=resolveUsageHistory(host,request,{limit:10});let step=run.next();assert.equal(step.value.operation,'workspace.file.list');assert.equal(step.value.payload.prefix,'meta/scriptorium/modules/assistant/');
 const path='meta/scriptorium/modules/assistant/usage.jsonl',rev='a'.repeat(64);const text='{"ts":"2026-10-01T00:00:00Z","feature":"rewrite","model":"m","unknown":true}\n';const bytes=[...new TextEncoder().encode(text)];
 step=run.next({entries:[{path,revision:rev,byte_length:bytes.length}],next_cursor:null});assert.equal(step.value.operation,'workspace.file.read');assert.equal(step.value.payload.path,path);
 step=run.next({revision:rev,offset:0,total_bytes:bytes.length,bytes,next_offset:null});assert.equal(step.done,true);assert.equal((step.value as any).total,1);assert.equal((step.value as any).historyWarning,'host_usage_store_unavailable');assert.equal((step.value as any).legacyRevision,rev);
});
