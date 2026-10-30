import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import { readKnowledgeSnapshot, readSceneManuscript, type FileChunk, type PagedFileList, type SnapshotFileEntry, type SnapshotReader } from "./snapshot.js";

const encoder = new TextEncoder();
const sources: Record<string, string> = {
  "bible/characters/char-1.yaml": "id: char-1\nname: Duplicate\n",
  "bible/characters/char-1/profile.yaml": "id: char-1\nname: Nested duplicate\n",
  "bible/characters/char-2/profile.yaml": [
    "id: char-2", "name: 灯", "aliases:", "  - あかり", "notes:", "  lead:", "    - type: paragraph", "      text: known note", "  sections: []", "custom:", "  ownerField: preserve", "",
  ].join("\n"),
  "bible/characters/char-2/voice.yaml": "firstPerson: [私]\ntone: calm\n",
  "bible/locations/loc-1.yaml": "id: loc-1\nname: Harbor\ntravel:\n  daysTo: 2\n",
  "bible/locations/bad.yaml": "id: [unterminated\n",
  "plot/volumes/v1/volume.yaml": "id: vol-1\ntype: volume\ntitle: First Volume\norder: 1\n",
  "plot/volumes/v1/chapters/c1/chapter.yaml": "id: ch-1\ntype: chapter\ntitle: First Chapter\nvolume: vol-1\norder: 1\n",
  "plot/volumes/v1/chapters/c1/scenes/scene-1.yaml": [
    "id: scene-1", "type: scene", "title: 灯の場面", "chapter: ch-1", "order: 1", "pov: char-1", "location: loc-missing", "appears: [char-2]", "manuscript: manuscript/v1/c1/actual.md", "",
  ].join("\n"),
  "meta/tags.yaml": "character: [lead]\n",
  "manuscript/v1/c1/actual.md": "\uFEFF---\r\ntitle: Scene\r\n---\r\n灯😀\r\n",
};

class FixtureReader implements SnapshotReader {
  readonly snapshot: Snapshot = { id: "snapshot-1", local_commit: null, worktree_generation: "g1", draft_generation: null };
  readonly listedPrefixes: string[] = [];
  readonly readPaths: string[] = [];
  readonly contents = new Map(Object.entries(sources).map(([path, text]) => [path, encoder.encode(text)]));
  readonly entries = new Map<string, SnapshotFileEntry>([...this.contents].map(([path, bytes]) => [path, {
    path, revision: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.byteLength, media_type: path.endsWith(".md") ? "text/markdown" : "application/yaml",
  }]));

  *list(input: { snapshot: Snapshot; prefix: string; cursor?: string; limit: number }): Generator<never, PagedFileList, unknown> {
    assert.deepEqual(input.snapshot, this.snapshot);
    this.listedPrefixes.push(input.prefix);
    const all = [...this.entries.values()].filter((entry) => entry.path === input.prefix || entry.path.startsWith(`${input.prefix.replace(/\/$/u, "")}/`)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const start = input.cursor ? Number(input.cursor) : 0;
    const pageSize = Math.min(input.limit, 2);
    const entries = all.slice(start, start + pageSize);
    const end = start + entries.length;
    return { entries, next_cursor: end < all.length ? String(end) : null };
  }

  *read(input: { snapshot: Snapshot; path: string; offset: number; length: number }): Generator<never, FileChunk, unknown> {
    assert.deepEqual(input.snapshot, this.snapshot);
    this.readPaths.push(input.path);
    const bytes = this.contents.get(input.path);
    const entry = this.entries.get(input.path);
    if (!bytes || !entry) throw new Error("file_not_found");
    const slice = bytes.slice(input.offset, input.offset + Math.min(input.length, 5));
    const next = input.offset + slice.byteLength;
    return {
      revision: entry.revision, total_bytes: bytes.byteLength, offset: input.offset, bytes: slice,
      next_offset: next < bytes.byteLength ? next : null,
    };
  }
}

function drain<T>(task: Generator<unknown, T, unknown>): T {
  const state = task.next();
  assert.equal(state.done, true, "fixture reads do not yield Host calls");
  return state.value;
}

test("Knowledge snapshot pages listings and reads exact bytes without eager manuscript import", () => {
  const reader = new FixtureReader();
  const story = drain(readKnowledgeSnapshot(reader));

  assert.deepEqual([...new Set(reader.listedPrefixes)].sort(), ["bible", "meta", "plot"]);
  assert.ok(reader.readPaths.length > 10, "the test input crosses multiple short byte ranges");
  assert.ok(!reader.readPaths.some((path) => path.startsWith("manuscript/")));
  assert.deepEqual(story.duplicateIds.get("char-1"), ["bible/characters/char-1.yaml", "bible/characters/char-1/profile.yaml"]);
  assert.equal(story.entities.has("char-1"), false, "ambiguous entity IDs must never be last-write-wins");
  assert.equal(story.entities.get("char-2")?.raw.voice && (story.entities.get("char-2")!.raw.voice as Record<string, unknown>).tone, "calm");
  assert.equal(story.entities.get("vol-1")?.name, "First Volume");
  assert.equal(story.entities.get("ch-1")?.name, "First Chapter");
  assert.equal(story.entities.get("scene-1")?.name, "灯の場面");
  assert.equal((story.entities.get("char-2")?.raw.custom as Record<string, unknown>).ownerField, "preserve");
  assert.ok(story.diagnostics.some((row) => row.code === "duplicate_id" && row.entityId === "char-1"));
  assert.ok(story.diagnostics.some((row) => row.code === "unsupported_format" && row.path === "bible/locations/bad.yaml"));
  assert.ok(story.diagnostics.some((row) => row.code === "broken_reference" && row.message.includes("loc-missing")));
});

test("scene manuscript reads preserve explicit path, CRLF, Unicode and final newline across chunks", () => {
  const reader = new FixtureReader();
  const manuscript = drain(readSceneManuscript(reader, "manuscript/v1/c1/actual.md"));
  assert.equal(manuscript.content, sources["manuscript/v1/c1/actual.md"]);
  assert.ok(reader.readPaths.every((path) => path === "manuscript/v1/c1/actual.md"));
});

test("scene manuscript reader rejects unsafe paths before Host access", () => {
  const reader = new FixtureReader();
  assert.throws(() => drain(readSceneManuscript(reader, "manuscript/../secrets.md")), /invalid_path/u);
  assert.equal(reader.listedPrefixes.length, 0);
});

test("approved scene and chapter summaries remain auxiliary snapshot files", () => {
  const reader = new FixtureReader();
  for (const path of ["plot/volumes/v1/chapters/c1/scene-summaries/scene-1.yaml", "plot/volumes/v1/chapters/c1/chapter-summary.yaml"]) {
    const bytes = encoder.encode("summaryLines: [one, two, three]\n");
    reader.contents.set(path, bytes);
    reader.entries.set(path, { path, revision: createHash("sha256").update(bytes).digest("hex"), byte_length: bytes.length, media_type: "application/yaml" });
  }
  const story = drain(readKnowledgeSnapshot(reader));
  for (const path of ["plot/volumes/v1/chapters/c1/scene-summaries/scene-1.yaml", "plot/volumes/v1/chapters/c1/chapter-summary.yaml"]) {
    assert.ok(story.files.has(path));
    assert.ok(story.revisions.has(path));
    assert.ok(!story.diagnostics.some((diagnostic) => diagnostic.path === path));
  }
  assert.ok(story.diagnostics.some((diagnostic) => diagnostic.path === "bible/locations/bad.yaml"));
});
