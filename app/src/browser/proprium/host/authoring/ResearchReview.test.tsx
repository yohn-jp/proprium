import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionResult } from "../../authoring/types.js";
import {
  buildKnowledgeCorpus,
  parseIgnoredTerms,
  parseKnowledgeEntityPage,
  parseLegacyConsent,
  ResearchReview,
  sourceEvidenceForCandidate,
  type KnowledgeEntity,
} from "./ResearchReview.js";

const REVISION = "a".repeat(64);

test("Knowledge corpus is pinned to the selected entity paths and keeps names only as known terms", () => {
  const entities: KnowledgeEntity[] = [
    { id: "char-a", type: "character", name: "灯", aliases: ["あかり"], path: "bible/characters/char-a.yaml", revision: REVISION,
      raw: { id: "char-a", type: "character", name: "灯", aliases: ["あかり"], description: "青い灯を守る。", notes: { private: "港に住む。" } } },
    { id: "char-b", type: "character", name: "海", aliases: [], path: "bible/characters/char-b.yaml", revision: "b".repeat(64),
      raw: { id: "char-b", type: "character", name: "海", description: "灯の友人。" } },
  ];
  const corpus = buildKnowledgeCorpus([entities[0]!], entities);
  assert.equal(corpus.items.length, 1);
  assert.deepEqual(corpus.items[0], {
    id: "char-a", path: "bible/characters/char-a.yaml", revision: REVISION,
    texts: [
      { id: "description", text: "青い灯を守る。" },
      { id: "notes.private", text: "港に住む。" },
    ],
  });
  assert.deepEqual(corpus.knownTerms, ["灯", "あかり", "海"]);
  assert.equal(corpus.texts.get("char-a\u0000description"), "青い灯を守る。");
});

test("Knowledge entity list rejects malformed or duplicate source identities instead of dropping them", () => {
  const entity = { id: "char-a", type: "character", name: "灯", aliases: [], filePath: "bible/characters/char-a.yaml", fileRevision: REVISION, raw: { description: "灯" } };
  assert.equal(parseKnowledgeEntityPage({ items: [entity], collectionRevision: REVISION, nextCursor: null }).entities.length, 1);
  assert.throws(() => parseKnowledgeEntityPage({ items: [entity, entity], collectionRevision: REVISION, nextCursor: null }), /重複/u);
  assert.throws(() => parseKnowledgeEntityPage({ items: [{ ...entity, filePath: "../outside.yaml" }], collectionRevision: REVISION, nextCursor: null }), /不正/u);
});

test("ignore list validates a pinned revision and unique author terms", () => {
  assert.deepEqual(parseIgnoredTerms({ fileRevision: null, terms: [] }), { fileRevision: null, terms: [] });
  assert.deepEqual(parseIgnoredTerms({ fileRevision: REVISION, terms: ["星", "灯"] }), { fileRevision: REVISION, terms: ["星", "灯"] });
  assert.throws(() => parseIgnoredTerms({ fileRevision: "bad", terms: [] }), /無視リスト/u);
  assert.throws(() => parseIgnoredTerms({ fileRevision: null, terms: ["灯", ""] }), /無視リスト/u);
});

test("legacy external choices remain visible but never map or grant a Host capability", () => {
  const value = parseLegacyConsent({
    features: [
      { id: "rewrite", label: "言い換え", locality: "external", legacyEnabled: true, requiresHostGrant: true },
      { id: "hybrid-search", label: "意味検索", locality: "local", legacyEnabled: true, requiresHostGrant: false },
    ],
    legacySettings: { externalEnabled: { rewrite: true, "retired-secret-name": false, "bad-flag": "yes" } },
  });
  assert.equal(value.features[0]?.legacyEnabled, true);
  assert.deepEqual(value.unknownExternal, [
    { id: "bad-flag", enabled: null },
    { id: "retired-secret-name", enabled: false },
  ]);
  const html = renderToStaticMarkup(createElement(ResearchReview, {
    scopeKey: "workspace:main", knowledgeAvailable: false,
    taskControls: createElement("section", { "aria-label": "Research index tasks" }, "Rebuild index"),
    invokeRead: async () => { throw new Error("SSR does not invoke actions"); },
    invokeUi: async () => { throw new Error("SSR does not invoke actions"); },
  }));
  assert.match(html, /旧設定は履歴として表示/u);
  assert.match(html, /Research/u);
  assert.match(html, /Research index tasks/u);
  assert.doesNotMatch(html, /proprium\.paired-writing/u);
});

test("Knowledge handoff evidence is the exact UTF-16 quote from each selected pinned source", () => {
  const candidate = {
    term: "星", reading: "ほし", sourceIds: ["entity-a"], occurrenceCount: 1,
    evidence: [{ sourceId: "entity-a", textId: "notes", path: "bible/characters/a.yaml", revision: REVISION, range: { start: 2, end: 3 } }],
  };
  const corpus = { items: [{ id: "entity-a", path: "bible/characters/a.yaml", revision: REVISION, texts: [{ id: "notes", text: "😀星の海" }] }],
    texts: new Map([["entity-a\u0000notes", "😀星の海"]]), knownTerms: [] };
  assert.deepEqual(sourceEvidenceForCandidate(candidate, corpus), [
    { path: "bible/characters/a.yaml", revision: REVISION, start: 2, end: 3, quote: "星" },
  ]);
  assert.deepEqual(sourceEvidenceForCandidate(candidate, { ...corpus, texts: new Map([["entity-a\u0000notes", "別の月"]]) }), []);
  assert.deepEqual(sourceEvidenceForCandidate(candidate, { ...corpus, items: [{ ...corpus.items[0]!, revision: "b".repeat(64) }] }), []);
});

test("browser action interfaces use normal Host results", () => {
  const result: ActionResult = {
    request_id: "request", scope: { workspace_id: "workspace", repository_id: 1, branch: "main", generation: "1" },
    snapshot: { id: "snapshot", local_commit: null, worktree_generation: "1", draft_generation: null },
    ok: true, value: { fileRevision: null, terms: [] }, warnings: [],
  };
  assert.equal(result.ok, true);
});
