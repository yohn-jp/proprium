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
