import { ChangeWriterError } from "./writer.js";
import type { WriterJournalStore, WriterScope, WriterState } from "./writer.js";

interface StoredWriterState { readonly key: string; readonly state: WriterState; }
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
    const request = transaction.objectStore("scopes").get(scopeKey(scope)) as IDBRequest<StoredWriterState | undefined>;
    return new Promise((resolve, reject) => {
      let result: WriterState = EMPTY;
      request.onsuccess = () => { result = request.result?.state ?? EMPTY; };
      request.onerror = () => reject(new ChangeWriterError("storage_unknown", "Proposal receipts could not be read."));
      transaction.oncomplete = () => resolve(result);
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
    const request = store.get(scopeKey(scope)) as IDBRequest<StoredWriterState | undefined>;
    return new Promise((resolve, reject) => {
      let value: T;
      let callbackFailed = false;
      request.onsuccess = () => {
        try {
          const result = update(request.result?.state ?? EMPTY);
          value = result.value;
          store.put({ key: scopeKey(scope), state: result.next } satisfies StoredWriterState);
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

function scopeKey(scope: WriterScope): string {
  return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch, scope.generation]);
}
