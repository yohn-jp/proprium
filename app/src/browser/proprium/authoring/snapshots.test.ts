import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuthoringSnapshotError,
  AuthoringSnapshotReader,
  type AuthoringScope,
  type SnapshotFile,
  type SnapshotLease,
  type SnapshotPage,
  type SnapshotPort,
} from "./snapshots.js";

const scope: AuthoringScope = Object.freeze({
  workspace_id: "workspace-0001",
  repository_id: 8123,
  branch: "main",
  generation: "generation-1",
});

class FixturePort implements SnapshotPort {
  readonly files = new Map<string, Uint8Array>();
  readonly largestRead = { bytes: 0 };
  listed = 0;
  listingCursorScope: string | null = null;
  mutateAfterFirstRange = false;
  private rangeCount = 0;
  private readonly lease: SnapshotLease;

  constructor() {
    this.lease = Object.freeze({
      scope,
      snapshot: Object.freeze({
        id: "snapshot-1", local_commit: "abc123", worktree_generation: "generation-1", draft_generation: null,
      }),
      host_token: "test-only-token",
    });
  }

  async pin(requested: AuthoringScope, options: { include_draft: boolean }): Promise<SnapshotLease> {
    assert.deepEqual(requested, scope);
    assert.equal(options.include_draft, false);
    return this.lease;
  }

  async assert_current(lease: SnapshotLease): Promise<void> {
    if (lease.snapshot.id !== this.lease.snapshot.id) throw Object.assign(new Error("Stale snapshot"), { code: "snapshot_stale" });
  }

  async list(_lease: SnapshotLease, query: { prefix: string; cursor: string | null; limit: number }): Promise<SnapshotPage> {
    if (query.cursor !== this.listingCursorScope && query.cursor !== null) throw new Error("Unknown fixture cursor");
    this.listingCursorScope = query.cursor === null ? null : this.listingCursorScope;
    const paths = [...this.files.keys()].filter(path => path.startsWith(query.prefix)).sort(compareUtf8);
    const start = query.cursor === null ? 0 : Number(query.cursor);
    const selected = paths.slice(start, start + query.limit);
    this.listed += selected.length;
    const items = await Promise.all(selected.map(async path => this.metadata(path)));
    const next = start + selected.length;
    const cursor = next < paths.length ? String(next) : null;
    this.listingCursorScope = cursor;
    return { items, next_cursor: cursor };
  }

  async stat(_lease: SnapshotLease, path: string): Promise<SnapshotFile | null> {
    return this.files.has(path) ? this.metadata(path) : null;
  }

  async read_range(_lease: SnapshotLease, path: string, offset: number, length: number) {
    const data = this.files.get(path);
    if (!data) throw Object.assign(new Error("Missing file"), { code: "file_not_found" });
    this.rangeCount += 1;
    const bytes = data.slice(offset, offset + length);
    this.largestRead.bytes = Math.max(this.largestRead.bytes, bytes.byteLength);
    if (this.mutateAfterFirstRange && this.rangeCount === 2) bytes[0] = (bytes[0]! + 1) & 0xff;
    return {
      bytes,
      total_bytes: data.byteLength,
      offset,
      revision: await digest(data),
    };
  }

  private async metadata(path: string): Promise<SnapshotFile> {
    const bytes = this.files.get(path)!;
    return {
      path,
      revision: await digest(bytes),
      byte_length: bytes.byteLength,
      media_type: path.endsWith(".md") ? "text/markdown" : "application/yaml",
    };
  }
}

test("pins a scope and pages a large hierarchy without imposing the v1 file or byte limit", async () => {
  const port = new FixturePort();
  for (let index = 0; index < 301; index += 1) {
    port.files.set(`plot/volumes/v1/chapters/c${String(index).padStart(3, "0")}/scenes/s${String(index).padStart(3, "0")}.yaml`,
      new TextEncoder().encode(`id: s${index}\r\ntitle: Scene ${index}\r\n`));
    port.files.set(`manuscript/v1/c${String(index).padStart(3, "0")}/s${String(index).padStart(3, "0")}.md`, new Uint8Array(9 * 1024).fill(index & 0xff));
  }
  const longText = `${"漢字《かんじ》\r\n本文。".repeat(11_000)}\r\n`;
  const longBytes = new TextEncoder().encode(longText);
  assert.ok(longBytes.byteLength > 130 * 1024);
  port.files.set("manuscript/v1/c000/long.md", longBytes);
  assert.ok([...port.files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0) > 2 * 1024 * 1024);

  const reader = new AuthoringSnapshotReader(port);
  const lease = await reader.pin(scope);
  assert.equal(lease.snapshot.draft_generation, null);
  const paths: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await reader.list(lease, { prefix: "plot/volumes/v1/chapters/", cursor, limit: 73 });
    assert.ok(page.items.length <= 73);
    paths.push(...page.items.map(item => item.path));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(paths.length, 301);
  assert.equal(port.listed, 301);
  for (let index = 1; index < paths.length; index += 1) assert.ok(compareUtf8(paths[index - 1]!, paths[index]!) < 0);

  const first = await reader.read(lease, "manuscript/v1/c000/long.md", { offset: 65_535, length: 65_536 });
  assert.equal(first.total_bytes, longBytes.byteLength);
  assert.equal(first.revision, await digest(longBytes));
  assert.equal(first.bytes.byteLength, 65_536);
  assert.equal(first.next_offset, 65_535 + 65_536);
  assert.deepEqual(first.bytes, longBytes.subarray(65_535, 65_535 + 65_536));
  assert.ok(port.largestRead.bytes <= 256 * 1024);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  let decoded = "";
  let chunkIndex = 0;
  let nextOffset: number | null;
  do {
    const chunk = await reader.read(lease, "manuscript/v1/c000/long.md", { offset, length: chunkIndex === 0 ? 65_537 : 65_536 });
    decoded += decoder.decode(chunk.bytes, { stream: chunk.next_offset !== null });
    nextOffset = chunk.next_offset;
    if (nextOffset !== null) offset = nextOffset;
    chunkIndex += 1;
  } while (nextOffset !== null);
  assert.ok(chunkIndex > 3);
  assert.equal(decoded, longText);
});

test("rejects cursors reused for another prefix, snapshot or workspace and rejects unsafe paths", async () => {
  const port = new FixturePort();
  port.files.set("bible/characters/a.yaml", new TextEncoder().encode("id: a\n"));
  port.files.set("bible/locations/a.yaml", new TextEncoder().encode("id: a\n"));
  const reader = new AuthoringSnapshotReader(port);
  const lease = await reader.pin(scope);
  const first = await reader.list(lease, { prefix: "bible/", limit: 1 });
  assert.ok(first.next_cursor);
  await assert.rejects(reader.list(lease, { prefix: "manuscript/", cursor: first.next_cursor }), error =>
    error instanceof AuthoringSnapshotError && error.code === "invalid_input");
  await assert.rejects(reader.read(lease, "../secret.md"), error =>
    error instanceof AuthoringSnapshotError && error.code === "invalid_path");
  await assert.rejects(reader.read(lease, "bible/missing.yaml"), error =>
    error instanceof AuthoringSnapshotError && error.code === "file_not_found");
});

test("fails closed when pinned byte content no longer matches its SHA-256 revision", async () => {
  const port = new FixturePort();
  port.files.set("manuscript/large.md", new Uint8Array(400 * 1024).fill(0x61));
  const reader = new AuthoringSnapshotReader(port);
  const lease = await reader.pin(scope);
  port.mutateAfterFirstRange = true;
  await assert.rejects(reader.read(lease, "manuscript/large.md", { offset: 0, length: 128 }), error =>
    error instanceof AuthoringSnapshotError && error.code === "snapshot_stale");
  assert.ok(port.largestRead.bytes <= 256 * 1024);
});

async function digest(bytes: Uint8Array): Promise<string> {
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...result].map(value => value.toString(16).padStart(2, "0")).join("");
}

function compareUtf8(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}
