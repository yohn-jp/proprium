import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import YAML from "yaml";
import type {
  ActionResult,
  ChangeOperation,
  ChangeProposal,
  ModuleActionContext,
  ModuleContext,
  RepositoryIdentity,
  SnapshotId,
  SnapshotReader,
} from "@scriptorium/contracts";
import { createStoryActions } from "./actions.js";

const SERIES_PATH = "meta/scriptorium/modules/story/v1/series.json";

function revision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function yaml(value: unknown): string { return YAML.stringify(value); }

function repository(repositoryId: string): RepositoryIdentity {
  return { provider: "local", repositoryId, defaultBranch: "main", ownerScope: "owner:test", url: `file:///repositories/${repositoryId}` };
}

function fixtureFiles(extra: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries({
    "bible/characters/char-uma/profile.yaml": yaml({
      id: "char-uma", name: "Uma", type: "character", aliases: ["U"], tags: ["lead"],
      notes: { daily: ["Keep the promise"] }, relations: [],
    }),
    "bible/characters/char-uma/voice.yaml": yaml({ cadence: "short" }),
    "bible/locations/loc-cafe.yaml": yaml({ id: "loc-cafe", name: "Cafe", type: "location" }),
    "plot/volumes/vol-main/volume.yaml": yaml({ id: "vol-main", title: "Main", type: "volume", order: 1 }),
    "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml": yaml({ id: "ch-main-1", title: "Arrival", type: "chapter", volume: "vol-main", order: 1 }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": yaml({ id: "sc-1", title: "Door", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 1, location: "loc-cafe", appears: ["char-uma"], manuscript: "manuscript/vol-main/ch-main-1/sc-1.md" }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml": yaml({ id: "sc-2", title: "Table", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 2, manuscript: "manuscript/vol-main/ch-main-1/sc-2.md" }),
    "manuscript/vol-main/ch-main-1/sc-1.md": "---\ntitle: Door\n---\nUma enters the cafe.\n",
    "manuscript/vol-main/ch-main-1/sc-2.md": "---\ntitle: Table\n---\nUma sits down.\n",
    ...extra,
  }));
}

function makeReader(files: Map<string, string>, repositoryId = "repo-work"): SnapshotReader {
  const snapshot: SnapshotId = { repository: repository(repositoryId), remoteCommit: "a".repeat(40) };
  return {
    snapshot,
    async read(path) {
      const content = files.get(path);
      return content === undefined ? null : { content, revision: revision(content) };
    },
    async list(prefix) { return [...files.keys()].filter((path) => path === prefix || path.startsWith(`${prefix}/`)).sort(); },
  };
}

function makeModuleContext(): ModuleContext {
  return {
    cacheDirectory: "/unused/story-cache",
    signal: new AbortController().signal,
    async acquireCapability() { throw new Error("capability unavailable"); },
    async createWorkerService() { throw new Error("Story has no worker"); },
  };
}

function makeActionContext(reader: SnapshotReader, options: {
  proposals?: Array<{ id: string; operations: ChangeOperation[] }>;
  linkedReader?: (repositoryId: string) => Promise<SnapshotReader>;
  projectId?: string;
} = {}): ModuleActionContext {
  return {
    projectId: options.projectId ?? "transient-registry-project-id",
    reader,
    async invoke() { return { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } }; },
    async listActions() { return []; },
    async linkedReader(repositoryId) {
      if (!options.linkedReader) throw new Error(`Unexpected linked repository: ${repositoryId}`);
      return options.linkedReader(repositoryId);
    },
    signal: new AbortController().signal,
    async propose(operations, evidence, proposalId) {
      const proposal: ChangeProposal = { id: proposalId ?? `proposal-${(options.proposals?.length ?? 0) + 1}`, snapshot: reader.snapshot, operations, source: "module", ...(evidence ? { evidence } : {}) };
      options.proposals?.push(proposal);
      return proposal;
    },
    async runJob() { throw new Error("Story has no worker jobs"); },
  };
}

function actionById(id: string) {
  const action = createStoryActions(makeModuleContext()).find((candidate) => candidate.id === id);
  assert.ok(action, `missing Story action ${id}`);
  return action;
}

async function invoke<T>(id: string, input: unknown, context: ModuleActionContext): Promise<Extract<ActionResult<T>, { ok: true }>> {
  const result = await actionById(id).invoke(input, context);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result as Extract<ActionResult<T>, { ok: true }>;
}

test("entity reads expose source revision and preserve nested notes and character voice", async () => {
  const reader = makeReader(fixtureFiles());
  const context = makeActionContext(reader);
  const entities = await invoke<Array<{ id: string; revision: string; raw: Record<string, unknown> }>>("story.entities.list", {}, context);
  const character = entities.data.find((entity) => entity.id === "char-uma");
  assert.ok(character);
  assert.equal(character.revision.length, 73);
  assert.deepEqual(character.raw.notes, { daily: ["Keep the promise"] });
  assert.deepEqual(character.raw.voice, { cadence: "short" });
  assert.equal((await invoke<{ revision: string }>("story.entities.collection-revision", {}, context)).data.revision.length, 73);
  assert.equal((await invoke<{ revision: string } | null>("story.entities.get", { id: "char-uma" }, context)).data?.revision, character.revision);
});

test("entity updates validate source revisions and return a reviewable Core proposal", async () => {
  const files = fixtureFiles();
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const entity = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const updated = await invoke<{ raw: Record<string, unknown> }>("story.entities.update", {
    id: "char-uma", patch: { name: "Uma Kato" }, base_revision: entity.revision, operation_id: "update-uma-1",
  }, context);
  assert.equal(updated.data.raw.name, "Uma Kato");
  assert.equal(updated.proposals?.[0]?.id, "proposal-1");
  assert.equal(updated.proposals?.[0]?.operations[0]?.id, "story-update-uma-1");
  assert.equal(updated.proposals?.[0]?.operations[0]?.writes[0]?.path, "bible/characters/char-uma/profile.yaml");
  assert.equal(YAML.parse(files.get("bible/characters/char-uma/profile.yaml")!).name, "Uma", "proposing does not write the snapshot");

  const stale = await actionById("story.entities.update").invoke({
    id: "char-uma", patch: { name: "Stale" }, base_revision: "stale-revision", operation_id: "update-uma-stale",
  }, context);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "operation_precondition_conflict");
  assert.equal(proposals.length, 1);
});

test("scene creation inserts by position in one proposal and includes every changed file precondition", async () => {
  const files = fixtureFiles();
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const tree = (await invoke<{ tree: VolumeTree; revision: string }>("story.volumes.tree", {}, context)).data;
  const result = await invoke<{ id: string; filePath: string }>("story.entities.create", {
    type: "scene", slug: "new-entry", title: "New entry", chapter: "ch-main-1", volume: "vol-main",
    position: 2, characters: ["char-uma"], location: "loc-cafe", base_revision: tree.revision, operation_id: "insert-scene-1",
  }, context);
  assert.equal(result.data.id, "sc-new-entry");
  assert.equal(result.proposals?.length, 1);
  const operation = result.proposals![0]!.operations[0]!;
  assert.equal(operation.id, "story-insert-scene-1");
  assert.deepEqual(operation.writes.map((write) => write.path).sort(), [
    "manuscript/vol-main/ch-main-1/sc-new-entry.md",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-new-entry.yaml",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml",
  ].sort());
  const newScene = YAML.parse(operation.writes.find((write) => write.path.endsWith("/sc-new-entry.yaml"))!.content!);
  const shiftedSibling = YAML.parse(operation.writes.find((write) => write.path.endsWith("sc-2.yaml"))!.content!);
  assert.equal(newScene.order, 2);
  assert.deepEqual(newScene.relations, [{ target: "char-uma", kind: "appears" }]);
  assert.equal(shiftedSibling.order, 3);
  assert.ok(operation.reads.some((item) => item.path.endsWith("sc-2.yaml") && item.revision === revision(files.get("plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml")!)));
  assert.equal(proposals.length, 1);
});

test("series bindings use stable repository identity and preserve unknown settings", async () => {
  const settings = {
    version: 1,
    series: [{ id: "series-main", name: "Main", ownerId: "owner:test", bibleRepositoryId: "repo-bible", memberRepositoryIds: ["repo-work"], createdAt: "2026-01-01T00:00:00.000Z", futureSeriesField: "keep" }],
    bindings: [{ repositoryId: "repo-work", seriesId: "series-main", futureBindingField: 12 }],
    futureRootField: { keep: true },
  };
  const reader = makeReader(fixtureFiles({ [SERIES_PATH]: JSON.stringify(settings) + "\n" }));
  const linkedReader = makeReader(fixtureFiles(), "repo-bible");
  const linkedIds: string[] = [];
  const context = makeActionContext(reader, { linkedReader: async (id) => { linkedIds.push(id); return linkedReader; } });
  const binding = await invoke<{ bibleRepositoryId: string; requiresAuthorReview: boolean }>("story.series.binding.get", {}, context);
  assert.equal(binding.data.bibleRepositoryId, "repo-bible");
  assert.equal(binding.data.requiresAuthorReview, false);
  const overlay = await invoke<{ workSnapshot: SnapshotId; bibleSnapshot: SnapshotId }>("story.series.overlay", {}, context);
  assert.equal(overlay.data.workSnapshot.repository.repositoryId, "repo-work");
  assert.equal(overlay.data.bibleSnapshot.repository.repositoryId, "repo-bible");
  assert.deepEqual(linkedIds, ["repo-bible"]);

  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const settingsContext = makeActionContext(reader, { proposals, projectId: "different-transient-id" });
  const fileRevision = revision(JSON.stringify(settings) + "\n");
  const updated = await invoke("story.series.update", { id: "series-main", patch: { name: "Renamed" }, base_revision: fileRevision, operation_id: "series-update-1" }, settingsContext);
  const written = JSON.parse(updated.proposals![0]!.operations[0]!.writes[0]!.content!);
  assert.deepEqual(written.futureRootField, { keep: true });
  assert.equal(written.series[0].futureSeriesField, "keep");
  assert.equal(written.bindings[0].futureBindingField, 12);
  assert.equal(written.bindings[0].repositoryId, "repo-work");
  assert.equal("projectId" in written.bindings[0], false);
});

test("suggested tags do not allocate NLP at module load and report optional capability absence", async () => {
  let capabilityRequests = 0;
  const moduleContext: ModuleContext = {
    ...makeModuleContext(),
    async acquireCapability() { capabilityRequests++; throw new Error("not enabled"); },
  };
  const actions = createStoryActions(moduleContext);
  assert.equal(capabilityRequests, 0);
  const result = await actions.find((item) => item.id === "story.entities.suggested-tags")!.invoke({ id: "char-uma" }, makeActionContext(makeReader(fixtureFiles())));
  assert.equal(capabilityRequests, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "feature_unavailable");
});

function sourceHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

test("NarrativeChangeSet preserves all nine source operation kinds in one identity-bound Core proposal", async () => {
  const files = fixtureFiles({
    "plot/threads/thread-main.yaml": yaml({ id: "thread-main", name: "A promise", type: "thread", relations: [] }),
  });
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  context.invoke = async (actionId) => actionId === "core.proposals.get"
    ? { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } }
    : { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } };
  const entities = (await invoke<Array<{ id: string; revision: string; filePath: string }>>("story.entities.list", {}, context)).data;
  const rev = (id: string) => entities.find((entity) => entity.id === id)!.revision;
  const body = "Uma enters the cafe.";
  const changeSet = {
    schemaVersion: 1,
    id: "ncs-story-001",
    projectId: context.projectId,
    goal: "Preserve the source change set",
    status: "proposed",
    assessment: { confidence: 0.9, risk: "medium" },
    operations: [
      { id: "create-location", kind: "entity.create", precondition: { kind: "absent" }, target: { entityId: "loc-new", entityType: "location" }, values: { id: "loc-new", type: "location", name: "Garden" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "low" } },
      { id: "create-scene", kind: "scene.create", precondition: { kind: "absent" }, target: { sceneId: "sc-new" }, values: { id: "sc-new", type: "scene", title: "Garden", volume: "vol-main", chapter: "ch-main-1", order: 3 }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "medium" } },
      { id: "insert-scene", kind: "scene.insert", precondition: { kind: "revision", value: rev("ch-main-1") }, target: { sceneId: "sc-new", chapterId: "ch-main-1" }, position: 3, expectedSiblings: [{ id: "sc-1", revision: rev("sc-1") }, { id: "sc-2", revision: rev("sc-2") }], evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "medium" } },
      { id: "update-entity", kind: "entity.update", precondition: { kind: "revision", value: rev("char-uma") }, target: { entityId: "char-uma" }, changes: { name: "Uma Kato" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "low" } },
      { id: "update-scene", kind: "scene.update", precondition: { kind: "revision", value: rev("sc-2") }, target: { sceneId: "sc-2" }, changes: { title: "The table" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "medium" } },
      { id: "append-state", kind: "state.append-event", precondition: { kind: "revision", value: rev("sc-1") }, target: { sceneId: "sc-1", eventId: "event-arrival" }, event: { sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "manual", eventId: "event-arrival", evidence: [{ sceneId: "sc-1", excerpt: "enters the cafe" }], confidence: 0.9, createdAt: "2026-01-01T00:00:00.000Z", status: "confirmed" }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "medium" } },
      { id: "link-thread", kind: "thread.link-scene", precondition: { kind: "revision", value: rev("thread-main") }, target: { threadId: "thread-main", sceneId: "sc-1" }, relation: "planted", note: "Promise introduced", evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "low" } },
      { id: "link-reference", kind: "reference.link", precondition: { kind: "revision", value: rev("loc-cafe") }, target: { from: "loc-cafe", to: "loc-new", kind: "related" }, note: "Nearby places", evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "low" } },
      { id: "replace-manuscript", kind: "manuscript.replace-range", precondition: { kind: "content-hash", value: sourceHash(body) }, target: { manuscriptId: "ms-vol-main-ch-main-1-sc-1", sceneId: "sc-1" }, range: { start: 0, end: 3 }, replacement: "She", evidenceIds: ["evidence-one"], assessment: { confidence: 0.8, risk: "medium" } },
    ],
    evidence: [{ id: "evidence-one", sourceKind: "entity", sourceId: "char-uma", revision: rev("char-uma") }],
    diagnostics: { before: null, after: null },
  };
  const result = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  if (!result.ok) return;
  assert.equal(result.proposals?.length, 1);
  assert.equal(result.proposals?.[0]?.id, changeSet.id);
  assert.equal(result.proposals?.[0]?.operations.length, 9);
  const data = result.data as {
    operationMap: Record<string, string>;
    dependencies: Record<string, string[]>;
    resultIds: Record<string, string>;
    resultPaths: Record<string, string[]>;
    resultRevisions: Record<string, string>;
    affectedEntities: Record<string, Array<{ id: string; revision: string }>>;
    sourceFingerprint: string;
  };
  assert.equal(Object.keys(data.operationMap).length, 9);
  assert.deepEqual(data.dependencies["insert-scene"], ["create-scene"]);
  assert.equal(data.resultIds["link-reference"], JSON.stringify(["loc-cafe", "loc-new", "related"]));
  const coreProposal = result.proposals![0]!;
  const sourceEvidence = coreProposal.evidence!.find((item) => item.kind === "source.narrative-change-set.v1")!;
  const details = sourceEvidence.details as { sourceChangeSet: unknown; sourceFingerprint: string; operationMap: Record<string, string> };
  assert.deepEqual(details.sourceChangeSet, changeSet);
  assert.equal(details.sourceFingerprint.length, 64);
  assert.deepEqual(details.operationMap, data.operationMap);
  const persisted = details as unknown as Record<string, unknown>;
  assert.equal(persisted.sourceFingerprint, data.sourceFingerprint);
  assert.deepEqual(persisted.resultPaths, data.resultPaths);
  assert.deepEqual(persisted.resultRevisions, data.resultRevisions);
  assert.deepEqual(persisted.affectedEntities, data.affectedEntities);
  assert.ok(data.resultPaths["create-scene"]?.includes("plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-new.yaml"));
  assert.ok(data.resultPaths["create-scene"]?.includes("manuscript/vol-main/ch-main-1/sc-new.md"));
  assert.equal(data.resultRevisions["create-scene"]?.startsWith('"sha256-'), true);
  assert.deepEqual(data.affectedEntities["insert-scene"]?.map((item) => item.id), ["sc-1", "sc-2", "sc-new"]);
  assert.deepEqual(coreProposal.operations.map((operation) => operation.id), Object.values(data.operationMap));
  assert.equal(coreProposal.operations[0]?.writes[0]?.path, "bible/locations/loc-new.yaml");
  assert.equal(files.get("bible/locations/loc-new.yaml"), undefined, "proposal conversion does not write to the snapshot");
  assert.equal(proposals.length, 1);
});

test("co-occurrence action returns source Jaccard/PMI and accepts scene scope", async () => {
  const files = fixtureFiles({
    "bible/characters/char-two/profile.yaml": yaml({ id: "char-two", name: "Two", type: "character" }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": yaml({ id: "sc-1", title: "Door", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 1, location: "loc-cafe", appears: ["char-uma", "char-two"], manuscript: "manuscript/vol-main/ch-main-1/sc-1.md" }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-2.yaml": yaml({ id: "sc-2", title: "Table", type: "scene", volume: "vol-main", chapter: "ch-main-1", order: 2, appears: ["char-uma", "char-two"], manuscript: "manuscript/vol-main/ch-main-1/sc-2.md" }),
  });
  const context = makeActionContext(makeReader(files));
  const all = await invoke<{ edges: Array<{ a: string; b: string; sceneCount: number; jaccard: number; pmi: number }>; gaps: unknown[] }>("story.cooccurrence", {}, context);
  assert.deepEqual(all.data.edges, [{ a: "char-two", b: "char-uma", sceneCount: 2, jaccard: 1, pmi: 0 }]);
  const scoped = await invoke<typeof all.data>("story.cooccurrence", { sceneIds: ["sc-1"] }, context);
  assert.equal(scoped.data.edges[0]?.sceneCount, 1);
  assert.equal(scoped.data.edges[0]?.jaccard, 1);
  const invalid = await actionById("story.cooccurrence").invoke({ sceneIds: "sc-1" }, context);
  assert.equal(invalid.ok, false);
});

test("NarrativeChangeSet retries return the stored proposal and reject changed source meaning", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  let stored: ChangeProposal | undefined;
  context.invoke = async (actionId) => {
    if (actionId !== "core.proposals.get") return { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } };
    return stored
      ? { ok: true, snapshot: reader.snapshot, data: { proposal: { proposal: stored } } }
      : { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } };
  };
  const current = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const changeSet = {
    schemaVersion: 1, id: "ncs-retry-1", projectId: context.projectId, goal: "Update a name", status: "proposed",
    assessment: { confidence: 0.8, risk: "low" },
    operations: [{ id: "update-uma", kind: "entity.update", precondition: { kind: "revision", value: current.revision }, target: { entityId: "char-uma" }, changes: { name: "Uma Retry" }, evidenceIds: [], assessment: { confidence: 0.8, risk: "low" } }],
    evidence: [], diagnostics: { before: null, after: null },
  };
  const first = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  stored = first.proposals![0];
  const retry = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(retry.ok, true);
  if (retry.ok) { assert.equal(retry.proposals?.[0]?.id, changeSet.id); assert.equal((retry.data as { replayed: boolean }).replayed, true); }
  const changed = await actionById("story.changes.propose").invoke({ ...changeSet, goal: "Changed meaning under same ID" }, context);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, "change_set_identity_conflict");
  assert.equal(proposals.length, 1, "an exact retry does not reset Core approvals by proposing again");
});

test("NarrativeChangeSet preserves unrestricted source IDs and maps unsafe IDs to Core-safe proposal IDs", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: ChangeProposal[] = [];
  const context = makeActionContext(reader, { proposals });
  let stored: ChangeProposal | undefined;
  context.invoke = async (actionId, input) => {
    assert.equal(actionId, "core.proposals.get");
    assert.equal((input as { proposalId: string }).proposalId, stored?.id ?? (input as { proposalId: string }).proposalId);
    return stored
      ? { ok: true, snapshot: reader.snapshot, data: { proposal: { proposal: stored } } }
      : { ok: false, snapshot: reader.snapshot, error: { code: "proposal_not_found", message: "missing", retryable: false } };
  };
  const current = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const sourceId = `legacy source / ${"作家".repeat(30)}`;
  const changeSet = {
    schemaVersion: 1, id: sourceId, projectId: context.projectId, goal: "Update a name", status: "proposed",
    assessment: { confidence: 0.8, risk: "low" },
    operations: [{ id: "update-uma-legacy", kind: "entity.update", precondition: { kind: "revision", value: current.revision }, target: { entityId: "char-uma" }, changes: { name: "Uma Legacy" }, evidenceIds: [], assessment: { confidence: 0.8, risk: "low" } }],
    evidence: [], diagnostics: { before: null, after: null },
  };
  const first = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(first.ok, true, first.ok ? undefined : first.error.message);
  if (!first.ok) return;
  const data = first.data as { changeSetId: string; proposalId: string; coreProposalId: string; replayed: boolean };
  assert.equal(data.changeSetId, sourceId);
  assert.equal(data.coreProposalId, data.proposalId);
  assert.match(data.coreProposalId, /^story-cs-[a-f0-9]{64}$/);
  assert.ok(data.coreProposalId.length <= 128);
  assert.equal(first.proposals?.[0]?.id, data.coreProposalId);
  stored = first.proposals?.[0];
  assert.ok(stored);
  const sourceEvidence = stored.evidence?.find((item) => item.kind === "source.narrative-change-set.v1");
  assert.equal((sourceEvidence?.details as { coreProposalId?: string }).coreProposalId, data.coreProposalId);
  assert.equal(((sourceEvidence?.details as { sourceChangeSet?: { id?: string } }).sourceChangeSet)?.id, sourceId);

  const replay = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(replay.ok, true, replay.ok ? undefined : replay.error.message);
  if (replay.ok) {
    assert.equal((replay.data as { replayed: boolean }).replayed, true);
    assert.equal((replay.data as { changeSetId: string }).changeSetId, sourceId);
    assert.equal((replay.data as { coreProposalId: string }).coreProposalId, data.coreProposalId);
  }
  const changed = await actionById("story.changes.propose").invoke({ ...changeSet, goal: "A different goal" }, context);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, "change_set_identity_conflict");
  assert.equal(proposals.length, 1);
});
