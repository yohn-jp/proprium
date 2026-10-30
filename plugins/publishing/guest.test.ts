import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { guest } from "./guest.js";

type FileValue = { text?: string; bytes?: Uint8Array };

const files = new Map<string, FileValue>([
  ["meta/project.yaml", { text: "title: 夜の旅\nsubtitle: 雨の町\n" }],
  ["plot/volumes/v1/volume.yaml", { text: "id: v1\ntitle: 第一巻\n" }],
  ["plot/volumes/v1/chapters/c1/chapter.yaml", { text: "id: c1\ntitle: はじまり\n" }],
  ["plot/volumes/v1/chapters/c1/scenes/s1.yaml", { text: "id: s1\ntitle: 雨の夜\n" }],
  ["manuscript/v1/c1/s1.md", { text: "---\ntitle: Draft title\nprivate_note: do not export\n---\n｜夜《よる》の町で《《雨》》が降った。\n" }],
  ["plot/volumes/v2/volume.yaml", { text: "id: v2\ntitle: 第二巻\n" }],
  ["plot/volumes/v2/chapters/c2/chapter.yaml", { text: "id: c2\ntitle: 別の巻\n" }],
  ["plot/volumes/v2/chapters/c2/scenes/s2.yaml", { text: "id: s2\ntitle: 別の場面\n" }],
  ["manuscript/v2/c2/s2.md", { text: "この場面は選択外。\n" }],
  ["meta/scriptorium/modules/publishing/episodes.yaml", { text: "ownerNote: keep\nepisodes:\n  - id: e1\n    number: 1\n    title: 第一話\n    scope: chapter\n    scopeId: c1\n    publishedAt: '2026-01-02'\n    extension: preserve-me\n" }],
]);

const tree = {
  tree_revision: "tree-r1",
  diagnostics: [],
  next_cursor: null,
} as const;

const treeItems = new Map<string | null, unknown[]>([
  [null, [
    { id: "v1", kind: "volume", title: "第一巻", order: 2, parent_id: null,
      metadata_path: "plot/volumes/v1/volume.yaml", metadata_revision: "rev-volume" },
    { id: "v2", kind: "volume", title: "第二巻", order: 1, parent_id: null,
      metadata_path: "plot/volumes/v2/volume.yaml", metadata_revision: "rev-volume-2" },
  ]],
  ["v1", [{ id: "c1", kind: "chapter", title: "はじまり", order: 1, parent_id: "v1",
    metadata_path: "plot/volumes/v1/chapters/c1/chapter.yaml", metadata_revision: "rev-chapter" }]],
  ["c1", [{ id: "s1", kind: "scene", title: "雨の夜", order: 3, parent_id: "c1",
    metadata_path: "plot/volumes/v1/chapters/c1/scenes/s1.yaml", metadata_revision: "rev-scene",
    manuscript_path: "manuscript/v1/c1/s1.md" }]],
  ["v2", [{ id: "c2", kind: "chapter", title: "別の巻", order: 1, parent_id: "v2",
    metadata_path: "plot/volumes/v2/chapters/c2/chapter.yaml", metadata_revision: "rev-chapter-2" }]],
  ["c2", [{ id: "s2", kind: "scene", title: "別の場面", order: 1, parent_id: "c2",
    metadata_path: "plot/volumes/v2/chapters/c2/scenes/s2.yaml", metadata_revision: "rev-scene-2",
    manuscript_path: "manuscript/v2/c2/s2.md" }]],
]);

function bytesFor(path: string): Uint8Array {
  const value = files.get(path);
  if (!value) throw Object.assign(new Error(`Missing fixture ${path}`), { code: "file_not_found" });
  return value.bytes ?? new TextEncoder().encode(value.text ?? "");
}

function actionResult<T>(value: T): { ok: true; value: T; warnings: string[] } {
  return { ok: true, value, warnings: [] };
}

function makeHost(providerConfigured = false, remoteConfirmed = true) {
  const artifactChunks = new Map<string, Uint8Array[]>();
  const artifactMeta = new Map<string, { filename: string; media_type: string; total_bytes: number; sha256: string }>();
  const proposals: unknown[] = [];
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  let nextArtifactId = 0;
  const request = (operation: string, payload: Record<string, unknown>): unknown => {
    calls.push({ operation, payload });
    if (operation === "workspace.file.list") {
      const prefix = payload.prefix as string;
      const entries = [...files.keys()].filter(path => path.startsWith(prefix)).sort().map(path => ({
        path, revision: createHash("sha256").update(bytesFor(path)).digest("hex"),
        byte_length: bytesFor(path).byteLength, media_type: path.endsWith(".yaml") || path.endsWith(".md") ? "text/plain" : "application/octet-stream",
      }));
      return { entries, next_cursor: null };
    }
    if (operation === "workspace.file.read") {
      const path = payload.path as string;
      const bytes = bytesFor(path);
      const offset = payload.offset as number;
      const part = bytes.slice(offset, offset + (payload.length as number));
      return {
        revision: createHash("sha256").update(bytes).digest("hex"),
        total_bytes: bytes.byteLength, offset, bytes: Array.from(part),
        next_offset: offset + part.byteLength < bytes.byteLength ? offset + part.byteLength : null,
      };
    }
    if (operation === "workspace.plugin.invoke") {
      assert.equal(payload.plugin_id, "proprium.narrative");
      assert.equal(payload.action_id, "proprium.narrative.hierarchy.tree");
      const input = payload.input as Record<string, unknown>;
      return actionResult({ ...tree, parent_id: input.parent_id ?? null, items: treeItems.get((input.parent_id ?? null) as string | null) ?? [] });
    }
    if (operation === "artifact.create") {
      const artifactId = `artifact-${++nextArtifactId}`;
      artifactChunks.set(artifactId, []);
      artifactMeta.set(artifactId, { filename: payload.filename as string, media_type: payload.media_type as string, total_bytes: 0, sha256: "" });
      return { artifact_id: artifactId, max_bytes: 128 * 1024 * 1024 };
    }
    if (operation === "artifact.append") {
      const id = payload.artifact_id as string;
      const chunks = artifactChunks.get(id);
      assert.ok(chunks);
      assert.equal(payload.sequence, chunks.length);
      const bytes = Uint8Array.from(payload.bytes as number[]);
      assert.ok(bytes.byteLength <= 64 * 1024);
      chunks.push(bytes);
      return {};
    }
    if (operation === "artifact.seal") {
      const id = payload.artifact_id as string;
      const all = Uint8Array.from(artifactChunks.get(id)!.flatMap(part => [...part]));
      const sha256 = createHash("sha256").update(all).digest("hex");
      assert.equal(payload.total_bytes, all.byteLength);
      assert.equal(payload.sha256, sha256);
      Object.assign(artifactMeta.get(id)!, { total_bytes: all.byteLength, sha256 });
      return { ...artifactMeta.get(id)!, artifact_id: id };
    }
    if (operation === "artifact.discard") {
      artifactChunks.delete(payload.artifact_id as string);
      artifactMeta.delete(payload.artifact_id as string);
      return {};
    }
    if (operation === "workspace.change.propose") {
      proposals.push(payload.changeset);
      return { proposal_id: `proposal-${proposals.length}` };
    }
    if (operation === "workspace.capabilities.query") {
      assert.deepEqual(payload, { capability_id: "publishing.share-reader.v1" });
      return { available: providerConfigured };
    }
    if (operation === "workspace.identity.read") {
      const path = "meta/scriptorium/modules/publishing/share-grants.jsonl";
      assert.deepEqual(payload, { paths: [path] });
      const source = files.get(path);
      const revision = source ? createHash("sha256").update(bytesFor(path)).digest("hex") : null;
      return {
        scope: { workspace_id: "workspace-1", repository_id: 42, branch: "main", generation: "g1" },
        snapshot: { id: "snapshot-1", local_commit: null, worktree_generation: "g1", draft_generation: null, remote_commit: "remote-1" },
        device_id: "device-1", legacy_project_ids: [],
        publication: {
          remote_commit: remoteConfirmed ? "remote-1" : "remote-previous",
          files: [{ path, revision: remoteConfirmed ? revision : null, remote_confirmed: remoteConfirmed }],
        },
      };
    }
    if (operation === "publishing.share-reader.v1.capabilities") {
      assert.deepEqual(Object.keys(payload).sort(), ["branch", "remote_commit", "repository_id"]);
      return providerConfigured
        ? { available: true, service_id: "test-reader", origin: "https://reader.example", host_public_origin: "https://host.example", reader_version: 1, max_expiry_hours: 87600 }
        : { available: false, service_id: "test-reader", origin: "https://reader.example", host_public_origin: "https://host.example", reader_version: 1, max_expiry_hours: 87600, reason: "provider_unavailable" };
    }
    if (operation === "secret.token.create") return { handle: "host-private-handle", sha256: "b".repeat(64) };
    if (operation === "workspace.change.timestamp") return { timestamp: "2026-10-26T12:00:00.000Z" };
    throw Object.assign(new Error(`Unexpected Host operation: ${operation}`), { code: "unsupported_operation" });
  };
  return { request, artifactChunks, artifactMeta, proposals, calls };
}

function storedZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

function invoke(action_id: string, input: Record<string, unknown>, host = makeHost()) {
  guest.initialize({ pluginId: "proprium.publishing", version: "0.1.0", workspaceId: "workspace-1" });
  const request = {
    schema_version: 1, request_id: "request-1", plugin_id: "proprium.publishing", action_id,
    scope: { workspace_id: "workspace-1", repository_id: 42, branch: "main", generation: "g1" },
    snapshot: { id: "snapshot-1", local_commit: null, worktree_generation: "g1", draft_generation: null, remote_commit: "remote-1" },
    input, deadline_ms: Date.now() + 30_000, idempotency_key: "operation-1",
  };
  let wire = guest.invoke(JSON.stringify(request));
  try {
    while (true) {
      const message = JSON.parse(wire) as Record<string, unknown>;
      if (message.kind !== "host_call") return { result: message, host };
      try {
        const value = host.request(message.operation as string, message.payload as Record<string, unknown>);
        wire = guest.invoke(JSON.stringify({ kind: "host_response", call_id: message.call_id, ok: true, value }));
      } catch (cause) {
        const error = cause as { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
        wire = guest.invoke(JSON.stringify({
          kind: "host_response", call_id: message.call_id, ok: false,
          error: {
            code: typeof error.code === "string" ? error.code : "storage_unknown",
            message: typeof error.message === "string" ? error.message : "Host operation failed",
            retryable: error.retryable === true,
            ...(error.details ? { details: error.details } : {}),
          },
        }));
      }
    }
  } finally {
    guest.dispose();
  }
}

test("export action reads only its pinned linked manuscript and seals Host artifact bytes", () => {
  const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "chapter", id: "c1", markup: "strip" });
  assert.equal(result.ok, true);
  const value = result.value as Record<string, unknown>;
  assert.equal(value.media_type, "text/plain; charset=utf-8");
  assert.equal(value.filename, "夜の旅-第一巻_はじまり-plain.txt");
  const artifactId = value.artifact_id as string;
  const bytes = Uint8Array.from(host.artifactChunks.get(artifactId)!.flatMap(part => [...part]));
  assert.equal(new TextDecoder().decode(bytes), "# 雨の夜\n\n夜の町で雨が降った。\n");
  assert.equal(bytes.byteLength, value.total_bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), value.sha256);
  assert.ok(host.calls.some(call => call.operation === "workspace.file.read" && call.payload.path === "manuscript/v1/c1/s1.md"));
  assert.ok(!host.calls.some(call => call.operation === "workspace.file.read" && String(call.payload.path).includes("private")));
  assert.ok(!host.calls.some(call => call.operation === "workspace.file.read" && call.payload.path === "manuscript/v2/c2/s2.md"));
  assert.ok(!host.calls.some(call => call.operation === "workspace.plugin.invoke" &&
    (call.payload.input as Record<string, unknown>).parent_id === "c2"));
});

test("all-work export preserves Narrative's multi-volume page order despite order metadata", () => {
  const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "all", markup: "raw" });
  assert.equal(result.ok, true);
  const value = result.value as Record<string, unknown>;
  const artifactId = value.artifact_id as string;
  const bytes = Uint8Array.from(host.artifactChunks.get(artifactId)!.flatMap(part => [...part]));
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.indexOf("# 雨の夜") < text.indexOf("# 別の場面"));
  assert.match(text, /雨の夜[\s\S]*別の場面/u);
});

test("volume export includes only the selected volume", () => {
  const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "volume", id: "v2", markup: "raw" });
  assert.equal(result.ok, true);
  const value = result.value as Record<string, unknown>;
  const bytes = Uint8Array.from(host.artifactChunks.get(value.artifact_id as string)!.flatMap(part => [...part]));
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /別の場面/u);
  assert.doesNotMatch(text, /雨の夜/u);
});

test("vertical print action seals ordered text for the Host-only preview", () => {
  const { result, host } = invoke("proprium.publishing.export.vertical-print", { scope: "all" });
  assert.equal(result.ok, true);
  const value = result.value as Record<string, unknown>;
  assert.equal(value.media_type, "text/plain; charset=utf-8");
  const bytes = Uint8Array.from(host.artifactChunks.get(value.artifact_id as string)!.flatMap(part => [...part]));
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /雨の夜[\s\S]*｜夜《よる》の町/u);
  assert.match(text, /雨の夜[\s\S]*別の場面/u);
  assert.doesNotMatch(text, /<html|<script/iu);
  assert.equal(bytes.byteLength, value.total_bytes);
});

test("unknown scope IDs fail before an artifact is created", () => {
  const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "chapter", id: "unknown", markup: "raw" });
  assert.equal(result.ok, false);
  assert.equal((result.error as { code: string }).code, "invalid_input");
  assert.ok(host.calls.some(call => call.operation === "workspace.plugin.invoke"));
  assert.ok(!host.calls.some(call => call.operation === "artifact.create"));
});

test("a missing linked manuscript reports its exact path and discards its incomplete artifact", () => {
  const path = "manuscript/v1/c1/s1.md";
  const original = files.get(path)!;
  files.delete(path);
  try {
    const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "chapter", id: "c1", markup: "raw" });
    assert.equal(result.ok, false);
    assert.equal((result.error as { code: string }).code, "file_not_found");
    assert.deepEqual((result.error as { details: Record<string, unknown> }).details, { path, reason: "missing_source" });
    assert.ok(host.calls.some(call => call.operation === "artifact.discard"));
  } finally {
    files.set(path, original);
  }
});

test("invalid Markdown frontmatter reports the linked source path and discards output", () => {
  const path = "manuscript/v1/c1/s1.md";
  const original = files.get(path)!;
  files.set(path, { text: "---\ntitle: [\n---\n本文\n" });
  try {
    const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "chapter", id: "c1", markup: "raw" });
    assert.equal(result.ok, false);
    assert.equal((result.error as { code: string }).code, "unsupported_format");
    assert.equal((result.error as { details: Record<string, unknown> }).details.path, path);
    assert.ok(host.calls.some(call => call.operation === "artifact.discard"));
  } finally {
    files.set(path, original);
  }
});

test("unsafe Narrative manuscript paths are rejected before reading or creating artifacts", () => {
  const original = treeItems.get("c1")!;
  treeItems.set("c1", original.map(item => ({ ...(item as Record<string, unknown>), manuscript_path: "../outside.md" })));
  try {
    const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "chapter", id: "c1", markup: "raw" });
    assert.equal(result.ok, false);
    assert.equal((result.error as { code: string }).code, "invalid_path");
    assert.ok(!host.calls.some(call => call.operation === "artifact.create"));
    assert.ok(!host.calls.some(call => call.operation === "workspace.file.read" && call.payload.path === "../outside.md"));
  } finally {
    treeItems.set("c1", original);
  }
});

test("duplicate Narrative identities are rejected instead of selecting an arbitrary page", () => {
  const original = treeItems.get("v1")!;
  treeItems.set("v1", [...original, original[0]!]);
  try {
    const { result, host } = invoke("proprium.publishing.export.plaintext", { scope: "chapter", id: "c1", markup: "raw" });
    assert.equal(result.ok, false);
    assert.equal((result.error as { code: string }).code, "ambiguous_identity");
    assert.ok(!host.calls.some(call => call.operation === "artifact.create"));
  } finally {
    treeItems.set("v1", original);
  }
});

test("EPUB action streams a real EPUB3 package through the artifact continuation", () => {
  const { result, host } = invoke("proprium.publishing.export.epub", {
    scope: "all", include_bible_appendix: false,
  });
  assert.equal(result.ok, true);
  const value = result.value as Record<string, unknown>;
  const artifactId = value.artifact_id as string;
  const bytes = Uint8Array.from(host.artifactChunks.get(artifactId)!.flatMap(part => [...part]));
  const entries = storedZipEntries(bytes);
  assert.equal(entries.get("mimetype") && new TextDecoder().decode(entries.get("mimetype")), "application/epub+zip");
  assert.deepEqual([...entries.keys()][0], "mimetype");
  assert.ok(entries.has("META-INF/container.xml"));
  const chapter = new TextDecoder().decode(entries.get("OEBPS/scene-00001.xhtml"));
  assert.match(chapter, /<ruby>夜<rt>よる<\/rt><\/ruby>/u);
  assert.match(chapter, /class="bouten">雨/u);
  assert.doesNotMatch(chapter, /private_note|Draft title/u);
  assert.equal(value.total_bytes, bytes.byteLength);
});

test("unsupported optional cover is a non-blocking ActionResult warning, not extra value data", () => {
  const { result } = invoke("proprium.publishing.export.epub", {
    scope: "all", include_bible_appendix: false, cover_path: "covers/front.svg",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ["unsupported_cover_type"]);
  assert.ok(!Object.hasOwn(result.value as object, "warnings"));
});

test("episode proposal preserves unknown YAML fields and proposes one guarded metadata write", () => {
  const { result, host } = invoke("proprium.publishing.episodes.propose", {
    expected_metadata_revision: createHash("sha256").update(bytesFor("meta/scriptorium/modules/publishing/episodes.yaml")).digest("hex"),
    expected_tree_revision: "tree-r1",
    episodes: [{ id: "e1", number: 1, title: "第一話・改", scope: "chapter", scope_id: "c1" }],
  });
  assert.equal(result.ok, true);
  assert.equal(host.proposals.length, 1);
  const changeset = host.proposals[0] as { read_set: Array<{ path: string; revision: string | null }>; units: Array<{ operations: Array<{ path: string; content: number[] }> }> };
  assert.deepEqual(changeset.units.flatMap(unit => unit.operations.map(operation => operation.path)), ["meta/scriptorium/modules/publishing/episodes.yaml"]);
  const text = new TextDecoder().decode(Uint8Array.from(changeset.units[0]!.operations[0]!.content));
  assert.match(text, /ownerNote: keep/u);
  assert.match(text, /extension: preserve-me/u);
  assert.match(text, /publishedAt: '2026-01-02'/u);
  assert.match(text, /title: 第一話・改/u);
  assert.ok(changeset.read_set.some(item => item.path === "meta/scriptorium/modules/publishing/episodes.yaml"));
  assert.ok(changeset.read_set.some(item => item.path === "plot/volumes/v1/chapters/c1/chapter.yaml"));
});

test("episode form blanks clear only publication dates and scene annotations", () => {
  const { result, host } = invoke("proprium.publishing.episodes.propose", {
    expected_metadata_revision: createHash("sha256").update(bytesFor("meta/scriptorium/modules/publishing/episodes.yaml")).digest("hex"),
    expected_tree_revision: "tree-r1",
    episodes: [{ id: "e1", number: 1, title: "第一話", scope: "chapter", scope_id: "c1", published_at: "", scene_ids: [] }],
  });
  assert.equal(result.ok, true);
  const changeset = host.proposals[0] as { units: Array<{ operations: Array<{ content: number[] }> }> };
  const text = new TextDecoder().decode(Uint8Array.from(changeset.units[0]!.operations[0]!.content));
  assert.doesNotMatch(text, /publishedAt:/u);
  assert.doesNotMatch(text, /sceneIds:/u);
  assert.match(text, /extension: preserve-me/u);
});

test("episode read presents records by episode number then ID", () => {
  const path = "meta/scriptorium/modules/publishing/episodes.yaml";
  const original = files.get(path)!;
  files.set(path, { text: "episodes:\n  - id: z-last\n    number: 2\n    title: 後\n    scope: chapter\n    scopeId: c1\n  - id: a-first\n    number: 1\n    title: 前\n    scope: chapter\n    scopeId: c1\n" });
  try {
    const { result } = invoke("proprium.publishing.episodes.read", {});
    assert.equal(result.ok, true);
    assert.deepEqual((result.value as { episodes: Array<{ id: string }> }).episodes.map(item => item.id), ["a-first", "z-last"]);
  } finally {
    files.set(path, original);
  }
});

test("legacy episode recovery proposes exact source bytes with source and absent-target guards", () => {
  const sourcePath = "meta/publish-episodes.yaml";
  const source = new TextEncoder().encode(
    "migrationNote: retain comments and extensions\nepisodes:\n  - id: legacy-e1\n    number: 4\n    title: 第四話\n    scope: chapter\n    scopeId: c1\n    futureField: keep-exactly\n",
  );
  const previousTarget = files.get("meta/scriptorium/modules/publishing/episodes.yaml");
  files.delete("meta/scriptorium/modules/publishing/episodes.yaml");
  files.set(sourcePath, { bytes: source });
  try {
    const sourceRevision = createHash("sha256").update(source).digest("hex");
    const inspected = invoke("proprium.publishing.recovery.inspect", {});
    assert.equal(inspected.result.ok, true);
    const recovery = inspected.result.value as {
      episode_sources: Array<{ source_path: string; state: string; source_revision: string | null; target_revision: string | null; episode_count: number }>;
      importable_episode_sources: Array<{ source_path: string; source_revision: string }>;
      import_available: boolean;
    };
    const candidate = recovery.episode_sources.find(item => item.source_path === sourcePath);
    assert.deepEqual(candidate, {
      source_path: sourcePath,
      label: `${sourcePath} — ready (1)`,
      state: "ready",
      source_revision: sourceRevision,
      target_revision: null,
      episode_count: 1,
      detail: "",
    });
    assert.equal(recovery.importable_episode_sources[0]?.source_revision, sourceRevision);
    assert.equal(recovery.import_available, true);
    assert.ok(!inspected.host.calls.some(call => call.operation === "workspace.file.list" &&
      ["app-state/share-tokens.json", "share-tokens.json"].includes(String(call.payload.prefix))));

    const { result, host } = invoke("proprium.publishing.recovery.propose", { source_path: sourcePath });
    assert.equal(result.ok, true);
    const value = result.value as Record<string, unknown>;
    assert.equal(value.status, "proposed");
    assert.equal("source" in value || "content" in value, false);
    const changeset = host.proposals[0] as {
      read_set: Array<{ path: string; revision: string | null }>;
      units: Array<{ operations: Array<{ kind: string; path: string; expected_revision: string | null; content: number[] }> }>;
      domain_evidence: Array<Record<string, unknown>>;
    };
    assert.deepEqual(changeset.read_set, [
      { path: sourcePath, revision: sourceRevision },
      { path: "meta/scriptorium/modules/publishing/episodes.yaml", revision: null },
    ]);
    const [operation] = changeset.units.flatMap(unit => unit.operations);
    assert.deepEqual(operation, {
      id: "publishing-recovery-write-operation-1", kind: "create",
      path: "meta/scriptorium/modules/publishing/episodes.yaml", expected_revision: null, content: [...source],
    });
    assert.equal(changeset.domain_evidence[0]?.source_revision, sourceRevision);
    assert.deepEqual(files.get(sourcePath)?.bytes, source, "the legacy source remains unchanged");
    assert.equal(files.has("meta/scriptorium/modules/publishing/episodes.yaml"), false, "proposal does not write the target itself");
  } finally {
    files.delete(sourcePath);
    if (previousTarget) files.set("meta/scriptorium/modules/publishing/episodes.yaml", previousTarget);
  }
});

test("legacy episode recovery leaves an existing divergent target untouched", () => {
  const sourcePath = "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml";
  files.set(sourcePath, { text: "episodes: []\n" });
  try {
    const { result, host } = invoke("proprium.publishing.recovery.propose", { source_path: sourcePath });
    assert.equal(result.ok, false);
    assert.equal((result.error as Record<string, unknown>).code, "conflict");
    assert.equal(host.proposals.length, 0);
    assert.ok(host.calls.some(call => call.operation === "workspace.file.read" && call.payload.path === sourcePath));
    assert.ok(host.calls.some(call => call.operation === "workspace.file.read" && call.payload.path === "meta/scriptorium/modules/publishing/episodes.yaml"));
  } finally {
    files.delete(sourcePath);
  }
});

test("legacy episode recovery blocks malformed sources and recognizes an exact prior import", () => {
  const sourcePath = "meta/publish-episodes.yaml";
  const targetPath = "meta/scriptorium/modules/publishing/episodes.yaml";
  const previousTarget = files.get(targetPath);
  files.set(sourcePath, { text: "episodes:\n  - id: duplicate\n    number: 1\n    title: A\n    scope: chapter\n    scopeId: c1\n  - id: duplicate\n    number: 2\n    title: B\n    scope: chapter\n    scopeId: c1\n" });
  try {
    const inspected = invoke("proprium.publishing.recovery.inspect", {});
    assert.equal(inspected.result.ok, true);
    const recovery = inspected.result.value as { episode_sources: Array<{ source_path: string; state: string }>; import_available: boolean };
    assert.equal(recovery.episode_sources.find(item => item.source_path === sourcePath)?.state, "invalid");
    assert.equal(recovery.import_available, false);

    const rejected = invoke("proprium.publishing.recovery.propose", { source_path: sourcePath });
    assert.equal(rejected.result.ok, false);
    assert.equal(rejected.host.proposals.length, 0);

    const exactSource = new TextEncoder().encode("episodes: []\n");
    files.set(sourcePath, { bytes: exactSource });
    files.set(targetPath, { bytes: exactSource });
    const alreadyImported = invoke("proprium.publishing.recovery.propose", { source_path: sourcePath });
    assert.equal(alreadyImported.result.ok, true);
    assert.equal((alreadyImported.result.value as Record<string, unknown>).status, "already_imported");
    assert.equal(alreadyImported.host.proposals.length, 0);
  } finally {
    files.delete(sourcePath);
    if (previousTarget) files.set(targetPath, previousTarget);
  }
});

test("retained hashed grants require an explicit repository and branch mapping and use a guarded Host proposal", () => {
  const sourcePath = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  const targetPath = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  const source = new TextEncoder().encode([
    JSON.stringify({ id: "legacy-grant-1", projectId: "scriptorium-work-7", scope: { kind: "chapter", id: "c1" }, label: "校正", tokenHash: "a".repeat(64), createdAt: "2025-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", extension: { note: "preserve me" } }),
    JSON.stringify({ id: "foreign-grant", projectId: "another-work", scope: { kind: "scene", id: "s2" }, label: "別作品", tokenHash: "b".repeat(64), createdAt: "2025-01-02T00:00:00.000Z", expiresAt: "2030-01-02T00:00:00.000Z" }),
  ].join("\n") + "\n");
  const previousTarget = files.get(targetPath);
  files.delete(targetPath);
  files.set(sourcePath, { bytes: source });
  try {
    const sourceRevision = createHash("sha256").update(source).digest("hex");
    const inspected = invoke("proprium.publishing.recovery.inspect", {});
    assert.equal(inspected.result.ok, true);
    const recovery = inspected.result.value as {
      grant_sources: Array<{ source_path: string; state: string; source_revision: string; target_revision: string | null; grant_count: number; project_ids: string[]; target_repository_id: number; target_branch: string }>;
      legacy_project_options: Array<{ value: string; label: string }>;
      grant_import_available: boolean;
      mapping_target: { repository_id: number; branch: string };
    };
    assert.deepEqual(recovery.grant_sources[0], {
      source_path: sourcePath, state: "mapping_required", source_revision: sourceRevision, target_revision: null,
      grant_count: 2, project_ids: ["another-work", "scriptorium-work-7"],
      target_repository_id: 42, target_branch: "main",
      detail: "Confirm the legacy project ID and the displayed Host repository ID and branch before proposing.",
    });
    assert.deepEqual(recovery.legacy_project_options, [
      { value: "another-work", label: "another-work (1)" },
      { value: "scriptorium-work-7", label: "scriptorium-work-7 (1)" },
    ]);
    assert.equal(recovery.grant_import_available, true);
    assert.deepEqual(recovery.mapping_target, { repository_id: 42, branch: "main" });

    const { result, host } = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "scriptorium-work-7", repository_id_confirmation: 42,
      branch_confirmation: "main",
    });
    assert.equal(result.ok, true);
    const value = result.value as Record<string, unknown>;
    assert.equal(value.status, "proposed");
    assert.equal("token" in value || "tokenHash" in value || "content" in value, false);
    const changeset = host.proposals[0] as {
      read_set: Array<{ path: string; revision: string | null }>;
      units: Array<{ operations: Array<{ kind: string; path: string; expected_revision: string | null; content: number[] }> }>;
      domain_evidence: Array<Record<string, unknown>>;
    };
    assert.deepEqual(changeset.read_set, [
      { path: sourcePath, revision: sourceRevision },
      { path: targetPath, revision: null },
    ]);
    const [operation] = changeset.units.flatMap(unit => unit.operations);
    assert.equal(operation?.kind, "create");
    assert.equal(operation?.path, targetPath);
    assert.equal(operation?.expected_revision, null);
    const rows = new TextDecoder().decode(Uint8Array.from(operation!.content)).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, 1, "foreign project IDs are not copied");
    assert.equal(rows[0]?.projectId, "scriptorium-work-7", "the legacy identity is retained as provenance");
    assert.equal(rows[0]?.repositoryId, 42);
    assert.equal(rows[0]?.branch, "main");
    assert.deepEqual(rows[0]?.scope, { kind: "chapter", id: "c1" });
    assert.deepEqual(rows[0]?.extension, { note: "preserve me" });
    assert.equal(rows[0]?.tokenHash, "a".repeat(64));
    assert.equal(changeset.domain_evidence[0]?.legacy_project_id, "scriptorium-work-7");
    assert.deepEqual(files.get(sourcePath)?.bytes, source, "the original source is not rewritten");
    assert.equal(files.has(targetPath), false, "the action only proposes the canonical file");
  } finally {
    files.delete(sourcePath);
    files.delete(targetPath);
    if (previousTarget) files.set(targetPath, previousTarget);
  }
});

test("retained grant mapping rejects foreign IDs, raw secrets, and repository or branch ambiguity", () => {
  const sourcePath = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  const targetPath = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  const previousTarget = files.get(targetPath);
  files.delete(targetPath);
  files.set(sourcePath, { text: JSON.stringify({ id: "safe", projectId: "legacy-work", scope: "ch-1", label: "safe", tokenHash: "c".repeat(64), createdAt: "2025-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" }) + "\n" });
  try {
    const wrongProject = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "foreign-work", repository_id_confirmation: 42, branch_confirmation: "main",
    });
    assert.equal(wrongProject.result.ok, false);
    assert.equal((wrongProject.result.error as Record<string, unknown>).code, "ambiguous_identity");
    assert.equal(wrongProject.host.proposals.length, 0);

    const wrongRepository = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "legacy-work", repository_id_confirmation: 99, branch_confirmation: "main",
    });
    assert.equal(wrongRepository.result.ok, false);
    assert.equal(wrongRepository.host.proposals.length, 0);
    const wrongBranch = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "legacy-work", repository_id_confirmation: 42, branch_confirmation: "release",
    });
    assert.equal(wrongBranch.result.ok, false);
    assert.equal(wrongBranch.host.proposals.length, 0);

    files.set(sourcePath, { text: JSON.stringify({ id: "secret", projectId: "legacy-work", scope: { kind: "chapter", id: "ch-1", token: "raw bearer" }, label: "unsafe", tokenHash: "d".repeat(64), createdAt: "2025-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", ownerId: "account" }) + "\n" });
    const inspection = invoke("proprium.publishing.recovery.inspect", {});
    assert.equal((inspection.result.value as { grant_sources: Array<{ state: string }> }).grant_sources[0]?.state, "invalid");
    const unsafe = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "legacy-work", repository_id_confirmation: 42, branch_confirmation: "main",
    });
    assert.equal(unsafe.result.ok, false);
    assert.equal(unsafe.host.proposals.length, 0);

    files.set(sourcePath, { text: JSON.stringify({ id: "hidden-secret", projectId: "legacy-work", scope: { kind: "chapter", id: "c1" }, label: "unsafe", tokenHash: "f".repeat(64), createdAt: "2025-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", futureNote: "share_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" }) + "\n" });
    const hidden = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "legacy-work", repository_id_confirmation: 42, branch_confirmation: "main",
    });
    assert.equal(hidden.result.ok, false, "bearer-shaped values under extension keys are rejected");
    assert.equal(hidden.host.proposals.length, 0);
  } finally {
    files.delete(sourcePath);
    files.delete(targetPath);
    if (previousTarget) files.set(targetPath, previousTarget);
  }
});

test("retained grant recovery recognizes an exact mapped target and rejects a divergent target", () => {
  const sourcePath = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  const targetPath = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  const previousTarget = files.get(targetPath);
  const sourceGrant = { id: "legacy-grant", projectId: "legacy-work", scope: { kind: "chapter", id: "c1" }, label: "review", tokenHash: "e".repeat(64), createdAt: "2025-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", note: "keep" };
  const mappedGrant = { ...sourceGrant, version: 1, grantVersion: 1, revocationVersion: 0, scope: { kind: "chapter", id: "c1" }, repositoryId: 42, branch: "main" };
  files.set(sourcePath, { text: JSON.stringify(sourceGrant) + "\n" });
  try {
    files.set(targetPath, { text: JSON.stringify(mappedGrant) + "\n" });
    const exact = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "legacy-work", repository_id_confirmation: 42, branch_confirmation: "main",
    });
    assert.equal(exact.result.ok, true, JSON.stringify(exact.result));
    assert.equal((exact.result.value as Record<string, unknown>).status, "already_imported");
    assert.equal(exact.host.proposals.length, 0);

    files.set(targetPath, { text: JSON.stringify({ ...mappedGrant, note: "different" }) + "\n" });
    const conflict = invoke("proprium.publishing.recovery.grants.propose", {
      source_path: sourcePath, legacy_project_id: "legacy-work", repository_id_confirmation: 42, branch_confirmation: "main",
    });
    assert.equal(conflict.result.ok, false);
    assert.equal((conflict.result.error as Record<string, unknown>).code, "conflict");
    assert.equal(conflict.host.proposals.length, 0);
  } finally {
    files.delete(sourcePath);
    files.delete(targetPath);
    if (previousTarget) files.set(targetPath, previousTarget);
  }
});

test("Host-local grant import accepts hash-only rows, preserves safe extensions and uses the existing broker", () => {
  const targetPath = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  const previousTarget = files.get(targetPath);
  files.delete(targetPath);
  try {
    const { result, host } = invoke("proprium.publishing.recovery.hostgrants.propose", {
      source_name: "app-state/share-tokens.json", source_sha256: "a".repeat(64), legacy_project_id: "legacy-work",
      repository_id_confirmation: 42, branch_confirmation: "main",
      grants: [{ id: "host-grant", projectId: "legacy-work", scope: { kind: "chapter", id: "c1" }, label: "old", tokenHash: "b".repeat(64), createdAt: "2025-02-01T00:00:00.000Z", expiresAt: "2030-02-01T00:00:00.000Z", futureField: { keep: "exactly" } }],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((result.value as Record<string, unknown>).status, "proposed");
    const changeset = host.proposals[0] as {
      read_set: Array<{ path: string; revision: string | null }>;
      units: Array<{ operations: Array<{ kind: string; path: string; expected_revision: string | null; content: number[] }> }>;
      domain_evidence: Array<Record<string, unknown>>;
    };
    assert.deepEqual(changeset.read_set, [{ path: targetPath, revision: null }]);
    const [operation] = changeset.units.flatMap(unit => unit.operations);
    assert.equal(operation?.kind, "create");
    assert.equal(operation?.expected_revision, null);
    const proposed = new TextDecoder().decode(Uint8Array.from(operation!.content));
    const imported = JSON.parse(proposed.trim()) as Record<string, unknown>;
    assert.equal(imported.repositoryId, 42);
    assert.equal(imported.branch, "main");
    assert.equal(imported.projectId, "legacy-work");
    assert.deepEqual(imported.futureField, { keep: "exactly" });
    assert.equal(changeset.domain_evidence[0]?.source_sha256, "a".repeat(64));
    assert.ok(!host.calls.some(call => call.operation === "workspace.file.list" && ["app-state/share-tokens.json", "share-tokens.json"].includes(String(call.payload.prefix))));
    assert.ok(!JSON.stringify(result).includes("tokenHash"));
  } finally {
    files.delete(targetPath);
    if (previousTarget) files.set(targetPath, previousTarget);
  }
});

test("Host-local grant import refuses secrets, foreign mappings and divergent IDs", () => {
  const source = {
    source_name: "share-tokens.json", source_sha256: "c".repeat(64), legacy_project_id: "legacy-work",
    repository_id_confirmation: 42, branch_confirmation: "main",
  };
  const rawGrant = { id: "host-grant", projectId: "legacy-work", scope: { kind: "chapter", id: "c1" }, label: "old", tokenHash: "d".repeat(64), createdAt: "2025-02-01T00:00:00.000Z", expiresAt: "2030-02-01T00:00:00.000Z" };
  const foreign = invoke("proprium.publishing.recovery.hostgrants.propose", { ...source, grants: [{ ...rawGrant, projectId: "another-work" }] });
  assert.equal(foreign.result.ok, false);
  assert.equal(foreign.host.proposals.length, 0);
  const wrongBranch = invoke("proprium.publishing.recovery.hostgrants.propose", { ...source, branch_confirmation: "release", grants: [rawGrant] });
  assert.equal(wrongBranch.result.ok, false);
  assert.equal(wrongBranch.host.proposals.length, 0);
  const secret = invoke("proprium.publishing.recovery.hostgrants.propose", { ...source, grants: [{ ...rawGrant, tokenPrefix: "share_secret", ownerId: "private-account" }] });
  assert.equal(secret.result.ok, false);
  assert.equal(secret.host.proposals.length, 0);

  const targetPath = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  const previousTarget = files.get(targetPath);
  try {
    files.set(targetPath, { text: JSON.stringify({ ...rawGrant, version: 1, grantVersion: 1, revocationVersion: 0, repositoryId: 42, branch: "main" }) + "\n" });
    const exact = invoke("proprium.publishing.recovery.hostgrants.propose", { ...source, grants: [rawGrant] });
    assert.equal(exact.result.ok, true);
    assert.equal((exact.result.value as Record<string, unknown>).status, "already_imported");
    assert.equal(exact.host.proposals.length, 0);

    files.set(targetPath, { text: JSON.stringify({ ...rawGrant, version: 1, grantVersion: 1, revocationVersion: 0, repositoryId: 42, branch: "main", label: "different" }) + "\n" });
    const conflict = invoke("proprium.publishing.recovery.hostgrants.propose", { ...source, grants: [rawGrant] });
    assert.equal(conflict.result.ok, false);
    assert.equal((conflict.result.error as Record<string, unknown>).code, "conflict");
    assert.equal(conflict.host.proposals.length, 0);
  } finally {
    files.delete(targetPath);
    if (previousTarget) files.set(targetPath, previousTarget);
  }
});

test("project tree action forwards one page without eager reordering", () => {
  const { result, host } = invoke("proprium.publishing.project.tree", { parent_id: null, limit: 25 });
  assert.equal(result.ok, true);
  assert.deepEqual(host.calls.filter(call => call.operation === "workspace.plugin.invoke").map(call => call.payload.input), [
    { parent_id: null, limit: 25 },
  ]);
  assert.equal((result.value as { items: Array<{ id: string }> }).items[0]?.id, "v1");
});

test("share creation without a configured provider produces no secret, proposal, URL or network request", () => {
  const { result, host } = invoke("proprium.publishing.shares.create", { kind: "chapter", id: "c1" });
  assert.equal(result.ok, false);
  assert.equal((result.error as { code: string }).code, "provider_unavailable");
  assert.ok(host.calls.some(call => call.operation === "publishing.share-reader.v1.capabilities"));
  assert.ok(!host.calls.some(call => call.operation === "secret.token.create"));
  assert.equal(host.proposals.length, 0);
  assert.ok(!host.calls.some(call => /https?:\/\//u.test(JSON.stringify(call.payload))));
});

test("share list uses only Host-local provider configuration and never calls the provider", () => {
  const { result, host } = invoke("proprium.publishing.shares.list", {});
  assert.equal(result.ok, true);
  assert.equal((result.value as { provider_configured: boolean }).provider_configured, false);
  assert.ok(host.calls.some(call => call.operation === "workspace.capabilities.query"));
  assert.ok(host.calls.some(call => call.operation === "workspace.identity.read"));
  assert.ok(!host.calls.some(call => call.operation === "publishing.share-reader.v1.capabilities"));
});

test("share list marks active only when the exact grant metadata revision is remotely confirmed", () => {
  const path = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  files.set(path, { text: `${JSON.stringify({ version: 1, id: "grant-live", tokenHash: "a".repeat(64), scope: { kind: "chapter", id: "c1" }, label: "preview", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" })}\n` });
  try {
    const pending = invoke("proprium.publishing.shares.list", {}, makeHost(true, false));
    assert.equal((pending.result.value as { shares: Array<{ status: string }> }).shares[0]?.status, "pending_publish");
    const published = invoke("proprium.publishing.shares.list", {}, makeHost(true, true));
    assert.equal((published.result.value as { shares: Array<{ status: string }> }).shares[0]?.status, "active");
  } finally {
    files.delete(path);
  }
});

test("share revocation stays pending until Host confirms that exact grants revision", () => {
  const path = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  files.set(path, { text: `${JSON.stringify({ version: 1, id: "grant-revoked", tokenHash: "a".repeat(64), scope: { kind: "chapter", id: "c1" }, label: "preview", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: "2026-10-01T00:00:00.000Z" })}\n` });
  try {
    const pending = invoke("proprium.publishing.shares.list", {}, makeHost(true, false));
    assert.equal((pending.result.value as { shares: Array<{ status: string }> }).shares[0]?.status, "revocation_pending");
    const published = invoke("proprium.publishing.shares.list", {}, makeHost(true, true));
    assert.equal((published.result.value as { shares: Array<{ status: string }> }).shares[0]?.status, "revoked");
  } finally {
    files.delete(path);
  }
});

test("configured share creation proposes only a hashed descriptor and never returns the Host handle", () => {
  const host = makeHost(true);
  const { result } = invoke("proprium.publishing.shares.create", {
    kind: "chapter", id: "c1", label: "見本", expires_in_hours: 12,
  }, host);
  assert.equal(result.ok, true);
  const value = result.value as Record<string, unknown>;
  assert.equal(value.status, "proposed");
  const preview = value.preview as Record<string, unknown>;
  assert.equal(preview.scope && (preview.scope as Record<string, unknown>).kind, "chapter");
  assert.equal(preview.label, "見本");
  assert.equal(preview.expires_at, "2026-10-27T00:00:00.000Z");
  assert.equal(Object.hasOwn(value, "token"), false);
  assert.equal(Object.hasOwn(value, "handle"), false);
  assert.equal(host.proposals.length, 1);
  const changeset = host.proposals[0] as { read_set: Array<{ path: string; revision: string | null }>; units: Array<{ operations: Array<{ path: string; content: number[] }> }> };
  const operation = changeset.units[0]!.operations[0]!;
  assert.equal(operation.path, "meta/scriptorium/modules/publishing/share-grants.jsonl");
  assert.equal(changeset.read_set[0]?.path, operation.path);
  const grant = JSON.parse(new TextDecoder().decode(Uint8Array.from(operation.content))) as Record<string, unknown>;
  assert.equal(grant.tokenHash, "b".repeat(64));
  assert.equal(grant.id, preview.grant_id);
  assert.equal(grant.repositoryId, 42);
  assert.equal(grant.branch, "main");
  assert.equal(Object.hasOwn(grant, "handle"), false);
  assert.ok(!JSON.stringify(value).includes("host-private-handle"));
  assert.ok(!JSON.stringify(host.proposals).includes("host-private-handle"));
});

test("share revocation uses the Host's stable operation timestamp and proposes only the grants file", () => {
  const path = "meta/scriptorium/modules/publishing/share-grants.jsonl";
  files.set(path, { text: `${JSON.stringify({ version: 1, id: "grant-1", tokenHash: "a".repeat(64), token: "must-not-copy", scope: { kind: "chapter", id: "c1" }, label: "preview", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z", extension: "preserve" })}\n` });
  try {
    const sourceRevision = createHash("sha256").update(bytesFor(path)).digest("hex");
    const { result, host } = invoke("proprium.publishing.shares.revoke", {
      id: "grant-1", expected_metadata_revision: sourceRevision,
    });
    assert.equal(result.ok, true);
    const changeset = host.proposals[0] as { units: Array<{ operations: Array<{ path: string; content: number[] }> }> };
    assert.deepEqual(changeset.units.flatMap(unit => unit.operations.map(operation => operation.path)), [path]);
    const content = new TextDecoder().decode(Uint8Array.from(changeset.units[0]!.operations[0]!.content));
    const record = JSON.parse(content) as Record<string, unknown>;
    assert.equal(record.revokedAt, "2026-10-26T12:00:00.000Z");
    assert.equal(record.extension, "preserve");
    assert.equal(Object.hasOwn(record, "token"), false);
    assert.ok(!content.includes("must-not-copy"));
    assert.ok(host.calls.some(call => call.operation === "workspace.change.timestamp"));
    assert.ok(!Object.keys(result.value as object).some(key => /token|bearer|secret|handle/iu.test(key)));
  } finally {
    files.delete(path);
  }
});

test("Publishing manifest passes release registry declaration validation", async () => {
  const { readFile } = await import("node:fs/promises");
  const { assertAuthoringDeclarations } = await import("../../scripts/authoring-manifest-schema.mjs");
  const manifest = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  await assertAuthoringDeclarations(manifest.id, manifest.capabilities, manifest.actions, manifest.ui ?? []);
});
