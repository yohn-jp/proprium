import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foldWorldStateUpToOrder,
  getEntityStateHistory,
  getWorldStateAtScene,
  listRuleStateEvents,
  type SceneStateEvent,
} from "./worldState.js";
import {
  computeThreadForgetRisks,
  diffReaderAndCharacterKnowledge,
  extractReaderDisclosures,
  firstMentionEvidence,
  scoreForgetRisk,
  type ReaderKnowledgeEvent,
  type SceneTextForDisclosure,
} from "./readerKnowledge.js";
import type { StoryEntity, StoryGraphInput } from "./types.js";
import type { ThreadLifecycleSnapshot } from "./threadLifecycle.js";

const snapshot = {
  repository: {
    provider: "local" as const,
    repositoryId: "repo-world",
    defaultBranch: "main",
    ownerScope: "owner-1",
    url: "file:///repo-world",
  },
  remoteCommit: "d".repeat(40),
};

function entity(
  id: string,
  type: StoryEntity["type"],
  raw: Record<string, unknown> = {},
  extra: Partial<StoryEntity> = {},
): StoryEntity {
  return { id, type, name: id, filePath: `${type}/${id}.yaml`, raw, ...extra };
}

function worldInput(): StoryGraphInput {
  const entities = [
    entity("vol-1", "volume", { order: 1 }),
    entity("ch-1", "chapter", { volume: "vol-1", order: 1 }),
    entity("sc-1", "scene", {
      chapter: "ch-1",
      order: 1,
      location: "loc-plaza",
      effects: [{ action: "acquire_item", characterId: "char-alice", itemId: "item-key" }],
    }),
    entity("sc-2", "scene", {
      chapter: "ch-1",
      order: 2,
      location: "loc-castle",
      effects: [
        { action: "move_to", characterId: "char-alice", toLocationId: "loc-castle" },
        {
          action: "transfer_item",
          itemId: "item-key",
          fromCharacterId: "char-alice",
          toCharacterId: "char-bob",
        },
      ],
    }),
    entity("sc-3", "scene", {
      chapter: "ch-1",
      order: 3,
      location: "loc-market",
      effects: [{ action: "drop_item", characterId: "char-bob", itemId: "item-key" }],
      state_events: [
        {
          eventId: "event-manual-1",
          sceneId: "sc-3",
          kind: "knowledge",
          subject: "char-alice",
          object: "item-key",
          payload: { propositionId: "p-key" },
        },
      ],
    }),
    entity("loc-plaza", "location"),
    entity("loc-castle", "location"),
    entity("loc-market", "location"),
    entity("char-alice", "character"),
    entity("char-bob", "character"),
    entity("item-key", "item"),
  ];
  return {
    snapshot,
    entities: new Map(entities.map((item) => [item.id, item])),
    links: [
      { from: "sc-1", to: "loc-plaza", kind: "appears" },
      { from: "sc-1", to: "char-alice", kind: "appears" },
      { from: "sc-1", to: "char-bob", kind: "appears" },
      { from: "sc-2", to: "loc-castle", kind: "appears" },
      { from: "sc-2", to: "char-alice", kind: "appears" },
      { from: "sc-2", to: "char-bob", kind: "appears" },
      { from: "sc-3", to: "loc-market", kind: "appears" },
      { from: "sc-3", to: "char-alice", kind: "appears" },
    ],
  };
}

test("world-state projection folds location, acquaintance, item ownership and confirmed raw events", () => {
  const story = worldInput();
  const atOne = getWorldStateAtScene({ ...story, sceneId: "sc-1" });
  const atTwo = getWorldStateAtScene({ ...story, sceneId: "sc-2" });
  const atThree = getWorldStateAtScene({ ...story, sceneId: "sc-3" });
  assert.strictEqual(atTwo.snapshot, snapshot);
  assert.equal(atOne.data?.itemOwners["item-key"]?.ownerCharacterId, "char-alice");
  assert.equal(atOne.data?.locations["char-alice"]?.locationId, "loc-plaza");
  assert.equal(atOne.data?.acquaintances.length, 1);
  assert.equal(atTwo.data?.itemOwners["item-key"]?.ownerCharacterId, "char-bob");
  assert.equal(atTwo.data?.locations["char-alice"]?.locationId, "loc-castle");
  assert.equal(atTwo.data?.acquaintances.length, 1);
  assert.equal(atThree.data?.itemOwners["item-key"]?.ownerCharacterId, null);
  assert.ok(atThree.data?.acquaintances.some((pair) => pair.a === "char-alice" && pair.b === "char-bob"));
  assert.equal(getWorldStateAtScene({ ...story, sceneId: "not-a-scene" }).data, null);
});

test("state-event ordering and draft status prevent unconfirmed changes from becoming objective", () => {
  const draft: SceneStateEvent = {
    sceneId: "sc-2",
    order: 2,
    kind: "location",
    subject: "char-alice",
    object: "loc-draft",
    payload: {},
    source: "llm-draft",
    status: "proposed",
  };
  const folded = foldWorldStateUpToOrder({
    snapshot,
    sceneId: "sc-2",
    order: 2,
    events: [
      {
        sceneId: "sc-1",
        order: 1,
        kind: "location",
        subject: "char-alice",
        object: "loc-plaza",
        payload: {},
        source: "rule",
      },
      draft,
      {
        sceneId: "sc-2",
        order: 2,
        kind: "location",
        subject: "char-alice",
        object: "loc-castle",
        payload: { via: "move_to" },
        source: "rule",
      },
    ],
  });
  assert.equal(folded.data.locations["char-alice"]?.locationId, "loc-castle");
  const ruleEvents = listRuleStateEvents(worldInput()).data;
  assert.ok(ruleEvents.some((event) => event.eventId === "event-manual-1" && event.source === "manual"));
  const history = getEntityStateHistory({ ...worldInput(), entityId: "item-key" });
  assert.ok(history.data?.entries.some((entry) => entry.kind === "ownership"));
});

test("reader disclosure uses first story-order mention, longest registered name, and summary changes", () => {
  const entities = [
    entity("char-alice", "character", {}, { name: "アリス" }),
    entity("loc-region", "location", {}, { name: "銀の鍵" }),
    entity("item-key", "item", {}, { name: "鍵" }),
    entity("item-crown", "item", {}, { name: "王冠" }),
  ];
  const scenes: SceneTextForDisclosure[] = [
    {
      sceneId: "sc-2",
      order: 2,
      text: "王冠の場所は分からない。",
      characterIds: ["char-alice"],
    },
    {
      sceneId: "sc-1",
      order: 1,
      text: "アリスは銀の鍵を見つけた。",
      characterIds: ["char-alice"],
      stateChanges: ["王冠を隠した。"],
    },
  ];
  const story: StoryGraphInput = {
    snapshot,
    entities: new Map(entities.map((item) => [item.id, item])),
    links: [],
  };
  const result = extractReaderDisclosures({ ...story, scenes });
  assert.strictEqual(result.snapshot, snapshot);
  assert.deepEqual(
    result.data.map((event) => [event.sceneId, event.entityId, event.disclosureKind, event.evidence]),
    [
      ["sc-1", "char-alice", "mention_first", "アリス"],
      ["sc-1", "loc-region", "mention_first", "銀の鍵"],
      ["sc-1", "item-crown", "summary_state_change", "王冠を隠した。"],
    ],
  );
  assert.equal(
    firstMentionEvidence({ snapshot, entity: entities[1]!, text: "銀の鍵と銀の鍵" }).data,
    "銀の鍵",
  );
});

test("reader/character knowledge diff reports explanation gaps and dramatic irony", () => {
  const entities = [
    entity("char-alice", "character", {}, { name: "アリス" }),
    entity("char-bob", "character", {}, { name: "ボブ" }),
    entity("item-crown", "item", {}, { name: "王冠" }),
    entity("item-secret", "item", {}, { name: "黒い手紙" }),
  ];
  const story: StoryGraphInput = {
    snapshot,
    entities: new Map(entities.map((item) => [item.id, item])),
    links: [],
  };
  const scenes: SceneTextForDisclosure[] = [
    { sceneId: "sc-1", order: 1, text: "アリスは扉を開けた。", characterIds: ["char-alice"] },
    {
      sceneId: "sc-2",
      order: 2,
      text: "ボブは周囲を見回した。",
      characterIds: ["char-bob"],
      stateChanges: ["王冠の存在が明かされた。"],
    },
  ];
  const disclosures: ReaderKnowledgeEvent[] = [
    {
      sceneId: "sc-2",
      order: 2,
      entityId: "item-crown",
      disclosureKind: "summary_state_change",
      evidence: "王冠の存在が明かされた。",
      source: "scene_summary",
    },
  ];
  const knowledgeEvents: SceneStateEvent[] = [
    {
      sceneId: "sc-1",
      order: 1,
      kind: "knowledge",
      subject: "char-alice",
      object: "item-secret",
      payload: {},
      source: "manual",
    },
  ];
  const result = diffReaderAndCharacterKnowledge({
    ...story,
    disclosures,
    knowledgeEvents,
    scenes,
    upToOrder: 2,
  });
  assert.deepEqual(result.data, [
    {
      kind: "character_knows_reader_does_not",
      characterId: "char-alice",
      entityId: "item-secret",
      characterKnewAtSceneId: "sc-1",
      readerDisclosedAtSceneId: null,
    },
    {
      kind: "reader_knows_character_does_not",
      characterId: "char-alice",
      entityId: "item-crown",
      characterKnewAtSceneId: null,
      readerDisclosedAtSceneId: "sc-2",
    },
    {
      kind: "reader_knows_character_does_not",
      characterId: "char-bob",
      entityId: "item-crown",
      characterKnewAtSceneId: null,
      readerDisclosedAtSceneId: "sc-2",
    },
  ]);
});

test("thread forget risk is source-scored from between-scene disclosures", () => {
  const lifecycle: ThreadLifecycleSnapshot[] = [
    {
      threadId: "thread-a",
      state: "resolved",
      mentions: [],
      plantedSceneId: "sc-1",
      recalledSceneIds: [],
      resolvedSceneId: "sc-4",
      scenesSinceLastMention: 0,
    },
    {
      threadId: "thread-b",
      state: "planted",
      mentions: [],
      plantedSceneId: "missing",
      recalledSceneIds: [],
      scenesSinceLastMention: 0,
    },
  ];
  assert.equal(scoreForgetRisk(0, 5), 0);
  const result = computeThreadForgetRisks({
    snapshot,
    snapshots: lifecycle,
    disclosures: [
      { sceneId: "sc-2", order: 2, entityId: "item-a", disclosureKind: "mention_first", evidence: "a", source: "mention" },
      { sceneId: "sc-3", order: 3, entityId: "item-b", disclosureKind: "mention_first", evidence: "b", source: "mention" },
      { sceneId: "sc-4", order: 4, entityId: "item-c", disclosureKind: "mention_first", evidence: "c", source: "mention" },
    ],
    orderBySceneId: new Map([["sc-1", 1], ["sc-2", 2], ["sc-3", 3], ["sc-4", 4]]),
  });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0]?.sceneDistance, 3);
  assert.equal(result.data[0]?.disclosureCountBetween, 2);
  assert.equal(result.data[0]?.forgetRisk, 0.183);
});
