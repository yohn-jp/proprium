import assert from "node:assert/strict";
import test from "node:test";
import { guest } from "../guest.js";
import { sha256 } from "../src/core.js";
import { frequentNouns, frequentPhrases, sentimentArc, toneDeviation, type MetricSentence } from "../src/textMetrics.js";

function sentence(text: string, start: number, parts: Array<[string, string, string?]>): MetricSentence {
  let offset = start;
  const tokens = parts.map(([surface, pos, base]) => {
    const token = { start: offset, end: offset + surface.length, surface, pos, ...(base ? { base } : {}) };
    offset += surface.length;
    return token;
  });
  return { start, end: offset, text, tokens };
}

test("pinned Japanese phrase, noun, emotion and declared-tone metrics preserve source evidence", () => {
  const rows = Array.from({ length: 3 }, (_, index) => {
    const start = index * 16;
    return [
      sentence("青空を見た。", start, [["青空", "名詞"], ["を", "助詞"], ["見た", "動詞", "見る"], ["。", "記号"]]),
      sentence("嬉しい空だった。", start + 6, [["嬉しい", "形容詞"], ["空", "名詞"], ["だっ", "助動詞"], ["た", "助動詞"], ["。", "記号"]]),
    ];
  }).flat();
  const nouns = frequentNouns(rows, new Set(["青空"]));
  assert.deepEqual(nouns.frequent.map(({ term, count }) => ({ term, count })), [{ term: "青空", count: 3 }]);
  assert.deepEqual(nouns.unknown, []);
  assert.deepEqual(nouns.frequent[0].evidence[0], { sentenceIndex: 1, start: 0, end: 2, quote: "青空" });
  const phrases = frequentPhrases(rows);
  assert.ok(phrases.some((row) => row.phrase === "青空を見た" && row.count === 3 && row.evidence[0].quote === "青空を見た"));
  const arc = sentimentArc(rows);
  assert.equal(arc.points[1].raw, 0.8);
  assert.equal(arc.points[1].isDialogue, false);
  assert.ok(arc.points[1].start < arc.points[1].end);
  assert.equal(arc.minIndex, 1);
  assert.equal(arc.maxIndex, 2);
  assert.ok(toneDeviation(rows[0].tokens, { tones: { suspense: { "戦慄": 1 }, slice: { "青空": 1 } } }, "suspense"));
});

test("text analysis consumes revision-bound Research tokens and returns lexical metrics", () => {
  guest.initialize({ pluginId: "proprium.diagnostics", version: "0.1.0", workspaceId: "workspace-metrics" });
  const text = "青空を見た。嬉しい空だった。青空を見た。嬉しい空だった。青空を見た。嬉しい空だった。";
  const scope = { workspace_id: "workspace-metrics", repository_id: 31, branch: "main", generation: "g-metrics" };
  const snapshot = { id: "s-metrics", local_commit: "commit-m", worktree_generation: "tree-m", draft_generation: null };
  const tokens: Array<Record<string, unknown>> = [];
  const sentences: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (let count = 0; count < 3; count++) {
    for (const parts of [
      [["青空", "名詞"], ["を", "助詞"], ["見た", "動詞", "見る"], ["。", "記号"]],
      [["嬉しい", "形容詞"], ["空", "名詞"], ["だっ", "助動詞"], ["た", "助動詞"], ["。", "記号"]],
    ] as Array<Array<[string, string, string?]>>) {
      const start = offset;
      for (const [surface, pos, base] of parts) {
        tokens.push({ start: offset, end: offset + surface.length, surface, pos, ...(base ? { base } : {}) });
        offset += surface.length;
      }
      sentences.push({ start, end: offset });
    }
  }
  const request = { schema_version: 1, request_id: "metrics-report", plugin_id: "proprium.diagnostics", action_id: "proprium.diagnostics.text.analyze.v1", scope, snapshot, input: { text }, deadline_ms: 30_000 };
  let result = JSON.parse(guest.invoke(JSON.stringify(request)));
  const respond = (call: Record<string, unknown>, ok: boolean, value: unknown) => JSON.parse(guest.invoke(JSON.stringify({
    kind: "host_response", call_id: call.call_id, ...(ok ? { ok: true, value } : { ok: false, error: value }),
  })));
  while (result.kind === "host_call") {
    const payload = result.payload as Record<string, unknown>;
    if (result.operation === "workspace.file.read") result = respond(result, false, { code: "file_not_found", message: "No custom lint config", retryable: false });
    else if (result.operation === "workspace.plugin.invoke") {
      const action = payload.action_id;
      if (action === "research.nlp.analyze") result = respond(result, true, { request_id: "research-nlp", scope, snapshot, ok: true, warnings: [], value: {
        source: { kind: "literal", textDigest: sha256(text) }, sentences, tokens,
        engine: { id: "fixture-tokenizer", version: "1.0.0", digest: "e".repeat(64) },
      } });
      else if (action === "research.terms.list") result = respond(result, true, { request_id: "research-terms", scope, snapshot, ok: true, warnings: [], value: {
        items: [{ canonical: "青空", aliases: [] }], registryRevision: "f".repeat(64), nextCursor: null,
      } });
      else assert.fail(`unexpected provider action ${String(action)}`);
    } else assert.fail(`unexpected Host operation ${String(result.operation)}`);
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.providers.lexical, "ready");
  assert.equal(result.value.providers.terms, "ready");
  assert.equal(result.value.frequentNouns[0].term, "青空");
  assert.equal(result.value.frequentNouns[0].count, 3);
  assert.ok(result.value.frequentPhrases.some((row: { phrase: string; count: number }) => row.phrase === "青空を見た" && row.count === 3));
  assert.equal(result.value.sentimentArc.points[1].raw, 0.8);
  assert.ok(result.value.habitualPhraseWarnings.some((row: { phrase: string; band: string }) => row.phrase === "嬉しい空" && row.band === "positive"));
  assert.equal(result.value.identity.providerIdentity.research.id, "fixture-tokenizer");
  guest.dispose();
});
