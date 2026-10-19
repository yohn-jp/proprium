import { assertProjectPath, createDocumentSource, snapshotKey, type DocumentSource, type FileRevision, type SnapshotId, type SnapshotReader } from "@scriptorium/contracts";
import { createSearchDocument, type SearchDocument } from "./search-ranking.js";

const MAX_INDEXES = 4;
const MAX_DOCUMENTS = 10_000;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const READ_BATCH = 48;
const MAX_SOURCE_PATHS = 100_000;
const DOCUMENT_ROOTS = ["manuscript", "plot", "bible", "meta/scratch"] as const;

export interface IndexedSnapshot {
  key: string;
  snapshot: SnapshotId;
  documents: ReadonlyMap<string, SearchDocument>;
  revisions: ReadonlyMap<string, string>;
  revisionList: readonly FileRevision[];
  bytes: number;
}

export type DocumentSourceFactory = (reader: SnapshotReader) => DocumentSource;

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? Object.assign(new Error("Search indexing was cancelled"), { code: "job_cancelled" });
}

function repositoryKey(snapshot: SnapshotId): string {
  const repository = snapshot.repository;
  return JSON.stringify([repository.provider, repository.ownerScope, repository.repositoryId, repository.defaultBranch]);
}

export function isSearchableDocumentPath(path: string): boolean {
  const lower = path.toLowerCase();
  const inManuscript = lower.startsWith("manuscript/");
  const inPlot = lower.startsWith("plot/");
  const inBible = lower.startsWith("bible/");
  const inScratch = lower.startsWith("meta/scratch/");
  if (!inManuscript && !inPlot && !inBible && !inScratch) return false;
  if (lower.split("/").some((part) => part.startsWith("."))) return false;
  const extension = lower.slice(lower.lastIndexOf(".") + 1);
  if (inManuscript || inScratch) return ["md", "markdown", "txt"].includes(extension);
  return ["md", "markdown", "txt", "yaml", "yml", "json"].includes(extension);
}

function isWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function validateRevisions(items: readonly FileRevision[], root?: string, allowDeleted = false): FileRevision[] {
  if (!Array.isArray(items) || items.length > MAX_SOURCE_PATHS) throw Object.assign(new Error("Document source returned too many paths"), { code: "search_index_limit" });
  const seen = new Set<string>();
  const selected: FileRevision[] = [];
  for (const item of items) {
    if (!item || typeof item.path !== "string") {
      throw Object.assign(new Error("Document source returned an invalid searchable revision"), { code: "invalid_document_source" });
    }
    assertProjectPath(item.path);
    if (root && !isWithinRoot(item.path, root)) throw Object.assign(new Error("Document source returned a path outside its requested root"), { code: "invalid_document_source" });
    if (!isSearchableDocumentPath(item.path)) continue;
    if (item.revision === null) {
      if (allowDeleted) {
        if (seen.has(item.path)) throw Object.assign(new Error("Document source returned a duplicate path"), { code: "invalid_document_source" });
        seen.add(item.path);
        selected.push({ path: item.path, revision: null });
      }
      continue;
    }
    if (typeof item.revision !== "string" || !/^[a-f0-9]{40,64}$/u.test(item.revision)) {
      throw Object.assign(new Error("Document source returned an invalid searchable revision"), { code: "invalid_document_source" });
    }
    if (seen.has(item.path)) throw Object.assign(new Error("Document source returned a duplicate path"), { code: "invalid_document_source" });
    seen.add(item.path);
    selected.push({ path: item.path, revision: item.revision });
    if (selected.length > MAX_DOCUMENTS) throw Object.assign(new Error("Snapshot has too many searchable documents"), { code: "search_index_limit" });
  }
  return selected;
}

async function idle(signal: AbortSignal): Promise<void> {
  checkAborted(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkAborted(signal);
}

async function enumerateDocuments(source: DocumentSource, signal: AbortSignal): Promise<FileRevision[]> {
  const items: FileRevision[] = [];
  for (const root of DOCUMENT_ROOTS) {
    checkAborted(signal);
    const listed = validateRevisions(await source.enumerate(root), root);
    checkAborted(signal);
    items.push(...listed);
    if (items.length > MAX_DOCUMENTS) throw Object.assign(new Error("Snapshot has too many searchable documents"), { code: "search_index_limit" });
  }
  return items.sort((left, right) => left.path.localeCompare(right.path));
}

async function changedDocuments(source: DocumentSource, previous: readonly FileRevision[], signal: AbortSignal): Promise<{ upserted: FileRevision[]; removed: string[] }> {
  const upserted: FileRevision[] = [];
  const removed: string[] = [];
  for (const root of DOCUMENT_ROOTS) {
    checkAborted(signal);
    const prior = previous.filter(({ path }) => path === root || path.startsWith(`${root}/`));
    const delta = await source.changes(prior, root);
    checkAborted(signal);
    if (!delta || !Array.isArray(delta.upserted) || !Array.isArray(delta.removed)) {
      throw Object.assign(new Error("Document source returned an invalid change set"), { code: "invalid_document_source" });
    }
    const rootUpserts = validateRevisions(delta.upserted, root, true);
    if (upserted.length + rootUpserts.length > MAX_SOURCE_PATHS) throw Object.assign(new Error("Document change set exceeds its path limit"), { code: "search_index_limit" });
    upserted.push(...rootUpserts);
    for (const path of delta.removed) {
      if (typeof path !== "string") throw Object.assign(new Error("Document source returned an invalid removed path"), { code: "invalid_document_source" });
      assertProjectPath(path);
      if (!isWithinRoot(path, root)) throw Object.assign(new Error("Document source removed a path outside its requested root"), { code: "invalid_document_source" });
      if (isSearchableDocumentPath(path)) {
        if (removed.length >= MAX_SOURCE_PATHS) throw Object.assign(new Error("Document change set exceeds its path limit"), { code: "search_index_limit" });
        removed.push(path);
      }
    }
    if (upserted.length > MAX_SOURCE_PATHS || removed.length > MAX_SOURCE_PATHS) {
      throw Object.assign(new Error("Document change set exceeds its path limit"), { code: "search_index_limit" });
    }
  }
  return { upserted, removed };
}

interface SharedWork<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason ?? Object.assign(new Error("Search request was cancelled"), { code: "job_cancelled" })); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

async function readUpserts(
  source: DocumentSource,
  upserts: readonly FileRevision[],
  signal: AbortSignal,
): Promise<Map<string, SearchDocument>> {
  const output = new Map<string, SearchDocument>();
  const validated = validateRevisions(upserts);
  for (let index = 0; index < validated.length; index += READ_BATCH) {
    checkAborted(signal);
    const batch = validated.slice(index, index + READ_BATCH);
    const files = await source.readMany(batch.map(({ path }) => path));
    checkAborted(signal);
    if (!Array.isArray(files) || files.length !== batch.length) {
      throw Object.assign(new Error("Document source did not return every indexed document"), { code: "invalid_document_source" });
    }
    const expected = new Map(batch.map((item) => [item.path, item.revision]));
    for (const file of files) {
      const revision = expected.get(file.path);
      if (!revision || file.revision !== revision || typeof file.content !== "string" || output.has(file.path)) {
        throw Object.assign(new Error("Document source returned a mismatched document revision"), { code: "invalid_document_source" });
      }
      const bytes = new TextEncoder().encode(file.content).byteLength;
      if (bytes > MAX_DOCUMENT_BYTES) throw Object.assign(new Error(`Searchable document exceeds ${MAX_DOCUMENT_BYTES} bytes: ${file.path}`), { code: "search_document_limit" });
      output.set(file.path, createSearchDocument(file.path, revision, file.content));
    }
    if (index + READ_BATCH < validated.length) await idle(signal);
  }
  return output;
}

export class SnapshotIndexCache {
  private readonly entries = new Map<string, IndexedSnapshot>();
  private readonly inflight = new Map<string, SharedWork<IndexedSnapshot>>();
  private readonly pathEntries = new Map<string, ReadonlySet<string>>();
  private readonly pathInflight = new Map<string, SharedWork<ReadonlySet<string>>>();
  private generation = 0;

  constructor(private readonly makeSource: DocumentSourceFactory = createDocumentSource) {}

  private sourceFor(reader: SnapshotReader): DocumentSource {
    const source = this.makeSource(reader);
    if (!source || source.version !== 1 || !source.snapshot || snapshotKey(source.snapshot) !== snapshotKey(reader.snapshot)) {
      throw Object.assign(new Error("Document source is not bound to the requested snapshot"), { code: "invalid_document_source" });
    }
    return source;
  }

  async get(reader: SnapshotReader, signal: AbortSignal): Promise<IndexedSnapshot> {
    checkAborted(signal);
    const key = snapshotKey(reader.snapshot);
    const cached = this.entries.get(key);
    if (cached) {
      this.touch(this.entries, key, cached);
      return cached;
    }
    return this.runShared(this.inflight, key, signal, (internalSignal, generation) =>
      this.build(this.sourceFor(reader), reader.snapshot, key, internalSignal, generation));
  }

  async documentPaths(reader: SnapshotReader, signal: AbortSignal): Promise<ReadonlySet<string>> {
    checkAborted(signal);
    const key = snapshotKey(reader.snapshot);
    const cached = this.pathEntries.get(key);
    if (cached) {
      this.touch(this.pathEntries, key, cached);
      return cached;
    }
    const indexed = this.entries.get(key);
    if (indexed) {
      const paths = new Set(indexed.revisions.keys());
      this.rememberPaths(key, paths);
      return paths;
    }
    return this.runShared(this.pathInflight, key, signal, async (internalSignal, generation) => {
      const source = this.sourceFor(reader);
      const listed = await enumerateDocuments(source, internalSignal);
      checkAborted(internalSignal);
      if (generation !== this.generation) throw Object.assign(new Error("Search cache was closed"), { code: "job_cancelled" });
      const paths = new Set(listed.map(({ path }) => path));
      this.rememberPaths(key, paths);
      return paths;
    });
  }

  clear(): void {
    this.generation += 1;
    for (const task of this.inflight.values()) task.controller.abort(Object.assign(new Error("Search module was disabled"), { code: "job_cancelled" }));
    for (const task of this.pathInflight.values()) task.controller.abort(Object.assign(new Error("Search module was disabled"), { code: "job_cancelled" }));
    this.entries.clear();
    this.pathEntries.clear();
    this.inflight.clear();
    this.pathInflight.clear();
  }

  private async build(source: DocumentSource, snapshot: SnapshotId, key: string, signal: AbortSignal, generation: number): Promise<IndexedSnapshot> {
    checkAborted(signal);
    const repo = repositoryKey(snapshot);
    const previous = [...this.entries.values()].reverse().find((entry) => repositoryKey(entry.snapshot) === repo);
    let documents = new Map(previous?.documents ?? []);
    let revisions: FileRevision[];
    let upserts: FileRevision[];
    if (previous) {
      const delta = await changedDocuments(source, previous.revisionList, signal);
      const removed = new Set<string>();
      for (const path of delta.removed) {
        assertProjectPath(path);
        if (!isSearchableDocumentPath(path)) continue;
        if (removed.has(path)) throw Object.assign(new Error("Document source returned a duplicate removed path"), { code: "invalid_document_source" });
        removed.add(path);
        documents.delete(path);
      }
      for (const item of delta.upserted) {
        if (item?.revision === null && typeof item.path === "string") {
          assertProjectPath(item.path);
          if (isSearchableDocumentPath(item.path)) {
            removed.add(item.path);
            documents.delete(item.path);
          }
        }
      }
      upserts = validateRevisions(delta.upserted).filter(({ path }) => !removed.has(path));
      for (const { path } of upserts) documents.delete(path);
      revisions = [...new Map([...documents.values()].map((document) => [document.path, { path: document.path, revision: document.revision }])).values(), ...upserts]
        .sort((left, right) => left.path.localeCompare(right.path));
    } else {
      upserts = await enumerateDocuments(source, signal);
      revisions = upserts;
    }
    const read = await readUpserts(source, upserts, signal);
    for (const [path, document] of read) documents.set(path, document);
    if (documents.size > MAX_DOCUMENTS || documents.size !== revisions.length) {
      throw Object.assign(new Error("Searchable document set is inconsistent or exceeds its limit"), { code: "search_index_limit" });
    }
    let bytes = 0;
    for (const document of documents.values()) bytes += new TextEncoder().encode(document.content).byteLength;
    if (bytes > MAX_INDEX_BYTES) throw Object.assign(new Error("Search index exceeds its bounded memory budget"), { code: "search_index_limit" });
    checkAborted(signal);
    if (generation !== this.generation) throw Object.assign(new Error("Search cache was closed"), { code: "job_cancelled" });
    const entry: IndexedSnapshot = { key, snapshot, documents, revisions: new Map(revisions.map(({ path, revision }) => [path, revision!])), revisionList: revisions, bytes };
    this.rememberIndex(key, entry);
    this.rememberPaths(key, new Set(revisions.map(({ path }) => path)));
    return entry;
  }

  private async runShared<T>(
    map: Map<string, SharedWork<T>>,
    key: string,
    signal: AbortSignal,
    work: (internalSignal: AbortSignal, generation: number) => Promise<T>,
  ): Promise<T> {
    let task = map.get(key);
    if (task?.controller.signal.aborted && !task.settled) {
      if (map.get(key) === task) map.delete(key);
      task = undefined;
    }
    if (!task) {
      const controller = new AbortController();
      const generation = this.generation;
      const created: SharedWork<T> = { controller, promise: Promise.resolve(undefined as T), waiters: 0, settled: false };
      created.promise = Promise.resolve().then(() => work(controller.signal, generation)).finally(() => {
        created.settled = true;
        if (map.get(key) === created) map.delete(key);
      });
      map.set(key, created);
      void created.promise.catch(() => {});
      task = created;
    }
    task.waiters += 1;
    try { return await awaitWithSignal(task.promise, signal); }
    finally {
      task.waiters -= 1;
      if (task.waiters === 0 && !task.settled) task.controller.abort(Object.assign(new Error("Search request was cancelled"), { code: "job_cancelled" }));
    }
  }

  private rememberIndex(key: string, entry: IndexedSnapshot): void {
    this.touch(this.entries, key, entry);
    while (this.entries.size > MAX_INDEXES || [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_INDEX_BYTES * 2) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === key) break;
      this.entries.delete(oldest);
      this.pathEntries.delete(oldest);
    }
  }

  private rememberPaths(key: string, paths: ReadonlySet<string>): void {
    this.touch(this.pathEntries, key, paths);
    while (this.pathEntries.size > MAX_INDEXES) {
      const oldest = this.pathEntries.keys().next().value;
      if (oldest === undefined) break;
      this.pathEntries.delete(oldest);
    }
  }

  private touch<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
  }
}

