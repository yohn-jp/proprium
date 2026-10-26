import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSeriesOverlay } from "./seriesOverlay.js";
import type { StoryEntity } from "./types.js";

const snapshot = {
  repository: {
    provider: "local" as const,
    repositoryId: "repo-series",
    defaultBranch: "main",
    ownerScope: "owner-1",
    url: "file:///repo-series",
  },
  remoteCommit: "e".repeat(40),
};

function entity(id: string, name: string): StoryEntity {
  return {
    id,
    type: "character",
    name,
    filePath: `characters/${id}.yaml`,
    raw: { id, name },
  };
}

test("series overlay gives work entities precedence and deduplicates relation identity", () => {
  const bibleA = entity("char-a", "bible-A");
  const workA = entity("char-a", "work-A");
  const workEntities = new Map([
    ["char-a", workA],
    ["char-c", entity("char-c", "work-C")],
  ]);
  const bibleEntities = new Map([
    ["char-a", bibleA],
    ["char-b", entity("char-b", "bible-B")],
  ]);
  const bibleLinks = [{ from: "char-a", to: "char-b", kind: "related", note: "bible" }];
  const workLinks = [
    { from: "char-a", to: "char-b", kind: "related", note: "work" },
    { from: "char-c", to: "char-a", kind: "related" },
  ];
  const result = mergeSeriesOverlay({
    snapshot,
    workEntities,
    workLinks,
    bibleEntities,
    bibleLinks,
  });
  assert.strictEqual(result.snapshot, snapshot);
  assert.equal(result.data.entities.size, 3);
  assert.equal(result.data.entities.get("char-a")?.name, "work-A");
  assert.equal(result.data.entities.get("char-b")?.name, "bible-B");
  assert.deepEqual(result.data.links, [bibleLinks[0], workLinks[1]]);
  assert.strictEqual(workEntities.get("char-a"), workA);
  assert.strictEqual(bibleEntities.get("char-a"), bibleA);
});

test("series overlay with an empty bible preserves the work view", () => {
  const result = mergeSeriesOverlay({
    snapshot,
    workEntities: new Map([["char-a", entity("char-a", "work-A")]]),
    workLinks: [],
    bibleEntities: new Map(),
    bibleLinks: [],
  });
  assert.equal(result.data.entities.size, 1);
  assert.deepEqual(result.data.links, []);
});
