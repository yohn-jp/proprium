import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeThreadLifecycles,
  findThreadMentionsByEmbedding,
} from "./threadLifecycle.js";
import { getThreadStatus } from "./threadStatus.js";
import type { StoryEntity, StoryGraphInput } from "./types.js";

const snapshot = {
  repository: {
    provider: "local" as const,
    repositoryId: "repo-threads",
    defaultBranch: "main",
    ownerScope: "owner-1",
    url: "file:///repo-threads",
  },
  remoteCommit: "b".repeat(40),
};

function entity(
  id: string,
  type: StoryEntity["type"],
  raw: Record<string, unknown> = {},
  extra: Partial<StoryEntity> = {},
): StoryEntity {
  return { id, type, name: id, filePath: `${type}/${id}.yaml`, raw, ...extra };
}

function manuscriptScene(id: string, order: number, body: string): StoryEntity[] {
  return [
    entity(id, "scene", { chapter: "ch-1", order, manuscript: `${id}.md` }),
    entity(`${id}-manuscript`, "manuscript", {}, {
      filePath: `${id}.md`,
      body,
    }),
  ];
}

function sourceInput(): StoryGraphInput {
  const entities = [
    entity("vol-1", "volume", { order: 1 }),
    entity("ch-1", "chapter", { volume: "vol-1", order: 1 }),
    ...manuscriptScene("sc-1", 1, "白い印を見つけた。"),
    ...manuscriptScene("sc-2", 2, "白い印の形が変わった。"),
    ...manuscriptScene("sc-3", 3, "白い印の謎が解けた。"),
    entity("thread-x", "thread", {}, { keywords: ["白い印"], status: "open" }),
  ];
  return {
    snapshot,
    entities: new Map(entities.map((item) => [item.id, item])),
    links: [
      { from: "sc-1", to: "thread-x", kind: "plants" },
      { from: "sc-2", to: "thread-x", kind: "advances" },
      { from: "thread-x", to: "sc-3", kind: "payoff" },
    ],
  };
}

test("thread lifecycle selects plant/payoff order and treats advances and mentions as recalls", async () => {
  const source = sourceInput();
  const result = await analyzeThreadLifecycles({
    ...source,
    scenes: [
      { sceneId: "sc-3", order: 3, text: "白い印の謎が解けた。" },
      { sceneId: "sc-1", order: 1, text: "白い印を見つけた。" },
      { sceneId: "sc-2", order: 2, text: "白い印の形が変わった。" },
    ],
  });
  const thread = result.data.snapshots[0]!;
  assert.strictEqual(result.snapshot, snapshot);
  assert.equal(thread.state, "resolved");
  assert.equal(thread.plantedSceneId, "sc-1");
  assert.deepEqual(thread.recalledSceneIds, ["sc-2"]);
  assert.equal(thread.resolvedSceneId, "sc-3");
  assert.deepEqual(thread.mentions.map((mention) => mention.matchedKeywords), [["白い印"], ["白い印"], ["白い印"]]);
});

test("point-in-time status keeps source labels and omits threads not planted yet", async () => {
  const source = sourceInput();
  const atOne = await getThreadStatus({ ...source, at: "sc-1" });
  const atTwo = await getThreadStatus({ ...source, at: "sc-2" });
  const atThree = await getThreadStatus({ ...source, at: "sc-3" });
  assert.strictEqual(atTwo.snapshot, snapshot);
  assert.equal(atOne.data.threads[0]?.status, "planted");
  assert.equal(atTwo.data.threads[0]?.status, "advanced");
  assert.equal(atThree.data.threads[0]?.status, "resolved");
  assert.equal(atOne.data.threads[0]?.mentions.length, 3);
  await assert.rejects(getThreadStatus({ ...source, at: "missing-scene" }), /Scene not found:/);
  await assert.rejects(getThreadStatus({ ...source, threadId: "missing-thread" }), /Thread not found:/);
});

test("lifecycle warnings honor abandonment, staleness and final-volume resolution guidance", async () => {
  const entities = [
    entity("vol-1", "volume", { order: 1 }),
    entity("ch-1", "chapter", { volume: "vol-1", order: 1 }),
    entity("sc-1", "scene", { chapter: "ch-1", order: 1 }),
    entity("sc-2", "scene", { chapter: "ch-1", order: 2 }),
    entity("sc-3", "scene", { chapter: "ch-1", order: 3 }),
    entity("sc-4", "scene", { chapter: "ch-1", order: 4 }),
    entity("thread-open", "thread", {}, { keywords: ["古い鍵"] }),
    entity("thread-abandoned", "thread", {}, { keywords: ["古い鍵"], status: "abandoned" }),
  ];
  const source: StoryGraphInput = {
    snapshot,
    entities: new Map(entities.map((item) => [item.id, item])),
    links: [{ from: "sc-1", to: "thread-open", kind: "plants" }],
  };
  const result = await analyzeThreadLifecycles({
    ...source,
    scenes: [
      { sceneId: "sc-1", order: 1, text: "古い鍵を見つけた。", volumeId: "vol-1" },
      { sceneId: "sc-2", order: 2, text: "別の話。", volumeId: "vol-1" },
      { sceneId: "sc-3", order: 3, text: "さらに別の話。", volumeId: "vol-1" },
      { sceneId: "sc-4", order: 4, text: "終章。", volumeId: "vol-1" },
    ],
    options: { staleSceneThreshold: 2 },
  });
  assert.deepEqual(result.data.warnings.map((warning) => [warning.threadId, warning.code]), [
    ["thread-open", "THREAD_STALE_UNMENTIONED"],
    ["thread-open", "THREAD_RESOLUTION_UNSET_AT_FINAL_VOLUME"],
  ]);
});

test("embedding mentions are added only for scenes without a keyword hit", async () => {
  const thread = entity("thread-x", "thread", {}, { keywords: ["白い印"] });
  const calls: string[] = [];
  const result = await findThreadMentionsByEmbedding({
    snapshot,
    threads: [thread],
    scenes: [
      { sceneId: "sc-keyword", order: 1, text: "白い印が見えた。" },
      { sceneId: "sc-embedding", order: 2, text: "別の表現。" },
    ],
    existing: new Map([
      ["thread-x", [{ sceneId: "sc-keyword", order: 1, matchedKeywords: ["白い印"], via: "keyword" as const }]],
    ]),
    embed: async (text) => {
      calls.push(text);
      return text === "白い印" ? new Float32Array([1, 0]) : new Float32Array([0.9, 0.1]);
    },
  });
  assert.deepEqual(
    result.data.get("thread-x")?.map((mention) => [mention.sceneId, mention.via]),
    [["sc-keyword", "keyword"], ["sc-embedding", "embedding"]],
  );
  assert.equal(calls.filter((call) => call === "白い印").length, 1);
  assert.ok(!calls.includes("白い印が見えた。"));
});
