import {
  assertChangeOperation,
  type ChangeOperation,
  type ChangeProposal,
  type CheckpointReceipt,
  type PublishReceipt,
  type ProposalStatus,
  type RepositoryIdentity,
  type SnapshotId,
} from "@scriptorium/contracts";

const DATABASE_NAME = "scriptorium-recovery";
const DATABASE_VERSION = 3;
const ENTRY_STORE = "operations";
const SCRATCH_STORE = "scratch";
const PROPOSAL_STORE = "proposals";
const RECEIPT_STORE = "publicationReceipts";

export type JournalState = "draft" | "checkpointing" | "checkpointed" | "publication_unknown" | "conflict";

export interface JournalEntry {
  version: 1;
  key: string;
  repositoryKey: string;
  documentKey: string;
  /** null marks a legacy record whose author identity was never recorded. */
  authorScope: string | null;
  repository: RepositoryIdentity;
  documentPath: string;
  sceneId: string;
  snapshot: SnapshotId;
  text: string;
  baseText: string;
  operation: ChangeOperation;
  proposalId?: string;
  state: JournalState;
  checkpoint?: CheckpointReceipt;
  publicationBatchId?: string;
  authorizedAt?: number;
  updatedAt: number;
}

export interface JournalProposal {
  key: string;
  repositoryKey: string;
  /** null marks a legacy proposal whose author identity was never recorded. */
  authorScope: string | null;
  repository: RepositoryIdentity;
  proposal: ChangeProposal;
  /** Latest Core review status for a remotely submitted proposal. */
  status?: ProposalStatus;
  /** A local dismissal hides a still-pending remote proposal without deleting its source record. */
  dismissedAt?: number;
  createdAt: number;
}

interface ScratchRecord {
  key: string;
  text: string;
  updatedAt: number;
}

interface PublicationReceiptRecord {
  key: string;
  repositoryKey: string;
  authorScope: string;
  receipt: PublishReceipt;
  createdAt: number;
}

export class JournalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JournalError";
  }
}

export function repositoryKey(repository: RepositoryIdentity): string {
  return JSON.stringify([
    repository.provider,
    repository.ownerScope,
    repository.repositoryId,
    repository.defaultBranch,
  ]);
}

export function documentKey(repository: RepositoryIdentity, path: string): string {
  return JSON.stringify([repositoryKey(repository), path]);
}

export function journalEntryKey(entry: Pick<JournalEntry, "documentKey" | "operation"> & { authorScope?: string | null }): string {
  return JSON.stringify([entry.documentKey, entry.authorScope ?? null, entry.operation.id, entry.operation.generation]);
}

export function publicationReceiptKey(repository: RepositoryIdentity, authorScope: string, batchId: string): string {
  return JSON.stringify([repositoryKey(repository), authorScope, batchId]);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function proposalOperationEntry(
  repository: RepositoryIdentity,
  authorScope: string,
  proposal: ChangeProposal,
  operation: ChangeOperation,
  state: JournalState = "draft",
  checkpoint?: CheckpointReceipt,
): JournalEntry {
  if (!authorScope) throw new JournalError("The proposal has no author identity scope.");
  assertChangeOperation(operation);
  const owner = repositoryKey(repository);
  if (repositoryKey(proposal.snapshot.repository) !== owner || repositoryKey(operation.repository) !== owner ||
      !proposal.operations.some((candidate) => stableJson(candidate) === stableJson(operation))) {
    throw new JournalError("The proposal operation does not match its repository or complete payload.");
  }
  const documentPath = operation.writes[0]?.path;
  if (!documentPath) throw new JournalError("The proposal operation has no recoverable file path.");
  const entry: JournalEntry = {
    version: 1,
    key: "",
    repositoryKey: owner,
    documentKey: documentKey(repository, documentPath),
    authorScope,
    repository,
    documentPath,
    sceneId: proposal.id,
    snapshot: proposal.snapshot,
    text: typeof operation.writes[0]?.content === "string" ? operation.writes[0].content : "",
    baseText: "",
    operation,
    proposalId: proposal.id,
    state,
    ...(checkpoint ? { checkpoint, authorizedAt: Date.now() } : {}),
    updatedAt: Date.now(),
  };
  entry.key = journalEntryKey(entry);
  return entry;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function storageMessage(error: unknown, operation: string): JournalError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "QuotaExceededError") {
    return new JournalError(`Browser storage is full. Your ${operation} is still in this tab, but it could not be protected for recovery. Free browser storage and try again.`, error);
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return new JournalError(`Browser storage is unavailable. Your ${operation} could not be protected for recovery.`, error);
  }
  return new JournalError(`Browser storage could not save your ${operation}. Keep this tab open and try again.`, error);
}

export class BrowserJournal {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(): Promise<BrowserJournal> {
    if (typeof indexedDB === "undefined") throw new JournalError("This browser does not provide IndexedDB recovery storage.");
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ENTRY_STORE)) {
          const entries = database.createObjectStore(ENTRY_STORE, { keyPath: "key" });
          entries.createIndex("documentKey", "documentKey", { unique: false });
          entries.createIndex("repositoryKey", "repositoryKey", { unique: false });
          entries.createIndex("state", "state", { unique: false });
        }
        if (!database.objectStoreNames.contains(SCRATCH_STORE)) {
          database.createObjectStore(SCRATCH_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(PROPOSAL_STORE)) {
          const proposals = database.createObjectStore(PROPOSAL_STORE, { keyPath: "key" });
          proposals.createIndex("repositoryKey", "repositoryKey", { unique: false });
        }
        if (!database.objectStoreNames.contains(RECEIPT_STORE)) {
          const receipts = database.createObjectStore(RECEIPT_STORE, { keyPath: "key" });
          receipts.createIndex("repositoryKey", "repositoryKey", { unique: false });
        }
      };
      const database = await requestValue(request);
      database.onversionchange = () => database.close();
      return new BrowserJournal(database);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  close(): void {
    this.database.close();
  }

  async put(entry: JournalEntry): Promise<void> {
    try {
      if (!entry.authorScope) throw new JournalError("The recovery record has no author identity scope.");
      assertChangeOperation(entry.operation);
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const key = journalEntryKey(entry);
      const existing = await requestValue(store.get(key)) as JournalEntry | undefined;
      if (existing && (existing.authorScope !== entry.authorScope || JSON.stringify(existing.operation) !== JSON.stringify(entry.operation))) {
        await done;
        throw new JournalError("A journal key cannot be reused for a different author or operation.");
      }
      if (!existing) store.put({ ...entry, key, updatedAt: Date.now() });
      await done;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "draft");
    }
  }

  /** Keep one editable draft per document while retaining every authorized operation. */
  async putLatestDraft(entry: JournalEntry): Promise<boolean> {
    try {
      if (!entry.authorScope) throw new JournalError("The recovery record has no author identity scope.");
      if (entry.state !== "draft") throw new JournalError("Only an editable draft can replace the latest draft.");
      assertChangeOperation(entry.operation);
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const existing = await requestValue(store.index("documentKey").getAll(entry.documentKey)) as JournalEntry[];
      for (const candidate of existing) {
        if (candidate.authorScope !== entry.authorScope) continue;
        if (candidate.operation.generation > entry.operation.generation) {
          await done;
          return false;
        }
        if (candidate.operation.generation === entry.operation.generation) {
          if (candidate.operation.id !== entry.operation.id || candidate.state !== "draft") {
            await done;
            return false;
          }
          if (JSON.stringify(candidate.operation) !== JSON.stringify(entry.operation)) {
            await done;
            throw new JournalError("A journal generation cannot be replaced with different content.");
          }
        }
      }
      const key = journalEntryKey(entry);
      for (const candidate of existing) {
        if (candidate.authorScope === entry.authorScope && candidate.state === "draft" && candidate.key !== key) {
          store.delete(candidate.key);
        }
      }
      store.put({ ...entry, key, updatedAt: Date.now() });
      await done;
      return true;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "draft");
    }
  }

  async getDocument(repository: RepositoryIdentity, path: string, authorScope: string): Promise<JournalEntry[]> {
    const key = documentKey(repository, path);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(ENTRY_STORE).index("documentKey").getAll(key)) as JournalEntry[];
      await done;
      return records
        .filter((entry) => entry.version === 1 && entry.documentKey === key && entry.authorScope === authorScope)
        .sort((left, right) => left.operation.generation - right.operation.generation || left.updatedAt - right.updatedAt);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  async getRepository(repository: RepositoryIdentity, authorScope: string): Promise<JournalEntry[]> {
    const key = repositoryKey(repository);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(ENTRY_STORE).index("repositoryKey").getAll(key)) as JournalEntry[];
      await done;
      return records
        .filter((entry) => entry.version === 1 && entry.repositoryKey === key && entry.authorScope === authorScope)
        .sort((left, right) => left.updatedAt - right.updatedAt);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  async getAllEntries(): Promise<JournalEntry[]> {
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const entries = await requestValue(transaction.objectStore(ENTRY_STORE).getAll()) as JournalEntry[];
      await done;
      return entries
        .filter((entry) => entry.version === 1)
        .map((entry) => ({ ...entry, authorScope: typeof entry.authorScope === "string" && entry.authorScope.length > 0 ? entry.authorScope : null }));
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  async putProposal(repository: RepositoryIdentity, authorScope: string, proposal: ChangeProposal, status?: ProposalStatus): Promise<void> {
    if (!authorScope) throw new JournalError("The proposal has no author identity scope.");
    if (!proposal || !/^[A-Za-z0-9_-]{1,128}$/u.test(proposal.id) || !Array.isArray(proposal.operations) || !proposal.operations.length ||
        !["author", "module", "mcp"].includes(proposal.source) || repositoryKey(proposal.snapshot.repository) !== repositoryKey(repository)) {
      throw new JournalError("The proposal has an invalid identity or belongs to a different repository.");
    }
    for (const operation of proposal.operations) {
      assertChangeOperation(operation);
      if (repositoryKey(operation.repository) !== repositoryKey(repository) || operation.baseRemoteCommit !== proposal.snapshot.remoteCommit) {
        throw new JournalError("The proposal contains an operation for a different repository snapshot.");
      }
    }
    if (status) {
      const statusProposal = status.proposal;
      if (!statusProposal || statusProposal.id !== proposal.id || repositoryKey(statusProposal.snapshot.repository) !== repositoryKey(repository) ||
          statusProposal.snapshot.remoteCommit !== proposal.snapshot.remoteCommit || statusProposal.source !== proposal.source ||
          !Array.isArray(statusProposal.operations) || !statusProposal.operations.length) {
        throw new JournalError("The review status does not match the journaled proposal identity.");
      }
      if (status.payloadComplete === false) {
        if (!/^[a-f0-9]{64}$/u.test(status.originalDigest ?? "") || !Array.isArray(status.operationIds) ||
            status.operationIds.length < statusProposal.operations.length || new Set(status.operationIds).size !== status.operationIds.length ||
            !statusProposal.operations.every((operation) => status.operationIds!.includes(operation.id))) {
          throw new JournalError("The partial review status is missing its original proposal binding.");
        }
        for (const operation of statusProposal.operations) {
          assertChangeOperation(operation);
          if (repositoryKey(operation.repository) !== repositoryKey(repository) || operation.baseRemoteCommit !== proposal.snapshot.remoteCommit) {
            throw new JournalError("The partial review status contains an operation for a different repository snapshot.");
          }
        }
      } else if (stableJson(statusProposal) !== stableJson(proposal)) {
        throw new JournalError("The review status does not contain the complete journaled proposal.");
      }
    }
    const owner = repositoryKey(repository);
    const record: JournalProposal = {
      key: JSON.stringify([owner, authorScope, proposal.id]),
      repositoryKey: owner,
      authorScope,
      repository,
      proposal,
      ...(status ? { status } : {}),
      createdAt: Date.now(),
    };
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(PROPOSAL_STORE);
      const existing = await requestValue(store.get(record.key)) as JournalProposal | undefined;
      if (existing && (existing.authorScope !== authorScope || existing.repositoryKey !== owner)) {
        await done;
        throw new JournalError("A proposal ID cannot be reused for a different author, repository, or payload.");
      }
      const existingWasPartial = existing?.status?.payloadComplete === false;
      const retryRestoredOriginal = Boolean(existing && existingWasPartial && status?.payloadComplete !== false &&
        JSON.stringify(proposal.operations.map((operation) => operation.id)) === JSON.stringify(existing.status?.operationIds) &&
        stableJson(status?.proposal) === stableJson(proposal));
      if (existingWasPartial && status?.payloadComplete === false &&
          (existing!.status?.originalDigest !== status.originalDigest ||
            JSON.stringify(existing!.status?.operationIds) !== JSON.stringify(status.operationIds))) {
        await done;
        throw new JournalError("The partial proposal's immutable original binding changed.");
      }
      if (existing && stableJson(existing.proposal) !== stableJson(proposal) &&
          !(status?.payloadComplete === false || retryRestoredOriginal)) {
        await done;
        throw new JournalError("A proposal ID cannot be reused for a different author, repository, or payload.");
      }
      // A partial Git recovery is only the accepted subset. Never let it replace a complete
      // browser copy; retain that private payload while updating the server review status.
      const keepCompletePrivatePayload = Boolean(existing && status?.payloadComplete === false && !existingWasPartial);
      const effectiveProposal = keepCompletePrivatePayload
        ? existing!.proposal
        : existingWasPartial && status?.payloadComplete === false
          ? {
            ...proposal,
            operations: status.operationIds!.flatMap((id) => {
              const known = existing!.proposal.operations.find((operation) => operation.id === id);
              const latest = proposal.operations.find((operation) => operation.id === id);
              return known ? [known] : latest ? [latest] : [];
            }),
            ...(existing!.proposal.evidence ? { evidence: existing!.proposal.evidence } : {}),
          }
          : proposal;
      const updated: JournalProposal = existing
        ? {
          ...existing,
          proposal: effectiveProposal,
          ...(status ? { status } : {}),
          ...(status && (status.approvedOperationIds.length > 0 || status.checkpoints.length > 0 || status.publishedOperationIds.length > 0)
            ? { dismissedAt: undefined }
            : {}),
          createdAt: existing.createdAt,
        }
        : record;
      if (!existing || (status && stableJson(existing.status) !== stableJson(status))) store.put(updated);
      await done;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "module proposal");
    }
  }

  async getProposals(repository: RepositoryIdentity, authorScope: string): Promise<JournalProposal[]> {
    const key = repositoryKey(repository);
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(PROPOSAL_STORE).index("repositoryKey").getAll(key)) as JournalProposal[];
      await done;
      return records.filter((record) => record.repositoryKey === key && record.authorScope === authorScope && record.dismissedAt === undefined).sort((left, right) => left.createdAt - right.createdAt);
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async dismissProposal(repository: RepositoryIdentity, authorScope: string, proposalId: string): Promise<void> {
    const key = JSON.stringify([repositoryKey(repository), authorScope, proposalId]);
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(PROPOSAL_STORE);
      const record = await requestValue(store.get(key)) as JournalProposal | undefined;
      if (!record || record.authorScope !== authorScope || record.repositoryKey !== repositoryKey(repository)) {
        await done;
        throw new JournalError("The exact proposal is no longer in this author recovery journal.");
      }
      store.put({ ...record, dismissedAt: Date.now() });
      await done;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "module proposal");
    }
  }

  async getAllProposals(): Promise<JournalProposal[]> {
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(PROPOSAL_STORE).getAll()) as JournalProposal[];
      await done;
      return records.map((record) => ({
        ...record,
        authorScope: typeof record.authorScope === "string" && record.authorScope.length > 0 ? record.authorScope : null,
      }));
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async removeProposal(repository: RepositoryIdentity, authorScope: string, proposalId: string): Promise<void> {
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(PROPOSAL_STORE).delete(JSON.stringify([repositoryKey(repository), authorScope, proposalId]));
      await done;
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async updateState(
    entry: JournalEntry,
    state: JournalState,
    receipt?: CheckpointReceipt,
  ): Promise<JournalEntry> {
    if (!entry.authorScope) throw new JournalError("The recovery record has no author identity scope.");
    const key = journalEntryKey(entry);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const existing = await requestValue(store.get(key)) as JournalEntry | undefined;
      if (!existing || existing.authorScope !== entry.authorScope ||
          existing.operation.id !== entry.operation.id || existing.operation.generation !== entry.operation.generation ||
          JSON.stringify(existing.operation) !== JSON.stringify(entry.operation)) {
        await done;
        throw new JournalError("The exact journal operation was not found; refusing a stale state update.");
      }
      const rank: Record<JournalState, number> = { draft: 0, checkpointing: 1, checkpointed: 2, publication_unknown: 3, conflict: 4 };
      const nextState = rank[state] >= rank[existing.state] ? state : existing.state;
      const updated: JournalEntry = {
        ...existing,
        ...(entry.proposalId ? { proposalId: entry.proposalId } : {}),
        ...(entry.publicationBatchId ? { publicationBatchId: entry.publicationBatchId } : {}),
        ...(entry.authorizedAt ? { authorizedAt: entry.authorizedAt } : {}),
        state: nextState,
        ...(receipt && nextState === "checkpointed" ? { checkpoint: receipt } : {}),
        updatedAt: Date.now(),
      };
      store.put(updated);
      await done;
      return updated;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw storageMessage(error, "draft state");
    }
  }

  async removeEntry(entry: JournalEntry): Promise<void> {
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(ENTRY_STORE).delete(journalEntryKey(entry));
      if (entry.key && entry.key !== journalEntryKey(entry)) transaction.objectStore(ENTRY_STORE).delete(entry.key);
      await done;
    } catch (error) {
      throw storageMessage(error, "draft");
    }
  }

  async acknowledge(repository: RepositoryIdentity, authorScope: string, receipt: PublishReceipt): Promise<number> {
    if (receipt.state !== "confirmed") return 0;
    const acknowledged = new Set(receipt.acknowledged.map((item) => `${item.operationId}\u0000${item.generation}`));
    const owner = repositoryKey(repository);
    try {
      const receiptRecord: PublicationReceiptRecord = {
        key: publicationReceiptKey(repository, authorScope, receipt.batchId),
        repositoryKey: owner,
        authorScope,
        receipt,
        createdAt: Date.now(),
      };
      const receiptTransaction = this.database.transaction(RECEIPT_STORE, "readwrite", { durability: "strict" });
      const receiptDone = transactionDone(receiptTransaction);
      receiptTransaction.objectStore(RECEIPT_STORE).put(receiptRecord);
      await receiptDone;
      if (acknowledged.size === 0) return 0;

      const transaction = this.database.transaction([ENTRY_STORE, PROPOSAL_STORE], "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const proposals = transaction.objectStore(PROPOSAL_STORE);
      const [entries, proposalRecords] = await Promise.all([
        requestValue(store.getAll()) as Promise<JournalEntry[]>,
        requestValue(proposals.getAll()) as Promise<JournalProposal[]>,
      ]);
      let removed = 0;
      for (const entry of entries) {
        const identity = `${entry.operation.id}\u0000${entry.operation.generation}`;
        if (entry.repositoryKey === owner && entry.authorScope === authorScope && entry.publicationBatchId === receipt.batchId && acknowledged.has(identity) && entry.state !== "draft") {
          store.delete(entry.key);
          removed++;
        }
      }
      for (const record of proposalRecords) {
        const remotelyPublished = new Set(record.status?.publishedOperationIds ?? []);
        if (record.repositoryKey === owner && record.authorScope === authorScope && record.proposal.operations.every((operation) =>
          acknowledged.has(`${operation.id}\u0000${operation.generation}`) || remotelyPublished.has(operation.id))) {
          proposals.delete(record.key);
        }
      }
      await done;
      return removed;
    } catch (error) {
      throw storageMessage(error, "publication receipt");
    }
  }

  async getPublicationReceipts(repository: RepositoryIdentity, authorScope: string): Promise<PublishReceipt[]> {
    const owner = repositoryKey(repository);
    try {
      const transaction = this.database.transaction(RECEIPT_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(RECEIPT_STORE).index("repositoryKey").getAll(owner)) as PublicationReceiptRecord[];
      await done;
      return records
        .filter((record) => record.repositoryKey === owner && record.authorScope === authorScope)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((record) => record.receipt);
    } catch (error) {
      throw storageMessage(error, "publication receipt");
    }
  }

  async removeDrafts(repository: RepositoryIdentity, path: string, authorScope: string): Promise<number> {
    const entries = await this.getDocument(repository, path, authorScope);
    const drafts = entries.filter((entry) => entry.state === "draft");
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      for (const entry of drafts) store.delete(entry.key);
      await done;
      return drafts.length;
    } catch (error) {
      throw storageMessage(error, "draft");
    }
  }

  async getScratch(repository: RepositoryIdentity, path: string): Promise<string> {
    const key = documentKey(repository, path);
    try {
      const transaction = this.database.transaction(SCRATCH_STORE, "readonly");
      const done = transactionDone(transaction);
      const record = await requestValue(transaction.objectStore(SCRATCH_STORE).get(key)) as ScratchRecord | undefined;
      await done;
      return record?.text ?? "";
    } catch (error) {
      throw storageMessage(error, "scratch note");
    }
  }

  async putScratch(repository: RepositoryIdentity, path: string, text: string): Promise<void> {
    const record: ScratchRecord = { key: documentKey(repository, path), text, updatedAt: Date.now() };
    try {
      const transaction = this.database.transaction(SCRATCH_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(SCRATCH_STORE).put(record);
      await done;
    } catch (error) {
      throw storageMessage(error, "scratch note");
    }
  }
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
