import {
  assertChangeOperation,
  type ChangeOperation,
  type ChangeProposal,
  type CheckpointReceipt,
  type PublishReceipt,
  type RepositoryIdentity,
  type SnapshotId,
} from "@scriptorium/contracts";

const DATABASE_NAME = "scriptorium-recovery";
const DATABASE_VERSION = 2;
const ENTRY_STORE = "operations";
const SCRATCH_STORE = "scratch";
const PROPOSAL_STORE = "proposals";

export type JournalState = "draft" | "checkpointing" | "checkpointed" | "publication_unknown" | "conflict";

export interface JournalEntry {
  version: 1;
  key: string;
  repositoryKey: string;
  documentKey: string;
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
  repository: RepositoryIdentity;
  proposal: ChangeProposal;
  createdAt: number;
}

interface ScratchRecord {
  key: string;
  text: string;
  updatedAt: number;
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

export function journalEntryKey(entry: Pick<JournalEntry, "documentKey" | "operation">): string {
  return JSON.stringify([entry.documentKey, entry.operation.id]);
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
      assertChangeOperation(entry.operation);
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(ENTRY_STORE).put({ ...entry, key: journalEntryKey(entry), updatedAt: Date.now() });
      await done;
    } catch (error) {
      throw storageMessage(error, "draft");
    }
  }

  /** Keep one editable draft per document while retaining every authorized operation. */
  async putLatestDraft(entry: JournalEntry): Promise<void> {
    try {
      assertChangeOperation(entry.operation);
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      const store = transaction.objectStore(ENTRY_STORE);
      const existing = await requestValue(store.index("documentKey").getAll(entry.documentKey)) as JournalEntry[];
      for (const candidate of existing) {
        if (candidate.state === "draft" && candidate.key !== journalEntryKey(entry)) store.delete(candidate.key);
      }
      store.put({ ...entry, key: journalEntryKey(entry), updatedAt: Date.now() });
      await done;
    } catch (error) {
      throw storageMessage(error, "draft");
    }
  }

  async getDocument(repository: RepositoryIdentity, path: string): Promise<JournalEntry[]> {
    const key = documentKey(repository, path);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(ENTRY_STORE).index("documentKey").getAll(key)) as JournalEntry[];
      await done;
      return records
        .filter((entry) => entry.version === 1 && entry.documentKey === key)
        .sort((left, right) => left.operation.generation - right.operation.generation || left.updatedAt - right.updatedAt);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  async getRepository(repository: RepositoryIdentity): Promise<JournalEntry[]> {
    const key = repositoryKey(repository);
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(ENTRY_STORE).index("repositoryKey").getAll(key)) as JournalEntry[];
      await done;
      return records
        .filter((entry) => entry.version === 1 && entry.repositoryKey === key)
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
      return entries.filter((entry) => entry.version === 1);
    } catch (error) {
      throw storageMessage(error, "recovery journal");
    }
  }

  async putProposal(repository: RepositoryIdentity, proposal: ChangeProposal): Promise<void> {
    for (const operation of proposal.operations) assertChangeOperation(operation);
    const key = repositoryKey(repository);
    const record: JournalProposal = {
      key: JSON.stringify([key, proposal.id]),
      repositoryKey: key,
      repository,
      proposal,
      createdAt: Date.now(),
    };
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(PROPOSAL_STORE).put(record);
      await done;
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async getProposals(repository: RepositoryIdentity): Promise<JournalProposal[]> {
    const key = repositoryKey(repository);
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(PROPOSAL_STORE).index("repositoryKey").getAll(key)) as JournalProposal[];
      await done;
      return records.filter((record) => record.repositoryKey === key).sort((left, right) => left.createdAt - right.createdAt);
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async getAllProposals(): Promise<JournalProposal[]> {
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readonly");
      const done = transactionDone(transaction);
      const records = await requestValue(transaction.objectStore(PROPOSAL_STORE).getAll()) as JournalProposal[];
      await done;
      return records;
    } catch (error) {
      throw storageMessage(error, "module proposal");
    }
  }

  async removeProposal(repository: RepositoryIdentity, proposalId: string): Promise<void> {
    try {
      const transaction = this.database.transaction(PROPOSAL_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(PROPOSAL_STORE).delete(JSON.stringify([repositoryKey(repository), proposalId]));
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
    const updated: JournalEntry = {
      ...entry,
      key: journalEntryKey(entry),
      state,
      ...(receipt ? { checkpoint: receipt } : {}),
      updatedAt: Date.now(),
    };
    await this.put(updated);
    return updated;
  }

  async removeEntry(entry: JournalEntry): Promise<void> {
    try {
      const transaction = this.database.transaction(ENTRY_STORE, "readwrite", { durability: "strict" });
      const done = transactionDone(transaction);
      transaction.objectStore(ENTRY_STORE).delete(entry.key || journalEntryKey(entry));
      await done;
    } catch (error) {
      throw storageMessage(error, "draft");
    }
  }

  async acknowledge(repository: RepositoryIdentity, receipt: PublishReceipt): Promise<number> {
    if (receipt.state !== "confirmed") return 0;
    const acknowledged = new Set(receipt.acknowledged.map((item) => `${item.operationId}\u0000${item.generation}`));
    const owner = repositoryKey(repository);
    if (acknowledged.size === 0) return 0;
    try {
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
        if (entry.repositoryKey === owner && entry.publicationBatchId === receipt.batchId && acknowledged.has(identity) && entry.state !== "draft") {
          store.delete(entry.key);
          removed++;
        }
      }
      for (const record of proposalRecords) {
        if (record.repositoryKey === owner && record.proposal.operations.every((operation) => acknowledged.has(`${operation.id}\u0000${operation.generation}`))) {
          proposals.delete(record.key);
        }
      }
      await done;
      return removed;
    } catch (error) {
      throw storageMessage(error, "publication receipt");
    }
  }

  async removeDrafts(repository: RepositoryIdentity, path: string): Promise<number> {
    const entries = await this.getDocument(repository, path);
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
