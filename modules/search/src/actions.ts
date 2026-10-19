import { randomUUID } from "node:crypto";
import { assertProjectPath, snapshotKey, type ActionResult, type ChangeOperation, type ModuleAction, type ModuleActionContext, type ModuleContext, type ModuleDefinition, type ModuleManifest, type SnapshotReader, type ValueSchema } from "@scriptorium/contracts";
import { SnapshotIndexCache } from "./index-cache.js";
import { normalizeSearchText, searchDocuments, searchTerms, type SearchMode } from "./search-ranking.js";
import { normalizeTerm, parseTermRegistry, resolveTermSpans, TERM_REGISTRY_PATH, type SearchTerm, type TermRegistry } from "./terminology.js";

const MAX_QUERY_LENGTH = 512;
const MAX_VISIBLE_TEXT = 24_000;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const NLP_TOKENIZER_CAPABILITY = "nlp.tokenizer";
const SEMANTIC_EMBEDDING_CAPABILITY = "semantic.embedding";

interface NlpTokenizerPort {
  analyze(text: string, snapshot: ModuleActionContext["reader"]["snapshot"], signal: AbortSignal): Promise<{ tokens: Array<{ surface: string; pos?: string }> }>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

const outputSchema: ValueSchema = { parse(value) { return record(value, "action output"); } };

function action(id: string, effect: ModuleAction["effect"], parse: (value: unknown) => unknown, invoke: ModuleAction["invoke"]): ModuleAction {
  return { id, effect, inputSchema: { parse }, outputSchema, invoke };
}

function parseQuery(value: unknown): { query: string; mode: SearchMode; limit: number; scope?: string; useNlp: boolean; includeSemantic: boolean } {
  const input = record(value, "input");
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > MAX_QUERY_LENGTH) {
    throw new TypeError(`query must contain 1 to ${MAX_QUERY_LENGTH} characters`);
  }
  const mode = input.mode ?? "fulltext";
  if (mode !== "fulltext" && mode !== "exact" && mode !== "prefix") throw new TypeError("mode must be fulltext, exact, or prefix");
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new TypeError("limit must be between 1 and 100");
  if (input.scope !== undefined && (typeof input.scope !== "string" || input.scope.length > 1024)) throw new TypeError("scope must be a repository path of at most 1024 characters");
  if (input.useNlp !== undefined && typeof input.useNlp !== "boolean") throw new TypeError("useNlp must be a boolean");
  if (input.includeSemantic !== undefined && typeof input.includeSemantic !== "boolean") throw new TypeError("includeSemantic must be a boolean");
  const scope = typeof input.scope === "string" ? input.scope.trim() : "";
  if (scope) assertProjectPath(scope);
  return { query: input.query.trim(), mode, limit: limit as number,
    ...(scope ? { scope } : {}),
    useNlp: input.useNlp === true, includeSemantic: input.includeSemantic === true };
}

function parseResolve(value: unknown): { text: string } {
  const input = record(value, "input");
  if (typeof input.text !== "string" || input.text.length > MAX_VISIBLE_TEXT) throw new TypeError(`text must be at most ${MAX_VISIBLE_TEXT} UTF-16 code units`);
  return { text: input.text };
}

function parseEmpty(value: unknown): Record<string, unknown> { return record(value, "input"); }

function parseTermProposal(value: unknown): { id?: string; canonical: string; aliases: string[]; targetPath: string } {
  const input = record(value, "input");
  if (input.id !== undefined && (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(input.id))) throw new TypeError("id is invalid");
  if (typeof input.canonical !== "string" || !input.canonical.trim() || input.canonical.length > 256) throw new TypeError("canonical must contain 1 to 256 characters");
  if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 32 || input.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 256))) {
    throw new TypeError("aliases must contain at most 32 non-empty strings of at most 256 characters");
  }
  if (typeof input.targetPath !== "string") throw new TypeError("targetPath is required");
  assertProjectPath(input.targetPath);
  return { ...(typeof input.id === "string" ? { id: input.id } : {}), canonical: input.canonical.trim(),
    aliases: Array.isArray(input.aliases) ? input.aliases as string[] : [], targetPath: input.targetPath };
}

function parseTermRemoval(value: unknown): { id: string } {
  const input = record(value, "input");
  if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(input.id)) throw new TypeError("id is invalid");
  return { id: input.id };
}

async function readRegistry(reader: SnapshotReader): Promise<{ registry: TermRegistry; revision: string | null }> {
  const file = await reader.read(TERM_REGISTRY_PATH);
  if (!file) return { registry: { schemaVersion: 1, terms: [] }, revision: null };
  if (new TextEncoder().encode(file.content).byteLength > MAX_REGISTRY_BYTES) throw new TypeError("Search term registry exceeds its 1 MiB limit");
  let parsed: unknown;
  try { parsed = JSON.parse(file.content); }
  catch { throw new TypeError("Search term registry is invalid JSON"); }
  return { registry: parseTermRegistry(parsed), revision: file.revision };
}

async function optionalNlpTokens(moduleContext: ModuleContext, context: ModuleActionContext, query: string): Promise<{ tokens: string[]; warning?: string }> {
  if (context.signal.aborted) throw context.signal.reason ?? Object.assign(new Error("Search was cancelled"), { code: "job_cancelled" });
  try {
    const lease = await moduleContext.acquireCapability<NlpTokenizerPort>(NLP_TOKENIZER_CAPABILITY);
    try {
      const analysis = await lease.value.analyze(query, context.reader.snapshot, context.signal);
      const tokens = analysis.tokens.filter((token) => typeof token.surface === "string" && token.surface.trim().length > 1 &&
        (!token.pos || token.pos.startsWith("名詞"))).map((token) => token.surface);
      return { tokens };
    } finally { await lease.release(); }
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { tokens: [], warning: "nlp_tokenizer_unavailable" };
  }
}

export function createSearchActions(moduleContext: ModuleContext, indexes: SnapshotIndexCache, registries = new Map<string, Promise<TermRegistry>>()): ModuleAction[] {
  const registryFor = (reader: SnapshotReader): Promise<TermRegistry> => {
    const key = snapshotKey(reader.snapshot);
    const cached = registries.get(key);
    if (cached) return cached;
    const pending = readRegistry(reader).then(({ registry }) => registry);
    registries.set(key, pending);
    while (registries.size > 4) registries.delete(registries.keys().next().value!);
    void pending.catch(() => { if (registries.get(key) === pending) registries.delete(key); });
    return pending;
  };

  return [
    action("search.query", "compute", parseQuery, async (raw, context) => {
      const input = raw as ReturnType<typeof parseQuery>;
      const index = await indexes.get(context.reader, context.signal);
      const warnings: string[] = [];
      let queryHints: string[] = [];
      if (input.useNlp) {
        const enhanced = await optionalNlpTokens(moduleContext, context, input.query);
        queryHints = enhanced.tokens;
        if (enhanced.warning) warnings.push(enhanced.warning);
      }
      let registry: TermRegistry = { schemaVersion: 1, terms: [] };
      try { registry = await registryFor(context.reader); }
      catch { warnings.push("term_registry_unavailable"); }
      const lexical = searchDocuments(index.documents.values(), input.query, input.mode, input.limit, input.scope, queryHints);
      const termHits = searchTerms(registry.terms, index.revisions, input.query, input.mode, input.scope);
      let semanticResults: unknown[] = [];
      if (input.includeSemantic) {
        const result = await context.invoke("semantic.search", { query: input.query, mode: "scene", limit: input.limit }, context.signal);
        if (result.ok) semanticResults = Array.isArray((result.data as { results?: unknown[] }).results) ? (result.data as { results: unknown[] }).results : [];
        else warnings.push(`semantic_unavailable:${result.error.code}`);
      }
      const hits = [...lexical, ...termHits].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.title.localeCompare(right.title)).slice(0, input.limit);
      return { ok: true, snapshot: context.reader.snapshot, data: {
        indexSnapshot: index.snapshot, results: hits, semanticResults, warnings,
        indexedDocuments: index.documents.size, indexBytes: index.bytes,
      } } as ActionResult;
    }),
    action("search.terms.list", "read", parseEmpty, async (_raw, context) => {
      let registry: TermRegistry;
      let warning: string | undefined;
      try { registry = await registryFor(context.reader); }
      catch { registry = { schemaVersion: 1, terms: [] }; warning = "term_registry_unavailable"; }
      const paths = await indexes.documentPaths(context.reader, context.signal);
      return { ok: true, snapshot: context.reader.snapshot, data: {
        terms: registry.terms.map((term) => ({ ...term, targetAvailable: paths.has(term.targetPath) })),
        ...(warning ? { warning } : {}),
      } } as ActionResult;
    }),
    action("search.terms.resolve", "read", parseResolve, async (raw, context) => {
      const input = raw as ReturnType<typeof parseResolve>;
      let registry: TermRegistry;
      let warning: string | undefined;
      try { registry = await registryFor(context.reader); }
      catch { registry = { schemaVersion: 1, terms: [] }; warning = "term_registry_unavailable"; }
      const paths = await indexes.documentPaths(context.reader, context.signal);
      const resolved = resolveTermSpans(input.text, registry.terms, paths);
      return { ok: true, snapshot: context.reader.snapshot, data: { ...resolved, ...(warning ? { warning } : {}) } } as ActionResult;
    }),
    action("search.terms.propose", "propose", parseTermProposal, async (raw, context) => {
      const input = raw as ReturnType<typeof parseTermProposal>;
      const paths = await indexes.documentPaths(context.reader, context.signal);
      if (!paths.has(input.targetPath)) throw Object.assign(new Error("Term target is not an available document in this snapshot"), { code: "term_target_unavailable" });
      const { registry, revision } = await readRegistry(context.reader);
      const id = input.id ?? registry.terms.find((term) => normalizeTerm(term.canonical) === normalizeTerm(input.canonical))?.id ?? `term-${randomUUID()}`;
      const target = await context.reader.read(input.targetPath);
      if (!target) throw Object.assign(new Error("Term target is unavailable in this snapshot"), { code: "term_target_unavailable" });
      const nextTerm: SearchTerm = { id, canonical: input.canonical, aliases: input.aliases, targetPath: input.targetPath };
      const terms = [...registry.terms.filter((term) => term.id !== id), nextTerm].sort((left, right) => left.id.localeCompare(right.id));
      const next = parseTermRegistry({ schemaVersion: 1, terms });
      const content = `${JSON.stringify(next, null, 2)}\n`;
      const operation: ChangeOperation = {
        id: `search-${randomUUID()}`, generation: 0,
        repository: context.reader.snapshot.repository,
        baseRemoteCommit: context.reader.snapshot.remoteCommit,
        effect: "settings",
        reads: [{ path: TERM_REGISTRY_PATH, revision }, { path: input.targetPath, revision: target.revision }],
        writes: [{ path: TERM_REGISTRY_PATH, revision, content }],
        message: `Update terminology entry: ${input.canonical}`,
      };
      const proposal = await context.propose([operation], [{
        id: randomUUID(), snapshot: context.reader.snapshot, module: "search", kind: "term_registry_update",
        paths: [{ path: TERM_REGISTRY_PATH, revision }, { path: input.targetPath, revision: target.revision }],
        details: { termId: id, canonical: input.canonical, aliases: input.aliases, targetPath: input.targetPath },
      }]);
      registries.delete(snapshotKey(context.reader.snapshot));
      return { ok: true, snapshot: context.reader.snapshot, data: { term: nextTerm, proposal } } as ActionResult;
    }),
    action("search.terms.remove", "propose", parseTermRemoval, async (raw, context) => {
      const input = raw as ReturnType<typeof parseTermRemoval>;
      const { registry, revision } = await readRegistry(context.reader);
      const existing = registry.terms.find((term) => term.id === input.id);
      if (!existing) throw Object.assign(new Error("Search term was not found"), { code: "term_not_found" });
      const next = parseTermRegistry({ schemaVersion: 1, terms: registry.terms.filter((term) => term.id !== input.id) });
      const content = `${JSON.stringify(next, null, 2)}\n`;
      const operation: ChangeOperation = {
        id: `search-${randomUUID()}`, generation: 0,
        repository: context.reader.snapshot.repository,
        baseRemoteCommit: context.reader.snapshot.remoteCommit,
        effect: "settings", reads: [{ path: TERM_REGISTRY_PATH, revision }],
        writes: [{ path: TERM_REGISTRY_PATH, revision, content }],
        message: `Remove terminology entry: ${existing.canonical}`,
      };
      const proposal = await context.propose([operation], [{
        id: randomUUID(), snapshot: context.reader.snapshot, module: "search", kind: "term_registry_remove",
        paths: [{ path: TERM_REGISTRY_PATH, revision }], details: { termId: existing.id, canonical: existing.canonical },
      }]);
      registries.delete(snapshotKey(context.reader.snapshot));
      return { ok: true, snapshot: context.reader.snapshot, data: { removed: existing.id, proposal } } as ActionResult;
    }),
  ];
}

export const searchManifest: ModuleManifest = {
  id: "search", version: "0.1.0", contractVersion: 1,
  dependencies: [], provides: [], requires: [],
  optionalRequires: [NLP_TOKENIZER_CAPABILITY, SEMANTIC_EMBEDDING_CAPABILITY],
  serverEntry: "./dist/index.js", browserEntry: "./dist/browser.js",
  statePaths: ["meta/scriptorium/modules/search"], locality: "local",
};

export function createSearchDefinition(context: ModuleContext): ModuleDefinition {
  const indexes = new SnapshotIndexCache();
  const registries = new Map<string, Promise<TermRegistry>>();
  return {
    manifest: searchManifest,
    actions: createSearchActions(context, indexes, registries),
    ui: [
      { id: "search.panel", module: "search", slot: "dock", title: "全文検索", action: "search.query", contractVersion: 1, kind: "panel", contexts: ["workspace", "editor"] },
      { id: "search.terms", module: "search", slot: "inspection", title: "用語辞典", action: "search.terms.list", contractVersion: 1, kind: "panel", contexts: ["workspace", "editor", "reading"] },
      { id: "search.terms.adornment", module: "search", slot: "editor", title: "用語リンク", action: "search.terms.resolve", contractVersion: 1, kind: "editor-adornment", contexts: ["editor", "reading"] },
    ],
    async dispose() { indexes.clear(); registries.clear(); },
  };
}

export { type TermResolution } from "./terminology.js";
