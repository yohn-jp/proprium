import { ChangeWriterError } from "./writer.js";
import type { PersistedProposal, WriterJournalStore, WriterScope, WriterState } from "./writer.js";

interface StoredWriterState { readonly key: string; readonly state: WriterState; }
/** The journal belongs to the durable workspace, not an activation's ephemeral generation. */
function scopeKey(scope: WriterScope): string {
  return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch]);
}

function scopedRecords(all: readonly StoredWriterState[], scope: WriterScope): StoredWriterState[] {
  const key = scopeKey(scope);
  const legacyPrefix = key.slice(0, -1) + ",";
  return all.filter(item => item.key === key || item.key.startsWith(legacyPrefix));
}

/** Merge legacy per-generation receipts without discarding interrupted writes. */
function recoverLegacyRows(rows: readonly StoredWriterState[]): WriterState {
  if (rows.length === 0) return EMPTY;
  if (rows.length === 1) return rows[0]!.state;
  const proposals: Record<string, PersistedProposal> = Object.create(null);
  const idempotency: Record<string, WriterState["idempotency"][string]> = Object.create(null);
  const timestamps: Record<string, string> = Object.create(null);
  let writeAhead: WriterState["write_ahead"] = null;
  let sequence = 0;
  const events: WriterState["events"][number][] = [];
  for (const row of rows) {
    const state = row.state;
    sequence = Math.max(sequence, state.sequence);
    for (const [id, proposal] of Object.entries(state.proposals)) {
      if (Object.hasOwn(proposals, id)) throw new ChangeWriterError("storage_unknown", "Conflicting legacy proposal receipts require manual recovery.");
      proposals[id] = proposal;
    }
    for (const [id, receipt] of Object.entries(state.idempotency)) {
      if (Object.hasOwn(idempotency, id) && (idempotency[id]!.proposal_id !== receipt.proposal_id ||
          idempotency[id]!.request_digest !== receipt.request_digest)) {
        throw new ChangeWriterError("storage_unknown", "Conflicting legacy idempotency receipts require manual recovery.");
      }
      idempotency[id] = receipt;
    }
    for (const [id, timestamp] of Object.entries(state.timestamps)) {
      if (Object.hasOwn(timestamps, id) && timestamps[id] !== timestamp) {
        throw new ChangeWriterError("storage_unknown", "Conflicting legacy timestamps require manual recovery.");
      }
      timestamps[id] = timestamp;
    }
    if (state.write_ahead) {
      if (writeAhead) throw new ChangeWriterError("storage_unknown", "Multiple interrupted legacy writers require manual recovery.");
      writeAhead = state.write_ahead;
    }
    events.push(...state.events);
  }
  // A single interrupted unit may be recovered. Never silently drop a second, unrelated interruption.
  const unresolved = Object.values(proposals).filter(value => value.record.status === "applying" || value.record.status === "storage_unknown");
  if (writeAhead && unresolved.some(item => item.record.proposal_id !== writeAhead!.proposal_id)) {
    throw new ChangeWriterError("storage_unknown", "Unrelated legacy applying receipts require manual recovery.");
  }
  events.sort((left, right) => left.at.localeCompare(right.at) || left.sequence - right.sequence);
  const resequenced = events.map((item, index) => Object.freeze({ ...item, sequence: index + 1 }));
  return Object.freeze({
    sequence: Math.max(sequence, resequenced.length),
    proposals: Object.freeze(proposals), idempotency: Object.freeze(idempotency),
    timestamps: Object.freeze(timestamps), write_ahead: writeAhead, events: Object.freeze(resequenced),
  });
}

const EMPTY: WriterState = Object.freeze({
  sequence: 0,
  proposals: Object.freeze({}),
  idempotency: Object.freeze({}),
  timestamps: Object.freeze({}),
  write_ahead: null,
  events: Object.freeze([]),
});

/** Durable browser journal. Each callback and full scope state commits atomically. */
export class IndexedDbWriterJournalStore implements WriterJournalStore {
  private database?: Promise<IDBDatabase>;

  constructor(private readonly databaseName = "proprium-authoring-writer", private readonly databaseVersion = 1) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new ChangeWriterError("storage_unknown", "IndexedDB is unavailable for proposal receipts."));
        return;
      }
      const request = indexedDB.open(this.databaseName, this.databaseVersion);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("scopes")) request.result.createObjectStore("scopes", { keyPath: "key" });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipt storage could not be opened."));
      request.onblocked = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipt storage upgrade is blocked by another tab."));
    });
    return this.database;
  }

  async read(scope: WriterScope): Promise<WriterState> {
    const db = await this.open();
    const transaction = db.transaction("scopes", "readonly");
    const request = transaction.objectStore("scopes").getAll() as IDBRequest<StoredWriterState[]>;
    return new Promise((resolve, reject) => {
      let result: WriterState = EMPTY;
      let callbackFailed = false;
      request.onsuccess = () => {
        try { result = recoverLegacyRows(scopedRecords(request.result, scope)); }
        catch (error) { callbackFailed = true; reject(error); }
      };
      request.onerror = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipts could not be read."));
      transaction.oncomplete = () => { if (!callbackFailed) resolve(result); };
      transaction.onerror = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipt read transaction failed."));
      transaction.onabort = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipt read transaction was interrupted."));
    });
  }

  async transact<T>(scope: WriterScope, update: (current: WriterState) => { readonly next: WriterState; readonly value: T }): Promise<T> {
    const db = await this.open();
    let transaction: IDBTransaction;
    try { transaction = db.transaction("scopes", "readwrite", { durability: "strict" }); }
    catch { throw new ChangeWriterError("storage_unknown", "This browser cannot provide strict durable proposal receipt transactions."); }
    const store = transaction.objectStore("scopes");
    const request = store.getAll() as IDBRequest<StoredWriterState[]>;
    return new Promise((resolve, reject) => {
      let value: T;
      let callbackFailed = false;
      request.onsuccess = () => {
        try {
          const records = scopedRecords(request.result, scope);
          const result = update(recoverLegacyRows(records));
          value = result.value;
          store.put({ key: scopeKey(scope), state: result.next } satisfies StoredWriterState);
          // The new stable record and removal of all old-generation records are one transaction.
          for (const legacy of records) if (legacy.key !== scopeKey(scope)) store.delete(legacy.key);
        } catch (error) {
          callbackFailed = true;
          try { transaction.abort(); } catch { /* The transaction already completed. */ }
          reject(error);
        }
      };
      request.onerror = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipt state could not be loaded for update."));
      transaction.oncomplete = () => { if (!callbackFailed) resolve(value!); };
      transaction.onerror = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipt transaction failed."));
      transaction.onabort = () => { if (!callbackFailed) reject(new ChangeWriterError("storage_unknown", "Proposal receipt transaction was interrupted.")); };
    });
  }
}
 
