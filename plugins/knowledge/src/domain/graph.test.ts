import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSceneContext,
  buildSceneLocationInfos,
  getBacklinks,
  getEntityAppearances,
  getGraphData,
  getThreadsOverview,
  getVolumeTree,
} from "./graph.js";
import { buildLocationMap } from "./locationMap.js";
import type { StoryEntity, StoryGraphInput } from "./types.js";

const snapshot = {
  repository: {
    provider: "local" as const,
    repositoryId: "repo-1",
    defaultBranch: "main",
    ownerScope: "owner-1",
    url: "file:///repo-1",
  },
  remoteCommit: "a".repeat(40),
};

function entity(
  id: string,
  type: StoryEntity["type"],
  raw: Record<string, unknown> = {},
  extra: Partial<StoryEntity> = {},
): StoryEntity {
  return { id, type, name: id, filePath: `${type}/${id}.yaml`, raw, ...extra };
}

function input(
  entities: StoryEntity[],
  links: StoryGraphInput["links"] = [],
): StoryGraphInput {
  return { snapshot, entities: new Map(entities.map((item) => [item.id, item])), links };
}

test("backlinks retain source relation order and omit missing source entities", () => {
  const story = input(
    [entity("char-a", "character"), entity("scene-a", "scene")],
    [
      { from: "scene-a", to: "char-a", kind: "appears" },
      { from: "missing", to: "char-a", kind: "mentions" },
      { from: "scene-a", to: "char-a", kind: "pov" },
    ],
  );
  const result = getBacklinks({ ...story, toId: "char-a" });
  assert.strictEqual(result.snapshot, snapshot);
  assert.deepEqual(
    result.data.map(({ link, entity: source }) => [link.kind, source.id]),
    [["appears", "scene-a"], ["pov", "scene-a"]],
  );
});

test("appearances aggregate relation kinds by scene and sort by scene order", () => {
  const story = input(
    [
      entity("char-a", "character"),
      entity("scene-late", "scene", { order: 8, volume: "vol-2", chapter: "ch-3" }),
      entity("scene-early", "scene", { order: 2, volume: "vol-1", chapter: "ch-1" }),
      entity("thread-a", "thread"),
    ],
    [
      { from: "scene-late", to: "char-a", kind: "appears" },
      { from: "scene-early", to: "char-a", kind: "mentions" },
      { from: "scene-late", to: "char-a", kind: "pov" },
      { from: "thread-a", to: "char-a", kind: "related" },
      { from: "scene-early", to: "char-a", kind: "mentions" },
    ],
  );
  const result = getEntityAppearances({ ...story, entityId: "char-a" });
  assert.deepEqual(
    result.data.map((appearance) => [
      appearance.scene.id,
      appearance.volumeId,
      appearance.chapterId,
      appearance.kinds,
    ]),
    [
      ["scene-early", "vol-1", "ch-1", ["mentions"]],
      ["scene-late", "vol-2", "ch-3", ["appears", "pov"]],
    ],
  );
});

test("scene context resolves POV, raw location, relation collections and manuscript path", () => {
  const story = input(
    [
      entity("scene-a", "scene", { location: "loc-raw", manuscript: "manuscript/a.md" }),
      entity("char-a", "character"),
      entity("loc-raw", "location"),
      entity("loc-linked", "location"),
      entity("item-a", "item"),
      entity("thread-a", "thread"),
      entity("manuscript-a", "manuscript", {}, { filePath: "manuscript/a.md", body: "scene text" }),
    ],
    [
      { from: "scene-a", to: "char-a", kind: "pov" },
      { from: "scene-a", to: "char-a", kind: "appears" },
      { from: "scene-a", to: "loc-linked", kind: "appears" },
      { from: "scene-a", to: "item-a", kind: "appears" },
      { from: "scene-a", to: "thread-a", kind: "plants" },
      { from: "scene-a", to: "thread-a", kind: "advances" },
    ],
  );
  const result = buildSceneContext({ ...story, sceneId: "scene-a" });
  assert.equal(result.data?.pov?.id, "char-a");
  assert.equal(result.data?.location?.id, "loc-raw");
  assert.deepEqual(result.data?.appears.map((item) => item.id), ["char-a"]);
  assert.deepEqual(result.data?.items.map((item) => item.id), ["item-a"]);
  assert.deepEqual(result.data?.threadsPlanted.map((item) => item.id), ["thread-a"]);
  assert.deepEqual(result.data?.threadsAdvanced.map((item) => item.id), ["thread-a"]);
  assert.equal(result.data?.manuscriptBody, "scene text");
});

test("volume tree and scene-location chronology use volume/chapter/scene order", () => {
  const story = input(
    [
      entity("vol-2", "volume", { order: 2 }),
      entity("vol-1", "volume", { order: 1 }),
      entity("ch-2", "chapter", { volume: "vol-2", order: 1 }),
      entity("ch-1", "chapter", { volume: "vol-1", order: 1 }),
      entity("sc-b", "scene", { chapter: "ch-1", order: 2, location: "loc-b" }),
      entity("sc-a", "scene", { chapter: "ch-1", order: 1, location: "loc-a" }),
      entity("sc-c", "scene", { chapter: "ch-2", order: 1, location: "loc-b" }),
      entity("loc-a", "location"),
      entity("loc-b", "location"),
      entity("char-a", "character"),
    ],
    [
      { from: "sc-a", to: "char-a", kind: "appears" },
      { from: "sc-c", to: "char-a", kind: "appears" },
    ],
  );
  assert.deepEqual(getVolumeTree(story).data.map((volume) => volume.volume.id), ["vol-1", "vol-2"]);
  const chronology = buildSceneLocationInfos(story).data;
  assert.deepEqual(
    chronology.map((item) => [item.sceneId, item.order, item.locationId, item.characterIds]),
    [["sc-a", 1, "loc-a", ["char-a"]], ["sc-b", 2, "loc-b", []], ["sc-c", 3, "loc-b", ["char-a"]]],
  );
});

test("thread overview combines both planted relation directions and deduplicates by scene", () => {
  const story = input(
    [entity("thread-x", "thread"), entity("scene-1", "scene"), entity("scene-2", "scene")],
    [
      { from: "thread-x", to: "scene-1", kind: "planted", note: "thread record" },
      { from: "scene-1", to: "thread-x", kind: "plants", note: "scene record" },
      { from: "scene-2", to: "thread-x", kind: "advances" },
      { from: "thread-x", to: "scene-2", kind: "payoff" },
    ],
  );
  const [overview] = getThreadsOverview(story).data;
  assert.deepEqual(overview?.planted.map((item) => [item.scene.id, item.note]), [
    ["scene-1", "thread record"],
  ]);
  assert.deepEqual(overview?.advanced.map((item) => item.scene.id), ["scene-2"]);
  assert.deepEqual(overview?.payoff.map((item) => item.scene.id), ["scene-2"]);
});

test("graph defaults omit scene nodes and location map adds deduplicated reciprocal travel edges", () => {
  const story = input(
    [
      entity("loc-a", "location", { travel: { adjacent: ["loc-b"], daysTo: { "loc-b": 3 } } }),
      entity("loc-b", "location", { travel: { adjacent: ["loc-a"], sameAs: ["loc-c"], daysTo: { "loc-c": 0 } } }),
      entity("loc-c", "location"),
      entity("char-a", "character"),
      entity("scene-a", "scene"),
    ],
    [
      { from: "loc-a", to: "loc-b", kind: "border" },
      { from: "loc-b", to: "loc-a", kind: "border" },
      { from: "scene-a", to: "char-a", kind: "appears" },
    ],
  );
  const defaultGraph = getGraphData(story).data;
  assert.ok(!defaultGraph.nodes.some((node) => node.type === "scene"));
  assert.ok(!defaultGraph.nodes.some((node) => node.type === "volume"));
  const locationMap = buildLocationMap(story).data;
  assert.deepEqual(locationMap.edges, [
    { from: "loc-a", to: "loc-b", kind: "border" },
    { from: "loc-a", to: "loc-b", kind: "adjacent", days: 3 },
    { from: "loc-b", to: "loc-c", kind: "sameAs", days: 0 },
  ]);
});
