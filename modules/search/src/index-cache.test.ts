import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentSource, SnapshotId, SnapshotReader } from "@scriptorium/contracts";
import { isSearchableDocumentPath, SnapshotIndexCache, type DocumentSourceFactory } from "./index-cache.js";

type StoredFile = { content: string; revision: string };
type TestSnapshot = SnapshotId & { files: Map<string, StoredFile>; failChanges?: boolean; failRead?: boolean };

function snapshot(repositoryId: string, remoteCommit: string, files: Record<string, string>, overlayCommit?: string): TestSnapshot {
  const id: SnapshotId = {
    repository: { provider: "local", repositoryId, defaultBranch: "main", ownerScope: "owner", url: `local://${repositoryId}` },
    remoteCommit,
    ...(overlayCommit ? { overlayCommit } : {}),
  };
  return Object.assign(id, { files: new Map(Object.entries(files).map(([path, content]) => [path, { content, revision: contentRevision(content) }])) });
}

function contentRevision(content: string): string {
  let result = 0;
  for (let index = 0; index < content.length; index += 1) result = (result * 33 + content.charCodeAt(index)) >>> 0;
  return result.toString(16).padStart(8, "0").repeat(8);
}

function reader(value: TestSnapshot): SnapshotReader {
  return { snapshot: value, async read() { return null; }, async list() { return []; } };
}

function sourceFactory(counters: { enumerate: number; changes: number; readPaths: string[] }): DocumentSourceFactory {
  return (rawReader) => {
    const current = rawReader.snapshot as TestSnapshot;
    return {
      version: 1,
      snapshot: current,
      async enumerate(prefix) {
        counters.enumerate += 1;
        return [...current.files].filter(([path]) => !prefix || path === prefix || path.startsWith(`${prefix}/`))
          .map(([path, file]) => ({ path, revision: file.revision }));
      },
      async readMany(paths) {
        if (current.failRead) throw new Error("read failed");
        counters.readPaths.push(...paths);
        return paths.map((path) => ({ path, ...current.files.get(path)! }));
      },
      async changes(previous, prefix) {
        counters.changes += 1;
        if (current.failChanges) throw new Error("change calculation failed");
        const prior = new Map(previous.map(({ path, revision }) => [path, revision]));
        const inScope = (path: string) => !prefix || path === prefix || path.startsWith(`${prefix}/`);
        const scopedFiles = [...current.files].filter(([path]) => inScope(path));
        const upserted = scopedFiles.filter(([path, file]) => prior.get(path) !== file.revision).map(([path, file]) => ({ path, revision: file.revision }));
        const paths = new Set(scopedFiles.map(([path]) => path));
        return { upserted, removed: [...prior.keys()].filter((path) => !paths.has(path)) };
      },
    } satisfies DocumentSource;
  };
}

test("index cache filters project data to canonical textual document roots", async () => {
  const first = snapshot("repo-a", "a".repeat(40), {
    "manuscript/v1/c1/s1.md": "Moonlit harbor",
    "plot/v1/c1/s1.yaml": "name: harbor",
    "bible/places/harbor.yaml": "description: moonlit",
    "meta/scratch/notes.md": "local note",
    "meta/scriptorium/modules/search/terms.json": "private term state",
    "meta/scriptorium/operations/checkpoint.json": "private operation state",
    "attachments/cover.png": "binary",
    "unrelated/readme.md": "unrelated text",
    "plot/.hidden/source.md": "hidden text",
  });
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  const cache = new SnapshotIndexCache(sourceFactory(counters));
  const indexed = await cache.get(reader(first), new AbortController().signal);
  assert.deepEqual([...indexed.documents.keys()].sort(), [
    "bible/places/harbor.yaml", "manuscript/v1/c1/s1.md", "meta/scratch/notes.md", "plot/v1/c1/s1.yaml",
  ]);
  assert.equal(counters.readPaths.some((path) => path.startsWith("meta/scriptorium/")), false);
  assert.equal(counters.readPaths.some((path) => path.startsWith("attachments/")), false);
  assert.equal(isSearchableDocumentPath("meta/scriptorium/modules/search/terms.json"), false);
});

test("unchanged snapshots reuse the index and changed revisions update and remove only their entries", async () => {
  const first = snapshot("repo-a", "a".repeat(40), {
    "manuscript/v1/c1/s1.md": "old harbor",
    "manuscript/v1/c1/s2.md": "remove me",
  });
  const second = snapshot("repo-a", "b".repeat(40), {
    "manuscript/v1/c1/s1.md": "new harbor",
    "manuscript/v1/c1/s3.md": "new scene",
  });
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  const cache = new SnapshotIndexCache(sourceFactory(counters));
  const initial = await cache.get(reader(first), new AbortController().signal);
  const repeated = await cache.get(reader(first), new AbortController().signal);
  assert.equal(repeated, initial);
  assert.equal(counters.enumerate, 4);
  assert.equal(counters.readPaths.length, 2);
  const updated = await cache.get(reader(second), new AbortController().signal);
  assert.equal(counters.changes, 4);
  assert.deepEqual([...updated.documents.keys()].sort(), ["manuscript/v1/c1/s1.md", "manuscript/v1/c1/s3.md"]);
  assert.equal(updated.documents.get("manuscript/v1/c1/s1.md")?.content, "new harbor");
  assert.equal(updated.documents.has("manuscript/v1/c1/s2.md"), false);
  assert.deepEqual(counters.readPaths.slice(2), ["manuscript/v1/c1/s1.md", "manuscript/v1/c1/s3.md"]);
});

test("overlay and repository identity isolate index cache entries", async () => {
  const base = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "base" });
  const overlay = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "checkpoint overlay" }, "b".repeat(40));
  const other = snapshot("repo-b", "a".repeat(40), { "manuscript/v1/c1/s1.md": "other repository" });
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  const cache = new SnapshotIndexCache(sourceFactory(counters));
  const baseIndex = await cache.get(reader(base), new AbortController().signal);
  const overlayIndex = await cache.get(reader(overlay), new AbortController().signal);
  const otherIndex = await cache.get(reader(other), new AbortController().signal);
  assert.notEqual(baseIndex, overlayIndex);
  assert.notEqual(baseIndex, otherIndex);
  assert.equal(overlayIndex.documents.get("manuscript/v1/c1/s1.md")?.content, "checkpoint overlay");
  assert.equal(otherIndex.documents.get("manuscript/v1/c1/s1.md")?.content, "other repository");
  assert.equal(counters.enumerate, 8);
  assert.equal(counters.changes, 4);
});

test("failed refresh never projects an older index as the requested snapshot", async () => {
  const first = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "old" });
  const failed = snapshot("repo-a", "b".repeat(40), { "manuscript/v1/c1/s1.md": "new" });
  failed.failChanges = true;
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  const cache = new SnapshotIndexCache(sourceFactory(counters));
  const initial = await cache.get(reader(first), new AbortController().signal);
  await assert.rejects(cache.get(reader(failed), new AbortController().signal), /change calculation failed/u);
  assert.equal((await cache.get(reader(first), new AbortController().signal)), initial);
  assert.equal(initial.snapshot.remoteCommit, "a".repeat(40));
});

test("aborted indexing does not cache a partial snapshot", async () => {
  const first = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "first" });
  const controller = new AbortController();
  let abortOnce = true;
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  const cache = new SnapshotIndexCache((rawReader) => {
    const factory = sourceFactory(counters);
    const source = factory(rawReader);
    return { ...source, async enumerate(prefix) {
      const rows = await source.enumerate(prefix);
      if (abortOnce) { abortOnce = false; controller.abort(); }
      return rows;
    } };
  });
  await assert.rejects(cache.get(reader(first), controller.signal), (error: unknown) => (error as { name?: string }).name === "AbortError");
  const retried = await cache.get(reader(first), new AbortController().signal);
  assert.equal(retried.documents.size, 1);
  assert.equal(counters.enumerate, 5);
});

test("disabled module disposal cannot let an unfinished read repopulate the cache", async () => {
  const first = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "first" });
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  let started!: () => void;
  let release!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  let shouldBlock = true;
  const blockedRead = new Promise<void>((resolve) => { release = resolve; });
  const cache = new SnapshotIndexCache((rawReader) => {
    const source = sourceFactory(counters)(rawReader);
    return { ...source, async readMany(paths) {
      if (shouldBlock) { started(); await blockedRead; }
      return source.readMany(paths);
    } };
  });
  const pending = cache.get(reader(first), new AbortController().signal);
  await readStarted;
  cache.clear();
  release();
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === "job_cancelled");
  shouldBlock = false;
  assert.equal((await cache.get(reader(first), new AbortController().signal)).documents.size, 1);
});

test("source responses outside an explicitly requested root are rejected", async () => {
  const first = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "text" });
  const cache = new SnapshotIndexCache((rawReader) => {
    const source = sourceFactory({ enumerate: 0, changes: 0, readPaths: [] })(rawReader);
    return { ...source, async enumerate(prefix) {
      const rows = await source.enumerate(prefix);
      return prefix === "manuscript" ? [...rows, { path: "plot/private.md", revision: contentRevision("private") }] : rows;
    } };
  });
  await assert.rejects(cache.get(reader(first), new AbortController().signal), /outside its requested root/u);
});

test("a new request after cancellation starts fresh work instead of joining an aborted build", async () => {
  const first = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "first" });
  const controller = new AbortController();
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  let firstEnumeration = true;
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const cache = new SnapshotIndexCache((rawReader) => {
    const source = sourceFactory(counters)(rawReader);
    return { ...source, async enumerate(prefix) {
      const rows = await source.enumerate(prefix);
      if (firstEnumeration) {
        firstEnumeration = false;
        controller.abort();
        started();
        await blocked;
      }
      return rows;
    } };
  });
  const cancelled = cache.get(reader(first), controller.signal);
  await entered;
  await assert.rejects(cancelled);
  const retry = await cache.get(reader(first), new AbortController().signal);
  assert.equal(retry.documents.size, 1);
  release();
});

test("cancelling one shared requester leaves another active request on the same snapshot intact", async () => {
  const first = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "first" });
  const cancelledController = new AbortController();
  const activeController = new AbortController();
  const counters = { enumerate: 0, changes: 0, readPaths: [] as string[] };
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let blockFirstRoot = true;
  const cache = new SnapshotIndexCache((rawReader) => {
    const source = sourceFactory(counters)(rawReader);
    return { ...source, async enumerate(prefix) {
      const rows = await source.enumerate(prefix);
      if (blockFirstRoot) {
        blockFirstRoot = false;
        started();
        await blocked;
      }
      return rows;
    } };
  });
  const cancelled = cache.get(reader(first), cancelledController.signal);
  await entered;
  const active = cache.get(reader(first), activeController.signal);
  cancelledController.abort();
  await assert.rejects(cancelled, (error: unknown) => (error as { name?: string }).name === "AbortError");
  release();
  assert.equal((await active).documents.size, 1);
});

test("document sources must bind to the exact requested snapshot including checkpoint overlay", async () => {
  const expected = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "expected" }, "b".repeat(40));
  const wrong = snapshot("repo-a", "a".repeat(40), { "manuscript/v1/c1/s1.md": "wrong" });
  const cache = new SnapshotIndexCache((rawReader) => {
    const source = sourceFactory({ enumerate: 0, changes: 0, readPaths: [] })(rawReader);
    return { ...source, snapshot: wrong };
  });
  await assert.rejects(cache.get(reader(expected), new AbortController().signal), /not bound to the requested snapshot/u);
});

