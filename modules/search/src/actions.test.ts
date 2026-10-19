import assert from "node:assert/strict";
import { test } from "node:test";
import { assertChangeOperation, type ChangeOperation, type ModuleAction, type ModuleActionContext, type ModuleContext, type SnapshotId, type SnapshotReader } from "@scriptorium/contracts";
import { createSearchDefinition, createSearchActions } from "./actions.js";
import { SnapshotIndexCache } from "./index-cache.js";
import { TERM_REGISTRY_PATH } from "./terminology.js";

const snapshot: SnapshotId = {
  repository: { provider: "local", repositoryId: "search-fixture", defaultBranch: "main", ownerScope: "owner", url: "local://search-fixture" },
  remoteCommit: "a".repeat(40),
};

function revision(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

function makeReader(values: Record<string, string>, options: { blockReads?: boolean } = {}): SnapshotReader {
  const files = new Map(Object.entries(values).map(([path, content]) => [path, { content, revision: revision(content) }]));
  return {
    snapshot,
    async read(path) { return files.get(path) ?? null; },
    async list(prefix) { return [...files.keys()].filter((path) => path === prefix || path.startsWith(`${prefix}/`)); },
    async listRevisions(prefix) { return [...files].filter(([path]) => path === prefix || path.startsWith(`${prefix}/`)).map(([path, file]) => ({ path, revision: file.revision })); },
  };
}

function actionContext(reader: SnapshotReader, options: {
  invoke?: ModuleActionContext["invoke"];
  propose?: ModuleActionContext["propose"];
} = {}): ModuleActionContext {
  return {
    projectId: "search-fixture", reader, signal: new AbortController().signal,
    async invoke(id, input, signal) { return options.invoke ? options.invoke(id, input, signal) : { ok: false, snapshot, error: { code: "missing_action", message: "missing", retryable: false } }; },
    async listActions() { return []; }, async linkedReader() { throw new Error("unused"); },
    async propose(operations, evidence, proposalId) {
      if (options.propose) return options.propose(operations, evidence, proposalId);
      throw new Error("unexpected proposal");
    }, async runJob() { throw new Error("unused"); },
  };
}

function findAction(actions: ModuleAction[], id: string): ModuleAction {
  const action = actions.find((candidate) => candidate.id === id);
  assert.ok(action, `expected action ${id}`);
  return action;
}

function moduleContext(onAcquire: (id: string) => Promise<{ value: unknown; release(): Promise<void> }>): ModuleContext {
  return { cacheDirectory: "/tmp/search-test", signal: new AbortController().signal, acquireCapability: onAcquire, async createWorkerService() { throw new Error("search is model-free"); } };
}

test("lexical search does not activate optional NLP or Semantic providers unless requested", async () => {
  let capabilityRequests = 0;
  const module = createSearchDefinition(moduleContext(async () => { capabilityRequests += 1; throw new Error("provider is disabled"); }));
  assert.equal(capabilityRequests, 0, "module registration must not load optional capabilities");
  assert.deepEqual(module.manifest.dependencies, []);
  assert.deepEqual(module.manifest.optionalRequires, ["nlp.tokenizer", "semantic.embedding"]);
  assert.equal(module.ui.find(({ id }) => id === "search.terms")?.contexts?.includes("workspace"), true);
  assert.equal(module.ui.find(({ id }) => id === "search.terms.adornment")?.kind, "editor-adornment");
  let semanticRequests = 0;
  const context = actionContext(makeReader({ "manuscript/vol-main/ch-main-1/sc-1.md": "The moonlit harbor is quiet." }), {
    async invoke(id, input, signal) {
      semanticRequests += 1;
      assert.equal(id, "semantic.search");
      assert.equal((input as { query: string }).query, "moonlit harbor");
      assert.equal(signal.aborted, false);
      return { ok: false, snapshot, error: { code: "missing_action", message: "disabled", retryable: false } };
    },
  });
  const query = findAction(module.actions, "search.query");
  assert.throws(() => query.inputSchema.parse({ query: "harbor", scope: " ../outside" }), /Unsafe project path/u);
  const basic = await query.invoke(query.inputSchema.parse({ query: "moonlit harbor" }), context);
  assert.equal(basic.ok, true);
  if (basic.ok) assert.equal((basic.data as { results: unknown[] }).results.length, 1);
  assert.equal(capabilityRequests, 0);
  assert.equal(semanticRequests, 0);

  const enhanced = await query.invoke(query.inputSchema.parse({ query: "moonlit harbor", useNlp: true }), context);
  assert.equal(enhanced.ok, true);
  if (enhanced.ok) assert.deepEqual((enhanced.data as { warnings: string[] }).warnings, ["nlp_tokenizer_unavailable"]);
  assert.equal(capabilityRequests, 1);
  assert.equal(semanticRequests, 0);

  const semantic = await query.invoke(query.inputSchema.parse({ query: "moonlit harbor", includeSemantic: true }), context);
  assert.equal(semantic.ok, true);
  if (semantic.ok) assert.deepEqual((semantic.data as { warnings: string[] }).warnings, ["semantic_unavailable:missing_action"]);
  assert.equal(semanticRequests, 1);
  await module.dispose();
});

test("terminology changes are emitted only as revision-guarded dictionary proposals", async () => {
  const reader = makeReader({ "manuscript/vol-main/ch-main-1/sc-1.md": "A blue harbor." });
  let proposed: ChangeOperation[] = [];
  let evidence: Parameters<ModuleActionContext["propose"]>[1];
  const context = actionContext(reader, { propose: async (operations, rows) => {
    proposed = operations;
    evidence = rows;
    return { id: "proposal-1", snapshot, operations, source: "module" };
  } });
  const actions = createSearchActions(moduleContext(async () => { throw new Error("unused"); }), new SnapshotIndexCache());
  const proposal = await findAction(actions, "search.terms.propose").invoke(findAction(actions, "search.terms.propose").inputSchema.parse({
    canonical: "Blue Harbor", aliases: ["Harbor"], targetPath: "manuscript/vol-main/ch-main-1/sc-1.md",
  }), context);
  assert.equal(proposal.ok, true);
  assert.equal(proposed.length, 1);
  assert.deepEqual(proposed[0]!.writes.map(({ path }) => path), [TERM_REGISTRY_PATH]);
  assert.deepEqual(proposed[0]!.reads, [
    { path: TERM_REGISTRY_PATH, revision: null },
    { path: "manuscript/vol-main/ch-main-1/sc-1.md", revision: revision("A blue harbor.") },
  ]);
  assert.equal(proposed[0]!.effect, "settings");
  assert.doesNotThrow(() => assertChangeOperation(proposed[0]));
  assert.match(proposed[0]!.writes[0]!.content ?? "", /Blue Harbor/u);
  assert.equal(evidence?.[0]?.paths.some(({ path }) => path === "manuscript/vol-main/ch-main-1/sc-1.md"), true);
});

test("module disposal aborts and invalidates active index work", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const reader = makeReader({ "manuscript/vol-main/ch-main-1/sc-1.md": "A blue harbor." });
  const originalReadMany = reader.read.bind(reader);
  reader.read = async (path) => {
    if (path.startsWith("manuscript/")) { started(); await blocked; }
    return originalReadMany(path);
  };
  const definition = createSearchDefinition(moduleContext(async () => { throw new Error("unused"); }));
  const query = findAction(definition.actions, "search.query");
  const pending = query.invoke(query.inputSchema.parse({ query: "harbor" }), actionContext(reader));
  await readStarted;
  await definition.dispose();
  release();
  await assert.rejects(pending, (error: unknown) => (error as { code?: string }).code === "job_cancelled");
});
