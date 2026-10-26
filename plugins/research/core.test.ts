import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResearchIndex,
  createResearchDocument,
  isSearchableDocumentPath,
  lexicalTokens,
  parseTermRegistry,
  queryResearchIndex,
  removeTermRegistryEntry,
  resolveTermSpans,
  upsertTermRegistry,
} from "./core.js";

const revision = (char: string) => char.repeat(64);

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
