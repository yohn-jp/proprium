import assert from "node:assert/strict";
import test from "node:test";
import type {
  Approval,
  ChangeOperation,
  ChangeProposal,
  CheckpointReceipt,
  RepositoryIdentity,
} from "@scriptorium/contracts";
import { runCheckpointProtocol, CheckpointConflictError, type CheckpointApi, type CheckpointJournal } from "./checkpoint-protocol.js";
import { documentKey, journalEntryKey, repositoryKey, type JournalEntry, type JournalState } from "../storage/journal.js";

const repository: RepositoryIdentity = {
  provider: "github",
  repositoryId: "repo-1",
  ownerScope: "owner-1",
  defaultBranch: "main",
  url: "https://github.com/owner-1/story",
};
const authorScope = "author-1";
const documentPath = "manuscript/scene-1.md";
const remoteCommit = "0123456789abcdef0123456789abcdef01234567";

function operation(overrides: Partial<ChangeOperation> = {}): ChangeOperation {
  return {
    id: "operation-1",
    generation: 7,
    repository,
    baseRemoteCommit: remoteCommit,
    effect: "manuscript",
    reads: [{ path: documentPath, revision: null }],
    writes: [{ path: documentPath, revision: null, content: "---\ntitle: Scene\n---\nDraft text\n" }],
    message: "loom(scene): scene-1",
    ...overrides,
  };
}

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  const base: JournalEntry = {
    version: 1,
    key: "",
    repositoryKey: repositoryKey(repository),
    documentKey: documentKey(repository, documentPath),
    authorScope,
    repository,
    documentPath,
    sceneId: "scene-1",
    snapshot: { repository, remoteCommit },
    text: "Draft text",
    baseText: "Original text",
    operation: operation(),
    state: "draft",
    updatedAt: 1,
  };
  const result = { ...base, ...overrides };
  result.key = journalEntryKey(result);
  return result;
}

interface HarnessOptions {
  failAt?: string;
  conflictOnFirstStateWrite?: boolean;
  wrongProposal?: boolean;
  wrongReceipt?: boolean;
  loseFirstCheckpointResponse?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const proposalRecords = new Map<string, ChangeProposal>();
  const proposed: ChangeProposal[] = [];
  const approvals: Approval[] = [];
  const checkpoints: ChangeOperation[] = [];
  let failAt = options.failAt;
  let stateWriteCount = 0;
  let stored = entry();
  let checkpointReceipt: CheckpointReceipt | undefined;

  const journal: CheckpointJournal = {
    async updateState(value, state, receipt) {
      stateWriteCount += 1;
      events.push(`journal:update:${state}:${stateWriteCount}`);
      if (failAt === `update:${state}:${stateWriteCount}`) throw new Error(`injected update failure ${stateWriteCount}`);
      if (options.conflictOnFirstStateWrite && stateWriteCount === 1) {
        stored = { ...stored, state: "conflict" };
        return stored;
      }
      const rank: Record<JournalState, number> = { draft: 0, checkpointing: 1, checkpointed: 2, publication_unknown: 3, conflict: 4 };
      const nextState = rank[state] >= rank[stored.state] ? state : stored.state;
      stored = {
        ...stored,
        ...(value.proposalId ? { proposalId: value.proposalId } : {}),
        ...(value.authorizedAt ? { authorizedAt: value.authorizedAt } : {}),
        state: nextState,
        ...(receipt && nextState === "checkpointed" ? { checkpoint: receipt } : {}),
      };
      return stored;
    },
    async putProposal(owner, scope, proposal) {
      events.push("journal:putProposal");
      if (failAt === "putProposal") throw new Error("injected proposal journal failure");
      assert.equal(repositoryKey(owner), repositoryKey(repository));
      assert.equal(scope, authorScope);
      const key = JSON.stringify([repositoryKey(owner), scope, proposal.id]);
      const previous = proposalRecords.get(key);
      if (previous) assert.deepEqual(previous, proposal);
      proposalRecords.set(key, proposal);
      return null;
    },
    async removeProposal(owner, scope, proposalId) {
      events.push("journal:removeProposal");
      if (failAt === "removeProposal") throw new Error("injected cleanup failure");
      assert.equal(repositoryKey(owner), repositoryKey(repository));
      assert.equal(scope, authorScope);
      proposalRecords.delete(JSON.stringify([repositoryKey(owner), scope, proposalId]));
      return true;
    },
  };

  const api: CheckpointApi = {
    async propose(_projectId, proposal) {
      events.push("api:propose");
      proposed.push(proposal);
      if (failAt === "propose") throw new Error("injected propose failure");
      if (options.wrongProposal) return { ...proposal, id: "unexpected-proposal" };
      return proposal;
    },
    async approve(_projectId, approval) {
      events.push("api:approve");
      approvals.push(approval);
      if (failAt === "approve") throw new Error("injected approval failure");
    },
    async checkpoint(_projectId, submitted) {
      events.push("api:checkpoint");
      checkpoints.push(submitted);
      if (failAt === "checkpoint") throw new Error("injected checkpoint failure");
      checkpointReceipt ??= {
        operationId: submitted.id,
        generation: submitted.generation,
        localCommit: "abcdef0123456789abcdef0123456789abcdef01",
        remoteBase: submitted.baseRemoteCommit,
        revisions: [{ path: documentPath, revision: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" }],
      };
      if (options.wrongReceipt) return { ...checkpointReceipt, generation: checkpointReceipt.generation + 1 };
      if (options.loseFirstCheckpointResponse && checkpoints.length === 1) throw new Error("checkpoint response lost");
      return checkpointReceipt;
    },
  };

  return {
    events,
    journal,
    api,
    proposed,
    approvals,
    checkpoints,
    proposalRecords,
    get stored() { return stored; },
    get stateWriteCount() { return stateWriteCount; },
    retry() { failAt = undefined; },
    input(overrides: Partial<Parameters<typeof runCheckpointProtocol>[0]> = {}) {
      return {
        projectId: "project-1",
        repository,
        authorScope,
        entry: entry(),
        api,
        journal,
        ...overrides,
      };
    },
  };
}

test("checkpoint effects share one durable sequence and emit only after the initial journal write", async () => {
  const worker = harness();
  let emitted: JournalEntry | undefined;
  const result = await runCheckpointProtocol(worker.input({ onCheckpointing: (value) => {
    emitted = value;
    worker.events.push("ui:checkpointing");
  } }));

  assert.deepEqual(worker.events, [
    "journal:update:checkpointing:1",
    "ui:checkpointing",
    "api:propose",
    "journal:putProposal",
    "journal:update:checkpointing:2",
    "api:approve",
    "api:checkpoint",
    "journal:update:checkpointed:3",
    "journal:removeProposal",
  ]);
  assert.equal(emitted?.state, "checkpointing");
  assert.equal(result.state, "checkpointed");
  assert.equal(result.proposalId, "author-operation-1-7");
  assert.deepEqual(result.checkpoint, worker.stored.checkpoint);
  assert.equal(worker.proposalRecords.size, 0);
  assert.deepEqual(worker.approvals, [{ proposalId: "author-operation-1-7", operationIds: ["operation-1"], authorScope }]);
});

test("failures at each durable or network step retain the same scoped operation for retry", async (context) => {
  const failurePoints = [
    "update:checkpointing:1",
    "propose",
    "putProposal",
    "update:checkpointing:2",
    "approve",
    "checkpoint",
    "update:checkpointed:3",
  ];
  for (const failurePoint of failurePoints) {
    await context.test(failurePoint, async () => {
      const worker = harness({ failAt: failurePoint });
      let emitted = false;
      await assert.rejects(runCheckpointProtocol(worker.input({ onCheckpointing: () => { emitted = true; } })), /injected/u);
      assert.equal(emitted, failurePoint !== "update:checkpointing:1");
      assert.ok(worker.stateWriteCount >= 1);
      assert.equal(worker.stored.operation.id, "operation-1");
      assert.equal(worker.stored.operation.generation, 7);
      if (worker.stored.state !== "draft") {
        assert.equal(worker.stored.state, "checkpointing");
        assert.equal(worker.stored.proposalId, "author-operation-1-7");
      }
      for (const record of worker.proposalRecords.values()) {
        assert.equal(record.id, "author-operation-1-7");
        assert.equal(repositoryKey(record.snapshot.repository), repositoryKey(repository));
        assert.equal(record.operations[0]?.id, "operation-1");
      }
      for (const approval of worker.approvals) {
        assert.equal(approval.authorScope, authorScope);
        assert.deepEqual(approval.operationIds, ["operation-1"]);
      }
    });
  }
});

test("a lost checkpoint response is retried with the same proposal, operation generation, and author scope", async () => {
  const worker = harness({ loseFirstCheckpointResponse: true });
  await assert.rejects(runCheckpointProtocol(worker.input()), /response lost/u);
  assert.equal(worker.stored.state, "checkpointing");
  assert.equal(worker.stored.proposalId, "author-operation-1-7");
  assert.equal(worker.proposalRecords.size, 1);

  const result = await runCheckpointProtocol(worker.input());
  assert.equal(result.state, "checkpointed");
  assert.equal(result.checkpoint?.operationId, "operation-1");
  assert.equal(result.checkpoint?.generation, 7);
  assert.deepEqual(worker.proposed.map((proposal) => proposal.id), ["author-operation-1-7", "author-operation-1-7"]);
  assert.deepEqual(worker.checkpoints.map((item) => [item.id, item.generation]), [["operation-1", 7], ["operation-1", 7]]);
  assert.deepEqual(worker.approvals.map((approval) => approval.authorScope), [authorScope, authorScope]);
  assert.equal(worker.proposalRecords.size, 0);
});

test("cleanup failure cannot turn a durable checkpoint receipt into a failed save", async () => {
  const worker = harness({ failAt: "removeProposal" });
  const result = await runCheckpointProtocol(worker.input());

  assert.equal(result.state, "checkpointed");
  assert.equal(result.checkpoint?.operationId, "operation-1");
  assert.equal(worker.stored.state, "checkpointed");
  assert.equal(worker.proposalRecords.size, 1);
});

test("a conflict returned by the journal remains a conflict and prevents further effects", async () => {
  const worker = harness({ conflictOnFirstStateWrite: true });
  await assert.rejects(runCheckpointProtocol(worker.input({ entry: entry({ state: "checkpointing" }) })), CheckpointConflictError);

  assert.equal(worker.stored.state, "conflict");
  assert.equal(worker.proposed.length, 0);
  assert.deepEqual(worker.events, ["journal:update:checkpointing:1"]);
});

test("receipt identity and caller repository and author scope are checked before confirmation", async () => {
  const wrongProposal = harness({ wrongProposal: true });
  await assert.rejects(runCheckpointProtocol(wrongProposal.input()), /提案/u);
  assert.equal(wrongProposal.stored.state, "checkpointing");
  assert.equal(wrongProposal.proposalRecords.size, 0);
  assert.equal(wrongProposal.approvals.length, 0);

  const wrongReceipt = harness({ wrongReceipt: true });
  await assert.rejects(runCheckpointProtocol(wrongReceipt.input()), /受領証/u);
  assert.equal(wrongReceipt.stored.state, "checkpointing");
  assert.equal(wrongReceipt.proposalRecords.size, 1);

  const wrongAuthor = harness();
  await assert.rejects(runCheckpointProtocol(wrongAuthor.input({ authorScope: "author-2" })), /作者スコープ/u);
  assert.deepEqual(wrongAuthor.events, []);

  const otherRepository: RepositoryIdentity = { ...repository, repositoryId: "repo-2" };
  const wrongRepository = harness();
  await assert.rejects(runCheckpointProtocol(wrongRepository.input({ repository: otherRepository })), /識別情報/u);
  assert.deepEqual(wrongRepository.events, []);
});
