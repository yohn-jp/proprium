import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStateEventCandidates } from "../src/state-events.js";

test("state events keep only uniquely evidenced exact UTF-16 spans", () => {
  const text = "---\ntitle: 題\n---\n😀灯は港へ着いた。灯は港へ着いた。\n鍵を渡した。";
  const base = { kind: "ownership", target: "char-a", operation: "give", before: null, after: { owner: "char-b" }, object: "key", payload: {} };
  const result = parseStateEventCandidates(JSON.stringify({ events: [
    { ...base, evidenceQuote: "灯は港へ着いた。" }, { ...base, evidenceQuote: "鍵を渡した。" },
    { ...base, evidenceQuote: "存在しない" },
  ] }), { path: "manuscript/a.md", revision: "a".repeat(64), text });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.confidence, 0.5);
  assert.equal(text.slice(result.events[0]!.evidence.start, result.events[0]!.evidence.end), "鍵を渡した。");
  assert.equal(result.diagnostics.length, 2);
});

test("state event candidates reject invented types and more than 20 entries", () => {
  const source = { path: "manuscript/a.md", revision: "a".repeat(64), text: "確かな本文" };
  assert.throws(() => parseStateEventCandidates(JSON.stringify({ events: [{ kind: "prediction" }] }), source), { code: "invalid_input" });
  assert.throws(() => parseStateEventCandidates(JSON.stringify({ events: Array(21).fill({}) }), source), { code: "capacity" });
});
