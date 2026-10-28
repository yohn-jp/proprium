import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGuest } from "../shared/guest.js";
import type { ActionRequest, ChangeSet, Snapshot } from "../../app/src/browser/proprium/authoring/types.js";
import type { Handler, HostCall, GuestHost } from "../shared/guest.js";
import type { CacheKey, FileEntry, FilePage } from "../shared/operations.js";
import { createResearchHandlers } from "./guest.js";

interface FixtureFile { path: string; text: string; revision: string; bytes: Uint8Array }
const snapshot: Snapshot = { id: "snapshot-1", local_commit: "a".repeat(40), worktree_generation: "generation-1", draft_generation: null };
const scope = { workspace_id: "workspace-1", repository_id: 42, branch: "main", generation: "scope-1" };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function file(path: string, text: string): FixtureFile {
  const bytes = new TextEncoder().encode(text);
  return { path, text, revision: hash(bytes), bytes };
}

class ResearchHostFixture {
  readonly files = new Map<string, FixtureFile>();
  readonly snapshotIds = new Set([snapshot.id]);
  readonly calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  readonly proposals: ChangeSet[] = [];
  readonly cache = new Map<string, unknown>();
  readonly artifacts = new Map<string, { bytes: number[]; nextSequence: number; filename: string; mediaType: string; sealed?: boolean }>();
  failArtifactAppend = false;
  private artifactSequence = 0;

  request<T>(operation: string, payload: Record<string, unknown>): Generator<HostCall, T, unknown> {
    const fixture = this;
    return (function* () { return (yield { kind: "host_call", call_id: "", operation, payload }) as T; })();
  }

  respond(operation: string, payload: Record<string, unknown>): unknown {
    this.calls.push({ operation, payload });
    if (operation === "workspace.file.list") {
      const prefix = payload.prefix as string;
      const all = [...this.files.values()].filter((entry) => entry.path.startsWith(prefix)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const offset = payload.cursor === undefined ? 0 : Number(payload.cursor);
      const limit = payload.limit as number;
      const page = all.slice(offset, offset + limit).map((entry): FileEntry => ({ path: entry.path, revision: entry.revision, byte_length: entry.bytes.length, media_type: "text/plain" }));
      return { entries: page, next_cursor: offset + page.length < all.length ? String(offset + page.length) : null } satisfies FilePage;
    }
    if (operation === "workspace.file.read") {
      const entry = this.files.get(payload.path as string);
      if (!entry) throw Object.assign(new Error("missing"), { code: "file_not_found" });
      if (payload.snapshot && !this.snapshotIds.has((payload.snapshot as Snapshot).id)) throw new Error("wrong snapshot");
      const offset = payload.offset as number;
      const length = payload.length as number;
      const bytes = [...entry.bytes.slice(offset, offset + length)];
      const next = offset + bytes.length;
      return { revision: entry.revision, total_bytes: entry.bytes.length, offset, bytes, next_offset: next < entry.bytes.length ? next : null };
    }
    if (operation === "workspace.change.propose") {
      const changeset = payload.changeset as ChangeSet;
      this.proposals.push(changeset);
      return { proposal_id: "proposal-1", operation_ids: changeset.units.flatMap(({ operations }) => operations.map(({ id }) => id)) };
    }
    if (operation === "artifact.create") {
      const artifact_id = `artifact-${++this.artifactSequence}`;
      this.artifacts.set(artifact_id, { bytes: [], nextSequence: 0, filename: payload.filename as string, mediaType: payload.media_type as string });
      return { artifact_id, max_bytes: 16 * 1024 * 1024, max_chunk_bytes: 256 * 1024 };
    }
    if (operation === "artifact.append") {
      if (this.failArtifactAppend) throw Object.assign(new Error("append failed"), { code: "storage_unknown" });
      const artifact = this.artifacts.get(payload.artifact_id as string);
      const bytes = payload.bytes as number[];
      if (!artifact || artifact.sealed || payload.sequence !== artifact.nextSequence || bytes.length > 256 * 1024) throw new Error("invalid artifact append");
      artifact.bytes.push(...bytes); artifact.nextSequence++;
      return { artifact_id: payload.artifact_id, next_sequence: artifact.nextSequence, received_bytes: artifact.bytes.length };
    }
    if (operation === "artifact.seal") {
      const artifact = this.artifacts.get(payload.artifact_id as string);
      if (!artifact || artifact.sealed || payload.total_bytes !== artifact.bytes.length || payload.sha256 !== hash(Uint8Array.from(artifact.bytes))) throw new Error("invalid artifact seal");
      artifact.sealed = true;
      return { artifact_id: payload.artifact_id, media_type: artifact.mediaType, filename: artifact.filename, scope, snapshot, total_bytes: artifact.bytes.length, sha256: payload.sha256 };
    }
    if (operation === "artifact.discard") {
      this.artifacts.delete(payload.artifact_id as string);
      return {};
    }
    if (operation === "workspace.derived.cache.get") {
      const key = JSON.stringify(payload.key as CacheKey);
      return this.cache.has(key) ? { found: true, value: this.cache.get(key) } : { found: false };
    }
    if (operation === "workspace.derived.cache.put") {
      this.cache.set(JSON.stringify(payload.key as CacheKey), payload.value);
      return { stored: true };
    }
    if (operation === "workspace.derived.cache.evict") {
      if (payload.key) this.cache.delete(JSON.stringify(payload.key as CacheKey));
      else this.cache.clear();
      return { evicted: true };
    }
    throw new Error(`Unexpected Host operation ${operation}`);
  }
}

async function invoke(
  handler: Handler,
  hostFixture: ResearchHostFixture,
  actionId: string,
  input: Record<string, unknown>,
  options: { idempotencyKey?: string; scope?: ActionRequest["scope"]; snapshot?: Snapshot } = {},
): Promise<unknown> {
  const requestSnapshot = options.snapshot ?? snapshot;
  const context: ActionRequest = {
    schema_version: 1, request_id: `request-${actionId}`, plugin_id: "proprium.research", action_id: actionId,
    scope: options.scope ?? scope, snapshot: requestSnapshot, input, deadline_ms: 30_000,
    ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
  };
  const guestHost: GuestHost = { request: hostFixture.request.bind(hostFixture) };
  const result = handler(input, context, guestHost);
  if (!result || typeof result !== "object" || !("next" in result) || typeof result.next !== "function") return result;
  const iterator = result as Generator<HostCall, unknown, unknown>;
  let state = iterator.next();
  while (!state.done) {
    const call = state.value;
    try { state = iterator.next(hostFixture.respond(call.operation, call.payload)); }
    catch (error) { state = iterator.throw(error); }
  }
  return state.value;
}

test("search values match the signed schema with and without envelope warnings", async () => {
  const schemaPath = process.env.PROPRIUM_AUTHORING_SCHEMA ?? fileURLToPath(new URL("../../app/src/browser/proprium/authoring/schema.ts", import.meta.url));
  const { assertValue } = await import(pathToFileURL(schemaPath).href);
  const metadata = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
  const outputSchema = metadata.actions.find((row: any) => row.action_id === "research.query").output_schema;
  for (const morphologyHints of [false, true]) {
    const host = new ResearchHostFixture();
    const item = file("manuscript/scene.md", "青い灯台で待つ。\n"); host.files.set(item.path, item);
    const guest = createGuest("proprium.research", createResearchHandlers());
    guest.initialize({ pluginId: "proprium.research", version: "1.0.0", workspaceId: scope.workspace_id });
    try {
      const request = { schema_version: 1, request_id: `query-${morphologyHints}`, plugin_id: "proprium.research", action_id: "research.query", scope, snapshot,
        input: { query: "灯台", mode: "lexical", morphologyHints }, deadline_ms: 30000 };
      let output = JSON.parse(guest.invoke(JSON.stringify(request)));
      while (output.kind === "host_call") {
        const value = host.respond(output.operation, output.payload);
        output = JSON.parse(guest.invoke(JSON.stringify({ kind: "host_response", call_id: output.call_id, ok: true, value })));
      }
      assert.equal(output.ok, true);
      assertValue(outputSchema, output.value, "Research query output");
      assert.equal(output.value.hits[0].path, item.path);
      assert.deepEqual(output.warnings, morphologyHints ? ["tokenizer_unavailable"] : []);
      assert.deepEqual(output.value.snapshot, snapshot);
      assert.equal(output.value.scope, null);
      assert.equal(Object.hasOwn(output.value, "warnings"), false);
    } finally { guest.dispose(); }
  }
});

test("Research guest pages a 300-file Host snapshot and binds cursors to its exact revision", async () => {
  const host = new ResearchHostFixture();
  for (let index = 0; index < 300; index++) host.files.set(`manuscript/v/ch/${String(index).padStart(3, "0")}.md`, file(`manuscript/v/ch/${String(index).padStart(3, "0")}.md`, `passage ${index} contains lantern evidence`));
  const handlers = createResearchHandlers();
  const first = await invoke(handlers["research.query"]!, host, "research.query", { query: "lantern", mode: "lexical", limit: 100 });
  assert.equal((first as { hits: unknown[] }).hits.length, 100);
  assert.deepEqual((first as { coverage: unknown }).coverage, { documents: 300, bytes: [...host.files.values()].reduce((sum, value) => sum + value.bytes.length, 0) });
  assert.ok((first as { nextCursor: string }).nextCursor);
  const manuscriptPages = host.calls.filter(({ operation, payload }) => operation === "workspace.file.list" && payload.prefix === "manuscript/");
  assert.equal(manuscriptPages.length, 2);
  assert.ok(manuscriptPages.every(({ payload }) => payload.limit === 256));
  const second = await invoke(handlers["research.query"]!, host, "research.query", { query: "lantern", mode: "lexical", limit: 100, cursor: (first as { nextCursor: string }).nextCursor });
  const third = await invoke(handlers["research.query"]!, host, "research.query", { query: "lantern", mode: "lexical", limit: 100, cursor: (second as { nextCursor: string }).nextCursor });
  const all = [...(first as { hits: Array<{ path: string }> }).hits, ...(second as { hits: Array<{ path: string }> }).hits, ...(third as { hits: Array<{ path: string }> }).hits];
  assert.equal(all.length, 300);
  assert.equal(new Set(all.map(({ path }) => path)).size, 300);
  await assert.rejects(() => invoke(handlers["research.query"]!, host, "research.query", { query: "different", mode: "lexical", limit: 100, cursor: (first as { nextCursor: string }).nextCursor }), /cursor does not match/u);
});

test("query scope supports an exact file and excludes same-prefix siblings", async () => {
  const host = new ResearchHostFixture();
  const target = file("manuscript/chapter.md", "moonlight passage");
  const sibling = file("manuscript/chapter.md.copy.md", "moonlight decoy");
  host.files.set(target.path, target); host.files.set(sibling.path, sibling);
  const page = await invoke(createResearchHandlers()["research.query"]!, host, "research.query", { query: "moonlight", scope: target.path }) as { hits: Array<{ path: string }>; coverage: { documents: number } };
  assert.deepEqual(page.hits.map(({ path }) => path), [target.path]);
  assert.equal(page.coverage.documents, 1);
});

test("search and terminology cursors are bound to the workspace scope as well as snapshot and query", async () => {
  const host = new ResearchHostFixture();
  host.files.set("manuscript/a.md", file("manuscript/a.md", "lantern passage one"));
  host.files.set("manuscript/b.md", file("manuscript/b.md", "lantern passage two"));
  const termRows = Array.from({ length: 2 }, (_, index) => ({ id: `term-${index}`, canonical: `Lantern ${index}`, aliases: [], targetPath: "manuscript/a.md" }));
  host.files.set("meta/scriptorium/modules/search/terms.json", file("meta/scriptorium/modules/search/terms.json", JSON.stringify({ schemaVersion: 1, terms: termRows })));
  const handlers = createResearchHandlers();
  const firstSearch = await invoke(handlers["research.query"]!, host, "research.query", { query: "lantern", limit: 1 }) as { nextCursor: string };
  const firstTerms = await invoke(handlers["research.terms.list"]!, host, "research.terms.list", { limit: 1 }) as { nextCursor: string };
  const otherScope = { ...scope, workspace_id: "workspace-2" };
  await assert.rejects(() => invoke(handlers["research.query"]!, host, "research.query", {
    query: "lantern", limit: 1, cursor: firstSearch.nextCursor,
  }, { scope: otherScope }), /cursor does not match/u);
  await assert.rejects(() => invoke(handlers["research.terms.list"]!, host, "research.terms.list", {
    limit: 1, cursor: firstTerms.nextCursor,
  }, { scope: otherScope }), /another snapshot or query/u);
});

test("index status reads Host metadata and a new guest verifies cached source revisions", async () => {
  const host = new ResearchHostFixture();
  const source = file("manuscript/volume/chapter.md", "The lantern in the rain.");
  host.files.set(source.path, source);
  const firstHandlers = createResearchHandlers();
  const rebuilt = await invoke(firstHandlers["research.index.rebuild"]!, host, "research.index.rebuild", {}) as { state: string; indexSnapshot: string };
  assert.equal(rebuilt.state, "current");
  assert.equal(rebuilt.indexSnapshot, snapshot.id);
  assert.ok([...host.cache.values()].some((value) => value && typeof value === "object" && (value as Record<string, unknown>).schemaVersion === 1));

  const statusCallsStart = host.calls.length;
  const status = await invoke(createResearchHandlers()["research.index.status"]!, host, "research.index.status", {}) as { state: string; coverage: { documents: number } };
  assert.deepEqual(status, { state: "current", indexSnapshot: snapshot.id, coverage: { documents: 1, bytes: source.bytes.length } });
  assert.deepEqual(host.calls.slice(statusCallsStart).map(({ operation }) => operation), ["workspace.derived.cache.get"]);

  const queryCallsStart = host.calls.length;
  const page = await invoke(createResearchHandlers()["research.query"]!, host, "research.query", { query: "lantern", includeTerms: false }) as { hits: Array<{ path: string; navigationSpan: unknown }> };
  assert.equal(page.hits[0]?.path, source.path);
  assert.deepEqual(page.hits[0]?.navigationSpan, { path: source.path, revision: source.revision, start: 4, end: 11, quote: "lantern" });
  assert.ok(host.calls.slice(queryCallsStart).some(({ operation }) => operation === "workspace.derived.cache.get"));
  assert.equal(host.calls.slice(queryCallsStart).some(({ operation }) => operation === "workspace.file.read"), false);
});

test("changed snapshots reread only changed and added files while removing deleted entries", async () => {
  const host = new ResearchHostFixture();
  for (const [path, text] of [
    ["manuscript/changed.md", "old lighthouse"],
    ["manuscript/removed.md", "harbor removed"],
    ["manuscript/unchanged.md", "quiet harbor"],
  ]) host.files.set(path, file(path, text));
  const handlers = createResearchHandlers();
  const original = await invoke(handlers["research.query"]!, host, "research.query", { query: "harbor", includeTerms: false }) as { hits: Array<{ path: string }> };
  assert.deepEqual(original.hits.map(({ path }) => path), ["manuscript/removed.md", "manuscript/unchanged.md"]);

  host.files.set("manuscript/changed.md", file("manuscript/changed.md", "new beacon"));
  host.files.delete("manuscript/removed.md");
  host.files.set("manuscript/added.md", file("manuscript/added.md", "distant beacon"));
  const nextSnapshot: Snapshot = { ...snapshot, id: "snapshot-2", worktree_generation: "generation-2", draft_generation: "draft-2" };
  host.snapshotIds.add(nextSnapshot.id);
  const nextScope = { ...scope, generation: "scope-2" };
  const readStart = host.calls.length;
  const updated = await invoke(handlers["research.query"]!, host, "research.query", { query: "beacon", includeTerms: false }, {
    scope: nextScope, snapshot: nextSnapshot,
  }) as { hits: Array<{ path: string }> };

  assert.deepEqual(updated.hits.map(({ path }) => path), ["manuscript/added.md", "manuscript/changed.md"]);
  assert.deepEqual(host.calls.slice(readStart).filter(({ operation }) => operation === "workspace.file.read").map(({ payload }) => payload.path).sort(), [
    "manuscript/added.md", "manuscript/changed.md",
  ]);
  const nextSnapshotManifests = [...host.cache.values()].filter((value) => value && typeof value === "object" &&
    (value as Record<string, unknown>).snapshotId === nextSnapshot.id);
  assert.ok(nextSnapshotManifests.length > 0, "the updated snapshot is sealed into its own cache namespace");
});

test("UI-only search fusion validates both Host envelopes and source spans before RRF", async () => {
  const host = new ResearchHostFixture();
  const source = file("manuscript/lantern.md", "The lantern opens the sea.\n");
  host.files.set(source.path, source);
  const handlers = createResearchHandlers();
  const lexicalValue = await invoke(handlers["research.query"]!, host, "research.query", {
    query: "lantern", mode: "lexical", limit: 30, includeTerms: false,
  }) as Record<string, unknown>;
  const quote = "The lantern opens the sea.";
  const span = { path: source.path, revision: source.revision, start: 0, end: quote.length, quote };
  const vectorValue = {
    snapshot,
    model: { id: "e5-small", revision: "v1", role: "embedding", dimensions: 384, digest: "d".repeat(64) },
    results: [{ entityId: "scene-a", sourcePath: source.path, sourceRevision: source.revision, sentenceIndex: 0,
      quote, cosineScore: 0.91, rank: 1, indexCoverage: 1, evidence: [span] }],
  };
  const fusionInput = {
    mode: "hybrid", query: "lantern", limit: 30,
    lexicalResult: { scope, snapshot, value: lexicalValue },
    vectorResult: { scope, snapshot, query: "lantern", granularity: "sentence", value: vectorValue },
  };
  const result = await invoke(handlers["research.search.fuse"]!, host, "research.search.fuse", fusionInput) as {
    snapshot: Snapshot; snapshotId: string; hits: Array<{ path: string; source: string; navigationSpan: { quote: string }; semanticCandidate?: { sentenceIndex: number } }>;
    expressionStatus: { state: string }; warnings: string[];
  };
  const schemaPath = process.env.PROPRIUM_AUTHORING_SCHEMA ?? fileURLToPath(new URL("../../app/src/browser/proprium/authoring/schema.ts", import.meta.url));
  const { assertValue } = await import(pathToFileURL(schemaPath).href);
  const metadata = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
  const descriptor = metadata.actions.find((row: any) => row.action_id === "research.search.fuse");
  assertValue(descriptor.input_schema, fusionInput, "Research fusion input");
  assertValue(descriptor.output_schema, result, "Research fusion output");
  assert.equal(result.snapshotId, snapshot.id);
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(result.hits[0]?.path, source.path);
  assert.equal(result.hits[0]?.source, "hybrid");
  assert.equal(result.hits[0]?.navigationSpan.quote, quote);
  assert.equal(result.hits[0]?.semanticCandidate?.sentenceIndex, 0);
  assert.equal(result.expressionStatus.state, "not_requested");

  await assert.rejects(() => invoke(handlers["research.search.fuse"]!, host, "research.search.fuse", {
    ...fusionInput, vectorResult: { ...fusionInput.vectorResult, snapshot: { ...snapshot, id: "old-snapshot" } },
  }), /another Host scope, snapshot, query, or granularity/u);
  await assert.rejects(() => invoke(handlers["research.search.fuse"]!, host, "research.search.fuse", {
    ...fusionInput, vectorResult: { ...fusionInput.vectorResult, value: { ...vectorValue,
      results: [{ ...vectorValue.results[0], quote: "forged quote" }] } },
  }), /not a current source-backed result/u);
});

test("path-scoped fusion filters the global Semantic page without changing provider ranks", async () => {
  const host = new ResearchHostFixture();
  const inside = file("manuscript/in-scope/lantern.md", "The lantern waits inside.\n");
  const outside = file("manuscript/other/lantern.md", "The lantern waits outside.\n");
  host.files.set(inside.path, inside); host.files.set(outside.path, outside);
  const handlers = createResearchHandlers();
  const pathScope = "manuscript/in-scope";
  const lexicalValue = await invoke(handlers["research.query"]!, host, "research.query", {
    query: "lantern", mode: "lexical", scope: pathScope, limit: 30, includeTerms: false,
  }) as Record<string, unknown>;
  const outsideQuote = "The lantern waits outside.";
  const insideQuote = "The lantern waits inside.";
  const vectorValue = {
    snapshot,
    model: { id: "e5-small", revision: "v1", role: "embedding" },
    results: [
      { entityId: "scene-outside", sourcePath: outside.path, sourceRevision: outside.revision, sentenceIndex: 0,
        quote: outsideQuote, cosineScore: 0.95, rank: 1, indexCoverage: 1,
        evidence: [{ path: outside.path, revision: outside.revision, start: 0, end: outsideQuote.length, quote: outsideQuote }] },
      { entityId: "scene-inside", sourcePath: inside.path, sourceRevision: inside.revision, sentenceIndex: 0,
        quote: insideQuote, cosineScore: 0.90, rank: 2, indexCoverage: 1,
        evidence: [{ path: inside.path, revision: inside.revision, start: 0, end: insideQuote.length, quote: insideQuote }] },
    ],
  };
  const result = await invoke(handlers["research.search.fuse"]!, host, "research.search.fuse", {
    mode: "hybrid", query: "lantern", scope: pathScope, limit: 30,
    lexicalResult: { scope, snapshot, value: lexicalValue },
    vectorResult: { scope, snapshot, query: "lantern", granularity: "sentence", value: vectorValue },
  }) as { scope: string | null; hits: Array<{ path: string; semanticRank: number | null; scoreFactors: string[] }> };
  assert.equal(result.scope, pathScope);
  assert.deepEqual(result.hits.map(({ path }) => path), [inside.path]);
  assert.equal(result.hits[0]?.semanticRank, 2);
  assert.ok(result.hits[0]?.scoreFactors.includes("rrf-semantic:1/62"));
});

test("expression fusion reports tokenizer denial while preserving its validated hybrid candidates", async () => {
  const host = new ResearchHostFixture();
  const source = file("manuscript/lantern.md", "The lantern opens the sea.\n");
  host.files.set(source.path, source);
  const handlers = createResearchHandlers();
  const lexicalValue = await invoke(handlers["research.query"]!, host, "research.query", {
    query: "lantern", mode: "lexical", limit: 30, includeTerms: false,
  }) as Record<string, unknown>;
  const quote = "The lantern opens the sea.";
  const vectorValue = { snapshot, model: { id: "e5-small", revision: "v1", role: "embedding" }, results: [
    { entityId: "scene-a", sourcePath: source.path, sourceRevision: source.revision, sentenceIndex: 0,
      quote, cosineScore: 0.91, rank: 1, indexCoverage: 1,
      evidence: [{ path: source.path, revision: source.revision, start: 0, end: quote.length, quote }] },
  ] };
  const result = await invoke(handlers["research.search.fuse"]!, host, "research.search.fuse", {
    mode: "expression", query: "lantern", limit: 30,
    lexicalResult: { scope, snapshot, value: lexicalValue },
    vectorResult: { scope, snapshot, query: "lantern", granularity: "sentence", value: vectorValue },
  }) as { expressionStatus: { state: string; reason?: string }; hits: unknown[]; warnings: string[] };
  assert.equal(result.expressionStatus.state, "unavailable");
  assert.equal(result.expressionStatus.reason, "dependency_unavailable");
  assert.equal(result.hits.length, 1);
  assert.ok(result.warnings.includes("expression_tokenizer_unavailable"));
});

test("token counting labels an explicitly selected approximation and rejects unavailable or unsafe models", async () => {
  const handler = createResearchHandlers()["research.nlp.countTokens"]!;
  const approximate = await invoke(handler, new ResearchHostFixture(), "research.nlp.countTokens", { texts: ["青剣 ABC"], modelId: "approx" }) as {
    identity: { method: string; modelId: string }; fallbackReason: string;
  };
  assert.deepEqual(approximate, {
    counts: [4], identity: { modelId: "approx", version: "source-approx-v1", digest: "205e2370155900abcc923065a85072f74eb706f1bcec68fbaa93eb15883d4b88", method: "approx" },
    fallbackReason: "user_selected_approximation",
  });
  await assert.rejects(() => invoke(handler, new ResearchHostFixture(), "research.nlp.countTokens", { texts: ["text"], modelId: "https://hosted.invalid/model" }), /approved local tokenizer/u);
  await assert.rejects(() => invoke(handler, new ResearchHostFixture(), "research.nlp.countTokens", { texts: ["text"], modelId: "owner/model" }), { code: "dependency_unavailable" });
  await assert.rejects(() => invoke(createResearchHandlers()["research.query"]!, new ResearchHostFixture(), "research.query", { query: "term", limit: "100" as unknown as number }), /limit must be between/u);
});

test("chunked cached sources survive multi-chunk files and corrupt cache is rebuilt from pinned Host bytes", async () => {
  const host = new ResearchHostFixture();
  const text = `${"calm passage with rain. ".repeat(12_000)} lantern beacon`;
  const source = file("manuscript/long.md", text);
  host.files.set(source.path, source);
  const first = await invoke(createResearchHandlers()["research.query"]!, host, "research.query", { query: "beacon", includeTerms: false }) as { hits: Array<{ path: string }> };
  assert.deepEqual(first.hits.map(({ path }) => path), [source.path]);
  const dataRows = [...host.cache.entries()].filter(([key]) => JSON.parse(key).key.includes(":data:"));
  assert.ok(dataRows.length >= 2, "large source should cross the bounded cache chunk boundary");
  const queryCallsStart = host.calls.length;
  const cached = await invoke(createResearchHandlers()["research.query"]!, host, "research.query", { query: "beacon", includeTerms: false }) as { hits: Array<{ path: string }> };
  assert.deepEqual(cached.hits.map(({ path }) => path), [source.path]);
  assert.equal(host.calls.slice(queryCallsStart).some(({ operation }) => operation === "workspace.file.read"), false);

  const damaged = dataRows[0]!;
  host.cache.set(damaged[0], { base64: "%%%%" });
  const rebuildCallsStart = host.calls.length;
  const rebuilt = await invoke(createResearchHandlers()["research.query"]!, host, "research.query", { query: "beacon", includeTerms: false }) as { hits: Array<{ path: string }> };
  assert.deepEqual(rebuilt.hits.map(({ path }) => path), [source.path]);
  assert.ok(host.calls.slice(rebuildCallsStart).some(({ operation }) => operation === "workspace.derived.cache.evict"));
  assert.ok(host.calls.slice(rebuildCallsStart).some(({ operation }) => operation === "workspace.file.read"));
});

test("term proposal uses exact Host revisions and retains unknown registry fields", async () => {
  const host = new ResearchHostFixture();
  const target = file("bible/characters/aria.yaml", "name: Aria\n");
  const registry = file("meta/scriptorium/modules/search/terms.json", JSON.stringify({
    schemaVersion: 1, vendorRoot: { retained: true }, terms: [{ id: "term-aria", canonical: "Aria", aliases: ["Ari"], targetPath: target.path, vendorEntry: "keep" }],
  }, null, 2));
  host.files.set(target.path, target);
  host.files.set(registry.path, registry);
  const handlers = createResearchHandlers();
  const result = await invoke(handlers["research.terms.propose"]!, host, "research.terms.propose", {
    termId: "term-aria", canonical: "Aria Rose", aliases: ["Rose"], targetPath: target.path,
    expectedRegistryRevision: registry.revision, expectedTargetRevision: target.revision,
  }, { idempotencyKey: "idempotency-1" }) as { changeSetId: string; operationIds: string[]; preview: { affectedPaths: string[] } };
  assert.equal(result.changeSetId, "proposal-1");
  assert.equal(result.operationIds.length, 1);
  assert.deepEqual(result.preview.affectedPaths, ["meta/scriptorium/modules/search/terms.json", target.path]);
  assert.equal(host.proposals.length, 1);
  const proposed = JSON.parse(new TextDecoder().decode(Uint8Array.from(host.proposals[0]!.units[0]!.operations[0]!.content!))) as Record<string, unknown>;
  assert.deepEqual(proposed.vendorRoot, { retained: true });
  const nextTerm = (proposed.terms as Array<Record<string, unknown>>).find(({ canonical }) => canonical === "Aria Rose");
  assert.equal(nextTerm?.vendorEntry, "keep");
  assert.deepEqual(host.proposals[0]!.read_set, [
    { path: registry.path, revision: registry.revision }, { path: target.path, revision: target.revision },
  ]);

  await assert.rejects(() => invoke(handlers["research.terms.propose"]!, host, "research.terms.propose", {
    canonical: "Other", targetPath: target.path, expectedRegistryRevision: "0".repeat(64), expectedTargetRevision: target.revision,
  }, { idempotencyKey: "idempotency-2" }), /revision changed/u);
  assert.equal(host.proposals.length, 1);
});

test("terminology reads resolve target availability across the full workspace namespace", async () => {
  const host = new ResearchHostFixture();
  const source = file("manuscript/page.md", "The Silver Bell rings.");
  const outsideRootTarget = file("docs/glossary/silver-bell.md", "Silver Bell\n");
  const registry = file("meta/scriptorium/modules/search/terms.json", JSON.stringify({ schemaVersion: 1, terms: [
    { id: "term-bell", canonical: "Silver Bell", aliases: ["Bell"], targetPath: outsideRootTarget.path },
    { id: "term-missing", canonical: "Missing Bell", aliases: ["Bell"], targetPath: "docs/missing.md" },
  ] }));
  host.files.set(source.path, source); host.files.set(outsideRootTarget.path, outsideRootTarget); host.files.set(registry.path, registry);
  const handlers = createResearchHandlers();
  const listed = await invoke(handlers["research.terms.list"]!, host, "research.terms.list", {}) as { items: Array<{ id: string; targetAvailable: boolean; ambiguityCount: number }> };
  assert.deepEqual(listed.items.map(({ id, targetAvailable, ambiguityCount }) => ({ id, targetAvailable, ambiguityCount })), [
    { id: "term-bell", targetAvailable: true, ambiguityCount: 1 },
    { id: "term-missing", targetAvailable: false, ambiguityCount: 1 },
  ]);
  const resolved = await invoke(handlers["research.terms.resolve"]!, host, "research.terms.resolve", {
    path: source.path, textRevision: source.revision, text: source.text,
  }) as { spans: Array<{ start: number; end: number; termId: string; targetPath: string }>; ambiguities: unknown[] };
  assert.equal(resolved.spans.length, 1);
  assert.equal(source.text.slice(resolved.spans[0]!.start, resolved.spans[0]!.end), "Silver Bell");
  assert.equal(resolved.spans[0]!.targetPath, outsideRootTarget.path);
  assert.deepEqual(resolved.ambiguities, []);
});

test("synonym and candidate preference proposals preserve YAML comments and extensions", async () => {
  const host = new ResearchHostFixture();
  const synonyms = file(SYNONYMS, "# dictionary root comment\nsourceVersion: 9\ngroups:\n  # preserve this group note\n  - words: [mountain, hill]\n    context: positive\n    vendor: retained\n");
  const ignored = file(IGNORED, "# ignore root comment\nowner: author\nignored:\n  # keep this note\n  - 雨雲\n");
  host.files.set(synonyms.path, synonyms); host.files.set(ignored.path, ignored);
  const handlers = createResearchHandlers();
  const group = await invoke(handlers["research.synonyms.get"]!, host, "research.synonyms.get", { term: "mountain" }) as { groupRef: { fileRevision: string; ordinal: number; words: string[]; context: string } };
  await invoke(handlers["research.synonyms.propose"]!, host, "research.synonyms.propose", {
    words: ["mountain", "peak"], context: "positive", mergeGroupRef: group.groupRef, expectedFileRevision: synonyms.revision,
  }, { idempotencyKey: "synonym-key" });
  const synonymOperation = host.proposals.at(-1)!.units[0]!.operations[0]!;
  const synonymText = new TextDecoder().decode(Uint8Array.from(synonymOperation.content!));
  assert.match(synonymText, /dictionary root comment/u);
  assert.match(synonymText, /preserve this group note/u);
  assert.match(synonymText, /vendor: retained/u);
  assert.match(synonymText, /peak/u);

  await invoke(handlers["research.candidates.ignore.propose"]!, host, "research.candidates.ignore.propose", {
    terms: ["雨雲"], ignore: false, expectedFileRevision: ignored.revision,
  }, { idempotencyKey: "ignore-key" });
  const ignoreText = new TextDecoder().decode(Uint8Array.from(host.proposals.at(-1)!.units[0]!.operations[0]!.content!));
  assert.match(ignoreText, /ignore root comment/u);
  assert.match(ignoreText, /keep this note/u);
  assert.match(ignoreText, /owner: author/u);
  assert.doesNotMatch(ignoreText, /雨雲/u);
});

test("new synonym proposals work when no dictionary or merge target exists", async () => {
  const host = new ResearchHostFixture();
  const handlers = createResearchHandlers();
  const lookup = await invoke(handlers["research.synonyms.get"]!, host, "research.synonyms.get", { term: "灯" }) as Record<string, unknown>;
  assert.deepEqual(lookup, { group: null, alternatives: [], fileRevision: null });

  const proposalInput = { words: ["灯", "明かり"], expectedFileRevision: null };
  const output = await invoke(handlers["research.synonyms.propose"]!, host, "research.synonyms.propose", proposalInput,
    { idempotencyKey: "new-synonym-key" }) as Record<string, unknown>;
  assert.deepEqual(host.proposals.at(-1)!.units[0]!.operations.map(({ path }) => path), [SYNONYMS]);
  assert.deepEqual(output.groupsAfter, [{ words: ["灯", "明かり"] }]);

  const schemaPath = process.env.PROPRIUM_AUTHORING_SCHEMA ?? fileURLToPath(new URL("../../app/src/browser/proprium/authoring/schema.ts", import.meta.url));
  const { assertValue } = await import(pathToFileURL(schemaPath).href);
  const manifest = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
  assertValue(manifest.actions.find((item: any) => item.action_id === "research.synonyms.get").output_schema, lookup, "empty synonym lookup");
  assertValue(manifest.actions.find((item: any) => item.action_id === "research.synonyms.propose").input_schema, proposalInput, "new synonym proposal input");
  assertValue(manifest.actions.find((item: any) => item.action_id === "research.synonyms.propose").output_schema, output, "new synonym proposal output");
});

test("large registry proposals seal a scoped artifact before referencing its bytes", async () => {
  const host = new ResearchHostFixture();
  const target = file("bible/characters/aria.yaml", "name: Aria\n");
  const registry = file("meta/scriptorium/modules/search/terms.json", JSON.stringify({
    schemaVersion: 1, vendorPayload: "x".repeat(40_000), terms: [],
  }));
  host.files.set(target.path, target); host.files.set(registry.path, registry);
  const result = await invoke(createResearchHandlers()["research.terms.propose"]!, host, "research.terms.propose", {
    canonical: "Aria", aliases: [], targetPath: target.path, expectedRegistryRevision: registry.revision, expectedTargetRevision: target.revision,
  }, { idempotencyKey: "large-registry-key" });
  assert.equal((result as { changeSetId: string }).changeSetId, "proposal-1");
  assert.equal(host.artifacts.size, 1);
  const artifact = [...host.artifacts.values()][0]!;
  assert.equal(artifact.sealed, true);
  assert.ok(artifact.bytes.length > 32 * 1024);
  const operation = host.proposals[0]!.units[0]!.operations[0]!;
  assert.equal(operation.content, undefined);
  assert.equal(operation.content_artifact, "artifact-1");
});

test("failed artifact transfer discards its incomplete Host artifact", async () => {
  const host = new ResearchHostFixture();
  const target = file("bible/characters/aria.yaml", "name: Aria\n");
  const registry = file("meta/scriptorium/modules/search/terms.json", JSON.stringify({ schemaVersion: 1, vendorPayload: "x".repeat(40_000), terms: [] }));
  host.files.set(target.path, target); host.files.set(registry.path, registry);
  host.failArtifactAppend = true;
  await assert.rejects(() => invoke(createResearchHandlers()["research.terms.propose"]!, host, "research.terms.propose", {
    canonical: "Aria", aliases: [], targetPath: target.path, expectedRegistryRevision: registry.revision, expectedTargetRevision: target.revision,
  }, { idempotencyKey: "failed-artifact-key" }), /append failed/u);
  assert.equal(host.artifacts.size, 0);
  assert.ok(host.calls.some(({ operation }) => operation === "artifact.discard"));
  assert.equal(host.proposals.length, 0);
});

const SYNONYMS = "meta/scriptorium/modules/nlp/synonyms.yaml";
const IGNORED = "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml";
