import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResearchIndex,
  fuseSearchCandidates,
  filterIgnoredCandidates,
  createResearchDocument,
  isSearchableDocumentPath,
  lexicalTokens,
  parseTermRegistry,
  queryResearchIndex,
  removeTermRegistryEntry,
  resolveTermSpans,
  updateResearchIndex,
  upsertTermRegistry,
} from "./core.js";

const revision = (char: string) => char.repeat(64);

test("ignored candidate terms are removed by exact author choice before pagination", () => {
  const candidates = [{ term: "雨雲", occurrenceCount: 8 }, { term: "雨", occurrenceCount: 4 }, { term: "雨雲 (仮)", occurrenceCount: 2 }];
  assert.deepEqual(filterIgnoredCandidates(candidates, new Set(["雨雲"])), [candidates[1], candidates[2]]);
  assert.deepEqual(filterIgnoredCandidates(candidates, new Set()), candidates);
});

test("search filters roots and hidden paths, indexes Japanese pairs, and returns source ranges", () => {
  assert.equal(isSearchableDocumentPath("manuscript/vol/ch/scene.md"), true);
  assert.equal(isSearchableDocumentPath("bible/characters/a.json"), true);
  assert.equal(isSearchableDocumentPath("bible/.private/a.md"), false);
  assert.equal(isSearchableDocumentPath("notes/a.md"), false);
  assert.deepEqual(lexicalTokens("青い駅前"), ["青い", "い駅", "駅前"]);

  const text = "🎐 Ｂlue Lantern on the moonlit harbor.";
  const index = buildResearchIndex([
    { path: "manuscript/vol/ch/blue-lantern.md", fileRevision: revision("a"), text },
    { path: "bible/locations/harbor.yaml", fileRevision: revision("b"), text: "name: harbor" },
    { path: "manuscript/.hidden/blue-lantern.md", fileRevision: revision("c"), text },
    { path: "notes/blue-lantern.md", fileRevision: revision("d"), text },
  ], "snapshot-1");
  const page = queryResearchIndex(index, { query: "blue lantern", mode: "lexical", snapshot: "snapshot-1" });
  assert.deepEqual(page.hits.map(({ path }) => path), ["manuscript/vol/ch/blue-lantern.md"]);
  const hit = page.hits[0]!;
  const range = hit.matchRanges[0]!;
  assert.equal(text.slice(range.start, range.end), "Ｂlue Lantern");
  assert.equal(range.start, 3);
  assert.match(hit.snippet, /moonlit harbor/u);
  assert.equal(hit.fileRevision, revision("a"));
});

test("search modes rank deterministically and paginate with snapshot-bound cursors", () => {
  const documents = Array.from({ length: 305 }, (_, i) => ({
    path: `manuscript/vol/ch/harbor-${String(i).padStart(3, "0")}.md`,
    fileRevision: revision("a"),
    text: `A quiet harbor ${i}`,
  }));
  const index = buildResearchIndex(documents, "snapshot-2");
  const first = queryResearchIndex(index, { query: "harbor", mode: "lexical", snapshot: "snapshot-2", limit: 100 });
  assert.equal(first.hits.length, 100);
  assert.ok(first.nextCursor);
  const second = queryResearchIndex(index, { query: "harbor", mode: "lexical", snapshot: "snapshot-2", limit: 100, cursor: first.nextCursor! });
  const third = queryResearchIndex(index, { query: "harbor", mode: "lexical", snapshot: "snapshot-2", limit: 100, cursor: second.nextCursor! });
  const fourth = queryResearchIndex(index, { query: "harbor", mode: "lexical", snapshot: "snapshot-2", limit: 100, cursor: third.nextCursor! });
  const paths = [...first.hits, ...second.hits, ...third.hits, ...fourth.hits].map(({ path }) => path);
  assert.equal(paths.length, 305);
  assert.equal(new Set(paths).size, 305);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(fourth.nextCursor, null);
  assert.throws(() => queryResearchIndex(index, { query: "different", mode: "lexical", snapshot: "snapshot-2", limit: 100, cursor: first.nextCursor! }), /cursor does not match/u);
  assert.throws(() => queryResearchIndex(index, { query: "harbor", mode: "lexical", snapshot: "other" }), /another snapshot/u);

  const exact = queryResearchIndex(index, { query: "A quiet harbor 0", mode: "exact", snapshot: "snapshot-2" });
  assert.equal(exact.hits.some(({ path }) => path.endsWith("harbor-000.md")), true);
  const prefix = queryResearchIndex(index, { query: "harbor-00", mode: "prefix", snapshot: "snapshot-2", scope: "manuscript/vol/ch" });
  assert.equal(prefix.hits.length, 10);
  assert.equal(prefix.hits[0]?.scoreFactors.includes("prefix-path"), true);
});

test("term resolution maps compatibility graphemes to UTF-16 and keeps collisions ambiguous", () => {
  const registry = parseTermRegistry({ schemaVersion: 1, ownerNote: { keep: true }, terms: [
    { id: "term-blue", canonical: "Blue Lantern", aliases: ["Lantern"], targetPath: "bible/items/lantern.yaml", vendor: { retained: 7 } },
    { id: "term-lantern-keeper", canonical: "Lantern Keeper", aliases: ["Lantern"], targetPath: "bible/characters/keeper.yaml" },
    { id: "term-missing", canonical: "Missing Lamp", aliases: [], targetPath: "bible/items/missing.yaml" },
  ] });
  const text = "🎐 Ｂlue Lantern and Lanterners, then Lantern.";
  const resolved = resolveTermSpans(text, registry.terms, new Set(["bible/items/lantern.yaml", "bible/characters/keeper.yaml"]));
  assert.equal(text.slice(resolved.spans[0]!.start, resolved.spans[0]!.end), "Ｂlue Lantern");
  assert.equal(resolved.spans[0]!.start, 3);
  assert.equal(resolved.spans.length, 1);
  assert.deepEqual(resolved.ambiguities.map(({ alias, termIds }) => ({ alias, termIds })), [
    { alias: "Lantern", termIds: ["term-blue", "term-lantern-keeper"] },
  ]);

  const updated = upsertTermRegistry(registry, { id: "term-blue", canonical: "Blue Lantern", aliases: ["Blue Beacon"], targetPath: "bible/items/lantern.yaml" });
  assert.deepEqual(updated.ownerNote, { keep: true });
  assert.deepEqual(updated.terms.find(({ id }) => id === "term-blue")?.vendor, { retained: 7 });
  assert.deepEqual(removeTermRegistryEntry(updated, "term-missing").terms.map(({ id }) => id), ["term-blue", "term-lantern-keeper"]);
});

test("normalization span map stays exact across combining marks, expansions and following text", () => {
  const text = "x İ A\u030a 👩‍👩‍👦 end";
  const registry = parseTermRegistry({ schemaVersion: 1, terms: [
    { id: "term-dotted-i", canonical: "i\u0307", aliases: [], targetPath: "bible/items/i.yaml" },
    { id: "term-ring", canonical: "å", aliases: [], targetPath: "bible/items/ring.yaml" },
    { id: "term-end", canonical: "end", aliases: [], targetPath: "bible/items/end.yaml" },
  ] });
  const result = resolveTermSpans(text, registry.terms);
  assert.deepEqual(result.spans.map(({ start, end, termId }) => ({ value: text.slice(start, end), termId })), [
    { value: "İ", termId: "term-dotted-i" }, { value: "A\u030a", termId: "term-ring" }, { value: "end", termId: "term-end" },
  ]);
});

test("index and query reject unsafe, oversized, duplicate, malformed, or stale inputs", () => {
  assert.throws(() => createResearchDocument({ path: "../book.md", fileRevision: revision("a"), text: "x" }));
  assert.throws(() => buildResearchIndex([
    { path: "manuscript/a.md", fileRevision: revision("a"), text: "a" },
    { path: "manuscript/a.md", fileRevision: revision("b"), text: "b" },
  ], "snapshot"), /Duplicate/u);
  assert.throws(() => parseTermRegistry({ schemaVersion: 2, terms: [] }), /Unsupported/u);
  assert.throws(() => queryResearchIndex(buildResearchIndex([], "a"), { query: "x", mode: "lexical", snapshot: "b" }), /another snapshot/u);
});

test("snapshot delta reuses unchanged documents, replaces changed files, and drops deleted files", () => {
  const unchanged = { path: "manuscript/unchanged.md", fileRevision: revision("a"), text: "quiet harbor" };
  const changedBefore = { path: "manuscript/changed.md", fileRevision: revision("b"), text: "old lighthouse" };
  const deleted = { path: "manuscript/deleted.md", fileRevision: revision("c"), text: "removed harbor" };
  const previous = buildResearchIndex([unchanged, changedBefore, deleted], "snapshot-1");
  const reused = previous.documents.find(({ path }) => path === unchanged.path)!;
  const changedAfter = { path: changedBefore.path, fileRevision: revision("d"), text: "new beacon" };
  const added = { path: "manuscript/added.md", fileRevision: revision("e"), text: "distant beacon" };

  const next = updateResearchIndex(previous, [
    { path: unchanged.path, fileRevision: unchanged.fileRevision, byteLength: new TextEncoder().encode(unchanged.text).length },
    { path: changedAfter.path, fileRevision: changedAfter.fileRevision, byteLength: new TextEncoder().encode(changedAfter.text).length },
    { path: added.path, fileRevision: added.fileRevision, byteLength: new TextEncoder().encode(added.text).length },
  ], [changedAfter, added], "snapshot-2");

  assert.equal(next.snapshot, "snapshot-2");
  assert.equal(next.documents.find(({ path }) => path === unchanged.path), reused, "unchanged parsed text and token data are reused");
  assert.deepEqual(next.documents.map(({ path }) => path), ["manuscript/added.md", "manuscript/changed.md", "manuscript/unchanged.md"]);
  const page = queryResearchIndex(next, { query: "beacon", mode: "lexical", snapshot: "snapshot-2" });
  assert.deepEqual(page.hits.map(({ path }) => path), ["manuscript/added.md", "manuscript/changed.md"]);
  assert.equal(queryResearchIndex(next, { query: "old", mode: "lexical", snapshot: "snapshot-2" }).hits.length, 0);
  assert.throws(() => updateResearchIndex(previous, [
    { path: changedAfter.path, fileRevision: changedAfter.fileRevision, byteLength: new TextEncoder().encode(changedAfter.text).length },
  ], [], "snapshot-3"), /Changed searchable document bytes are required/u);
});

test("hybrid search uses bounded deterministic RRF and preserves the best exact source span per file", () => {
  const lexical = [
    { rank: 1, path: "manuscript/lexical.md", title: "lexical", fileRevision: "a".repeat(64), snippet: "lexical result", score: 120, scoreFactors: ["lexical-exact"], navigationSpan: { path: "manuscript/lexical.md", revision: "a".repeat(64), start: 0, end: 7, quote: "lexical" } },
    { rank: 2, path: "manuscript/shared.md", title: "shared", fileRevision: "b".repeat(64), snippet: "shared result", score: 80, scoreFactors: ["lexical-pair"], navigationSpan: { path: "manuscript/shared.md", revision: "b".repeat(64), start: 2, end: 8, quote: "shared" } },
  ];
  const semantic = [
    { candidateId: "one", entityId: "scene-1", sentenceIndex: 0, path: "manuscript/shared.md", title: "shared", fileRevision: "b".repeat(64), snippet: "best passage", cosineScore: 0.93, rank: 1, navigationSpan: { path: "manuscript/shared.md", revision: "b".repeat(64), start: 10, end: 22, quote: "best passage" } },
    { candidateId: "two", entityId: "scene-1", sentenceIndex: 1, path: "manuscript/shared.md", title: "shared", fileRevision: "b".repeat(64), snippet: "duplicate passage", cosineScore: 0.92, rank: 2, navigationSpan: { path: "manuscript/shared.md", revision: "b".repeat(64), start: 30, end: 47, quote: "duplicate passage" } },
    { candidateId: "three", entityId: "scene-2", sentenceIndex: 0, path: "manuscript/vector.md", title: "vector", fileRevision: "c".repeat(64), snippet: "vector result", cosineScore: 0.88, rank: 3, navigationSpan: { path: "manuscript/vector.md", revision: "c".repeat(64), start: 0, end: 13, quote: "vector result" } },
  ];
  const rows = fuseSearchCandidates(lexical, semantic, "hybrid", 30);
  assert.equal(rows[0]?.path, "manuscript/shared.md");
  assert.equal(rows[0]?.source, "hybrid");
  assert.equal(rows[0]?.navigationSpan.start, 10);
  assert.equal(rows[0]?.semanticRank, 1);
  assert.equal(rows.length, 3);
  assert.deepEqual(fuseSearchCandidates(lexical, semantic, "hybrid", 30), rows);
  assert.deepEqual(fuseSearchCandidates(lexical, semantic, "semantic", 30).map(({ path }) => path), ["manuscript/shared.md", "manuscript/vector.md"]);
  assert.throws(() => fuseSearchCandidates(lexical, semantic, "hybrid", 31), { code: "capacity" });
});
