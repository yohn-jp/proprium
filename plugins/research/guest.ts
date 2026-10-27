import { normalizeUnicode } from "../shared/unicode.js";
import { createGuest, withWarnings } from "../shared/guest.js";
import { HOST_OPERATIONS, readAsset, type CacheKey, type FileChunk, type FileEntry, type FilePage } from "../shared/operations.js";
import type { ActionRequest, ChangeSet, FileOperation } from "../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, Handler, HostCall } from "../shared/guest.js";
import {
  buildResearchIndex,
  isSearchableDocumentPath,
  isSafeRelativePath,
  parseTermRegistry,
  queryResearchIndex,
  removeTermRegistryEntry,
  resolveTermSpans,
  TERM_REGISTRY_PATH,
  upsertTermRegistry,
  type ResearchDocumentInput,
  type SearchRequest,
  type TermRegistry,
} from "./core.js";
import {
  aggregateCandidateEvidence,
  approximateTokenCount,
  expandKnownSpellingVariants,
  MAX_CANDIDATE_ITEMS,
  MAX_CANDIDATE_TEXT_BYTES,
  MAX_CANDIDATE_TOTAL_BYTES,
  MAX_NLP_TEXT_UTF16,
  isSafeLocalModelId,
  isWellFormedUtf16,
  mapLinderaRawTokens,
  suggestTermVariants,
  validateTokenCountTexts,
  splitIntoSentenceOffsets,
} from "./nlp.js";
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { sha256, sha256Text } from "./sha256.js";
import { ASSET_READ_CHUNK_BYTES, RESEARCH_DICTIONARY_FILES, RESEARCH_DICTIONARY_GROUP_ID,
  RESEARCH_DICTIONARY_MANIFEST_SHA256, RESEARCH_TOKENIZER_ID, RESEARCH_TOKENIZER_VERSION } from "./asset-group.js";
import { getResearchMorphologyBindings, type EngineToken } from "./morphology.js";

const PLUGIN_ID = "proprium.research";
const INDEX_SCHEMA_VERSION = 1;
const INDEX_CONFIG_DIGEST = sha256Text("proprium.research/index-v1/nfkc-casefold/japanese-bigrams/bounded-limits");
const TERMS_PAGE_PREFIX = "research-terms-v1:";
const SYNONYMS_PATH = "meta/scriptorium/modules/nlp/synonyms.yaml";
const IGNORED_PATH = "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml";
const FEATURE_SETTINGS_PATH = "meta/scriptorium/modules/nlp/feature-settings.json";
const MAX_SOURCE_PATHS = 100_000;
const MAX_RESOLVE_TARGET_PATHS = 128;
const MAX_FILE_READ = 2 * 1024 * 1024;
// JSON Host RPC encodes byte arrays as numbers; small reads keep margin under the 1 MiB v2 envelope.
const MAX_CHUNK = 32_768;
const CACHE_CHUNK_BYTES = 256 * 1024;
const CACHE_TEXT_PART_BYTES = 48 * 1024;
const MAX_CACHE_SERIALIZED_BYTES = 47 * 1024 * 1024;
const INLINE_CHANGE_BYTES = 32 * 1024;
const ARTIFACT_CHUNK_BYTES = 32 * 1024;
const ARTIFACT_OPERATIONS = { create: "artifact.create", append: "artifact.append", seal: "artifact.seal", discard: "artifact.discard" } as const;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_ANALYSIS_TEXT_BYTES = 64 * 1024;
const MAX_ANALYSIS_TOKENS = 4_096;
const RESEARCH_DISPOSE = Symbol("research.dispose");
// SHA-256 of the pinned source module that defines sourceApproxTokenCount and its bounds.
const TOKEN_COUNTER_DIGEST = "205e2370155900abcc923065a85072f74eb706f1bcec68fbaa93eb15883d4b88";

interface IndexCacheManifest {
  schemaVersion: 1;
  snapshotId: string;
  scope: string | null;
  documentCount: number;
  sourceBytes: number;
  serializedBytes: number;
  chunkCount: number;
  sha256: string;
  chunkDigests: string[];
}

interface ParsedYaml { document: Document; value: Record<string, unknown> }
interface LoadedRegistry { registry: TermRegistry; revision: string | null }
interface ResearchCacheEntry {
  snapshot: ActionRequest["snapshot"];
  scope?: string;
  snapshotId: string;
  index: ReturnType<typeof buildResearchIndex>;
}

function publicTerm(term: TermRegistry["terms"][number]): Record<string, unknown> {
  const extensions = Object.fromEntries(Object.entries(term).filter(([key]) => !["id", "canonical", "aliases", "targetPath"].includes(key)));
  return { id: term.id, canonical: term.canonical, aliases: term.aliases, targetPath: term.targetPath, ...(Object.keys(extensions).length ? { extensions } : {}) };
}

function fail(code: string, message: string, retryable = false, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, retryable, ...(details ? { details } : {}) });
}
function object(value: unknown, label = "input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid_input", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactFields(input: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length) throw fail("invalid_input", `Unknown input field: ${extras[0]}`);
}
function validRevision(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function utf8PathCompare(a: string, b: string): number {
  const left = new TextEncoder().encode(a); const right = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}
function snapshotCacheKey(context: ActionRequest, scope?: string): string {
  return JSON.stringify([context.scope.workspace_id, context.scope.repository_id, context.scope.branch, context.scope.generation, context.snapshot.id, scope ?? null]);
}
function encodeCursor(value: Record<string, unknown>, prefix = TERMS_PAGE_PREFIX): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return prefix + btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
function decodeCursor(value: string, prefix = TERMS_PAGE_PREFIX): Record<string, unknown> {
  try {
    if (!value.startsWith(prefix)) throw new Error();
    const encoded = value.slice(prefix.length).replace(/-/gu, "+").replace(/_/gu, "/");
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))));
    return object(parsed, "cursor");
  } catch { throw fail("invalid_input", "Term cursor is invalid"); }
}

function getMorphologyFailure(error: unknown): { code?: string; message: string } {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === "string") return { code: value.code, message: typeof value.message === "string" ? value.message : value.code };
    if (typeof value.message === "string") {
      const match = /^(capability_denied|missing_capability|provider_unavailable|model_unavailable|incompatible_abi|cancelled|capacity):\s*(.*)$/u.exec(value.message);
      return match ? { code: match[1], message: match[2] || match[1] } : { message: value.message };
    }
  }
  return { message: error instanceof Error ? error.message : typeof error === "string" ? error : "Tokenizer operation failed" };
}

function* ensureResearchTokenizer(host: GuestHost, isReady: () => boolean, setReady: (value: boolean) => void): Generator<HostCall, void, unknown> {
  if (isReady()) return;
  const morphology = getResearchMorphologyBindings();
  try {
    for (const file of RESEARCH_DICTIONARY_FILES) {
      let offset = 0;
      let begun = false;
      do {
        const chunk = yield* readAsset(host, {
          group_id: RESEARCH_DICTIONARY_GROUP_ID, file_path: file.path, offset, length: ASSET_READ_CHUNK_BYTES,
        });
        if (chunk.total_bytes !== file.byte_length || chunk.sha256 !== file.sha256) {
          throw fail("incompatible_abi", "Admitted dictionary bytes differ from the pinned Research tokenizer release");
        }
        if (!begun) {
          morphology.beginAsset(RESEARCH_DICTIONARY_GROUP_ID, file.path, file.byte_length, file.sha256);
          begun = true;
        }
        morphology.appendAsset(RESEARCH_DICTIONARY_GROUP_ID, file.path, offset, chunk.bytes);
        offset += chunk.bytes.length;
        if (chunk.next_offset === null) break;
        if (chunk.next_offset !== offset) throw fail("provider_unavailable", "Host asset range did not advance contiguously");
      } while (true);
      if (!begun || offset !== file.byte_length) throw fail("provider_unavailable", "Host returned an incomplete pinned dictionary file");
      morphology.finishAsset(RESEARCH_DICTIONARY_GROUP_ID, file.path);
    }
    morphology.loadTokenizer();
    setReady(true);
  } catch (error) {
    try { morphology.release(); } catch { /* Preserve the original Host/model error. */ }
    setReady(false);
    const failure = getMorphologyFailure(error);
    if (failure.code === "cancelled") throw fail("cancelled", failure.message, true);
    if (failure.code === "capacity") throw fail("capacity", failure.message);
    if (failure.code === "invalid_input" || failure.code === "snapshot_stale") throw error;
    if (failure.code === "capability_denied" || failure.code === "missing_capability" ||
        failure.code === "provider_unavailable" || failure.code === "model_unavailable") {
      throw fail("dependency_unavailable", "The optional signed Japanese tokenizer is not available in this workspace", true, { reason: failure.code });
    }
    if (failure.code === "incompatible_abi") throw fail("incompatible_abi", failure.message);
    throw fail("dependency_unavailable", failure.message, true);
  }
}

function mappedAnalysisTokens(text: string, raw: readonly EngineToken[], knownSentences?: readonly { start: number; end: number }[]): Array<Record<string, unknown>> {
  const mapped = mapLinderaRawTokens(text, raw);
  if (mapped.length > MAX_ANALYSIS_TOKENS) throw fail("capacity", "Analysis produces more tokens than the bounded result can return");
  const sentences = knownSentences ?? splitIntoSentenceOffsets(text);
  let sentenceIndex = 0;
  return mapped.map((token) => {
    while (sentenceIndex + 1 < sentences.length && token.start >= sentences[sentenceIndex]!.end) sentenceIndex++;
    return { ...token, sentenceIndex };
  });
}

function* listPrefix(host: GuestHost, context: ActionRequest, prefix: string): Generator<HostCall, FileEntry[], unknown> {
  const output: FileEntry[] = [];
  let cursor: string | null = null;
  do {
    const page: FilePage = yield* host.request<FilePage>(HOST_OPERATIONS.list, { snapshot: context.snapshot, prefix, ...(cursor ? { cursor } : {}), limit: 256 });
    if (!page || !Array.isArray(page.entries) || page.entries.length > 256 || !(page.next_cursor === null || typeof page.next_cursor === "string")) throw fail("storage_unknown", "Host returned an invalid file page");
    for (const entry of page.entries) {
      if (!entry || typeof entry.path !== "string" || !entry.path.startsWith(prefix) || !isSafeRelativePath(entry.path) || !validRevision(entry.revision) ||
          !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 || typeof entry.media_type !== "string") throw fail("storage_unknown", "Host returned invalid file metadata");
      if (output.length >= MAX_SOURCE_PATHS) throw fail("capacity", "Research source path limit exceeded");
      const previous = output.at(-1);
      if (previous && utf8PathCompare(previous.path, entry.path) >= 0) throw fail("storage_unknown", "Host file paths are not in strict UTF-8 order");
      output.push(entry);
    }
    cursor = page.next_cursor;
  } while (cursor !== null);
  return output;
}

function* listSearchableEntries(host: GuestHost, context: ActionRequest, scope?: string): Generator<HostCall, FileEntry[], unknown> {
  // The logical scope may be an exact file or directory; list the raw prefix and filter siblings below.
  const prefixes = scope ? [scope] : ["manuscript/", "plot/", "bible/", "meta/scratch/"];
  const byPath = new Map<string, FileEntry>();
  for (const prefix of prefixes) {
    for (const entry of yield* listPrefix(host, context, prefix)) {
      const inScope = !scope || entry.path === scope || entry.path.startsWith(`${scope}/`);
      if (inScope) byPath.set(entry.path, entry);
      if (byPath.size > MAX_SOURCE_PATHS) throw fail("capacity", "Research source path limit exceeded");
    }
  }
  return [...byPath.values()].sort((a, b) => utf8PathCompare(a.path, b.path));
}

function* readEntryText(host: GuestHost, context: ActionRequest, entry: FileEntry, maxBytes = MAX_FILE_READ): Generator<HostCall, string, unknown> {
  if (entry.byte_length > maxBytes) throw fail("capacity", `File exceeds the ${maxBytes}-byte read limit`, false, { path: entry.path });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let offset = 0;
  let text = "";
  do {
    const length = Math.min(MAX_CHUNK, Math.max(0, entry.byte_length - offset));
    const chunk = yield* host.request<FileChunk>(HOST_OPERATIONS.read, { snapshot: context.snapshot, path: entry.path, offset, length });
    if (!chunk || chunk.offset !== offset || chunk.revision !== entry.revision || chunk.total_bytes !== entry.byte_length || !Array.isArray(chunk.bytes) ||
        chunk.bytes.length > length || chunk.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
        (chunk.next_offset !== null && chunk.next_offset !== offset + chunk.bytes.length)) throw fail("snapshot_stale", "Pinned file bytes do not match the listed revision", true, { path: entry.path });
    const bytes = Uint8Array.from(chunk.bytes);
    try { text += decoder.decode(bytes, { stream: chunk.next_offset !== null }); }
    catch { throw fail("invalid_encoding", `File is not valid UTF-8: ${entry.path}`, false, { path: entry.path }); }
    if (chunk.next_offset === null) {
      if (offset + chunk.bytes.length !== entry.byte_length) throw fail("snapshot_stale", "Pinned file read ended before its listed byte length", true, { path: entry.path });
      break;
    }
    if (chunk.next_offset <= offset || chunk.bytes.length === 0) throw fail("storage_unknown", "Host file read did not advance");
    offset = chunk.next_offset;
  } while (true);
  try { text += decoder.decode(); }
  catch { throw fail("invalid_encoding", `File ends with invalid UTF-8: ${entry.path}`, false, { path: entry.path }); }
  return text;
}

function* readPathMeta(host: GuestHost, context: ActionRequest, path: string): Generator<HostCall, FileEntry | null, unknown> {
  // With a UTF-8 ordered prefix page, the exact path sorts before every longer sibling.
  // One item is enough to establish both presence and absence without walking a large prefix.
  const page: FilePage = yield* host.request<FilePage>(HOST_OPERATIONS.list, { snapshot: context.snapshot, prefix: path, limit: 1 });
  if (!page || !Array.isArray(page.entries) || page.entries.length > 1 || !(page.next_cursor === null || typeof page.next_cursor === "string")) throw fail("storage_unknown", "Host returned an invalid exact-path page");
  const entry = page.entries[0];
  if (!entry) return null;
  if (typeof entry.path !== "string" || !entry.path.startsWith(path) || !isSafeRelativePath(entry.path) || !validRevision(entry.revision) ||
      !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 || typeof entry.media_type !== "string") throw fail("storage_unknown", "Host returned invalid exact-path metadata");
  return entry.path === path ? entry : null;
}

function* readOptionalText(host: GuestHost, context: ActionRequest, path: string, maxBytes: number): Generator<HostCall, { text: string; revision: string } | null, unknown> {
  const entry = yield* readPathMeta(host, context, path);
  if (!entry) return null;
  if (entry.byte_length > maxBytes) throw fail("capacity", `${path} exceeds its declared byte limit`, false, { path });
  return { text: yield* readEntryText(host, context, entry, maxBytes), revision: entry.revision };
}

function* loadRegistry(host: GuestHost, context: ActionRequest): Generator<HostCall, LoadedRegistry, unknown> {
  const file = yield* readOptionalText(host, context, TERM_REGISTRY_PATH, 1024 * 1024);
  if (!file) return { registry: { schemaVersion: 1, terms: [] }, revision: null };
  let parsed: unknown;
  try { parsed = JSON.parse(file.text); }
  catch { throw fail("unsupported_schema", "Term registry is invalid JSON", false, { path: TERM_REGISTRY_PATH }); }
  return { registry: parseTermRegistry(parsed), revision: file.revision };
}

function idHash(value: string): string {
  return sha256Text(value).slice(0, 32);
}
function requireIdempotency(context: ActionRequest): string {
  if (!context.idempotency_key || context.idempotency_key.length > 256) throw fail("invalid_input", "Proposal action requires a Host idempotency key");
  return context.idempotency_key;
}
function* fileOperationContent(
  host: GuestHost,
  context: ActionRequest,
  path: string,
  revision: string | null,
  bytes: Uint8Array,
  operationId: string,
): Generator<HostCall, FileOperation, unknown> {
  const operation: FileOperation = { id: operationId, kind: revision === null ? "create" : "replace", path, expected_revision: revision };
  if (bytes.length <= INLINE_CHANGE_BYTES) return { ...operation, content: Array.from(bytes) };

  const filename = path.slice(path.lastIndexOf("/") + 1);
  const mediaType = path.toLowerCase().endsWith(".json") ? "application/json" : "application/yaml";
  const createdValue = yield* host.request<unknown>(ARTIFACT_OPERATIONS.create, { media_type: mediaType, filename, scope: context.scope, snapshot: context.snapshot });
  const created = typeof createdValue === "string" ? { artifact_id: createdValue } : object(createdValue, "artifact receipt");
  const artifactId = created.artifact_id;
  const maxBytes = created.max_bytes === undefined ? MAX_ARTIFACT_BYTES : created.max_bytes;
  const maxChunkBytes = created.max_chunk_bytes === undefined ? ARTIFACT_CHUNK_BYTES : created.max_chunk_bytes;
  if (typeof artifactId !== "string" || !artifactId || artifactId.length > 256) {
    throw fail("storage_unknown", "Host returned an invalid proposal artifact receipt", true);
  }
  let sealed = false;
  try {
    if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < bytes.length || (maxBytes as number) > MAX_ARTIFACT_BYTES ||
        !Number.isSafeInteger(maxChunkBytes) || (maxChunkBytes as number) < 1) throw fail("storage_unknown", "Host returned invalid proposal artifact limits", true);
    const chunkSize = Math.min(ARTIFACT_CHUNK_BYTES, maxChunkBytes as number);
    let received = 0;
    let sequence = 0;
    while (received < bytes.length) {
      const part = bytes.subarray(received, Math.min(received + chunkSize, bytes.length));
      yield* host.request(ARTIFACT_OPERATIONS.append, { artifact_id: artifactId, sequence, bytes: Array.from(part) });
      received += part.length;
      sequence++;
    }
    yield* host.request(ARTIFACT_OPERATIONS.seal, { artifact_id: artifactId, sha256: sha256(bytes), total_bytes: bytes.length });
    sealed = true;
    return { ...operation, content_artifact: artifactId };
  } catch (error) {
    if (!sealed) {
      try { yield* host.request(ARTIFACT_OPERATIONS.discard, { artifact_id: artifactId }); }
      catch (discardError) {
        const message = error instanceof Error ? error.message : "Artifact transfer failed";
        const cleanup = discardError instanceof Error ? discardError.message : "discard failed";
        throw fail("storage_unknown", `${message}; Host did not confirm temporary artifact cleanup: ${cleanup}`, true, { artifactId });
      }
    }
    throw error;
  }
}

function* submitRegistryProposal(
  host: GuestHost,
  context: ActionRequest,
  args: { path: string; before: unknown; after: unknown; revision: string | null; reads: Array<{ path: string; revision: string | null }>; title: string; reason: string; affectedPaths: string[] },
): Generator<HostCall, { changeSetId: string; operationIds: string[]; preview: Record<string, unknown> }, unknown> {
  const key = requireIdempotency(context);
  const bytes = new TextEncoder().encode(JSON.stringify(args.after, null, 2) + "\n");
  const digestKey = idHash(`${key}\0${args.path}`);
  const opId = `research-${digestKey}`;
  const contentOperation = yield* fileOperationContent(host, context, args.path, args.revision, bytes, opId);
  const changeset: ChangeSet = {
    id: `research-${idHash(key)}`,
    idempotency_key: key,
    scope: context.scope,
    snapshot: context.snapshot,
    title: args.title,
    reason: args.reason,
    read_set: args.reads,
    units: [{
      id: `research-unit-${digestKey}`,
      label: args.title,
      depends_on: [],
      operations: [contentOperation],
    }],
    evidence: [],
  };
  const receipt = object(yield* host.request(HOST_OPERATIONS.propose, { changeset }), "proposal receipt");
  const changeSetId = typeof receipt.proposal_id === "string" ? receipt.proposal_id : typeof receipt.id === "string" ? receipt.id : changeset.id;
  const returnedOperations = Array.isArray(receipt.operation_ids) ? receipt.operation_ids.filter((id): id is string => typeof id === "string") : [opId];
  return { changeSetId, operationIds: returnedOperations, preview: { before: args.before, after: args.after, affectedPaths: args.affectedPaths, evidence: [] } };
}

function parseYamlObject(text: string, path: string): ParsedYaml {
  const document = parseDocument(text, { strict: true, uniqueKeys: true, version: "1.2" });
  if (document.errors.length || document.warnings.length) throw fail("unsupported_schema", `Invalid YAML in ${path}`, false, { path });
  const value: unknown = document.toJS();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("unsupported_schema", `${path} must contain a YAML mapping`, false, { path });
  if (!isMap(document.contents)) throw fail("unsupported_schema", `${path} must contain a YAML mapping`, false, { path });
  return { document, value: value as Record<string, unknown> };
}
function yamlString(document: Document): string { return document.toString({ lineWidth: 0 }); }
function yamlSequence(document: Document, key: string, path: string): ReturnType<Document["createNode"]> {
  if (!isMap(document.contents)) throw fail("unsupported_schema", `${path} must contain a YAML mapping`);
  const node = document.contents.get(key, true);
  if (node === undefined) { const sequence = document.createNode([]); document.contents.set(key, sequence); return sequence; }
  if (!isSeq(node)) throw fail("unsupported_schema", `${path} ${key} must be a sequence`, false, { path });
  return node;
}
function yamlArray(node: unknown, field: string, path: string): unknown[] {
  if (!Array.isArray(node)) throw fail("unsupported_schema", `${path} ${field} must be a sequence`, false, { path });
  return node;
}

function cacheScopeDigest(context: ActionRequest, scope?: string): string {
  return sha256Text(JSON.stringify([context.scope.workspace_id, context.scope.repository_id, context.scope.branch, context.scope.generation, scope ?? null]));
}
function cacheKey(context: ActionRequest, scope: string | undefined, key: string): CacheKey {
  return { plugin_id: PLUGIN_ID, snapshot: context.snapshot, schema_version: INDEX_SCHEMA_VERSION,
    config_digest: INDEX_CONFIG_DIGEST, key: `research-index:${cacheScopeDigest(context, scope)}:${key}` };
}
function* cacheGet(host: GuestHost, context: ActionRequest, scope: string | undefined, key: string): Generator<HostCall, { found: boolean; value?: unknown }, unknown> {
  return yield* host.request(HOST_OPERATIONS.cacheGet, { key: cacheKey(context, scope, key) });
}
function* evictResearchCache(host: GuestHost, context: ActionRequest, scope?: string): Generator<HostCall, unknown, unknown> {
  return yield* host.request(HOST_OPERATIONS.cacheEvict, { key: cacheKey(context, scope, "manifest") });
}
function* storeCacheValue(host: GuestHost, context: ActionRequest, scope: string | undefined, key: string, value: unknown): Generator<HostCall, void, unknown> {
  const result = object(yield* host.request(HOST_OPERATIONS.cachePut, { key: cacheKey(context, scope, key), value }), "cache receipt");
  if (result.stored !== true) throw fail("storage_unknown", "Host did not confirm the derived index cache write", true);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 8192, bytes.length)));
  }
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new TypeError("Invalid cached index chunk encoding");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function indexDigest(entries: readonly Pick<FileEntry, "path" | "revision">[]): string {
  return sha256Text(JSON.stringify(entries.map(({ path, revision }) => [path, revision])));
}
function* indexCacheLines(documents: readonly ResearchDocumentInput[]): Generator<string> {
  const encoder = new TextEncoder();
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex++) {
    const document = documents[documentIndex]!;
    const bytes = encoder.encode(document.text);
    const partCount = Math.max(1, Math.ceil(bytes.length / CACHE_TEXT_PART_BYTES));
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      const part = bytes.subarray(partIndex * CACHE_TEXT_PART_BYTES, Math.min((partIndex + 1) * CACHE_TEXT_PART_BYTES, bytes.length));
      yield `${JSON.stringify({ documentIndex, path: document.path, fileRevision: document.fileRevision, partIndex, partCount, textBase64: base64(part) })}\n`;
    }
  }
}

function cacheManifest(value: unknown): IndexCacheManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 9 || item.schemaVersion !== 1 || typeof item.snapshotId !== "string" ||
      !(item.scope === null || typeof item.scope === "string") || !Number.isSafeInteger(item.documentCount) ||
      (item.documentCount as number) < 0 || !Number.isSafeInteger(item.sourceBytes) || (item.sourceBytes as number) < 0 ||
      !Number.isSafeInteger(item.serializedBytes) || (item.serializedBytes as number) < 0 || (item.serializedBytes as number) > MAX_CACHE_SERIALIZED_BYTES ||
      !Number.isSafeInteger(item.chunkCount) || (item.chunkCount as number) < 0 || (item.chunkCount as number) > 256 ||
      typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256) || !Array.isArray(item.chunkDigests) ||
      item.chunkDigests.length !== item.chunkCount || item.chunkDigests.some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) ||
      ((item.documentCount as number) === 0) !== ((item.chunkCount as number) === 0)) return null;
  return item as unknown as IndexCacheManifest;
}

function* cachedIndexSources(
  host: GuestHost,
  context: ActionRequest,
  scope: string | undefined,
  searchable: FileEntry[],
): Generator<HostCall, ResearchDocumentInput[] | null, unknown> {
  const manifestResult = yield* cacheGet(host, context, scope, "manifest");
  if (!manifestResult?.found) return null;
  const manifest = cacheManifest(manifestResult.value);
  if (!manifest || manifest.snapshotId !== context.snapshot.id || manifest.scope !== (scope ?? null) ||
      manifest.documentCount !== searchable.length || manifest.sha256 !== indexDigest(searchable)) {
    yield* evictResearchCache(host, context, scope);
    return null;
  }
  const documents: ResearchDocumentInput[] = [];
  let expectedDocument = 0;
  let currentParts: Uint8Array[] = [];
  let currentPartCount = 0;
  let nextPart = 0;
  let sourceBytes = 0;
  let serializedBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const invalidate = function* (): Generator<HostCall, null, unknown> { yield* evictResearchCache(host, context, scope); return null; };
  for (let chunkIndex = 0; chunkIndex < manifest.chunkCount; chunkIndex++) {
    const result = yield* cacheGet(host, context, scope, `data:${manifest.sha256}:${chunkIndex}`);
    const value = result?.value;
    if (!result?.found || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as Record<string, unknown>).base64 !== "string") return yield* invalidate();
    let chunkBytes: Uint8Array;
    try { chunkBytes = fromBase64((value as { base64: string }).base64); }
    catch { return yield* invalidate(); }
    if (chunkBytes.length === 0 || chunkBytes.length > CACHE_CHUNK_BYTES || sha256(chunkBytes) !== manifest.chunkDigests[chunkIndex]) return yield* invalidate();
    serializedBytes += chunkBytes.length;
    if (serializedBytes > manifest.serializedBytes) return yield* invalidate();
    let chunkText: string;
    try { chunkText = decoder.decode(chunkBytes); }
    catch { return yield* invalidate(); }
    if (!chunkText.endsWith("\n")) return yield* invalidate();
    const lines = chunkText.slice(0, -1).split("\n");
    for (const line of lines) {
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch { return yield* invalidate(); }
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 6) return yield* invalidate();
      const row = raw as Record<string, unknown>;
      const entry = searchable[expectedDocument];
      if (!entry || row.documentIndex !== expectedDocument || row.path !== entry.path || row.fileRevision !== entry.revision ||
          !Number.isSafeInteger(row.partIndex) || !Number.isSafeInteger(row.partCount) || (row.partCount as number) < 1 ||
          (row.partCount as number) > Math.ceil(MAX_FILE_READ / CACHE_TEXT_PART_BYTES) || (row.partIndex as number) !== nextPart ||
          typeof row.textBase64 !== "string" || nextPart > 0 && (row.partCount as number) !== currentPartCount) return yield* invalidate();
      if (nextPart === 0) { currentParts = []; currentPartCount = row.partCount as number; }
      let textPart: Uint8Array;
      try { textPart = fromBase64(row.textBase64); }
      catch { return yield* invalidate(); }
      if (textPart.length > CACHE_TEXT_PART_BYTES || (nextPart + 1 < currentPartCount && textPart.length !== CACHE_TEXT_PART_BYTES)) return yield* invalidate();
      currentParts.push(textPart);
      nextPart++;
      if (nextPart === currentPartCount) {
        const fullBytes = new Uint8Array(currentParts.reduce((sum, part) => sum + part.length, 0));
        let offset = 0;
        for (const part of currentParts) { fullBytes.set(part, offset); offset += part.length; }
        if (fullBytes.length !== entry.byte_length || sha256(fullBytes) !== entry.revision) return yield* invalidate();
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fullBytes); }
        catch { return yield* invalidate(); }
        sourceBytes += fullBytes.length;
        documents.push({ path: entry.path, fileRevision: entry.revision, text });
        expectedDocument++;
        currentParts = []; currentPartCount = 0; nextPart = 0;
      }
    }
  }
  if (expectedDocument !== searchable.length || nextPart !== 0 || sourceBytes !== manifest.sourceBytes || serializedBytes !== manifest.serializedBytes) return yield* invalidate();
  return documents;
}

function* storeIndexSources(
  host: GuestHost,
  context: ActionRequest,
  scope: string | undefined,
  index: ReturnType<typeof buildResearchIndex>,
): Generator<HostCall, void, unknown> {
  const digest = indexDigest(index.documents.map(({ path, fileRevision }) => ({ path, revision: fileRevision })));
  let serializedBytes = 0;
  let estimatedChunks = 0;
  let pendingBytes = 0;
  const encoder = new TextEncoder();
  for (const line of indexCacheLines(index.documents)) {
    const size = encoder.encode(line).length;
    if (size > CACHE_CHUNK_BYTES) throw fail("capacity", "A Research cache record exceeds the bounded cache chunk size");
    if (pendingBytes > 0 && pendingBytes + size > CACHE_CHUNK_BYTES) { estimatedChunks++; pendingBytes = 0; }
    pendingBytes += size;
    serializedBytes += size;
    if (serializedBytes > MAX_CACHE_SERIALIZED_BYTES) throw fail("capacity", "Serialized Research index exceeds its Host cache bound");
  }
  if (pendingBytes > 0) estimatedChunks++;
  if (Math.ceil(serializedBytes * 4 / 3) + estimatedChunks * 2048 > 64 * 1024 * 1024) throw fail("capacity", "Research index does not fit the per-plugin Host cache quota");

  const chunkDigests: string[] = [];
  let pending = "";
  let pendingSize = 0;
  const flush = function* (): Generator<HostCall, void, unknown> {
    const bytes = encoder.encode(pending);
    const chunkDigest = sha256(bytes);
    yield* storeCacheValue(host, context, scope, `data:${digest}:${chunkDigests.length}`, { base64: base64(bytes) });
    chunkDigests.push(chunkDigest);
    pending = ""; pendingSize = 0;
  };
  for (const line of indexCacheLines(index.documents)) {
    const size = encoder.encode(line).length;
    if (pendingSize > 0 && pendingSize + size > CACHE_CHUNK_BYTES) yield* flush();
    pending += line; pendingSize += size;
  }
  if (pendingSize > 0) yield* flush();
  if (chunkDigests.length !== estimatedChunks) throw fail("storage_unknown", "Research cache chunk count changed between bounded passes", true);
  const manifest: IndexCacheManifest = {
    schemaVersion: 1, snapshotId: context.snapshot.id, scope: scope ?? null, documentCount: index.documents.length,
    sourceBytes: index.bytes, serializedBytes, chunkCount: chunkDigests.length, sha256: digest, chunkDigests,
  };
  yield* storeCacheValue(host, context, scope, "manifest", manifest);
}

function* loadIndex(host: GuestHost, context: ActionRequest, scope?: string, force = false): Generator<HostCall, ReturnType<typeof buildResearchIndex>, unknown> {
  const entries = yield* listSearchableEntries(host, context, scope);
  const searchable = entries.filter(({ path }) => isSearchableDocumentPath(path));
  if (searchable.length > 10_000) throw fail("capacity", "Research document limit exceeded");
  const totalBytes = searchable.reduce((total, entry) => total + entry.byte_length, 0);
  if (totalBytes > 32 * 1024 * 1024) throw fail("capacity", "Research index exceeds its 32 MiB limit");
  if (!force) {
    const cached = yield* cachedIndexSources(host, context, scope, searchable);
    if (cached) return buildResearchIndex(cached, context.snapshot.id);
  }
  const documents: ResearchDocumentInput[] = [];
  for (const entry of searchable) {
    if (entry.byte_length > MAX_FILE_READ) throw fail("capacity", `Searchable file exceeds its 2 MiB limit: ${entry.path}`, false, { path: entry.path });
    const text = yield* readEntryText(host, context, entry);
    documents.push({ path: entry.path, fileRevision: entry.revision, text });
  }
  const index = buildResearchIndex(documents, context.snapshot.id);
  yield* storeIndexSources(host, context, scope, index);
  return index;
}

export function createResearchHandlers(): Record<string, Handler> {
  const indexes = new Map<string, ResearchCacheEntry>();
  let tokenizerReady = false;
  const dispose = () => {
    tokenizerReady = false;
    try { getResearchMorphologyBindings().release(); } catch { /* The component may not have initialized. */ }
  };
  const indexFor = (context: ActionRequest, scope?: string): ResearchCacheEntry | undefined => indexes.get(snapshotCacheKey(context, scope));
  const rememberIndex = (context: ActionRequest, index: ReturnType<typeof buildResearchIndex>, scope?: string): ResearchCacheEntry => {
    const entry: ResearchCacheEntry = { snapshot: context.snapshot, scope, snapshotId: context.snapshot.id, index };
    const key = snapshotCacheKey(context, scope);
    indexes.delete(key); indexes.set(key, entry);
    while (indexes.size > 1) indexes.delete(indexes.keys().next().value!);
    return entry;
  };
  const handlers: Record<string, Handler> = {
    "research.query": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["query", "mode", "scope", "cursor", "limit", "includeTerms", "morphologyHints"]);
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 512) throw fail("invalid_input", "query must contain 1 to 512 characters");
      const mode = input.mode ?? "lexical";
      if (mode !== "lexical" && mode !== "exact" && mode !== "prefix") throw fail("invalid_input", "mode must be lexical, exact, or prefix");
      if (input.scope !== undefined && (typeof input.scope !== "string" || !isSafeRelativePath(input.scope))) throw fail("invalid_path", "scope must be a safe relative path");
      if (input.cursor !== undefined && typeof input.cursor !== "string") throw fail("invalid_input", "cursor must be a string");
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) throw fail("invalid_input", "limit must be between 1 and 100");
      if (input.includeTerms !== undefined && typeof input.includeTerms !== "boolean" || input.morphologyHints !== undefined && typeof input.morphologyHints !== "boolean") throw fail("invalid_input", "search flags must be boolean");
      const scope = input.scope as string | undefined;
      let cached = indexFor(context, scope);
      if (!cached) cached = rememberIndex(context, yield* loadIndex(host, context, scope), scope);
      const registry = input.includeTerms === false ? { registry: { schemaVersion: 1, terms: [] } as TermRegistry } : yield* loadRegistry(host, context);
      const page = queryResearchIndex(cached.index, {
        query: input.query, mode, snapshot: context.snapshot.id, scope,
        scopeBinding: cacheScopeDigest(context, scope),
        ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        ...(typeof input.includeTerms === "boolean" ? { includeTerms: input.includeTerms } : {}),
        ...(input.morphologyHints === true ? { morphologyHints: true } : {}),
      } satisfies SearchRequest, { terms: registry.registry.terms, tokenizerAvailable: false });
      const { warnings, ...value } = page;
      const result = { ...value, query: input.query, mode, hits: page.hits.map((hit) => {
        const first = hit.kind === "document" ? hit.matchRanges[0] : undefined;
        return { ...hit, navigationSpan: first ? { path: hit.path, revision: hit.fileRevision, start: first.start, end: first.end } : null };
      }) };
      return warnings.length ? withWarnings(result, warnings) : result;
    },
    "research.index.status": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["scope"]);
      if (input.scope !== undefined && (typeof input.scope !== "string" || !isSafeRelativePath(input.scope))) throw fail("invalid_path", "scope must be a safe relative path");
      const scope = input.scope as string | undefined;
      let result: { found: boolean; value?: unknown };
      try { result = yield* cacheGet(host, context, scope, "manifest"); }
      catch (error) {
        const typed = error as Partial<{ code: string; message: string }>;
        return { state: "unavailable", coverage: { documents: 0, bytes: 0 }, lastError: { code: typed.code ?? "dependency_unavailable", message: typed.message ?? "Host derived cache is unavailable" } };
      }
      if (!result?.found) return { state: "missing", coverage: { documents: 0, bytes: 0 } };
      const manifest = cacheManifest(result.value);
      if (!manifest || manifest.snapshotId !== context.snapshot.id || manifest.scope !== (scope ?? null)) return { state: "stale", coverage: { documents: 0, bytes: 0 } };
      return { state: "current", indexSnapshot: manifest.snapshotId, coverage: { documents: manifest.documentCount, bytes: manifest.sourceBytes } };
    },
    "research.index.rebuild": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["scope", "force"]);
      if (input.scope !== undefined && (typeof input.scope !== "string" || !isSafeRelativePath(input.scope))) throw fail("invalid_path", "scope must be a safe relative path");
      if (input.force !== undefined && typeof input.force !== "boolean") throw fail("invalid_input", "force must be boolean");
      const scope = input.scope as string | undefined;
      const existing = indexFor(context, scope);
      const index = existing && input.force !== true ? existing.index : yield* loadIndex(host, context, scope, input.force === true);
      const entry = rememberIndex(context, index, scope);
      return { jobId: `research-index-${idHash(snapshotCacheKey(context, scope))}`, state: "current", indexSnapshot: entry.snapshotId, progress: { completed: index.documents.length, total: index.documents.length } };
    },
    "research.terms.list": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["prefix", "cursor", "limit"]);
      if (input.prefix !== undefined && (typeof input.prefix !== "string" || input.prefix.length > 256)) throw fail("invalid_input", "prefix must be at most 256 characters");
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw fail("invalid_input", "limit must be between 1 and 100");
      const loaded = yield* loadRegistry(host, context);
      let offset = 0;
      const cursorParams = JSON.stringify([input.prefix ?? "", limit, cacheScopeDigest(context)]);
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== "string") throw fail("invalid_input", "cursor must be a string");
        const cursor = decodeCursor(input.cursor);
        if (cursor.snapshot !== context.snapshot.id || cursor.params !== cursorParams || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) throw fail("snapshot_stale", "Term cursor belongs to another snapshot or query");
        offset = cursor.offset as number;
      }
      const ownersByAlias = new Map<string, Set<string>>();
      for (const term of loaded.registry.terms) for (const alias of [term.canonical, ...term.aliases]) {
        const normalized = normalizeUnicode(alias, "NFKC").toLowerCase();
        const owners = ownersByAlias.get(normalized) ?? new Set<string>();
        owners.add(term.id); ownersByAlias.set(normalized, owners);
      }
      const items = loaded.registry.terms
        .filter((term) => !input.prefix || term.canonical.startsWith(input.prefix as string) || term.aliases.some((alias) => alias.startsWith(input.prefix as string)))
        .map((term) => {
          const ambiguous = new Set([term.canonical, ...term.aliases]
            .map((alias) => normalizeUnicode(alias, "NFKC").toLowerCase())
            .filter((alias) => (ownersByAlias.get(alias)?.size ?? 0) > 1));
          return { ...publicTerm(term), id: term.id, targetPath: term.targetPath, ambiguityCount: ambiguous.size };
        })
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (offset > items.length) throw fail("invalid_input", "Term cursor offset is outside the result set");
      const page = items.slice(offset, offset + (limit as number));
      const nextOffset = offset + page.length;
      const targetAvailability = new Map<string, boolean>();
      for (const term of page) if (!targetAvailability.has(term.targetPath)) targetAvailability.set(term.targetPath, (yield* readPathMeta(host, context, term.targetPath)) !== null);
      return { items: page.map((term) => ({ ...term, targetAvailable: targetAvailability.get(term.targetPath) === true })), registryRevision: loaded.revision,
        nextCursor: nextOffset < items.length ? encodeCursor({ snapshot: context.snapshot.id, params: cursorParams, offset: nextOffset }) : null };
    },
    "research.terms.get": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["termId"]);
      if (typeof input.termId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(input.termId)) throw fail("invalid_input", "termId is invalid");
      const loaded = yield* loadRegistry(host, context);
      const term = loaded.registry.terms.find(({ id }) => id === input.termId);
      if (!term) throw fail("file_not_found", "Term entry was not found");
      const target = yield* readPathMeta(host, context, term.targetPath);
      return { term: publicTerm(term), targetAvailable: target !== null, ...(target ? { targetRevision: target.revision } : {}), otherAliasesForTarget: loaded.registry.terms.filter((other) => other.id !== term.id && other.targetPath === term.targetPath).map(({ id, canonical, aliases }) => ({ id, canonical, aliases })), registryRevision: loaded.revision };
    },
    "research.terms.expand": (raw) => {
      const input = object(raw); exactFields(input, ["query", "knownTerms"]);
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 512) throw fail("invalid_input", "query must contain 1 to 512 characters");
      const known = input.knownTerms ?? [];
      if (!Array.isArray(known) || known.length > 2_000 || known.some((term) => typeof term !== "string" || !term || term.length > 256)) throw fail("invalid_input", "knownTerms is invalid");
      return { terms: expandKnownSpellingVariants(input.query, known as string[]) };
    },
    "research.terms.resolve": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["path", "textRevision", "text"]);
      if (typeof input.path !== "string" || !isSafeRelativePath(input.path) || typeof input.textRevision !== "string" || !validRevision(input.textRevision) || typeof input.text !== "string" || input.text.length > 24_000) throw fail("invalid_input", "Term resolution source is invalid");
      const entry = yield* readPathMeta(host, context, input.path);
      if (!entry) throw fail("file_not_found", "Term resolution source is unavailable");
      if (entry.revision !== input.textRevision) throw fail("snapshot_stale", "Term resolution source revision changed", true);
      const loaded = yield* loadRegistry(host, context);
      const candidateMatches = resolveTermSpans(input.text, loaded.registry.terms);
      const candidateIds = new Set([
        ...candidateMatches.spans.map(({ termId }) => termId),
        ...candidateMatches.ambiguities.flatMap(({ termIds }) => termIds),
      ]);
      const targetPaths = new Set(loaded.registry.terms.filter(({ id }) => candidateIds.has(id)).map(({ targetPath }) => targetPath));
      if (targetPaths.size > MAX_RESOLVE_TARGET_PATHS) throw fail("capacity", "Term resolution matched too many distinct target paths");
      const availableTargets = new Set<string>();
      for (const targetPath of targetPaths) if (yield* readPathMeta(host, context, targetPath)) availableTargets.add(targetPath);
      const resolved = resolveTermSpans(input.text, loaded.registry.terms, availableTargets);
      return { ...resolved, registryRevision: loaded.revision };
    },
    "research.terms.propose": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["termId", "canonical", "aliases", "targetPath", "expectedRegistryRevision", "expectedTargetRevision"]);
      if (input.termId !== undefined && (typeof input.termId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(input.termId))) throw fail("invalid_input", "termId is invalid");
      if (typeof input.canonical !== "string" || !input.canonical.trim() || input.canonical.length > 256) throw fail("invalid_input", "canonical must contain 1 to 256 characters");
      if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > 32 || input.aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 256))) throw fail("invalid_input", "aliases are invalid");
      if (typeof input.targetPath !== "string" || !isSafeRelativePath(input.targetPath)) throw fail("invalid_path", "targetPath is invalid");
      if (input.expectedRegistryRevision !== null && typeof input.expectedRegistryRevision !== "string" || typeof input.expectedTargetRevision !== "string") throw fail("invalid_input", "expected revisions are invalid");
      const loaded = yield* loadRegistry(host, context);
      if (loaded.revision !== input.expectedRegistryRevision) throw fail("snapshot_stale", "Term registry revision changed", true);
      const target = yield* readPathMeta(host, context, input.targetPath);
      if (!target) throw fail("file_not_found", "Term target is unavailable in this snapshot");
      if (target.revision !== input.expectedTargetRevision) throw fail("snapshot_stale", "Term target revision changed", true);
      const existing = loaded.registry.terms.find((term) => input.termId ? term.id === input.termId : normalizeUnicode(term.canonical, "NFKC").toLowerCase() === normalizeUnicode((input.canonical as string).trim(), "NFKC").toLowerCase());
      const generatedId = `term-${idHash(`${requireIdempotency(context)}\0${input.canonical}\0${input.targetPath}`)}`;
      const termId = (input.termId as string | undefined) ?? existing?.id ?? generatedId;
      if (loaded.registry.terms.some((term) => term.id === termId && term.id !== existing?.id)) throw fail("conflict", "Generated term ID collides with an existing registry entry");
      const next = upsertTermRegistry(loaded.registry, { id: termId, canonical: input.canonical as string, aliases: (input.aliases as string[] | undefined) ?? [], targetPath: input.targetPath });
      const preview = yield* submitRegistryProposal(host, context, {
        path: TERM_REGISTRY_PATH, before: loaded.registry, after: next, revision: loaded.revision,
        reads: [{ path: TERM_REGISTRY_PATH, revision: loaded.revision }, { path: input.targetPath, revision: target.revision }],
        title: `Register term: ${input.canonical}`, reason: "Add or update a revision-bound terminology entry.", affectedPaths: [TERM_REGISTRY_PATH, input.targetPath],
      });
      return { ...preview, term: publicTerm(next.terms.find(({ id }) => id === termId)!) };
    },
    "research.terms.remove.propose": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["termId", "expectedRegistryRevision"]);
      if (typeof input.termId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(input.termId) || input.expectedRegistryRevision !== null && typeof input.expectedRegistryRevision !== "string") throw fail("invalid_input", "Term removal input is invalid");
      const loaded = yield* loadRegistry(host, context);
      if (loaded.revision !== input.expectedRegistryRevision) throw fail("snapshot_stale", "Term registry revision changed", true);
      const removed = loaded.registry.terms.find(({ id }) => id === input.termId);
      const next = removeTermRegistryEntry(loaded.registry, input.termId);
      const preview = yield* submitRegistryProposal(host, context, {
        path: TERM_REGISTRY_PATH, before: loaded.registry, after: next, revision: loaded.revision,
        reads: [{ path: TERM_REGISTRY_PATH, revision: loaded.revision }], title: `Remove term: ${removed!.canonical}`,
        reason: "Remove exactly the selected terminology entry.", affectedPaths: [TERM_REGISTRY_PATH],
      });
      return { ...preview, removedTerm: publicTerm(removed!) };
    },
    "research.nlp.analyze": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["text", "source"]);
      if (typeof input.text !== "string" || input.text.length > MAX_NLP_TEXT_UTF16 || new TextEncoder().encode(input.text).length > MAX_ANALYSIS_TEXT_BYTES) throw fail("capacity", "Analysis text exceeds its bounded UTF-16 or UTF-8 size");
      if (!isWellFormedUtf16(input.text)) throw fail("invalid_input", "Analysis text contains an unpaired UTF-16 surrogate");
      const source = object(input.source, "source");
      if (source.kind === "saved-file") {
        exactFields(source, ["kind", "path", "textRevision"]);
        if (typeof source.path !== "string" || !isSafeRelativePath(source.path) || !validRevision(source.textRevision)) throw fail("invalid_input", "Saved-file source identity is invalid");
        const entry = yield* readPathMeta(host, context, source.path);
        if (!entry) throw fail("file_not_found", "Analysis source file is unavailable in this snapshot");
        if (entry.revision !== source.textRevision) throw fail("snapshot_stale", "Analysis source revision changed", true);
        const savedText = yield* readEntryText(host, context, entry, MAX_NLP_TEXT_UTF16 * 4);
        if (savedText !== input.text) throw fail("snapshot_stale", "Analysis text does not match its saved-file revision", true);
      } else if (source.kind === "draft") {
        exactFields(source, ["kind", "draftGeneration"]);
        if (typeof source.draftGeneration !== "string" || !source.draftGeneration || source.draftGeneration.length > 256 || source.draftGeneration !== context.snapshot.draft_generation) throw fail("snapshot_stale", "Analysis draft generation is not current", true);
      } else if (source.kind === "literal") {
        exactFields(source, ["kind"]);
      } else {
        throw fail("invalid_input", "Analysis source kind must be saved-file, draft, or literal");
      }
      let sentences: Array<{ start: number; end: number }>;
      try { sentences = splitIntoSentenceOffsets(input.text); }
      catch { throw fail("capacity", "Analysis text exceeds the bounded sentence-splitting limit"); }
      yield* ensureResearchTokenizer(host, () => tokenizerReady, (value) => { tokenizerReady = value; });
      let rawTokens: EngineToken[];
      try {
        rawTokens = getResearchMorphologyBindings().tokenize(input.text);
        if (!Array.isArray(rawTokens)) throw fail("incompatible_abi", "Lindera returned a non-array token result");
      } catch (error) {
        const failure = getMorphologyFailure(error);
        if (failure.code === "capacity") throw fail("capacity", failure.message);
        if (failure.code === "cancelled") throw fail("cancelled", failure.message, true);
        if (failure.code === "incompatible_abi") throw fail("incompatible_abi", failure.message);
        throw fail("dependency_unavailable", failure.message, true);
      }
      let tokens: Array<Record<string, unknown>>;
      try { tokens = mappedAnalysisTokens(input.text, rawTokens, sentences); }
      catch (error) {
        const failure = getMorphologyFailure(error);
        if (failure.code === "capacity") throw fail("capacity", failure.message);
        if (failure.code === "invalid_input") throw fail("invalid_input", failure.message);
        throw fail("incompatible_abi", failure.message);
      }
      const sourceValue = object(input.source, "source");
      return {
        source: { ...sourceValue, textDigest: sha256Text(input.text) },
        sentences, tokens,
        engine: { id: RESEARCH_TOKENIZER_ID, version: RESEARCH_TOKENIZER_VERSION, digest: RESEARCH_DICTIONARY_MANIFEST_SHA256 },
      };
    },
    "research.nlp.countTokens": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["texts", "modelId"]);
      const texts = validateTokenCountTexts(input.texts);
      if (input.modelId !== undefined && !isSafeLocalModelId(input.modelId)) throw fail("invalid_input", "modelId must identify an approved local tokenizer");
      if (input.modelId === "approx") return { counts: texts.map(approximateTokenCount), identity: { modelId: "approx", version: "source-approx-v1", digest: TOKEN_COUNTER_DIGEST, method: "approx" }, fallbackReason: "user_selected_approximation" };
      if (input.modelId !== undefined && input.modelId !== RESEARCH_TOKENIZER_ID) throw fail("dependency_unavailable", "The requested local tokenizer is not included in this Research release");
      for (const text of texts) if (!isWellFormedUtf16(text)) throw fail("invalid_input", "Token-count text contains an unpaired UTF-16 surrogate");
      yield* ensureResearchTokenizer(host, () => tokenizerReady, (value) => { tokenizerReady = value; });
      const morphology = getResearchMorphologyBindings();
      const counts = texts.map((text) => {
        try {
          const value = morphology.countTokens(text);
          if (!Number.isSafeInteger(value) || value < 0) throw fail("incompatible_abi", "Lindera returned an invalid token count");
          return value;
        } catch (error) {
          const failure = getMorphologyFailure(error);
          if (failure.code === "capacity") throw fail("capacity", failure.message);
          if (failure.code === "incompatible_abi") throw fail("incompatible_abi", failure.message);
          throw fail("dependency_unavailable", failure.message, true);
        }
      });
      return { counts, identity: { modelId: RESEARCH_TOKENIZER_ID, version: RESEARCH_TOKENIZER_VERSION, digest: RESEARCH_DICTIONARY_MANIFEST_SHA256, method: "model" } };
    },
    "research.terms.candidates": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["corpus", "knownTerms", "includeReadings", "cursor", "limit"]);
      const corpus = object(input.corpus, "corpus"); exactFields(corpus, ["kind", "items"]);
      if (corpus.kind !== "text" && corpus.kind !== "knowledge-entities" || !Array.isArray(corpus.items) || corpus.items.length < 1 || corpus.items.length > MAX_CANDIDATE_ITEMS) throw fail("invalid_input", "Candidate corpus kind or item count is invalid");
      const known = input.knownTerms ?? [];
      if (!Array.isArray(known) || known.length > 2_000 || known.some((term) => typeof term !== "string" || !term.trim() || term.length > 256)) throw fail("invalid_input", "knownTerms is invalid");
      if (input.includeReadings !== undefined && typeof input.includeReadings !== "boolean" || input.cursor !== undefined && typeof input.cursor !== "string") throw fail("invalid_input", "Candidate flags or cursor are invalid");
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200) throw fail("invalid_input", "Candidate limit must be between 1 and 200");
      const sourceIds = new Set<string>();
      const candidateSources: Array<{ id: string; path?: string; revision: string; texts: Array<{ id: string; text: string }> }> = [];
      let totalBytes = 0;
      const enc = new TextEncoder();
      for (const row of corpus.items) {
        const source = object(row, "candidate source"); exactFields(source, ["id", "path", "revision", "texts"]);
        if (typeof source.id !== "string" || !source.id || source.id.length > 256 || sourceIds.has(source.id) || !validRevision(source.revision) ||
            source.path !== undefined && (typeof source.path !== "string" || !isSafeRelativePath(source.path)) || !Array.isArray(source.texts) || source.texts.length < 1) throw fail("invalid_input", "Candidate source identity or text list is invalid");
        sourceIds.add(source.id);
        if (typeof source.path === "string") {
          const entry = yield* readPathMeta(host, context, source.path);
          if (!entry) throw fail("file_not_found", "Candidate source path is unavailable in this snapshot");
          if (entry.revision !== source.revision) throw fail("snapshot_stale", "Candidate source revision changed", true);
        }
        const textIds = new Set<string>();
        const texts: Array<{ id: string; text: string }> = [];
        for (const rawText of source.texts) {
          const record = object(rawText, "candidate text"); exactFields(record, ["id", "text"]);
          if (typeof record.id !== "string" || !record.id || record.id.length > 256 || textIds.has(record.id) || typeof record.text !== "string" || record.text.length > MAX_NLP_TEXT_UTF16 || !isWellFormedUtf16(record.text)) throw fail("invalid_input", "Candidate text record is invalid");
          textIds.add(record.id);
          const bytes = enc.encode(record.text).length;
          if (bytes > MAX_CANDIDATE_TEXT_BYTES) throw fail("capacity", "Candidate text exceeds 64 KiB");
          totalBytes += bytes;
          if (totalBytes > MAX_CANDIDATE_TOTAL_BYTES) throw fail("capacity", "Candidate corpus exceeds 1 MiB");
          texts.push({ id: record.id, text: record.text });
        }
        candidateSources.push({ id: source.id, ...(typeof source.path === "string" ? { path: source.path } : {}), revision: source.revision, texts });
      }
      const includeReadings = input.includeReadings !== false;
      const knownTerms = [...new Set(known as string[])];
      const requestDigest = sha256Text(JSON.stringify([
        corpus.kind,
        candidateSources.map(({ id, path, revision, texts }) => [id, path ?? null, revision, texts.map(({ id: textId, text }) => [textId, text])]),
        knownTerms.slice().sort(), includeReadings,
      ]));
      const scopeDigest = cacheScopeDigest(context);
      let offset = 0;
      if (input.cursor !== undefined) {
        const cursor = decodeCursor(input.cursor, "research-candidates-v1:");
        if (cursor.snapshot !== context.snapshot.id || cursor.scope !== scopeDigest || cursor.params !== requestDigest) throw fail("snapshot_stale", "Candidate cursor does not match this corpus and workspace snapshot", true);
        if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) throw fail("invalid_input", "Candidate cursor offset is invalid");
        offset = cursor.offset as number;
      }
      yield* ensureResearchTokenizer(host, () => tokenizerReady, (value) => { tokenizerReady = value; });
      const morphology = getResearchMorphologyBindings();
      const sourcesWithTokens: Array<{
        id: string; path?: string; revision: string;
        texts: Array<{ id: string; text: string; tokens: ReturnType<typeof mapLinderaRawTokens> }>;
      }> = [];
      let totalTokens = 0;
      for (const source of candidateSources) {
        const texts = source.texts.map(({ id, text }) => {
          let engineTokens: EngineToken[];
          try { engineTokens = morphology.tokenize(text); }
          catch (error) {
            const failure = getMorphologyFailure(error);
            if (failure.code === "capacity") throw fail("capacity", failure.message);
            if (failure.code === "incompatible_abi") throw fail("incompatible_abi", failure.message);
            throw fail("dependency_unavailable", failure.message, true);
          }
          const tokens = mapLinderaRawTokens(text, engineTokens);
          totalTokens += tokens.length;
          if (totalTokens > 100_000) throw fail("capacity", "Candidate corpus exceeds the bounded tokenizer result budget");
          return { id, text, tokens };
        });
        sourcesWithTokens.push({ id: source.id, ...(source.path ? { path: source.path } : {}), revision: source.revision, texts });
      }
      const candidates = aggregateCandidateEvidence(sourcesWithTokens, new Set(knownTerms));
      const page = candidates.slice(offset, offset + (limit as number));
      const output = page.map(({ reading, ...candidate }) => ({ ...candidate, ...(includeReadings && reading ? { reading } : {}) }));
      const nextOffset = offset + output.length;
      return {
        candidates: output, sourceCount: candidateSources.length,
        nextCursor: nextOffset < candidates.length ? encodeCursor({ snapshot: context.snapshot.id, scope: scopeDigest, params: requestDigest, offset: nextOffset }, "research-candidates-v1:") : null,
        tokenizerIdentity: { id: RESEARCH_TOKENIZER_ID, version: RESEARCH_TOKENIZER_VERSION, digest: RESEARCH_DICTIONARY_MANIFEST_SHA256 },
      };
    },
    "research.terms.variants": (raw) => {
      const input = object(raw); exactFields(input, ["candidates", "knownTerms"]);
      if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 200) throw fail("invalid_input", "candidates are invalid");
      for (const rawCandidate of input.candidates) {
        const candidate = object(rawCandidate, "candidate"); exactFields(candidate, ["term", "count"]);
        if (typeof candidate.term !== "string" || !candidate.term || candidate.term.length > 256 || !Number.isSafeInteger(candidate.count) || (candidate.count as number) < 0 || (candidate.count as number) > 1_000_000_000) throw fail("invalid_input", "candidate term or count is invalid");
      }
      if (!Array.isArray(input.knownTerms) || input.knownTerms.length > 2_000 || input.knownTerms.some((term) => typeof term !== "string" || term.length > 256)) throw fail("invalid_input", "knownTerms are invalid");
      return { suggestions: suggestTermVariants(input.candidates as Array<{ term: string; count: number }>, input.knownTerms as string[]) };
    },
    "research.synonyms.get": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["term"]);
      if (typeof input.term !== "string" || !input.term.trim() || input.term.length > 256) throw fail("invalid_input", "term is invalid");
      const file = yield* readOptionalText(host, context, SYNONYMS_PATH, 1024 * 1024);
      if (!file) return { group: null, alternatives: [], fileRevision: null };
      const parsed = parseYamlObject(file.text, SYNONYMS_PATH);
      const rawGroups = parsed.value.groups ?? [];
      if (!Array.isArray(rawGroups)) throw fail("unsupported_schema", "Synonym groups must be a sequence", false, { path: SYNONYMS_PATH });
      for (let ordinal = 0; ordinal < rawGroups.length; ordinal++) {
        const group = object(rawGroups[ordinal], `synonym group ${ordinal + 1}`);
        if (!Array.isArray(group.words) || group.words.length < 2 || group.words.some((word) => typeof word !== "string" || !word.trim()) || group.context !== undefined && group.context !== "positive" && group.context !== "negative") throw fail("unsupported_schema", `Synonym group ${ordinal + 1} is invalid`, false, { path: SYNONYMS_PATH });
        const words = group.words as string[];
        if (!words.includes(input.term as string)) continue;
        const extensions = Object.fromEntries(Object.entries(group).filter(([key]) => key !== "words" && key !== "context"));
        return { group: { words, ...(typeof group.context === "string" ? { context: group.context } : {}), ...(Object.keys(extensions).length ? { extensions } : {}) }, groupRef: { fileRevision: file.revision, ordinal, words, ...(typeof group.context === "string" ? { context: group.context } : {}) }, alternatives: words.filter((word) => word !== input.term), fileRevision: file.revision };
      }
      return { group: null, alternatives: [], fileRevision: file.revision };
    },
    "research.synonyms.propose": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["words", "context", "mergeGroupRef", "expectedFileRevision"]);
      if (!Array.isArray(input.words) || input.words.length < 2 || input.words.length > 100 || input.words.some((word) => typeof word !== "string" || !word.trim() || word.length > 256) || input.context !== undefined && input.context !== "positive" && input.context !== "negative" || input.expectedFileRevision !== null && typeof input.expectedFileRevision !== "string") throw fail("invalid_input", "Synonym proposal input is invalid");
      const file = yield* readOptionalText(host, context, SYNONYMS_PATH, 1024 * 1024);
      const revision = file?.revision ?? null;
      if (revision !== input.expectedFileRevision) throw fail("snapshot_stale", "Synonym dictionary revision changed", true);
      const parsed = parseYamlObject(file?.text ?? "{}\n", SYNONYMS_PATH);
      const sequence = yamlSequence(parsed.document, "groups", SYNONYMS_PATH);
      if (!isSeq(sequence)) throw fail("unsupported_schema", "Synonym groups must be a sequence", false, { path: SYNONYMS_PATH });
      const groups = yamlArray(parsed.value.groups ?? [], "groups", SYNONYMS_PATH) as Array<Record<string, unknown>>;
      const words = [...new Set((input.words as string[]).map((word) => word.trim()))];
      let ordinal = -1;
      const ref = input.mergeGroupRef;
      if (ref !== undefined) {
        const merge = object(ref, "mergeGroupRef"); exactFields(merge, ["fileRevision", "ordinal", "words", "context"]);
        if (merge.fileRevision !== revision || !Number.isSafeInteger(merge.ordinal) || (merge.ordinal as number) < 0 || !Array.isArray(merge.words)) throw fail("snapshot_stale", "Synonym merge reference is stale", true);
        ordinal = merge.ordinal as number;
        const group = groups[ordinal];
        if (!group || JSON.stringify(group.words) !== JSON.stringify(merge.words) || group.context !== merge.context) throw fail("snapshot_stale", "Synonym merge target changed", true);
      } else {
        const overlaps = groups.map((group, index) => ({ group, index })).filter(({ group }) => Array.isArray(group.words) && words.some((word) => (group.words as unknown[]).includes(word)));
        if (overlaps.length) throw fail("invalid_input", "Words already appear in a synonym group; select its revision-bound groupRef");
        if (words.length < 2) throw fail("invalid_input", "A new synonym group requires at least two distinct words");
      }
      const before = groups.map((group) => ({ ...group }));
      if (ordinal >= 0) {
        const group = sequence.get(ordinal, true);
        if (!isMap(group)) throw fail("unsupported_schema", "Selected synonym group must be a mapping");
        const mergedWords = [...new Set([...groups[ordinal]!.words as string[], ...words])];
        group.set("words", mergedWords);
        if (input.context !== undefined) group.set("context", input.context);
      } else {
        const nextGroup = { words, ...(input.context ? { context: input.context } : {}) };
        sequence.add(nextGroup);
      }
      const afterParsed = parsed.document.toJS() as Record<string, unknown>;
      const preview = yield* submitRawProposal(host, context, {
        path: SYNONYMS_PATH, before, after: afterParsed, revision, content: new TextEncoder().encode(yamlString(parsed.document)),
        reads: [{ path: SYNONYMS_PATH, revision }], title: "Update synonym dictionary", reason: "Propose a revision-guarded synonym group edit while retaining YAML comments and unknown fields.", affectedPaths: [SYNONYMS_PATH],
      });
      return { ...preview, groupsBefore: before, groupsAfter: afterParsed.groups };
    },
    "research.candidates.ignore.propose": function* (raw, context, host) {
      const input = object(raw); exactFields(input, ["terms", "ignore", "expectedFileRevision"]);
      if (!Array.isArray(input.terms) || input.terms.length < 1 || input.terms.length > 128 || input.terms.some((term) => typeof term !== "string" || !term.trim() || term.length > 256) || typeof input.ignore !== "boolean" || input.expectedFileRevision !== null && typeof input.expectedFileRevision !== "string") throw fail("invalid_input", "Candidate ignore input is invalid");
      const file = yield* readOptionalText(host, context, IGNORED_PATH, 1024 * 1024);
      const revision = file?.revision ?? null;
      if (revision !== input.expectedFileRevision) throw fail("snapshot_stale", "Candidate ignore file revision changed", true);
      const parsed = parseYamlObject(file?.text ?? "{}\n", IGNORED_PATH);
      const sequence = yamlSequence(parsed.document, "ignored", IGNORED_PATH);
      if (!isSeq(sequence)) throw fail("unsupported_schema", "Ignored candidates must be a sequence", false, { path: IGNORED_PATH });
      const current = yamlArray(parsed.value.ignored ?? [], "ignored", IGNORED_PATH);
      if (current.some((term) => typeof term !== "string")) throw fail("unsupported_schema", "Ignored candidate list contains a non-string", false, { path: IGNORED_PATH });
      const terms = [...new Set((input.terms as string[]).map((term) => term.trim()))];
      const before = [...current] as string[];
      const next = input.ignore ? [...new Set([...before, ...terms])].sort() : before.filter((term) => !terms.includes(term));
      if (input.ignore) {
        for (const term of next.filter((candidate) => !before.includes(candidate))) sequence.add(term);
      } else {
        const keep = sequence.items.filter((_item, index) => !terms.includes(current[index] as string));
        sequence.items.splice(0, sequence.items.length, ...keep);
      }
      const after = parsed.document.toJS() as Record<string, unknown>;
      const preview = yield* submitRawProposal(host, context, {
        path: IGNORED_PATH, before: parsed.value, after, revision, content: new TextEncoder().encode(yamlString(parsed.document)),
        reads: [{ path: IGNORED_PATH, revision }], title: input.ignore ? "Ignore candidate terms" : "Restore candidate terms",
        reason: "Change only the author-owned ignored-candidate preference after review.", affectedPaths: [IGNORED_PATH],
      });
      return { ...preview, added: input.ignore ? terms.filter((term) => !before.includes(term)) : [], removed: input.ignore ? [] : terms.filter((term) => before.includes(term)) };
    },
    "research.legacy-consent.read": function* (_raw, context, host) {
      exactFields(object(_raw), []);
      const file = yield* readOptionalText(host, context, FEATURE_SETTINGS_PATH, 1024 * 1024);
      let settings: Record<string, unknown> = {};
      if (file) {
        try { settings = object(JSON.parse(file.text), "legacy feature settings"); }
        catch { throw fail("unsupported_schema", "Legacy feature settings are invalid JSON", false, { path: FEATURE_SETTINGS_PATH }); }
      }
      const enabled = settings.externalEnabled === undefined ? {} : object(settings.externalEnabled, "externalEnabled");
      const features = [
        { id: "speaker-eval", label: "話者評価", locality: "local" }, { id: "speaker-retrain", label: "話者再学習", locality: "local" },
        { id: "speaker-attribution", label: "話者帰属", locality: "local" }, { id: "speaker-attribution-llm", label: "話者推定（外部モデル）", locality: "external" },
        { id: "hybrid-search", label: "意味検索", locality: "local" }, { id: "expression-search", label: "表現の在庫", locality: "local" },
        { id: "embedding", label: "文埋め込み", locality: "local" }, { id: "stylometry", label: "文体分析", locality: "local" },
        { id: "setting-qa", label: "設定を尋ねる", locality: "external" }, { id: "aspect-review", label: "観点別下読み", locality: "external" },
        { id: "rewrite", label: "言い換え（外部モデル）", locality: "external" }, { id: "scene-summary", label: "シーン要約", locality: "external" },
        { id: "chapter-summary", label: "章要約", locality: "external" }, { id: "dialogue-sketch", label: "対話スケッチ", locality: "external" },
        { id: "continuation-options", label: "続きの相談", locality: "external" }, { id: "contradiction-check", label: "矛盾照合", locality: "external" },
        { id: "zukan-proposal", label: "図鑑提案", locality: "external" }, { id: "state-event-draft", label: "状態イベント草案", locality: "external" },
        { id: "first-read-reaction", label: "初読リアクション", locality: "external" },
      ].map((feature) => ({ ...feature, legacyEnabled: feature.locality === "local" || enabled[feature.id] === true, requiresHostGrant: feature.locality === "external" }));
      return { features, legacySettings: settings, sourceRevision: file?.revision ?? null };
    },
  };

  function* submitRawProposal(host: GuestHost, context: ActionRequest, args: {
    path: string; before: unknown; after: unknown; revision: string | null; content: Uint8Array;
    reads: Array<{ path: string; revision: string | null }>; title: string; reason: string; affectedPaths: string[];
  }): Generator<HostCall, { changeSetId: string; operationIds: string[]; preview: Record<string, unknown> }, unknown> {
    const key = requireIdempotency(context);
    const suffix = idHash(`${key}\0${args.path}`);
    const contentOperation = yield* fileOperationContent(host, context, args.path, args.revision, args.content, `research-${suffix}`);
    const changeset: ChangeSet = {
      id: `research-${idHash(key)}`, idempotency_key: key, scope: context.scope, snapshot: context.snapshot,
      title: args.title, reason: args.reason, read_set: args.reads,
      units: [{ id: `research-unit-${suffix}`, label: args.title, depends_on: [], operations: [contentOperation] }],
      evidence: [],
    };
    const receipt = object(yield* host.request(HOST_OPERATIONS.propose, { changeset }), "proposal receipt");
    return {
      changeSetId: typeof receipt.proposal_id === "string" ? receipt.proposal_id : typeof receipt.id === "string" ? receipt.id : changeset.id,
      operationIds: Array.isArray(receipt.operation_ids) ? receipt.operation_ids.filter((id): id is string => typeof id === "string") : changeset.units[0]!.operations.map(({ id }) => id),
      preview: { before: args.before, after: args.after, affectedPaths: args.affectedPaths, evidence: [] },
    };
  }

  Object.defineProperty(handlers, RESEARCH_DISPOSE, { value: dispose, enumerable: false });
  return handlers;
}

type DisposableResearchHandlers = Record<string, Handler> & { [RESEARCH_DISPOSE]?: () => void };
const researchHandlers = createResearchHandlers() as DisposableResearchHandlers;
const researchLifecycle = createGuest(PLUGIN_ID, researchHandlers);
export const guest = {
  ...researchLifecycle,
  dispose(): void {
    researchHandlers[RESEARCH_DISPOSE]?.();
    researchLifecycle.dispose();
  },
};

