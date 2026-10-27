import assert from "node:assert/strict";
import test from "node:test";
import { ProviderUsageHistory } from "./provider-usage.js";
import type { BrokerStore, PreferenceRecord } from "./brokers.js";
import type { ProviderRequestInput } from "./providers.js";
import type { Scope } from "./types.js";

const scope: Scope = { workspace_id: "work", repository_id: 1, branch: "main", generation: "g1" };
const input: ProviderRequestInput = { request_id: "request-1", provider_id: "provider", model_id: "model", purpose: "summary", payload: { prompt: "PRIVATE PROMPT" }, source_manifest: { text: "PRIVATE SOURCE" }, max_output_bytes: 100 };
function store() {
  const records = new Map<string, PreferenceRecord>();
  return { records, broker: {
    getPreference: async (key: string) => records.get(key),
    putPreference: async (record: PreferenceRecord) => { records.set(record.key, structuredClone(record)); },
  } as BrokerStore };
}

test("pending usage is unknown and partitioned; retries cannot resend", async () => {
  const { broker } = store();
  const history = new ProviderUsageHistory(broker);
  const receipt = await history.begin("plugin", "alice", scope, input);
  const pending = await history.read("plugin", "alice", scope);
  assert.equal(pending.complete, false);
  assert.deepEqual(pending.events, []);
  assert.match(pending.reason!, /no automatic resend/);
  await assert.rejects(history.begin("plugin", "alice", scope, input), { code: "external_state_unknown" });
  for (const [plugin, actor, isolatedScope] of [["other", "alice", scope], ["plugin", "bob", scope], ["plugin", "alice", { ...scope, branch: "other" }]] as const) {
    assert.deepEqual(await history.read(plugin, actor, isolatedScope), { available: true, events: [], complete: true });
  }
  await history.finish(receipt);
  const done = await history.read("plugin", "alice", scope);
  assert.equal(done.complete, true);
  assert.equal(done.events[0].state, "completed");
});

test("stored usage contains neither request content nor error message", async () => {
  const { records, broker } = store();
  const history = new ProviderUsageHistory(broker);
  const receipt = await history.begin("plugin", "alice", scope, input);
  await history.finish(receipt, Object.assign(new Error("PRIVATE OUTPUT"), { code: "cancelled" }));
  const persisted = JSON.stringify([...records.values()]);
  for (const secret of ["PRIVATE PROMPT", "PRIVATE SOURCE", "PRIVATE OUTPUT"]) assert.equal(persisted.includes(secret), false);
  assert.equal((await history.read("plugin", "alice", scope)).events[0].state, "aborted");
});
