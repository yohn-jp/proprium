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
  ProposalStatus,
  RepositoryIdentity,
  SnapshotId,
  SnapshotReader,
} from "@scriptorium/contracts";
import { createStoryActions } from "./actions.js";

const SERIES_PATH = "meta/scriptorium/modules/story/v1/series.json";
const STATE_PROPOSALS_PATH = "meta/scriptorium/modules/story/state-proposals.jsonl";
const ZUKAN_SUGGESTIONS_PATH = "meta/scriptorium/modules/story/zukan-suggestions.jsonl";

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

test("entity relationship proposals pin referenced entity revisions and participate in thread lifecycle reads", async () => {
  const files = fixtureFiles({
    "plot/threads/thread-promise.yaml": yaml({ id: "thread-promise", name: "Promise", type: "thread", keywords: ["promise"], relations: [] }),
  });
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const thread = (await invoke<{ revision: string }>("story.entities.get", { id: "thread-promise" }, context)).data;
  const planted = await invoke("story.entities.update", {
    id: "thread-promise", patch: { relations: [{ target: "sc-1", kind: "planted" }] },
    base_revision: thread.revision, operation_id: "plant-promise",
  }, context);
  const plantOperation = planted.proposals![0]!.operations[0]!;
  const scenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml";
  assert.ok(plantOperation.reads.some((item) => item.path === scenePath && item.revision === revision(files.get(scenePath)!)));
  files.set(plantOperation.writes[0]!.path, plantOperation.writes[0]!.content!);

  const scene = (await invoke<{ revision: string }>("story.entities.get", { id: "sc-2" }, makeActionContext(makeReader(files)))).data;
  const advanced = await invoke("story.entities.update", {
    id: "sc-2", patch: { relations: [{ target: "thread-promise", kind: "advances" }] },
    base_revision: scene.revision, operation_id: "advance-promise",
  }, makeActionContext(makeReader(files), { proposals }));
  const advanceOperation = advanced.proposals![0]!.operations[0]!;
  const threadPath = "plot/threads/thread-promise.yaml";
  assert.ok(advanceOperation.reads.some((item) => item.path === threadPath && item.revision === revision(files.get(threadPath)!)));
  files.set(advanceOperation.writes[0]!.path, advanceOperation.writes[0]!.content!);

  const lifecycle = await invoke<{ snapshots: Array<{ threadId: string; state: string; plantedSceneId?: string; recalledSceneIds: string[] }> }>(
    "story.threads.lifecycle", { threadId: "thread-promise" }, makeActionContext(makeReader(files)),
  );
  assert.equal(lifecycle.data.snapshots[0]?.state, "recalled");
  assert.equal(lifecycle.data.snapshots[0]?.plantedSceneId, "sc-1");
  assert.deepEqual(lifecycle.data.snapshots[0]?.recalledSceneIds, ["sc-2"]);

  const unsupported = await actionById("story.entities.update").invoke({
    id: "thread-promise", patch: { relations: [{ target: "sc-1", kind: "advances" }] }, operation_id: "bad-thread-direction",
  }, makeActionContext(makeReader(files), { proposals }));
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, "invalid_input");
  const unsupportedScene = await actionById("story.entities.update").invoke({
    id: "sc-2", patch: { relations: [{ target: "thread-promise", kind: "planted" }] }, operation_id: "bad-scene-direction",
  }, makeActionContext(makeReader(files), { proposals }));
  assert.equal(unsupportedScene.ok, false);
  if (!unsupportedScene.ok) assert.equal(unsupportedScene.error.code, "invalid_input");
});

function zukanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "suggestion-1", entity_id: "char-uma", block_path: "lead.0", proposed_text: "A newly approved fact.",
    evidence_json: JSON.stringify([{ quote: "verified in the story", sceneId: "sc-1" }]), status: "pending",
    source: "manuscript", kind: "fact", source_session_id: null, source_turn_range_json: null,
    confidence: "high", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z",
    future_field: { preserve: true }, migrationSource: { databaseSources: [{ databaseId: "project-arcadia", table: "zukan_suggestions" }] },
    ...overrides,
  };
}

test("Zukan suggestions list by status and approve/reject as snapshot-bound proposals", async () => {
  const profilePath = "bible/characters/char-uma/profile.yaml";
  const original = YAML.parse(fixtureFiles().get(profilePath)!);
  original.notes = {
    lead: [{ type: "paragraph", text: "Existing lead." }],
    sections: [{ heading: "History", body: [{ type: "paragraph", text: "Earlier detail." }], children: [{ heading: "Family", body: [], children: [] }] }],
  };
  const suggestionsPath = ZUKAN_SUGGESTIONS_PATH;
  const rows = [
    zukanRow(),
    zukanRow({ id: "suggestion-2", status: "rejected" }),
    zukanRow({ id: "suggestion-same-block", proposed_text: "Another note from this block." }),
  ];
  const files = fixtureFiles({
    [profilePath]: yaml(original),
    [suggestionsPath]: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const listed = await invoke<{ pendingCount: number; suggestions: Array<ZukanSuggestion> }>("story.zukan-suggestions.list", {}, context);
  assert.equal(listed.data.pendingCount, 2);
  assert.deepEqual(listed.data.suggestions.map((item) => item.id), ["suggestion-1", "suggestion-same-block"]);
  assert.equal(listed.data.suggestions[0]?.entityRevision?.length, 73);

  const approved = await invoke<{ suggestion: ZukanSuggestion; entityRevision: string }>("story.zukan-suggestions.approve", {
    id: "suggestion-1", entityRevision: listed.data.suggestions[0]!.entityRevision, operation_id: "approve-suggestion-1",
  }, context);
  const approval = approved.proposals![0]!.operations[0]!;
  assert.deepEqual(approval.writes.map((write) => write.path).sort(), [profilePath, suggestionsPath].sort());
  assert.ok(approval.reads.some((item) => item.path === profilePath && item.revision === revision(files.get(profilePath)!)));
  assert.ok(approval.reads.some((item) => item.path === suggestionsPath && item.revision === revision(files.get(suggestionsPath)!)));
  const updatedEntity = YAML.parse(approval.writes.find((write) => write.path === profilePath)!.content!);
  assert.equal(updatedEntity.notes.lead[0].text, "Existing lead.\nA newly approved fact.");
  assert.equal(updatedEntity.notes.sections[0].body[0].text, "Earlier detail.");
  assert.equal(updatedEntity.notes.sections[0].children[0].heading, "Family");
  const approvedRow = JSON.parse(approval.writes.find((write) => write.path === suggestionsPath)!.content!.split("\n")[0]!) as Record<string, unknown>;
  assert.equal(approvedRow.status, "approved");
  assert.equal(approvedRow.updated_at, "2026-01-02T00:00:00.001Z");
  assert.deepEqual(approvedRow.future_field, { preserve: true });
  assert.deepEqual(approvedRow.migrationSource, zukanRow().migrationSource);
  const approvedRows = approval.writes.find((write) => write.path === suggestionsPath)!.content!.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(approvedRows.find((row) => row.id === "suggestion-same-block")?.status, "stale", "approving an edit invalidates other pending suggestions based on the same changed note block");
  assert.equal(YAML.parse(files.get(profilePath)!).notes.lead[0].text, "Existing lead.", "proposing does not mutate the selected snapshot");

  const rejected = await invoke<{ suggestion: ZukanSuggestion }>("story.zukan-suggestions.reject", {
    id: "suggestion-1", operation_id: "reject-suggestion-1",
  }, context);
  const rejection = rejected.proposals![0]!.operations[0]!;
  assert.deepEqual(rejection.writes.map((write) => write.path), [suggestionsPath]);
  const rejectedRow = JSON.parse(rejection.writes[0]!.content!.split("\n")[0]!) as Record<string, unknown>;
  assert.equal(rejectedRow.status, "rejected");
});

test("Zukan creation validates manuscript provenance and proposes a stable pending JSONL row", async () => {
  const oldRow = zukanRow({ sourceHash: "a".repeat(64) });
  const files = fixtureFiles({
    [ZUKAN_SUGGESTIONS_PATH]: `${JSON.stringify(oldRow)}\n`,
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[]; evidence?: ChangeProposal["evidence"] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const input = {
    entityId: "char-uma",
    blockPath: "lead.0",
    proposedText: "Uma enters the cafe.",
    evidence: [{ quote: "Uma enters the cafe.", sceneId: "sc-1" }],
    source: "manuscript",
    kind: null,
    confidence: "high",
    operation_id: "zukan-create-uma",
  };
  const created = await invoke<{ suggestion: Record<string, unknown>; created: boolean; staledPendingCount: number }>(
    "story.zukan-suggestions.create", input, context,
  );
  assert.equal(created.data.created, true);
  assert.equal(created.data.staledPendingCount, 1, "a pending row with changed source freshness is staled atomically");
  const suggestion = created.data.suggestion;
  assert.match(String(suggestion.id), /^zukan-[a-f0-9]{64}$/u);
  assert.equal(suggestion.status, "pending", "creation only proposes a pending row and does not auto-approve it");
  assert.equal(suggestion.entityId, "char-uma");
  assert.equal(suggestion.entityName, "Uma");
  assert.equal(suggestion.sourceSnapshot, "a".repeat(40));
  assert.match(String(suggestion.sourceHash), /^[a-f0-9]{64}$/u);
  assert.equal(suggestion.createdAt, suggestion.updatedAt);

  const operation = created.proposals![0]!.operations[0]!;
  const profilePath = "bible/characters/char-uma/profile.yaml";
  const scenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-main-1/sc-1.md";
  assert.deepEqual(operation.writes.map((write) => write.path), [ZUKAN_SUGGESTIONS_PATH]);
  for (const path of [profilePath, scenePath, manuscriptPath, ZUKAN_SUGGESTIONS_PATH]) {
    assert.ok(operation.reads.some((read) => read.path === path && read.revision === (files.has(path) ? revision(files.get(path)!) : null)), `missing current revision for ${path}`);
  }
  assert.equal(operation.id, `story-zukan-create-${createHash("sha256").update("zukan-create-uma").digest("hex")}`);
  const proposedRows = operation.writes[0]!.content!.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(proposedRows[0]?.status, "stale");
  assert.deepEqual(proposedRows[0]?.future_field, { preserve: true });
  assert.equal(proposedRows[1]?.id, suggestion.id);
  assert.equal(proposedRows[1]?.sourceHash, suggestion.sourceHash);
  assert.equal(files.get(ZUKAN_SUGGESTIONS_PATH), `${JSON.stringify(oldRow)}\n`, "proposing does not mutate the selected snapshot");

  files.set(ZUKAN_SUGGESTIONS_PATH, operation.writes[0]!.content!);
  const duplicate = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>("story.zukan-suggestions.create", input, context);
  assert.equal(duplicate.data.created, false);
  assert.equal(duplicate.data.suggestion.id, suggestion.id);
  assert.equal(duplicate.proposals, undefined, "an already persisted stable suggestion is not proposed again");
  assert.equal(proposals.length, 1);
});

test("Zukan retries across an unrelated snapshot return the stored status without rebasing, while a new operation ID gets a new proposal identity", async () => {
  const files = fixtureFiles();
  const reader = makeReader(files);
  const firstProposals: ChangeProposal[] = [];
  const firstContext = makeActionContext(reader, { proposals: firstProposals });
  firstContext.listActions = async () => [{ id: "core.proposals.get" } as Awaited<ReturnType<ModuleActionContext["listActions"]>>[number]];
  let storedStatus: ProposalStatus | undefined;
  firstContext.invoke = async (_actionId, input) => {
    const proposalId = (input as { proposalId: string }).proposalId;
    return storedStatus
      ? { ok: true, snapshot: reader.snapshot, data: { proposal: storedStatus } }
      : { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: `missing ${proposalId}`, retryable: false } };
  };
  const input = {
    entityId: "char-uma",
    blockPath: "lead.0",
    proposedText: "Uma enters the cafe.",
    evidence: [{ quote: "Uma enters the cafe.", sceneId: "sc-1" }],
    source: "manuscript",
    kind: "fact",
    confidence: "high",
    operation_id: "logical-zukan-creation-1",
  };
  const first = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>(
    "story.zukan-suggestions.create", input, firstContext,
  );
  assert.equal(first.data.created, true);
  assert.equal(first.proposals?.length, 1);
  const proposal = first.proposals![0]!;
  storedStatus = {
    proposal,
    payloadComplete: true,
    state: "proposed",
    approvedOperationIds: [],
    checkpoints: [],
    publishedOperationIds: [],
    stale: true,
  };

  const advancedReader: SnapshotReader = {
    ...makeReader(files),
    snapshot: { ...reader.snapshot, remoteCommit: "b".repeat(40) },
  };
  const advancedProposals: ChangeProposal[] = [];
  const advancedContext = makeActionContext(advancedReader, { proposals: advancedProposals });
  advancedContext.listActions = firstContext.listActions;
  advancedContext.invoke = async (_actionId, inputValue) => {
    assert.equal((inputValue as { proposalId: string }).proposalId, proposal.id);
    return { ok: true, snapshot: advancedReader.snapshot, data: { proposal: storedStatus! } };
  };
  const retried = await invoke<{
    suggestion: Record<string, unknown>;
    created: boolean;
    replayed: boolean;
    proposalStatus: ProposalStatus;
  }>("story.zukan-suggestions.create", input, advancedContext);
  assert.equal(retried.data.created, false);
  assert.equal(retried.data.replayed, true);
  assert.equal(retried.data.proposalStatus.proposal.id, proposal.id);
  assert.equal(retried.data.proposalStatus.proposal.snapshot.remoteCommit, reader.snapshot.remoteCommit);
  assert.equal(retried.data.proposalStatus.stale, true);
  assert.equal(retried.proposals, undefined, "an old-snapshot proposal is read back without proposing it against the newer snapshot");
  assert.equal(advancedProposals.length, 0);

  const changedMeaning = await actionById("story.zukan-suggestions.create").invoke({
    ...input, proposedText: "A changed fact under the same operation ID.",
  }, advancedContext);
  assert.equal(changedMeaning.ok, false);
  if (!changedMeaning.ok) assert.equal(changedMeaning.error.code, "suggestion_identity_conflict");
  assert.equal(advancedProposals.length, 0);

  const newIntentProposals: ChangeProposal[] = [];
  const newIntentContext = makeActionContext(reader, { proposals: newIntentProposals });
  newIntentContext.listActions = firstContext.listActions;
  newIntentContext.invoke = async (_actionId, inputValue) => {
    assert.notEqual((inputValue as { proposalId: string }).proposalId, proposal.id);
    return { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } };
  };
  const newIntent = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>(
    "story.zukan-suggestions.create", { ...input, operation_id: "logical-zukan-creation-2" }, newIntentContext,
  );
  assert.equal(newIntent.data.created, true);
  assert.equal(newIntent.proposals?.length, 1);
  assert.notEqual(newIntent.proposals?.[0]?.id, proposal.id);
  assert.notEqual(newIntent.data.suggestion.id, first.data.suggestion.id);
});

test("Zukan creation rejects stale manuscript quotes and validates sandbox source ranges", async () => {
  const files = fixtureFiles({
    "bible/dialogue_sketches/ds-uma.yaml": yaml({
      id: "ds-uma", type: "dialogue_sketch", participantEntityIds: ["char-uma"],
      lines: [{ speakerEntityId: "char-uma", text: "Uma likes tea." }],
    }),
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const stale = await actionById("story.zukan-suggestions.create").invoke({
    entityId: "char-uma", proposedText: "Uma visits the station.", source: "manuscript",
    evidence: [{ quote: "Uma visits the station.", sceneId: "sc-1" }], operation_id: "stale-zukan-quote",
  }, context);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "operation_precondition_conflict");
  assert.equal(proposals.length, 0);

  const sandbox = await invoke<{ suggestion: Record<string, unknown>; created: boolean }>("story.zukan-suggestions.create", {
    entityId: "char-uma", proposedText: "Uma likes tea.", source: "sandbox", sourceSessionId: "ds-uma",
    sourceTurnRange: { start: 0, end: 0 }, evidence: [{ quote: "likes tea" }], kind: "habit", confidence: "high",
    operation_id: "sandbox-zukan-uma",
  }, context);
  const sandboxOperation = sandbox.proposals![0]!.operations[0]!;
  assert.equal(sandbox.data.suggestion.sourceSessionId, "ds-uma");
  assert.deepEqual(sandbox.data.suggestion.sourceTurnRange, { start: 0, end: 0 });
  assert.ok(sandboxOperation.reads.some((read) => read.path === "bible/dialogue_sketches/ds-uma.yaml" && read.revision === revision(files.get("bible/dialogue_sketches/ds-uma.yaml")!)));
  const staleRange = await actionById("story.zukan-suggestions.create").invoke({
    entityId: "char-uma", proposedText: "Uma likes tea.", source: "sandbox", sourceSessionId: "ds-uma",
    sourceTurnRange: { start: 0, end: 2 }, evidence: [{ quote: "likes tea" }], operation_id: "stale-zukan-range",
  }, context);
  assert.equal(staleRange.ok, false);
  if (!staleRange.ok) assert.equal(staleRange.error.code, "operation_precondition_conflict");
  assert.equal(proposals.length, 1);
});

test("manual note edits stale matching pending Zukan rows in the same Story proposal", async () => {
  const profilePath = "bible/characters/char-uma/profile.yaml";
  const sourceEntity = YAML.parse(fixtureFiles().get(profilePath)!);
  sourceEntity.notes = {
    lead: [
      { type: "paragraph", text: "Original lead." },
      { type: "paragraph", text: "Unchanged lead." },
    ],
    sections: [],
  };
  const rows = [
    zukanRow({ id: "stale-matching-block", block_path: "lead.0" }),
    zukanRow({ id: "keep-other-block", block_path: "lead.1" }),
    zukanRow({ id: "keep-other-entity", entity_id: "loc-cafe", block_path: "lead.0" }),
    zukanRow({ id: "keep-rejected", status: "rejected", block_path: "lead.0" }),
  ];
  const suggestionsContent = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const files = fixtureFiles({
    [profilePath]: yaml(sourceEntity),
    [ZUKAN_SUGGESTIONS_PATH]: suggestionsContent,
  });
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(makeReader(files), { proposals });
  const updated = await invoke("story.entities.update", {
    id: "char-uma",
    patch: { notes: { lead: [
      { type: "paragraph", text: "Rewritten lead." },
      { type: "paragraph", text: "Unchanged lead." },
    ], sections: [] } },
  }, context);
  const operation = updated.proposals![0]!.operations[0]!;
  assert.deepEqual(operation.writes.map((write) => write.path).sort(), [profilePath, ZUKAN_SUGGESTIONS_PATH].sort());
  assert.ok(operation.reads.some((read) => read.path === ZUKAN_SUGGESTIONS_PATH && read.revision === revision(suggestionsContent)));
  const rewrittenRows = JSON.parse(`[${operation.writes.find((write) => write.path === ZUKAN_SUGGESTIONS_PATH)!.content!.trim().split("\n").join(",")}]`) as Array<Record<string, unknown>>;
  const statusById = new Map(rewrittenRows.map((row) => [row.id, row.status]));
  assert.equal(statusById.get("stale-matching-block"), "stale");
  assert.equal(statusById.get("keep-other-block"), "pending");
  assert.equal(statusById.get("keep-other-entity"), "pending");
  assert.equal(statusById.get("keep-rejected"), "rejected");
  assert.equal(files.get(ZUKAN_SUGGESTIONS_PATH), suggestionsContent, "proposing does not mutate the selected snapshot");
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
  assert.deepEqual(operation.readScopes?.map((scope) => scope.prefix).sort(), ["bible", "plot"]);
  assert.ok(operation.readScopes?.every((scope) => /^[a-f0-9]{64}$/.test(scope.revision)));
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
  const linkedReader = makeReader(fixtureFiles({
    "bible/characters/char-uma/profile.yaml": yaml({ id: "char-uma", name: "Bible Uma", type: "character", aliases: ["Bible-U"], notes: { lead: [{ type: "paragraph", text: "Bible source record." }], sections: [] } }),
  }), "repo-bible");
  const linkedIds: string[] = [];
  const context = makeActionContext(reader, { linkedReader: async (id) => { linkedIds.push(id); return linkedReader; } });
  const binding = await invoke<{ bibleRepositoryId: string; requiresAuthorReview: boolean }>("story.series.binding.get", {}, context);
  assert.equal(binding.data.bibleRepositoryId, "repo-bible");
  assert.equal(binding.data.requiresAuthorReview, false);
  const overlay = await invoke<{ workSnapshot: SnapshotId; bibleSnapshot: SnapshotId; workEntities: Array<{ id: string; name: string }>; bibleEntities: Array<{ id: string; name: string; raw: Record<string, unknown> }> }>("story.series.overlay", {}, context);
  assert.equal(overlay.data.workSnapshot.repository.repositoryId, "repo-work");
  assert.equal(overlay.data.bibleSnapshot.repository.repositoryId, "repo-bible");
  assert.equal(overlay.data.workEntities.find((entity) => entity.id === "char-uma")?.name, "Uma");
  assert.equal(overlay.data.bibleEntities.find((entity) => entity.id === "char-uma")?.name, "Bible Uma", "the browser can inspect the actual Bible record even when a work record has the same ID");
  assert.equal((overlay.data.bibleEntities.find((entity) => entity.id === "char-uma")?.raw.aliases as string[])[0], "Bible-U");
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

test("state-proposal lifecycle uses the source manuscript FNV hash", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  const created = await invoke<{ id: string; manuscriptHash: string }>("story.state-proposals.create", {
    id: "proposal-arrival",
    sceneId: "sc-1",
    event: { kind: "location", subject: "char-uma", object: "loc-cafe", payload: {} },
  }, context);
  assert.equal(created.data.manuscriptHash, sourceHash("Uma enters the cafe."));
  const row = JSON.parse(proposals[0]!.operations[0]!.writes[0]!.content!) as { manuscript_hash: string };
  assert.equal(row.manuscript_hash, sourceHash("Uma enters the cafe."));
});

test("NarrativeChangeSet preserves all nine source operation kinds in one identity-bound Core proposal", async () => {
  const body = "Uma enters the cafe.";
  const stateProposal = {
    id: "proposal-arrival",
    scene_id: "sc-1",
    event_json: JSON.stringify({ sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "llm-draft", eventId: "draft-arrival", status: "proposed" }),
    manuscript_hash: sourceHash(body),
    status: "proposed",
    conflict_event_ids_json: "[]",
    duplicate_of_proposal_id: null,
    history_json: "[]",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const stateProposalContent = `${JSON.stringify(stateProposal)}\n`;
  const files = fixtureFiles({
    "plot/threads/thread-main.yaml": yaml({ id: "thread-main", name: "A promise", type: "thread", relations: [] }),
    [STATE_PROPOSALS_PATH]: stateProposalContent,
  });
  const reader = makeReader(files);
  const proposals: Array<{ id: string; operations: ChangeOperation[] }> = [];
  const context = makeActionContext(reader, { proposals });
  context.invoke = async (actionId) => actionId === "core.proposals.get"
    ? { ok: false, snapshot: reader.snapshot, error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false } }
    : { ok: false, snapshot: reader.snapshot, error: { code: "missing_action", message: "not wired", retryable: false } };
  const entities = (await invoke<Array<{ id: string; revision: string; filePath: string }>>("story.entities.list", {}, context)).data;
  const rev = (id: string) => entities.find((entity) => entity.id === id)!.revision;
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
      { id: "append-state", kind: "state.append-event", precondition: { kind: "revision", value: rev("sc-1") }, target: { sceneId: "sc-1", eventId: "event-arrival" }, event: { sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "manual", eventId: "event-arrival", evidence: [{ sceneId: "sc-1", excerpt: "enters the cafe" }], confidence: 0.9, createdAt: "2026-01-01T00:00:00.000Z", status: "confirmed" }, sourceProposal: { id: stateProposal.id, manuscriptHash: stateProposal.manuscript_hash }, evidenceIds: ["evidence-one"], assessment: { confidence: 0.9, risk: "medium" } },
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
  assert.deepEqual(data.dependencies["create-scene"], ["create-location"], "a later create depends on earlier Story writes represented by its virtual scope revision");
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
  const createLocation = coreProposal.operations[0]!;
  const createScene = coreProposal.operations[1]!;
  const createdScenePath = "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-new.yaml";
  assert.equal(createScene.reads.find((read) => read.path === createdScenePath)?.revision, null);
  assert.equal(createScene.writes.find((write) => write.path === createdScenePath)?.revision, null,
    "rewriting a virtual scene within one source operation keeps its original Core absence precondition");
  assert.deepEqual(createLocation.readScopes?.map((scope) => scope.prefix).sort(), ["bible", "plot"]);
  assert.deepEqual(createScene.readScopes?.map((scope) => scope.prefix).sort(), ["bible", "plot"]);
  const bibleScope = (operation: ChangeOperation) => operation.readScopes?.find((scope) => scope.prefix === "bible")?.revision;
  assert.notEqual(bibleScope(createScene), bibleScope(createLocation), "later source operations include earlier planned Story creates in their membership guard");
  assert.equal(createScene.readScopes?.find((scope) => scope.prefix === "plot")?.revision, createLocation.readScopes?.find((scope) => scope.prefix === "plot")?.revision);
  const stateCoreOperation = coreProposal.operations.find((operation) => operation.id === data.operationMap["append-state"]);
  assert.ok(stateCoreOperation?.reads.some((read) => read.path === STATE_PROPOSALS_PATH && read.revision === revision(stateProposalContent)));
  assert.equal(coreProposal.operations[0]?.writes[0]?.path, "bible/locations/loc-new.yaml");
  assert.equal(files.get("bible/locations/loc-new.yaml"), undefined, "proposal conversion does not write to the snapshot");
  assert.equal(proposals.length, 1);
});

test("state.append-event rejects stale or mismatched source proposals", async () => {
  const body = "Uma enters the cafe.";
  const manuscriptHash = sourceHash(body);
  const row = {
    id: "proposal-arrival",
    scene_id: "sc-1",
    event_json: JSON.stringify({ sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "llm-draft", eventId: "draft-arrival", status: "proposed" }),
    manuscript_hash: manuscriptHash,
    status: "proposed",
    conflict_event_ids_json: "[]",
    duplicate_of_proposal_id: null,
    history_json: "[]",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const submit = async (label: string, proposalRow: typeof row | null, operationHash = manuscriptHash) => {
    const files = fixtureFiles({
      [STATE_PROPOSALS_PATH]: proposalRow ? `${JSON.stringify(proposalRow)}\n` : "",
    });
    const reader = makeReader(files);
    const context = makeActionContext(reader);
    context.invoke = async () => ({
      ok: false,
      snapshot: reader.snapshot,
      error: { code: "PROPOSAL_NOT_FOUND", message: "missing", retryable: false },
    });
    const scene = (await invoke<{ revision: string }>("story.entities.get", { id: "sc-1" }, context)).data;
    const changeSet = {
      schemaVersion: 1,
      id: `ncs-state-${label}`,
      projectId: context.projectId,
      goal: "Append a proposed state event",
      status: "proposed",
      assessment: { confidence: 0.9, risk: "medium" },
      operations: [{
        id: "append-state",
        kind: "state.append-event",
        precondition: { kind: "revision", value: scene.revision },
        target: { sceneId: "sc-1", eventId: "event-arrival" },
        event: { sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: {}, source: "manual", eventId: "event-arrival", status: "confirmed" },
        sourceProposal: { id: row.id, manuscriptHash: operationHash },
        evidenceIds: [],
        assessment: { confidence: 0.9, risk: "medium" },
      }],
      evidence: [],
      diagnostics: { before: null, after: null },
    };
    const result = await actionById("story.changes.propose").invoke(changeSet, context);
    assert.equal(result.ok, false, `${label} should not be proposed`);
    if (!result.ok) assert.equal(result.error.code, "operation_precondition_conflict", label);
  };

  await submit("missing", null);
  await submit("status", { ...row, status: "stale" });
  await submit("conflicts", { ...row, conflict_event_ids_json: '["old-event"]' });
  await submit("duplicate", { ...row, duplicate_of_proposal_id: "proposal-other" });
  await submit("event", { ...row, event_json: JSON.stringify({ sceneId: "sc-1", order: 1, kind: "location", subject: "char-uma", object: "loc-cafe", payload: { reason: "changed" }, source: "llm-draft", status: "proposed" }) });
  await submit("manuscript", { ...row, manuscript_hash: "deadbeef" }, "deadbeef");
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

test("reader model action derives chapter disclosures and knowledge checks from the selected snapshot", async () => {
  const context = makeActionContext(makeReader(fixtureFiles()));
  const result = await invoke<{
    chapterId: string;
    disclosures: Array<{ entityId: string; sceneId: string; evidence: string }>;
    knowledgeGaps: Array<{ kind: string }>;
    forgetRisks: Array<{ threadId: string; forgetRisk: number }>;
    firstReadReaction: null;
  }>("story.reader-model.build", { chapterId: "ch-main-1" }, context);
  assert.equal(result.data.chapterId, "ch-main-1");
  assert.ok(result.data.disclosures.some((item) => item.entityId === "char-uma" && item.sceneId === "sc-1" && item.evidence === "Uma"));
  assert.ok(Array.isArray(result.data.knowledgeGaps));
  assert.ok(Array.isArray(result.data.forgetRisks));
  assert.equal(result.data.firstReadReaction, null, "the local Story action does not invoke an optional external assistant");
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

test("NarrativeChangeSet refuses to reconstruct an incomplete recovered Core proposal", async () => {
  const reader = makeReader(fixtureFiles());
  const proposals: ChangeProposal[] = [];
  const context = makeActionContext(reader, { proposals });
  let recovered: unknown;
  context.invoke = async () => recovered
    ? { ok: true, snapshot: reader.snapshot, data: { proposal: recovered } }
    : { ok: false, snapshot: reader.snapshot, error: { code: "proposal_not_found", message: "missing", retryable: false } };
  const current = (await invoke<{ revision: string }>("story.entities.get", { id: "char-uma" }, context)).data;
  const changeSet = {
    schemaVersion: 1, id: "ncs-incomplete-recovery", projectId: context.projectId, goal: "Update a name", status: "proposed",
    assessment: { confidence: 0.8, risk: "low" },
    operations: [{ id: "update-uma", kind: "entity.update", precondition: { kind: "revision", value: current.revision }, target: { entityId: "char-uma" }, changes: { name: "Uma Recovery" }, evidenceIds: [], assessment: { confidence: 0.8, risk: "low" } }],
    evidence: [], diagnostics: { before: null, after: null },
  };
  const first = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(first.ok, true, first.ok ? undefined : first.error.message);
  if (!first.ok) return;
  const fullProposal = first.proposals![0]!;
  recovered = {
    proposal: { ...fullProposal, evidence: undefined },
    payloadComplete: false,
    operationIds: fullProposal.operations.map((operation) => operation.id),
  };
  const retry = await actionById("story.changes.propose").invoke(changeSet, context);
  assert.equal(retry.ok, false);
  if (!retry.ok) assert.equal(retry.error.code, "PROPOSAL_PAYLOAD_UNAVAILABLE");
  assert.equal(proposals.length, 1, "Story does not fabricate a full source proposal from Core's accepted subset");
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
  const originalRevision = ((sourceEvidence?.details as { resultRevisions?: Record<string, string> }).resultRevisions)?.["update-uma-legacy"];
  assert.equal(typeof originalRevision, "string");

  const changedSnapshotFiles = fixtureFiles();
  changedSnapshotFiles.set("bible/characters/char-uma/profile.yaml", yaml({ id: "char-uma", name: "A newer remote name", type: "character", aliases: ["U"], tags: ["lead"], notes: { daily: ["Keep the promise"] }, relations: [] }));
  const newerReader = makeReader(changedSnapshotFiles, "repo-work");
  const newerContext = makeActionContext(newerReader);
  newerContext.invoke = context.invoke;
  const replay = await actionById("story.changes.propose").invoke(changeSet, newerContext);
  assert.equal(replay.ok, true, replay.ok ? undefined : replay.error.message);
  if (replay.ok) {
    assert.equal((replay.data as { replayed: boolean }).replayed, true);
    assert.equal((replay.data as { changeSetId: string }).changeSetId, sourceId);
    assert.equal((replay.data as { coreProposalId: string }).coreProposalId, data.coreProposalId);
    assert.equal((replay.data as { resultRevisions: Record<string, string> }).resultRevisions["update-uma-legacy"], originalRevision, "replay returns persisted source results even if current snapshot has advanced");
  }
  const changed = await actionById("story.changes.propose").invoke({ ...changeSet, goal: "A different goal" }, newerContext);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, "change_set_identity_conflict");
  assert.equal(proposals.length, 1);
});
