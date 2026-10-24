import {
  assertChangeOperation,
  type Approval,
  type ChangeOperation,
  type ChangeProposal,
  type CheckpointReceipt,
  type RepositoryIdentity,
} from "@scriptorium/contracts";
import {
  documentKey,
  journalEntryKey,
  repositoryKey,
  stableJson,
  type BrowserJournal,
  type JournalEntry,
} from "../storage/journal.js";

export interface CheckpointApi {
  propose(projectId: string, proposal: ChangeProposal, signal?: AbortSignal): Promise<ChangeProposal>;
  approve(projectId: string, approval: Approval, signal?: AbortSignal): Promise<void>;
  checkpoint(projectId: string, operation: ChangeOperation, signal?: AbortSignal): Promise<CheckpointReceipt>;
}

export type CheckpointJournal = Pick<BrowserJournal, "updateState" | "putProposal" | "removeProposal">;

export interface CheckpointProtocolInput {
  projectId: string;
  repository: RepositoryIdentity;
  authorScope: string;
  entry: JournalEntry;
  api: CheckpointApi;
  journal: CheckpointJournal;
  signal?: AbortSignal;
  onCheckpointing?: (entry: JournalEntry) => void;
}

export class CheckpointConflictError extends Error {
  constructor() {
    super("競合した回復記録はチェックポイントできません。");
    this.name = "CheckpointConflictError";
  }
}

function assertCheckpointIdentity(
  entry: JournalEntry,
  repository: RepositoryIdentity,
  authorScope: string,
): void {
  const owner = repositoryKey(repository);
  if (!authorScope || entry.authorScope !== authorScope) {
    throw new Error("別の作者スコープの回復記録はチェックポイントできません。");
  }
  if (entry.repositoryKey !== owner || repositoryKey(entry.repository) !== owner ||
      entry.documentKey !== documentKey(repository, entry.documentPath) || entry.key !== journalEntryKey(entry) ||
      repositoryKey(entry.snapshot.repository) !== owner || repositoryKey(entry.operation.repository) !== owner ||
      entry.snapshot.remoteCommit !== entry.operation.baseRemoteCommit ||
      !entry.operation.writes.some((write) => write.path === entry.documentPath)) {
    throw new Error("回復記録のリポジトリまたは原稿の識別情報が一致しません。");
  }
  if (entry.state !== "draft" && entry.state !== "checkpointing" && entry.state !== "checkpointed") {
    throw new Error("この回復記録はチェックポイントできない状態です。");
  }
  assertChangeOperation(entry.operation);
}

function assertAcceptedProposal(accepted: ChangeProposal, expected: ChangeProposal): void {
  if (stableJson(accepted) !== stableJson(expected)) {
    throw new Error("Core が受け付けたチェックポイント提案が回復記録と一致しません。");
  }
}

function assertReceipt(receipt: CheckpointReceipt, operation: ChangeOperation): void {
  if (receipt.operationId !== operation.id || receipt.generation !== operation.generation ||
      receipt.remoteBase !== operation.baseRemoteCommit) {
    throw new Error("Core のチェックポイント受領証が回復記録の操作と一致しません。");
  }
}

/** Run one durable browser-journal and Core effect sequence for a checkpoint attempt. */
export async function runCheckpointProtocol(input: CheckpointProtocolInput): Promise<JournalEntry> {
  input.signal?.throwIfAborted();
  const repository = Object.freeze({ ...input.repository });
  const authorScope = input.authorScope;
  const entry = input.entry;
  assertCheckpointIdentity(entry, repository, authorScope);

  const proposalId = entry.proposalId ?? `author-${entry.operation.id}-${entry.operation.generation}`;
  const checkpointing = await input.journal.updateState({
    ...entry,
    proposalId,
    authorizedAt: entry.authorizedAt ?? Date.now(),
  }, "checkpointing");
  if (checkpointing.state === "conflict") throw new CheckpointConflictError();
  if (checkpointing.state !== "checkpointing" && checkpointing.state !== "checkpointed") {
    throw new Error("競合または公開状態になった回復記録はチェックポイントできません。");
  }
  input.onCheckpointing?.(checkpointing);

  const proposal: ChangeProposal = {
    id: proposalId,
    snapshot: checkpointing.snapshot,
    operations: [checkpointing.operation],
    source: "author",
  };
  input.signal?.throwIfAborted();
  const accepted = await input.api.propose(input.projectId, proposal, input.signal);
  assertAcceptedProposal(accepted, proposal);
  await input.journal.putProposal(repository, authorScope, accepted);

  const assigned = await input.journal.updateState({ ...checkpointing, proposalId: accepted.id }, "checkpointing");
  if (assigned.state === "conflict") throw new CheckpointConflictError();
  if (assigned.state !== "checkpointing" && assigned.state !== "checkpointed") {
    throw new Error("競合または公開状態になった回復記録はチェックポイントできません。");
  }
  input.signal?.throwIfAborted();
  await input.api.approve(input.projectId, {
    proposalId: accepted.id,
    operationIds: [assigned.operation.id],
    authorScope,
  }, input.signal);

  input.signal?.throwIfAborted();
  const receipt = await input.api.checkpoint(input.projectId, assigned.operation, input.signal);
  assertReceipt(receipt, assigned.operation);
  const saved = await input.journal.updateState(assigned, "checkpointed", receipt);
  if (saved.state !== "checkpointed" || !saved.checkpoint ||
      stableJson(saved.checkpoint) !== stableJson(receipt)) {
    throw new Error("チェックポイント受領証を回復記録へ保存できませんでした。");
  }
  await input.journal.removeProposal(repository, authorScope, accepted.id).catch(() => undefined);
  return saved;
}
