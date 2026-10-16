import assert from "node:assert/strict";
import test from "node:test";
import { buildStoryCooccurrence } from "./cooccurrence.js";
import type { StoryEntity, StoryGraphInput } from "./types.js";

const snapshot = {
  repository: { provider: "local" as const, repositoryId: "cooccurrence", defaultBranch: "main", ownerScope: "test", url: "file:///cooccurrence" },
  remoteCommit: "a".repeat(40),
};
function entity(id: string, type: StoryEntity["type"], raw: Record<string, unknown> = {}): StoryEntity {
  return { id, type, filePath: `${type}/${id}.yaml`, raw };
}
function input(entities: StoryEntity[], links: StoryGraphInput["links"]): StoryGraphInput {
  return { snapshot, entities: new Map(entities.map((row) => [row.id, row])), links };
}

test("co-occurrence uses canonical scene.appears relations, deduplicates, and calculates source Jaccard/PMI", () => {
  const story = input(
    [entity("char-a", "character"), entity("char-b", "character"), entity("char-c", "character"), entity("sc-1", "scene"), entity("sc-2", "scene"), entity("sc-3", "scene")],
    [
      { from: "sc-1", to: "char-a", kind: "appears" }, { from: "sc-1", to: "char-b", kind: "appears" },
      { from: "sc-1", to: "char-a", kind: "appears" }, { from: "sc-2", to: "char-a", kind: "appears" },
      { from: "sc-2", to: "char-b", kind: "appears" }, { from: "sc-3", to: "char-a", kind: "appears" },
      { from: "sc-3", to: "char-c", kind: "appears" }, { from: "char-a", to: "char-b", kind: "appears" },
    ],
  );
  const result = buildStoryCooccurrence(story);
  assert.deepEqual(result.edges, [
    { a: "char-a", b: "char-b", sceneCount: 2, jaccard: 2 / 3, pmi: 0 },
    { a: "char-a", b: "char-c", sceneCount: 1, jaccard: 1 / 3, pmi: 0 },
  ]);
  assert.deepEqual(result.gaps.filter(({ issue }) => issue === "cooccurring-but-unregistered"), [
    { a: "char-a", b: "char-b", issue: "cooccurring-but-unregistered", sceneCount: 2 },
  ]);
});

test("scope recalculates the denominator and relation gaps against scoped appearances", () => {
  const story = input(
    [
      entity("char-a", "character", { relations: [{ target: "char-b", kind: "related" }, { target: "char-c", kind: "related", auto: true }] }),
      entity("char-b", "character"), entity("char-c", "character"), entity("char-d", "character"),
      entity("sc-1", "scene"), entity("sc-2", "scene"), entity("sc-3", "scene"), entity("sc-4", "scene"),
    ],
    [
      { from: "sc-1", to: "char-a", kind: "appears" }, { from: "sc-1", to: "char-b", kind: "appears" },
      { from: "sc-2", to: "char-a", kind: "appears" }, { from: "sc-2", to: "char-b", kind: "appears" },
      { from: "sc-3", to: "char-a", kind: "appears" }, { from: "sc-3", to: "char-c", kind: "appears" },
      { from: "sc-4", to: "char-a", kind: "appears" }, { from: "sc-4", to: "char-c", kind: "appears" }, { from: "sc-4", to: "char-d", kind: "appears" },
      { from: "char-a", to: "char-b", kind: "related" }, { from: "char-a", to: "char-c", kind: "related" },
    ],
  );
  const all = buildStoryCooccurrence(story);
  assert.ok(!all.gaps.some(({ a, b, issue }) => issue === "cooccurring-but-unregistered" && a === "char-a" && b === "char-b"));
  assert.ok(all.gaps.some(({ a, b, issue }) => issue === "cooccurring-but-unregistered" && a === "char-a" && b === "char-c"), "automatic relation links are not treated as registered");

  const scoped = buildStoryCooccurrence({ ...story, sceneIds: ["sc-1", "sc-2"] });
  assert.deepEqual(scoped.edges, [{ a: "char-a", b: "char-b", sceneCount: 2, jaccard: 1, pmi: 0 }]);
  assert.deepEqual(scoped.gaps, []);
});
