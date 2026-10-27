import { createGuest, type Handler } from "../shared/guest.js";
import { HOST_OPERATIONS, invokeAction, readFileVersioned, type FilePage } from "../shared/operations.js";
import {
  analyzeText,
  bodyOffset,
  DEFAULT_LINT_RULES,
  findingsForTextAnalysis,
  formatManuscript,
  lintText,
  sha256,
  transformText,
  type LintRule,
} from "./src/core.js";
import { checkProjectConsistency, isNarrativeEntityPath, readProjectGraph, type ProjectFile, type ProjectScope, type ValidationIssue } from "./src/projectConsistency.js";
import { checkProjectContinuity } from "./src/projectContinuity.js";
import { runDeterministicAspectReview, normalizeAspectIds, type AspectId, type AspectReviewScene } from "./src/aspectReview.js";
import { LINT_CONFIG_PATHS, parseLintRulesConfig } from "./src/config.js";
import { DEFAULT_PLOT_LEXICON, PLOT_CONFIG_PATHS, analyzePlotGoal, parsePlotLexicon, type PlotToken } from "./src/plot.js";
import { DEFAULT_TONE_LEXICON, TONE_CONFIG_PATHS, frequentNouns, frequentPhrases, habitualPhraseWarnings, parseToneLexicon, proseBalance, sentimentArc, toneDeviation, type MetricSentence, type ToneLexicon } from "./src/textMetrics.js";
import YAML, { isMap, isSeq } from "yaml";
import type { ChangeSet, ReadPrecondition, SourceSpan } from "../../app/src/browser/proprium/authoring/types.js";

const MAX_TEXT_CODE_POINTS = 500_000;
const MAX_PROPOSAL_BYTES = 64 * 1024 * 1024;
const INLINE_PROPOSAL_BYTES = 48 * 1024;
const ARTIFACT_CHUNK_BYTES = 32 * 1024;
const FEEDBACK_PATH = "meta/proprium/plugins/proprium.diagnostics/feedback.yaml";
const MAX_FEEDBACK_BYTES = 8 * 1024 * 1024;
const MAX_FEEDBACK_ENTRIES = 100_000;

interface RememberedFinding {
  sourceIdentity: Record<string, unknown>;
  scopeKey: string;
  snapshotId: string;
}
const rememberedFindings = new Map<string, RememberedFinding>();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function rememberIdentities(value: unknown, context: Parameters<Handler>[1]): void {
  const scopeKey = canonicalJson(context.scope);
  const seen = new Set<object>();
  let visited = 0;
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12 || visited++ > 100_000 || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node)) {
      const row = node as Record<string, unknown>;
      if (row.sourceIdentity && typeof row.sourceIdentity === "object" && !Array.isArray(row.sourceIdentity)) {
        const identity = row.sourceIdentity as Record<string, unknown>;
        const fingerprint = typeof row.fingerprint === "string" ? row.fingerprint : identity.findingFingerprint;
        if (typeof fingerprint === "string" && identity.findingFingerprint === fingerprint && identity.snapshot === context.snapshot.id &&
            identity.repositoryId === context.scope.repository_id && identity.branch === context.scope.branch && identity.generation === context.scope.generation) {
          const key = canonicalJson([context.scope.workspace_id, scopeKey, context.snapshot.id, fingerprint]);
          rememberedFindings.delete(key);
          rememberedFindings.set(key, { sourceIdentity: JSON.parse(JSON.stringify(identity)) as Record<string, unknown>, scopeKey, snapshotId: context.snapshot.id });
          while (rememberedFindings.size > 10_000) rememberedFindings.delete(rememberedFindings.keys().next().value as string);
        }
      }
    }
    if (Array.isArray(node)) for (const child of node) visit(child, depth + 1);
    else for (const child of Object.values(node as Record<string, unknown>)) visit(child, depth + 1);
  };
  visit(value, 0);
}

function remembering(handler: Handler): Handler {
  return function* (input, context, host) {
    const value = yield* invokeLocal(handler, input, context, host);
    rememberIdentities(value, context);
    return value;
  };
}

class DiagnosticActionError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details?: Record<string, unknown>) { super(message); }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DiagnosticActionError("invalid_input", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra) throw new DiagnosticActionError("invalid_input", `${label} contains unsupported field ${extra}`);
}
function textInput(input: Record<string, unknown>, label: string, keys: readonly string[]): string {
  closed(input, keys, label);
  if (typeof input.text !== "string") throw new DiagnosticActionError("invalid_input", `${label}.text must be a string`);
  if (Array.from(input.text).length > MAX_TEXT_CODE_POINTS) throw new DiagnosticActionError("capacity", `Text exceeds ${MAX_TEXT_CODE_POINTS} code points`, true);
  return input.text;
}
function rulesInput(raw: unknown): readonly LintRule[] {
  if (raw === undefined) return DEFAULT_LINT_RULES;
  if (!Array.isArray(raw) || raw.length > 128) throw new DiagnosticActionError("invalid_input", "ruleSet must contain at most 128 rules");
  try { return parseLintRulesConfig(JSON.stringify({ rules: raw })); }
  catch (error) { throw new DiagnosticActionError("invalid_input", error instanceof Error ? error.message : "Invalid ruleSet"); }
}

function* configuredLintRules(host: Parameters<Handler>[2], context: Parameters<Handler>[1], override?: unknown): Generator<import("../shared/guest.js").HostCall, { rules: readonly LintRule[]; revision: string; path?: string; read_set: ReadPrecondition[] }, unknown> {
  if (override !== undefined) {
    const rules = rulesInput(override);
    return { rules, revision: sha256(JSON.stringify(rules)), read_set: [] };
  }
  const read_set: ReadPrecondition[] = [];
  for (const path of LINT_CONFIG_PATHS) {
    try {
      const file = yield* readFileVersioned(host, context.snapshot, path);
      read_set.push({ path, revision: file.revision });
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
      catch { throw new DiagnosticActionError("invalid_encoding", `Lint configuration is not valid UTF-8: ${path}`, false, { path }); }
      try { return { rules: parseLintRulesConfig(text), revision: file.revision, path, read_set }; }
      catch (error) { throw new DiagnosticActionError("unsupported_format", `Invalid lint configuration at ${path}: ${error instanceof Error ? error.message : "parse error"}`, false, { path }); }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "file_not_found") { read_set.push({ path, revision: null }); continue; }
      throw error;
    }
  }
  return { rules: DEFAULT_LINT_RULES, revision: sha256(JSON.stringify(DEFAULT_LINT_RULES)), read_set };
}

function optionalProviderError(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as { code?: unknown } : {};
  return ["dependency_unavailable", "plugin_unavailable", "missing_capability", "action_not_found", "provider_unavailable"].includes(String(value.code ?? ""));
}

function boundedProviderRows(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new DiagnosticActionError("dependency_unavailable", `${label} is malformed or exceeds its result limit`, true);
  if (value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new DiagnosticActionError("dependency_unavailable", `${label} contains an invalid row`, true);
  return value;
}

function* configuredPlotLexicon(host: Parameters<Handler>[2], context: Parameters<Handler>[1]): Generator<import("../shared/guest.js").HostCall, { lexicon: typeof DEFAULT_PLOT_LEXICON; revision: string; path?: string; read_set: ReadPrecondition[] }, unknown> {
  const read_set: ReadPrecondition[] = [];
  for (const path of PLOT_CONFIG_PATHS) {
    let file: ReturnType<typeof readFileVersioned> extends Generator<unknown, infer R, unknown> ? R : never;
    try { file = yield* readFileVersioned(host, context.snapshot, path); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "file_not_found") {
        read_set.push({ path, revision: null });
        continue;
      }
      throw error;
    }
    read_set.push({ path, revision: file.revision });
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
    catch { throw new DiagnosticActionError("invalid_encoding", `Plot lexicon is not valid UTF-8: ${path}`, false, { path }); }
    try { return { lexicon: parsePlotLexicon(text), revision: file.revision, path, read_set }; }
    catch (error) { throw new DiagnosticActionError("unsupported_format", `Invalid plot lexicon at ${path}: ${error instanceof Error ? error.message : "parse error"}`, false, { path }); }
  }
  const revision = sha256(JSON.stringify(DEFAULT_PLOT_LEXICON));
  return { lexicon: DEFAULT_PLOT_LEXICON, revision, read_set };
}

function* configuredToneLexicon(host: Parameters<Handler>[2], context: Parameters<Handler>[1]): Generator<import("../shared/guest.js").HostCall, { lexicon: ToneLexicon; revision: string; path?: string; read_set: ReadPrecondition[] }, unknown> {
  const read_set: ReadPrecondition[] = [];
  for (const path of TONE_CONFIG_PATHS) {
    let file: ReturnType<typeof readFileVersioned> extends Generator<unknown, infer R, unknown> ? R : never;
    try { file = yield* readFileVersioned(host, context.snapshot, path); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "file_not_found") { read_set.push({ path, revision: null }); continue; }
      throw error;
    }
    read_set.push({ path, revision: file.revision });
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
    catch { throw new DiagnosticActionError("invalid_encoding", `Tone lexicon is not valid UTF-8: ${path}`, false, { path }); }
    try { return { lexicon: parseToneLexicon(text), revision: file.revision, path, read_set }; }
    catch (error) { throw new DiagnosticActionError("unsupported_format", `Invalid tone lexicon at ${path}: ${error instanceof Error ? error.message : "parse error"}`, false, { path }); }
  }
  return { lexicon: DEFAULT_TONE_LEXICON, revision: sha256(JSON.stringify(DEFAULT_TONE_LEXICON)), read_set };
}

function* researchKnownTerms(host: Parameters<Handler>[2]): Generator<import("../shared/guest.js").HostCall, { terms: Set<string>; revision: string | null }, unknown> {
  const terms = new Set<string>();
  let cursor: string | undefined;
  let registryRevision: string | null = null;
  let pages = 0;
  do {
    const page = yield* invokeAction<Record<string, unknown>>(host, "proprium.research", "research.terms.list", { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === "string") || !(page.registryRevision === null || typeof page.registryRevision === "string")) throw new DiagnosticActionError("dependency_unavailable", "Research returned an invalid term page", true);
    if (registryRevision !== null && page.registryRevision !== registryRevision) throw new DiagnosticActionError("snapshot_stale", "Research term registry changed between pages", true);
    registryRevision = page.registryRevision as string | null;
    for (const item of page.items) {
      const row = object(item, "Research term entry");
      if (typeof row.canonical !== "string" || !Array.isArray(row.aliases) || row.aliases.some((alias) => typeof alias !== "string")) throw new DiagnosticActionError("dependency_unavailable", "Research returned an invalid term entry", true);
      terms.add(row.canonical);
      for (const alias of row.aliases as string[]) terms.add(alias);
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (++pages > 100 || terms.size > 20_000) throw new DiagnosticActionError("capacity", "Research term registry exceeds the Diagnostics analysis limit", true);
  } while (cursor);
  return { terms, revision: registryRevision };
}

function validateResearchAnalysis(raw: unknown, text: string): { tokens: PlotToken[]; sentences: Array<{ start: number; end: number }>; engine: Record<string, unknown> } {
  const value = object(raw, "Research analysis result");
  const source = object(value.source, "Research analysis source");
  if (source.textDigest !== sha256(text) || !Array.isArray(value.tokens) || value.tokens.length > 250_000 || !Array.isArray(value.sentences) || value.sentences.length > 250_000) {
    throw new DiagnosticActionError("snapshot_stale", "Research token analysis does not match the exact source text", true);
  }
  const engine = object(value.engine, "Research engine identity");
  if (typeof engine.id !== "string" || typeof engine.version !== "string" || typeof engine.digest !== "string") {
    throw new DiagnosticActionError("dependency_unavailable", "Research returned an incomplete tokenizer identity", true);
  }
  const sentences = value.sentences.map((rawSentence, index) => {
    const sentence = object(rawSentence, `Research sentence ${index}`);
    if (!Number.isSafeInteger(sentence.start) || !Number.isSafeInteger(sentence.end) || (sentence.start as number) < 0 || (sentence.end as number) < (sentence.start as number) || (sentence.end as number) > text.length) throw new DiagnosticActionError("snapshot_stale", `Research returned an invalid sentence range at index ${index}`, true);
    return { start: sentence.start as number, end: sentence.end as number };
  });
  const tokens = value.tokens.map((rawToken, index): PlotToken => {
    const token = object(rawToken, `Research token ${index}`);
    if (!Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end) || (token.start as number) < 0 || (token.end as number) <= (token.start as number) || (token.end as number) > text.length ||
        typeof token.surface !== "string" || text.slice(token.start as number, token.end as number) !== token.surface || typeof token.pos !== "string" ||
        (token.base !== undefined && typeof token.base !== "string") || (token.sentenceIndex !== undefined && !Number.isSafeInteger(token.sentenceIndex))) {
      throw new DiagnosticActionError("snapshot_stale", `Research returned an invalid token span at index ${index}`, true);
    }
    return { start: token.start as number, end: token.end as number, surface: token.surface, pos: token.pos, ...(typeof token.base === "string" ? { base: token.base } : {}), ...(typeof token.sentenceIndex === "number" ? { sentenceIndex: token.sentenceIndex } : {}) };
  });
  return { tokens, sentences, engine };
}

function metricSentences(result: ReturnType<typeof validateResearchAnalysis>, fullText: string, bodyStart: number): { text: string; tokens: PlotToken[]; sentences: MetricSentence[] } {
  const body = fullText.slice(bodyStart);
  const tokens = result.tokens.filter((token) => token.start >= bodyStart && token.end <= fullText.length)
    .map((token) => ({ ...token, start: token.start - bodyStart, end: token.end - bodyStart }));
  const sentences = result.sentences.filter((span) => span.end > span.start && span.start >= bodyStart && span.end <= fullText.length)
    .map((span) => {
      const start = span.start - bodyStart, end = span.end - bodyStart;
      return { start, end, text: body.slice(start, end), tokens: tokens.filter((token) => token.start >= start && token.start < end) };
    }).filter((sentence) => sentence.text.trim().length > 0);
  return { text: body, tokens, sentences };
}

function metricFinding(kind: string, message: string, textHash: string, context: Parameters<Handler>[1], source: { documentPath?: string; documentRevision?: string; draftGeneration?: string }, configRevisions: Record<string, string>, evidenceRows: Array<{ start: number; end: number; quote: string }>, providerIdentity: Record<string, unknown> = {}, extraSources: Array<Record<string, unknown>> = []): Record<string, unknown> {
  const sources = [...(source.documentPath && source.documentRevision ? evidenceRows.slice(0, 24).map((item) => ({
    path: source.documentPath!, fileRevision: source.documentRevision!, textHash, span: { start: item.start, end: item.end }, quote: item.quote,
  })) : []), ...extraSources];
  const fingerprint = sha256(JSON.stringify([
    context.scope.workspace_id, context.scope.repository_id, context.scope.branch, context.scope.generation,
    context.snapshot.id, kind, message, textHash, configRevisions, providerIdentity, sources, source.draftGeneration ?? null,
  ]));
  const quote = evidenceRows.map((item) => item.quote).join(" / ").slice(0, 1000);
  const sourceIdentity = {
    actionId: "proprium.diagnostics.text.analyze.v1", repositoryId: context.scope.repository_id, branch: context.scope.branch,
    generation: context.scope.generation, snapshot: context.snapshot.id, findingFingerprint: fingerprint,
    analyzer: { id: "proprium.diagnostics.cpu", version: "1.0.0" }, sources,
    ...(Object.keys(configRevisions).length ? { configRevisions } : {}), ...(Object.keys(providerIdentity).length ? { providerIdentity } : {}), ...(source.draftGeneration ? { draftGeneration: source.draftGeneration } : {}),
  };
  const evidence = evidenceRows.slice(0, 24).map((item) => ({
    ...(source.documentPath ? { path: source.documentPath } : {}), ...(source.documentRevision ? { revision: source.documentRevision } : {}),
    text_hash: textHash, start: item.start, end: item.end, quote: item.quote.slice(0, 4000),
  }));
  return {
    fingerprint, class: "statistical", kind, severity: "warning", basis: "deterministic", message,
    analyzer_id: "proprium.diagnostics.cpu", analyzer_version: "1.0.0",
    ...(source.documentPath ? { source_path: source.documentPath } : {}), ...(source.documentRevision ? { source_revision: source.documentRevision } : {}),
    text_hash: textHash, quote, evidence, sourceIdentity,
    ...(evidenceRows.length ? { range: { start: evidenceRows[0].start, end: evidenceRows[0].end } } : {}),
  };
}

function safeManuscriptPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && value.startsWith("manuscript/") && /\.md$/iu.test(value) &&
    !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function idempotencyKey(input: Record<string, unknown>, context: Parameters<Handler>[1]): string {
  const supplied = input.idempotencyKey;
  const envelope = context.idempotency_key;
  if (supplied !== undefined && (typeof supplied !== "string" || !supplied || supplied.length > 256)) throw new DiagnosticActionError("invalid_input", "idempotencyKey must be a bounded nonempty string");
  if (typeof supplied === "string" && typeof envelope === "string" && supplied !== envelope) throw new DiagnosticActionError("invalid_input", "Action and request idempotency keys disagree");
  const key = typeof envelope === "string" ? envelope : supplied;
  if (typeof key !== "string" || !key) throw new DiagnosticActionError("invalid_input", "Proposal action requires an idempotency key");
  return key;
}

function* fileRevision(host: Parameters<Handler>[2], snapshot: Parameters<Handler>[1]["snapshot"], path: string): Generator<import("../shared/guest.js").HostCall, string, unknown> {
  let cursor: string | undefined;
  do {
    const page: FilePage = yield* host.request<FilePage>(HOST_OPERATIONS.list, { snapshot, prefix: path, limit: 256, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.entries) || !(page.next_cursor === null || typeof page.next_cursor === "string")) throw new DiagnosticActionError("snapshot_stale", "Host returned an invalid file page", true);
    const entry = page.entries.find((item) => item && item.path === path);
    if (entry) return safeRevision(entry.revision, `Revision for ${path}`);
    cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
  } while (cursor);
  throw new DiagnosticActionError("file_not_found", `Manuscript file not found: ${path}`);
}

function diffSummary(path: string, before: string, after: string, beforeHash: string, afterHash: string): Record<string, unknown> {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  const excerpt = (text: string, start: number, end: number) => {
    const clippedStart = Math.max(start, Math.min(end, start + 512));
    const value = text.slice(start, clippedStart);
    return clippedStart < end ? `${value}…` : value;
  };
  return {
    path, beforeHash, afterHash, start: prefix, beforeLength: beforeEnd - prefix, afterLength: afterEnd - prefix,
    beforeExcerpt: excerpt(before, prefix, beforeEnd), afterExcerpt: excerpt(after, prefix, afterEnd),
  };
}

function changedEvidence(path: string, revision: string, before: string, after: string): SourceSpan[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const end = Math.min(before.length - suffix, start + 4000);
  return [{ path, revision, start, end, quote: before.slice(start, end) }];
}

function* changeContent(host: Parameters<Handler>[2], context: Parameters<Handler>[1], path: string, text: string): Generator<import("../shared/guest.js").HostCall, { content?: number[]; content_artifact?: string; artifact_id?: string }, unknown> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_PROPOSAL_BYTES) throw new DiagnosticActionError("capacity", `Proposed manuscript exceeds ${MAX_PROPOSAL_BYTES} bytes`, true);
  if (bytes.byteLength <= INLINE_PROPOSAL_BYTES) return { content: Array.from(bytes) };
  let artifactId: string | undefined;
  try {
    const created = yield* host.request<Record<string, unknown>>("artifact.create", {
      media_type: "text/markdown", filename: path.slice(path.lastIndexOf("/") + 1), scope: context.scope, snapshot: context.snapshot,
    });
    artifactId = typeof created === "string" ? created : typeof created.artifact_id === "string" ? created.artifact_id : undefined;
    if (!artifactId) throw new DiagnosticActionError("invalid_input", "Host returned an invalid artifact ID");
    for (let offset = 0, sequence = 0; offset < bytes.byteLength; offset += ARTIFACT_CHUNK_BYTES, sequence++) {
      const chunk = Array.from(bytes.subarray(offset, Math.min(bytes.byteLength, offset + ARTIFACT_CHUNK_BYTES)));
      yield* host.request("artifact.append", { artifact_id: artifactId, sequence, bytes: chunk });
    }
    yield* host.request("artifact.seal", { artifact_id: artifactId, sha256: sha256(text), total_bytes: bytes.byteLength });
    return { content_artifact: artifactId, artifact_id: artifactId };
  } catch (error) {
    if (artifactId) {
      try { yield* host.request("artifact.discard", { artifact_id: artifactId }); } catch { /* Host cleanup is best-effort after the original typed error. */ }
    }
    throw error;
  }
}

function* submitChangeSet(host: Parameters<Handler>[2], changeset: ChangeSet, artifactId?: string): Generator<import("../shared/guest.js").HostCall, string, unknown> {
  try {
    const receipt = yield* host.request<Record<string, unknown>>(HOST_OPERATIONS.propose, { changeset });
    const proposalId = typeof receipt?.proposal_id === "string" ? receipt.proposal_id : typeof receipt?.proposalId === "string" ? receipt.proposalId : undefined;
    if (!proposalId) throw new DiagnosticActionError("storage_unknown", "Host proposal receipt did not include a proposal ID", true);
    return proposalId;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    if (artifactId && code !== "storage_unknown") {
      try { yield* host.request("artifact.discard", { artifact_id: artifactId }); } catch { /* Receipt may already own the artifact; Host retains uncertain proposals. */ }
    }
    throw error;
  }
}

function* invokeLocal(handler: Handler, input: Record<string, unknown>, context: Parameters<Handler>[1], host: Parameters<Handler>[2]): Generator<import("../shared/guest.js").HostCall, unknown, unknown> {
  const result = handler(input, context, host);
  if (result && typeof result === "object" && "next" in result && typeof result.next === "function") return yield* result as Generator<import("../shared/guest.js").HostCall, unknown, unknown>;
  return result;
}

function makeChangeSet(input: {
  context: Parameters<Handler>[1]; actionId: string; idempotencyKey: string; path: string; revision: string | null;
  before: string; after: string; title: string; reason: string; evidence: SourceSpan[]; content: { content?: number[]; content_artifact?: string };
  read_set?: ReadPrecondition[];
}): ChangeSet {
  const identity = sha256(JSON.stringify([input.context.scope, input.context.snapshot, input.actionId, input.idempotencyKey]));
  const operationId = `diag-${identity.slice(0, 32)}-replace`;
  return {
    id: `diag-${identity.slice(0, 40)}`, idempotency_key: input.idempotencyKey,
    scope: input.context.scope, snapshot: input.context.snapshot, title: input.title, reason: input.reason,
    read_set: [...new Map([...(input.read_set ?? []), { path: input.path, revision: input.revision }].map((item) => [item.path, item])).values()],
    units: [{ id: `diag-${identity.slice(0, 32)}-unit`, label: input.title, depends_on: [], operations: [{
      id: operationId, kind: input.revision === null ? "create" : "replace", path: input.path, expected_revision: input.revision,
      ...(input.content.content ? { content: input.content.content } : {}), ...(input.content.content_artifact ? { content_artifact: input.content.content_artifact } : {}),
    }] }],
    evidence: input.evidence,
  };
}
function sourceFields(input: Record<string, unknown>): { documentPath?: string; documentRevision?: string; draftGeneration?: string } {
  if (input.documentPath !== undefined && (typeof input.documentPath !== "string" || input.documentPath.length > 1024 || !input.documentPath || input.documentPath.startsWith("/") || input.documentPath.includes("\\") || input.documentPath.includes("\0") || input.documentPath.split("/").some((part) => !part || part === "." || part === ".."))) throw new DiagnosticActionError("invalid_input", "documentPath must be a safe relative path");
  if (input.documentRevision !== undefined && (typeof input.documentRevision !== "string" || !/^[a-f0-9]{64}$/u.test(input.documentRevision))) throw new DiagnosticActionError("invalid_input", "documentRevision must be a SHA-256 revision");
  if (input.draftGeneration !== undefined && (typeof input.draftGeneration !== "string" || input.draftGeneration.length > 256)) throw new DiagnosticActionError("invalid_input", "draftGeneration must be a bounded string");
  return {
    ...(typeof input.documentPath === "string" ? { documentPath: input.documentPath } : {}),
    ...(typeof input.documentRevision === "string" ? { documentRevision: input.documentRevision } : {}),
    ...(typeof input.draftGeneration === "string" ? { draftGeneration: input.draftGeneration } : {}),
  };
}

function parseProjectScope(value: unknown): ProjectScope | undefined {
  if (value === undefined) return undefined;
  const scope = object(value, "scope");
  closed(scope, ["workId", "volumeId", "chapterId", "sceneId"], "scope");
  for (const [key, id] of Object.entries(scope)) if (typeof id !== "string" || id.length === 0 || id.length > 256) throw new DiagnosticActionError("invalid_input", `scope.${key} must be a nonempty bounded ID`);
  return {
    ...(typeof scope.workId === "string" ? { workId: scope.workId } : {}),
    ...(typeof scope.volumeId === "string" ? { volumeId: scope.volumeId } : {}),
    ...(typeof scope.chapterId === "string" ? { chapterId: scope.chapterId } : {}),
    ...(typeof scope.sceneId === "string" ? { sceneId: scope.sceneId } : {}),
  };
}

function validateScopeEntities(entities: readonly { id: string; type: string }[], scope: ProjectScope | undefined): void {
  if (scope?.sceneId && !entities.some((entity) => entity.type === "scene" && entity.id === scope.sceneId)) throw new DiagnosticActionError("scene_not_found", `Scene not found: ${scope.sceneId}`, false, { kind: "scene_not_found" });
  if (scope?.chapterId && !entities.some((entity) => entity.type === "chapter" && entity.id === scope.chapterId)) throw new DiagnosticActionError("scene_not_found", `Chapter not found: ${scope.chapterId}`, false, { kind: "chapter_not_found" });
  if (scope?.volumeId && !entities.some((entity) => entity.type === "volume" && entity.id === scope.volumeId)) throw new DiagnosticActionError("scene_not_found", `Volume not found: ${scope.volumeId}`, false, { kind: "volume_not_found" });
}

function validatePageCursor(cursor: unknown, snapshotId: string, scope: ProjectScope | undefined): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string") throw new DiagnosticActionError("invalid_input", "cursor must be a string");
  const identity = sha256(JSON.stringify([snapshotId, scope ?? null]));
  const match = /^dcp1\.([a-f0-9]{64})\.(0|[1-9][0-9]*)$/u.exec(cursor);
  if (!match || match[1] !== identity) throw new DiagnosticActionError("snapshot_stale", "Diagnostics cursor belongs to a different snapshot or scope", true);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset)) throw new DiagnosticActionError("invalid_input", "cursor offset is invalid");
  return offset;
}

function aspectCursor(cursor: unknown, snapshotId: string, chapterId: string, aspects: AspectId[]): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string") throw new DiagnosticActionError("invalid_input", "cursor must be a string");
  const identity = sha256(JSON.stringify([snapshotId, chapterId, aspects]));
  const match = /^dar1\.([a-f0-9]{64})\.(0|[1-9][0-9]*)$/u.exec(cursor);
  if (!match || match[1] !== identity) throw new DiagnosticActionError("snapshot_stale", "Aspect cursor belongs to a different chapter, selection, or snapshot", true);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset)) throw new DiagnosticActionError("invalid_input", "cursor offset is invalid");
  return offset;
}

function safeRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new DiagnosticActionError("snapshot_stale", `${label} is not a SHA-256 revision`, true);
  return value;
}

function* chapterScenes(host: Parameters<Handler>[2], snapshot: Parameters<Handler>[1]["snapshot"], chapterId: string): Generator<import("../shared/guest.js").HostCall, { chapterName: string; scenes: Array<{ id: string; title: string; metadataPath: string; metadataRevision: string; manuscriptPath: string; manuscriptRevision: string }> }, unknown> {
  const result = { chapterName: chapterId, scenes: [] as Array<{ id: string; title: string; metadataPath: string; metadataRevision: string; manuscriptPath: string; manuscriptRevision: string }> };
  let cursor: string | undefined;
  let treeRevision: string | undefined;
  do {
    const page = yield* invokeAction<Record<string, unknown>>(host, "proprium.narrative", "proprium.narrative.hierarchy.tree", {
      parent_id: chapterId, limit: 200, ...(cursor ? { cursor } : {}), ...(treeRevision ? { expected_tree_revision: treeRevision } : {}),
    });
    if (page.parent_id !== chapterId || !Array.isArray(page.items) || !(page.next_cursor === null || typeof page.next_cursor === "string")) throw new DiagnosticActionError("snapshot_stale", "Narrative returned an invalid chapter page", true);
    const revision = safeRevision(page.tree_revision, "Narrative tree revision");
    if (treeRevision !== undefined && treeRevision !== revision) throw new DiagnosticActionError("snapshot_stale", "Narrative tree changed during aspect review", true);
    treeRevision = revision;
    for (const rawItem of page.items) {
      const item = object(rawItem, "Narrative tree item");
      if (item.kind !== "scene" || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.metadata_path !== "string" || typeof item.manuscript_path !== "string") throw new DiagnosticActionError("snapshot_stale", "Narrative returned an incomplete scene identity", true);
      // Narrative scene.context is the authority for the exact pinned revisions and scene path.
      const scene = yield* invokeAction<Record<string, unknown>>(host, "proprium.narrative", "proprium.narrative.scene.context", {
        scene_id: item.id, expected_tree_revision: treeRevision,
      });
      if (scene.scene_id !== item.id || scene.manuscript_path !== item.manuscript_path) throw new DiagnosticActionError("snapshot_stale", "Narrative scene context does not match its chapter row", true);
      result.chapterName = typeof (scene.chapter as Record<string, unknown> | undefined)?.title === "string" ? (scene.chapter as Record<string, unknown>).title as string : result.chapterName;
      result.scenes.push({
        id: item.id, title: item.title, metadataPath: item.metadata_path,
        metadataRevision: safeRevision(scene.metadata_revision, "Scene metadata revision"),
        manuscriptPath: scene.manuscript_path,
        manuscriptRevision: safeRevision(scene.manuscript_revision, "Manuscript revision"),
      });
    }
    cursor = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
  } while (cursor);
  if (result.scenes.length === 0) throw new DiagnosticActionError("file_not_found", `Chapter ${chapterId} has no readable scenes`, false);
  return result;
}

function parseAspects(raw: unknown): AspectId[] {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return normalizeAspectIds(raw);
  if (!Array.isArray(raw) || raw.length > 3 || raw.some((item) => !["tempo", "pov-shift", "over-explain"].includes(String(item)))) throw new DiagnosticActionError("invalid_input", "aspects must contain unique supported aspect IDs");
  if (new Set(raw).size !== raw.length) throw new DiagnosticActionError("invalid_input", "aspects must not contain duplicates");
  return raw as AspectId[];
}

const chapterAspectsReview: Handler = function* (raw, context, host) {
  const input = object(raw, "chapter.aspects.review input");
  closed(input, ["chapterId", "aspects", "cursor", "limit"], "chapter.aspects.review input");
  if (typeof input.chapterId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.chapterId)) throw new DiagnosticActionError("invalid_input", "chapterId must be a stable bounded ID");
  const aspects = parseAspects(input.aspects);
  const limit = input.limit === undefined ? 100 : input.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new DiagnosticActionError("invalid_input", "limit must be an integer from 1 through 100");
  const start = aspectCursor(input.cursor, context.snapshot.id, input.chapterId, aspects);
  const chapter = yield* chapterScenes(host, context.snapshot, input.chapterId);
  const scenes: AspectReviewScene[] = [];
  for (const source of chapter.scenes) {
    const { bytes } = yield* readFileVersioned(host, context.snapshot, source.manuscriptPath, source.manuscriptRevision);
    let body: string;
    try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new DiagnosticActionError("invalid_encoding", `Manuscript is not valid UTF-8: ${source.manuscriptPath}`); }
    if (Array.from(body).length > MAX_TEXT_CODE_POINTS) throw new DiagnosticActionError("capacity", `Manuscript exceeds the ${MAX_TEXT_CODE_POINTS} code point analysis limit`, true);
    let povId: string | undefined;
    let povName: string | undefined;
    try {
      const knowledge = yield* invokeAction<Record<string, unknown>>(host, "proprium.knowledge", "knowledge.scene.context", { sceneId: source.id });
      povId = typeof knowledge.povId === "string" ? knowledge.povId : undefined;
      const cards = Array.isArray(knowledge.entityCards) ? knowledge.entityCards : [];
      const pov = cards.map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {}).find((item) => item.id === povId);
      povName = typeof pov?.name === "string" ? pov.name : undefined;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
      if (!["dependency_unavailable", "plugin_unavailable", "missing_capability", "action_not_found"].includes(code)) throw error;
    }
    scenes.push({ sceneId: source.id, sceneTitle: chapter.scenes.find((row) => row.id === source.id)?.title ?? source.id, body, manuscriptPath: source.manuscriptPath, manuscriptRevision: source.manuscriptRevision, metadataPath: source.metadataPath, metadataRevision: source.metadataRevision, ...(povId ? { povId } : {}), ...(povName ? { povName } : {}) });
  }
  const report = runDeterministicAspectReview(input.chapterId, chapter.chapterName, scenes, aspects);
  const findings = report.findings.map((finding) => ({ ...finding, evidence: finding.evidence ?? [] }));
  const end = Math.min(findings.length, start + (limit as number));
  const identity = sha256(JSON.stringify([context.snapshot.id, input.chapterId, aspects]));
  const nextCursor = end < findings.length ? `dar1.${identity}.${end}` : null;
  return { ...report, findings: findings.slice(start, end), nextCursor, complete: nextCursor === null };
};

const chapterAspectsPreview: Handler = function* (raw, context, host) {
  const input = object(raw, "chapter.aspects.preview input");
  closed(input, ["chapterId", "aspects"], "chapter.aspects.preview input");
  if (typeof input.chapterId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.chapterId)) throw new DiagnosticActionError("invalid_input", "chapterId must be a stable bounded ID");
  const aspects = parseAspects(input.aspects);
  const chapter = yield* chapterScenes(host, context.snapshot, input.chapterId);
  const labels: Record<AspectId, string> = { tempo: "テンポ", "pov-shift": "視点の揺れ", "over-explain": "説明過多" };
  const prompt = [
    "次の章を指定された観点で下読みし、章単位の所見を提案してください。",
    "各所見には根拠となる引用断片（quote）を付けてください。引用できない所見は出さないでください。",
    `chapter_id: ${input.chapterId}`, `chapter_name: ${chapter.chapterName}`,
    "観点:", aspects.map((aspect) => `- ${aspect}（${labels[aspect]}）`).join("\n") || "（なし）",
    "シーン本文:", "", "JSONのみを返してください。形式: {\"findings\":[{\"aspect\":\"tempo\",\"finding\":\"...\",\"quote\":\"...\",\"sceneId\":\"...\"}]}",
    "\n※ このプレビューではシーン本文を含めていません。実行時もモデルは呼び出さず、ローカル決定的な分析を行います。",
  ].join("\n");
  return { chapterId: input.chapterId, aspects, prompt, sourceFiles: chapter.scenes.map((scene) => ({ path: scene.metadataPath, revision: scene.metadataRevision })), includesManuscript: false, providerInvoked: false };
};

const plotGoalCheck: Handler = function* (raw, context, host) {
  const input = object(raw, "scene.plot-goal.check input");
  closed(input, ["sceneId", "documentRevision", "draftGeneration", "text"], "scene.plot-goal.check input");
  if (typeof input.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.sceneId)) throw new DiagnosticActionError("invalid_input", "sceneId must be a stable bounded ID");
  if (input.documentRevision !== undefined) safeRevision(input.documentRevision, "documentRevision");
  if (input.draftGeneration !== undefined && (typeof input.draftGeneration !== "string" || input.draftGeneration.length > 256)) throw new DiagnosticActionError("invalid_input", "draftGeneration must be a bounded string");

  const scene = yield* invokeAction<Record<string, unknown>>(host, "proprium.narrative", "proprium.narrative.scene.context", { scene_id: input.sceneId });
  if (scene.scene_id !== input.sceneId || !safeManuscriptPath(scene.manuscript_path)) throw new DiagnosticActionError("scene_not_found", `Narrative could not resolve ${input.sceneId} to a manuscript`);
  const path = scene.manuscript_path;
  const savedRevision = safeRevision(scene.manuscript_revision, "Narrative manuscript revision");
  if (input.documentRevision !== undefined && input.documentRevision !== savedRevision) throw new DiagnosticActionError("snapshot_stale", "Selected scene revision changed before Diagnostics ran", true);

  let text: string;
  let draftGeneration: string | undefined;
  if (input.text !== undefined) {
    if (typeof input.text !== "string" || Array.from(input.text).length > MAX_TEXT_CODE_POINTS) throw new DiagnosticActionError("capacity", "Draft text exceeds the plot analysis limit", true);
    if (input.draftGeneration !== context.snapshot.draft_generation || typeof input.draftGeneration !== "string") throw new DiagnosticActionError("snapshot_stale", "Draft text requires the current Host draft generation", true);
    text = input.text;
    draftGeneration = input.draftGeneration;
  } else {
    if (input.draftGeneration !== undefined) throw new DiagnosticActionError("invalid_input", "draftGeneration requires explicit Draft text");
    const file = yield* readFileVersioned(host, context.snapshot, path, savedRevision);
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
    catch { throw new DiagnosticActionError("invalid_encoding", `Manuscript is not valid UTF-8: ${path}`); }
    if (sha256(text) !== savedRevision) throw new DiagnosticActionError("snapshot_stale", "Host file revision does not match exact manuscript bytes", true);
    if (Array.from(text).length > MAX_TEXT_CODE_POINTS) throw new DiagnosticActionError("capacity", "Manuscript exceeds the plot analysis limit", true);
  }

  const bodyStart = bodyOffset(text);
  const bodyText = text.slice(bodyStart);
  const textHash = sha256(bodyText);
  const identityBase = {
    repositoryId: context.scope.repository_id,
    branch: context.scope.branch,
    snapshot: context.snapshot,
    sceneId: input.sceneId,
    documentPath: path,
    documentRevision: savedRevision,
    ...(draftGeneration ? { draftGeneration } : {}),
    textHash,
    bodyOrigin: bodyStart,
    analyzerId: "proprium.diagnostics.plot-goal",
    analyzerVersion: "1.0.0",
  };

  let knowledge: Record<string, unknown>;
  try {
    knowledge = yield* invokeAction<Record<string, unknown>>(host, "proprium.knowledge", "knowledge.entities.get", { id: input.sceneId });
  } catch (error) {
    if (!optionalProviderError(error)) throw error;
    const providerStatus = { knowledge: "unavailable", research: "not_run" };
    return { status: "unavailable", warnings: [], identity: { ...identityBase, providerStatus }, providerStatus };
  }

  const entity = knowledge.entity && typeof knowledge.entity === "object" && !Array.isArray(knowledge.entity) ? knowledge.entity as Record<string, unknown> : {};
  const rawEntity = entity.raw && typeof entity.raw === "object" && !Array.isArray(entity.raw) ? entity.raw as Record<string, unknown> : {};
  const goalParts = [rawEntity.goal, rawEntity.conflict].filter((part): part is string => typeof part === "string" && part.length > 0);
  const goalText = goalParts.join("。");
  const goalPath = typeof entity.filePath === "string" ? entity.filePath : "";
  const goalRevision = typeof entity.fileRevision === "string" ? entity.fileRevision : "";
  if (!goalText) {
    const providerStatus = { knowledge: "ready", research: "not_required" };
    return { status: "not_applicable", warnings: [], identity: { ...identityBase, goalSource: goalPath || null, goalRevision: goalRevision || null, providerStatus }, providerStatus };
  }
  if (!goalPath || goalPath.startsWith("/") || goalPath.includes("\\") || goalPath.includes("\0") || goalPath.split("/").some((part) => !part || part === "." || part === "..")) throw new DiagnosticActionError("snapshot_stale", "Knowledge omitted a safe goal source identity", true);
  safeRevision(goalRevision, "Knowledge scene file revision");
  if (scene.metadata_revision !== goalRevision) throw new DiagnosticActionError("snapshot_stale", "Knowledge goal fields do not match Narrative's scene metadata revision", true);

  let goalAnalysis: Record<string, unknown>;
  let bodyAnalysis: Record<string, unknown>;
  try {
    goalAnalysis = yield* invokeAction<Record<string, unknown>>(host, "proprium.research", "research.nlp.analyze", { text: goalText, source: { kind: "literal" } });
    const source = draftGeneration ? { kind: "draft", draftGeneration } : { kind: "saved-file", path, textRevision: savedRevision };
    bodyAnalysis = yield* invokeAction<Record<string, unknown>>(host, "proprium.research", "research.nlp.analyze", { text, source });
  } catch (error) {
    if (!optionalProviderError(error)) throw error;
    const providerStatus = { knowledge: "ready", research: "unavailable" };
    return { status: "unavailable", warnings: [], identity: { ...identityBase, goalSource: goalPath, goalRevision, providerStatus }, providerStatus };
  }

  const goalTokens = validateResearchAnalysis(goalAnalysis, goalText).tokens;
  const bodyResult = validateResearchAnalysis(bodyAnalysis, text);
  const bodyTokens = bodyResult.tokens.filter((token) => token.start >= bodyStart).map((token) => ({ ...token, start: token.start - bodyStart, end: token.end - bodyStart }));
  const config = yield* configuredPlotLexicon(host, context);
  const warnings = analyzePlotGoal({
    goalTokens, bodyTokens, bodyText, goalText, manuscriptPath: path, manuscriptRevision: savedRevision,
    goalPath, goalRevision, lexicon: config.lexicon,
  }).map((warning) => {
    const fingerprint = sha256(JSON.stringify([
      context.scope.workspace_id, context.scope.repository_id, context.scope.branch, context.scope.generation,
      context.snapshot.id, input.sceneId, path, savedRevision, draftGeneration ?? null, textHash,
      goalPath, goalRevision, config.revision, bodyResult.engine.digest, warning.kind, warning.archetype ?? null,
      warning.violationDensity ?? null, warning.similarity ?? null,
    ]));
    const sourceIdentity = {
      actionId: "proprium.diagnostics.scene.plot-goal.check.v1",
      repositoryId: context.scope.repository_id,
      branch: context.scope.branch,
      generation: context.scope.generation,
      snapshot: context.snapshot.id,
      findingFingerprint: fingerprint,
      analyzer: { id: "proprium.diagnostics.plot-goal", version: "1.0.0" },
      sceneId: input.sceneId,
      sources: warning.evidence.map((item) => ({
        path: item.path,
        fileRevision: item.revision,
        textHash: item.source === "goal" ? sha256(goalText) : textHash,
        span: { start: item.start, end: item.end },
        quote: item.quote,
      })),
      configRevisions: { plotLexicon: config.revision },
      providerIdentity: { research: bodyResult.engine },
      ...(draftGeneration ? { draftGeneration } : {}),
    };
    return { ...warning, fingerprint, sourceIdentity };
  });
  const providerStatus = { knowledge: "ready", research: "ready" };
  return {
    status: "ready", warnings,
    identity: {
      ...identityBase,
      goalSource: goalPath,
      goalRevision,
      goalTextHash: sha256(goalText),
      configRevisions: { plotLexicon: config.revision },
      configReadSet: config.read_set,
      researchEngine: bodyResult.engine,
      providerStatus,
      complete: true,
    },
    providerStatus,
  };
};

function projectFinding(issue: ValidationIssue, context: Parameters<Handler>[1], scope?: ProjectScope): Record<string, unknown> {
  const fingerprint = sha256(JSON.stringify([
    context.scope.workspace_id, context.scope.repository_id, context.scope.branch, context.scope.generation,
    context.snapshot.id, issue.filePath ?? null, issue.sourceRevision ?? null, issue.code, issue.entityId ?? null,
    ...(issue.evidence ?? []).map((item) => [item.path, item.revision]), issue.message,
  ]));
  const evidence = issue.evidence?.length ? issue.evidence.map((item) => ({ path: item.path, revision: item.revision, quote: issue.message.slice(0, 1000) }))
    : issue.filePath ? [{ path: issue.filePath, ...(issue.sourceRevision ? { revision: issue.sourceRevision } : {}), quote: issue.message.slice(0, 1000) }] : [];
  const sourceIdentity = {
    actionId: "proprium.diagnostics.project.consistency.run.v1",
    repositoryId: context.scope.repository_id,
    branch: context.scope.branch,
    generation: context.scope.generation,
    snapshot: context.snapshot.id,
    findingFingerprint: fingerprint,
    analyzer: { id: "proprium.diagnostics.project.consistency", version: "1.0.0" },
    sources: evidence.filter((item): item is typeof item & { revision: string } => typeof item.revision === "string").map((item) => ({ path: item.path, fileRevision: item.revision, ...(issue.entityId ? { entityId: issue.entityId } : {}), quote: item.quote })),
    scope: scope ?? null,
  };
  return {
    fingerprint,
    class: "structural",
    kind: issue.code,
    severity: issue.severity,
    basis: "deterministic",
    analyzer_id: "proprium.diagnostics.project.consistency",
    analyzer_version: "1.0.0",
    ...(issue.filePath ? { source_path: issue.filePath } : {}),
    ...(issue.sourceRevision ? { source_revision: issue.sourceRevision } : {}),
    ...(issue.entityId ? { entity_id: issue.entityId } : {}),
    message: issue.message.slice(0, 4000),
    quote: issue.message.slice(0, 1000),
    evidence,
    sourceIdentity,
  };
}

function continuityFinding(issue: ReturnType<typeof checkProjectContinuity>["findings"][number], context: Parameters<Handler>[1], scope?: ProjectScope): Record<string, unknown> {
  const fingerprint = sha256(JSON.stringify([
    context.scope.workspace_id, context.scope.repository_id, context.scope.branch, context.scope.generation,
    context.snapshot.id, issue.reason, issue.previousSceneId, issue.sceneId, issue.characterEntityId,
    issue.fromLocationId, issue.toLocationId, issue.itemId ?? null, issue.expectedOwnerId ?? null, issue.detail ?? null,
    issue.evidence.map((item) => [item.path, item.revision]),
  ]));
  const evidence = issue.evidence.map((item) => ({ path: item.path, revision: item.revision, quote: issue.detail ?? issue.reason }));
  const sourceIdentity = {
    actionId: "proprium.diagnostics.project.continuity.run.v1",
    repositoryId: context.scope.repository_id,
    branch: context.scope.branch,
    generation: context.scope.generation,
    snapshot: context.snapshot.id,
    findingFingerprint: fingerprint,
    analyzer: { id: "proprium.diagnostics.project.continuity", version: "1.0.0" },
    sources: evidence.map((item) => ({ path: item.path, fileRevision: item.revision, quote: item.quote })),
    scope: scope ?? null,
  };
  return {
    fingerprint, class: "declared_continuity", kind: issue.reason, severity: "warning", basis: "deterministic",
    analyzer_id: "proprium.diagnostics.project.continuity", analyzer_version: "1.0.0",
    source_path: evidence.find((item) => item.path.includes("/scenes/"))?.path ?? evidence[0]?.path,
    source_revision: evidence.find((item) => item.path.includes("/scenes/"))?.revision ?? evidence[0]?.revision,
    message: issue.detail ?? `${issue.reason}: ${issue.previousSceneId} → ${issue.sceneId}`,
    quote: issue.detail ?? issue.reason,
    evidence,
    sourceIdentity,
    scene_id: issue.sceneId,
    previous_scene_id: issue.previousSceneId,
    character_entity_id: issue.characterEntityId,
    from_location_id: issue.fromLocationId,
    to_location_id: issue.toLocationId,
    ...(issue.itemId ? { item_id: issue.itemId } : {}),
    ...(issue.expectedOwnerId !== undefined ? { expected_owner_id: issue.expectedOwnerId } : {}),
    ...(issue.fromDayOffset !== undefined ? { from_day_offset: issue.fromDayOffset } : {}),
    ...(issue.toDayOffset !== undefined ? { to_day_offset: issue.toDayOffset } : {}),
    ...(issue.requiredTravelDays !== undefined ? { required_travel_days: issue.requiredTravelDays } : {}),
    ...(issue.availableTravelDays !== undefined ? { available_travel_days: issue.availableTravelDays } : {}),
  };
}

function continuityCursor(cursor: unknown, snapshotId: string, scope: ProjectScope | undefined): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string") throw new DiagnosticActionError("invalid_input", "cursor must be a string");
  const identity = sha256(JSON.stringify(["continuity", snapshotId, scope ?? null]));
  const match = /^dcn1\.([a-f0-9]{64})\.(0|[1-9][0-9]*)$/u.exec(cursor);
  if (!match || match[1] !== identity) throw new DiagnosticActionError("snapshot_stale", "Continuity cursor belongs to a different snapshot or scope", true);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(offset)) throw new DiagnosticActionError("invalid_input", "cursor offset is invalid");
  return offset;
}

const projectContinuity: Handler = function* (raw, context, host) {
  const input = object(raw, "project.continuity input");
  closed(input, ["scope", "cursor", "pageSize"], "project.continuity input");
  const scope = parseProjectScope(input.scope);
  const pageSize = input.pageSize === undefined ? 50 : input.pageSize;
  if (!Number.isSafeInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > 100) throw new DiagnosticActionError("invalid_input", "pageSize must be an integer from 1 through 100");
  const start = continuityCursor(input.cursor, context.snapshot.id, scope);
  const entries: Array<{ path: string; revision: string; byte_length: number }> = [];
  let cursor: string | null = null;
  do {
    const page: FilePage = yield* host.request<FilePage>(HOST_OPERATIONS.list, { snapshot: context.snapshot, limit: 256, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.entries) || !(page.next_cursor === null || typeof page.next_cursor === "string")) throw new DiagnosticActionError("invalid_input", "Host returned an invalid file page");
    for (const entry of page.entries) {
      if (!entry || typeof entry.path !== "string" || typeof entry.revision !== "string" || !/^[a-f0-9]{64}$/u.test(entry.revision) || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0) throw new DiagnosticActionError("snapshot_stale", "Host returned an invalid pinned file identity", true);
      entries.push({ path: entry.path, revision: entry.revision, byte_length: entry.byte_length });
      if (entries.length > 100_000) throw new DiagnosticActionError("capacity", "Workspace contains too many files for a continuity scan", true);
    }
    cursor = page.next_cursor;
  } while (cursor !== null);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const yamlFiles: ProjectFile[] = [];
  for (const entry of entries) {
    if (!isNarrativeEntityPath(entry.path)) continue;
    const { bytes } = yield* readFileVersioned(host, context.snapshot, entry.path, entry.revision);
    try { yamlFiles.push({ path: entry.path, revision: entry.revision, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }); }
    catch { yamlFiles.push({ path: entry.path, revision: entry.revision, text: "", invalidEncoding: true }); }
  }
  const graph = readProjectGraph(yamlFiles);
  validateScopeEntities(graph.entities, scope);
  if (graph.issues.length) {
    const issue = graph.issues[0];
    throw new DiagnosticActionError(issue.code === "INVALID_ENCODING" ? "invalid_encoding" : "unsupported_format", `Continuity cannot parse ${issue.filePath ?? "a narrative source file"}: ${issue.message}`, false, { path: issue.filePath ?? "", issue: issue.code });
  }
  const manuscriptText = new Map<string, string>();
  const manuscriptPaths = new Set(graph.entities.filter((entity) => entity.type === "scene" && typeof entity.raw.manuscript === "string").map((entity) => entity.raw.manuscript as string));
  for (const path of manuscriptPaths) {
    const entry = byPath.get(path);
    if (!entry || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) continue;
    const { bytes } = yield* readFileVersioned(host, context.snapshot, path, entry.revision);
    try { manuscriptText.set(path, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { /* Invalid or unknown prose contributes no time/location assertions. */ }
  }
  const report = checkProjectContinuity(graph.entities, graph.links, manuscriptText, scope);
  const findings = report.findings.map((finding) => continuityFinding(finding, context, scope));
  const from = Math.min(start, findings.length);
  const end = Math.min(findings.length, from + (pageSize as number));
  const identity = sha256(JSON.stringify(["continuity", context.snapshot.id, scope ?? null]));
  const nextCursor = end < findings.length ? `dcn1.${identity}.${end}` : null;
  return {
    scope: scope ?? null,
    recognized: report.recognized,
    findings: findings.slice(from, end),
    counts: { warning: findings.length },
    cursor: nextCursor,
    complete: nextCursor === null,
    snapshot: context.snapshot,
    total_findings: findings.length,
  };
};

const projectConsistency: Handler = function* (raw, context, host) {
  const input = object(raw, "project.consistency input");
  closed(input, ["scope", "cursor", "pageSize"], "project.consistency input");
  const scope = parseProjectScope(input.scope);
  const pageSize = input.pageSize === undefined ? 50 : input.pageSize;
  if (!Number.isSafeInteger(pageSize) || (pageSize as number) < 1 || (pageSize as number) > 100) throw new DiagnosticActionError("invalid_input", "pageSize must be an integer from 1 through 100");
  const start = validatePageCursor(input.cursor, context.snapshot.id, scope);

  const entries: Array<{ path: string; revision: string }> = [];
  let listCursor: string | null = null;
  do {
    const page: FilePage = yield* host.request<FilePage>(HOST_OPERATIONS.list, {
      snapshot: context.snapshot,
      limit: 256,
      ...(listCursor ? { cursor: listCursor } : {}),
    });
    if (!page || !Array.isArray(page.entries) || !(page.next_cursor === null || typeof page.next_cursor === "string")) throw new DiagnosticActionError("invalid_input", "Host returned an invalid file page");
    for (const entry of page.entries) {
      if (!entry || typeof entry.path !== "string" || typeof entry.revision !== "string" || !/^[a-f0-9]{64}$/u.test(entry.revision)) throw new DiagnosticActionError("snapshot_stale", "Host returned an invalid pinned file identity", true);
      entries.push({ path: entry.path, revision: entry.revision });
    }
    listCursor = page.next_cursor;
  } while (listCursor !== null);

  const projectFiles: ProjectFile[] = entries.map(({ path, revision }) => ({ path, revision, text: "" }));
  for (let index = 0; index < projectFiles.length; index++) {
    const file = projectFiles[index];
    if (!isNarrativeEntityPath(file.path)) continue;
    const { bytes } = yield* readFileVersioned(host, context.snapshot, file.path, file.revision);
    try {
      projectFiles[index] = { ...file, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      projectFiles[index] = { ...file, invalidEncoding: true };
    }
  }
  validateScopeEntities(readProjectGraph(projectFiles).entities, scope);
  const report = checkProjectConsistency(projectFiles, scope);
  const findings = report.findings.map((finding) => projectFinding(finding, context, scope));
  const from = Math.min(start, findings.length);
  const end = Math.min(findings.length, from + (pageSize as number));
  const nextCursor = end < findings.length ? `dcp1.${sha256(JSON.stringify([context.snapshot.id, scope ?? null]))}.${end}` : null;
  return {
    scope: scope ?? null,
    recognized: report.recognized,
    findings: findings.slice(from, end),
    counts: report.counts,
    cursor: nextCursor,
    complete: nextCursor === null,
    snapshot: context.snapshot,
    total_findings: findings.length,
  };
};

const textAnalyze: Handler = function* (raw, context, host) {
  const input = object(raw, "text.analyze input");
  const text = textInput(input, "text.analyze", ["text", "sceneId", "documentPath", "documentRevision", "draftGeneration"]);
  let source = sourceFields(input);
  if (input.sceneId !== undefined && (typeof input.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.sceneId))) throw new DiagnosticActionError("invalid_input", "sceneId must be a stable bounded ID");
  if (source.documentRevision && !source.documentPath) throw new DiagnosticActionError("invalid_input", "documentRevision requires documentPath");
  if (source.documentPath && !source.documentRevision && !source.draftGeneration) throw new DiagnosticActionError("invalid_input", "Saved documentPath requires documentRevision");
  if (source.draftGeneration && source.draftGeneration !== context.snapshot.draft_generation) throw new DiagnosticActionError("snapshot_stale", "Draft generation is no longer current", true);

  let narrativeRevision: string | undefined;
  let narrativeMetadataRevision: string | undefined;
  if (typeof input.sceneId === "string") {
    const scene = yield* invokeAction<Record<string, unknown>>(host, "proprium.narrative", "proprium.narrative.scene.context", { scene_id: input.sceneId });
    if (scene.scene_id !== input.sceneId || !safeManuscriptPath(scene.manuscript_path)) throw new DiagnosticActionError("scene_not_found", `Narrative could not resolve ${input.sceneId} to a manuscript`);
    narrativeRevision = safeRevision(scene.manuscript_revision, "Narrative manuscript revision");
    narrativeMetadataRevision = safeRevision(scene.metadata_revision, "Narrative scene metadata revision");
    if (source.documentPath && source.documentPath !== scene.manuscript_path) throw new DiagnosticActionError("invalid_path", "documentPath does not match the selected scene's explicit manuscript link");
    if (source.documentRevision && source.documentRevision !== narrativeRevision) throw new DiagnosticActionError("snapshot_stale", "Selected scene revision changed before text analysis", true);
    source = { ...source, documentPath: scene.manuscript_path, documentRevision: narrativeRevision };
  }

  if (source.documentPath && source.documentRevision) {
    const saved = yield* readFileVersioned(host, context.snapshot, source.documentPath, source.documentRevision);
    let savedText: string;
    try { savedText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(saved.bytes); }
    catch { throw new DiagnosticActionError("invalid_encoding", `Manuscript is not valid UTF-8: ${source.documentPath}`); }
    if (sha256(savedText) !== source.documentRevision) throw new DiagnosticActionError("snapshot_stale", "Host file revision does not match exact manuscript bytes", true);
    if (!source.draftGeneration && savedText !== text) throw new DiagnosticActionError("snapshot_stale", "Text does not match the named saved-file revision", true);
  }

  const config = yield* configuredLintRules(host, context);
  const analysis = analyzeText(text, config.rules);
  const baseFindings = findingsForTextAnalysis(text, analysis, {
    workspaceId: context.scope.workspace_id,
    repositoryId: context.scope.repository_id,
    branch: context.scope.branch,
    generation: context.scope.generation,
    snapshotId: context.snapshot.id,
    ...source,
    configRevision: config.revision,
  });
  const bodyStart = bodyOffset(text);
  const body = text.slice(bodyStart);
  let lexicalStatus = "unavailable";
  let termsStatus = "unavailable";
  let variantsStatus = "unavailable";
  let knowledgeStatus = typeof input.sceneId === "string" ? "unavailable" : "not_applicable";
  let toneStatus = typeof input.sceneId === "string" ? "unavailable" : "not_applicable";
  let enriched: Record<string, unknown> = { ...analysis };
  const providerIdentity: Record<string, unknown> = {};
  const configRevisions: Record<string, string> = { lint: config.revision };
  const metricFindings: Record<string, unknown>[] = [];

  try {
    const nlpSource = source.draftGeneration
      ? { kind: "draft", draftGeneration: source.draftGeneration }
      : source.documentPath && source.documentRevision
        ? { kind: "saved-file", path: source.documentPath, textRevision: source.documentRevision }
        : { kind: "literal" };
    const research = yield* invokeAction<Record<string, unknown>>(host, "proprium.research", "research.nlp.analyze", { text, source: nlpSource });
    const morphology = validateResearchAnalysis(research, text);
    const metrics = metricSentences(morphology, text, bodyStart);
    lexicalStatus = "ready";
    providerIdentity.research = morphology.engine;

    let known = new Set<string>();
    try {
      const registry = yield* researchKnownTerms(host);
      known = registry.terms;
      termsStatus = "ready";
      if (registry.revision) configRevisions.terms = registry.revision;
    } catch (error) {
      if (!optionalProviderError(error)) throw error;
      termsStatus = "unavailable";
    }

    let intendedTone: string | undefined;
    let knowledgeSource: { path: string; revision: string } | undefined;
    if (typeof input.sceneId === "string") {
      try {
        const knowledge = yield* invokeAction<Record<string, unknown>>(host, "proprium.knowledge", "knowledge.entities.get", { id: input.sceneId });
        const entity = knowledge.entity && typeof knowledge.entity === "object" && !Array.isArray(knowledge.entity) ? knowledge.entity as Record<string, unknown> : {};
        const rawEntity = entity.raw && typeof entity.raw === "object" && !Array.isArray(entity.raw) ? entity.raw as Record<string, unknown> : {};
        if (entity.id !== input.sceneId || entity.type !== undefined && entity.type !== "scene") throw new DiagnosticActionError("snapshot_stale", "Knowledge returned an unexpected scene identity", true);
        if (typeof entity.filePath === "string" && typeof entity.fileRevision === "string") {
          const metadataRevision = safeRevision(entity.fileRevision, "Knowledge scene metadata revision");
          if (narrativeMetadataRevision && metadataRevision !== narrativeMetadataRevision) throw new DiagnosticActionError("snapshot_stale", "Knowledge scene metadata changed during analysis", true);
          knowledgeSource = { path: entity.filePath, revision: entity.fileRevision };
        }
        if (typeof rawEntity.intended_tone === "string" && rawEntity.intended_tone) intendedTone = rawEntity.intended_tone;
        if (typeof entity.name === "string") known.add(entity.name);
        if (Array.isArray(entity.aliases)) for (const alias of entity.aliases) if (typeof alias === "string") known.add(alias);
        if (Array.isArray(rawEntity.aliases)) for (const alias of rawEntity.aliases) if (typeof alias === "string") known.add(alias);
        knowledgeStatus = "ready";
        providerIdentity.knowledge = knowledgeSource ?? { sceneId: input.sceneId };
      } catch (error) {
        if (!optionalProviderError(error)) throw error;
        knowledgeStatus = "unavailable";
      }
    }

    const nounResult = frequentNouns(metrics.sentences, known);
    const phrases = frequentPhrases(metrics.sentences);
    const arc = sentimentArc(metrics.sentences);
    const balance = proseBalance(metrics.text, metrics.tokens, metrics.sentences);
    const habitual = habitualPhraseWarnings(metrics.sentences);
    let variants: unknown[] = [];
    if (termsStatus === "ready" && nounResult.unknown.length > 0) {
      try {
        const result = yield* invokeAction<Record<string, unknown>>(host, "proprium.research", "research.terms.variants", {
          candidates: nounResult.unknown.map(({ term, count }) => ({ term, count })), knownTerms: [...known].slice(0, 2000),
        });
        if (!Array.isArray(result.suggestions) || result.suggestions.length > 200) throw new DiagnosticActionError("dependency_unavailable", "Research returned invalid term-variant suggestions", true);
        variants = result.suggestions;
        variantsStatus = "ready";
      } catch (error) {
        if (!optionalProviderError(error)) throw error;
        variantsStatus = "unavailable";
      }
    } else variantsStatus = termsStatus;

    let toneWarnings: unknown[] = [];
    if (intendedTone && knowledgeSource) {
      const tone = yield* configuredToneLexicon(host, context);
      configRevisions.toneLexicon = tone.revision;
      const warning = toneDeviation(metrics.tokens, tone.lexicon, intendedTone);
      if (warning) {
        const dominant = typeof warning.dominantTone === "string" ? warning.dominantTone : "";
        const weights = tone.lexicon.tones[dominant] ?? {};
        const spans = metrics.tokens.filter((token) => weights[token.base ?? token.surface] !== undefined || weights[token.surface] !== undefined)
          .slice(0, 24).map((token) => ({ path: source.documentPath, revision: source.documentRevision, text_hash: analysis.textHash, start: token.start, end: token.end, quote: token.surface }));
        const message = String(warning.message ?? "Tone differs from declared intent");
        const fingerprint = sha256(JSON.stringify([context.scope.workspace_id, context.scope.repository_id, context.scope.branch, context.scope.generation, context.snapshot.id, input.sceneId, source.documentPath ?? null, source.documentRevision ?? null, analysis.textHash, tone.revision, intendedTone, dominant]));
        const toneVector = warning.toneVector && typeof warning.toneVector === "object" && !Array.isArray(warning.toneVector)
          ? Object.entries(warning.toneVector as Record<string, unknown>).map(([toneName, weight]) => ({ tone: toneName, weight: typeof weight === "number" ? weight : 0 }))
          : [];
        toneWarnings = [{ intendedTone, dominantTone: dominant, toneVector, message, signal: "statistical", fingerprint, evidence: spans }];
        metricFindings.push(metricFinding("tone-deviation", message, analysis.textHash, context, source,
          { lint: config.revision, toneLexicon: tone.revision },
          spans.map((span) => ({ start: span.start, end: span.end, quote: span.quote })),
          { research: morphology.engine, ...(knowledgeSource ? { knowledge: knowledgeSource } : {}) },
          knowledgeSource ? [{ path: knowledgeSource.path, fileRevision: knowledgeSource.revision, entityId: input.sceneId, quote: `intended_tone: ${intendedTone}` }] : []));
      }
      toneStatus = "ready";
      providerIdentity.tone = knowledgeSource;
    } else if (knowledgeStatus === "ready") toneStatus = "ready";

    for (const warning of balance.warnings) metricFindings.push(metricFinding(`prose-${warning.metric}`, warning.message, analysis.textHash, context, source, { lint: config.revision }, [], { research: morphology.engine }));
    for (const warning of habitual) metricFindings.push(metricFinding(`habitual-${warning.band}`, warning.message, analysis.textHash, context, source, { lint: config.revision }, warning.evidence, { research: morphology.engine }));
    enriched = {
      ...analysis,
      charCount: metrics.text.length,
      sentenceCount: metrics.sentences.length,
      frequentNouns: nounResult.frequent,
      unknownTermCandidates: termsStatus === "ready" ? nounResult.unknown : [],
      termVariantSuggestions: variants,
      frequentPhrases: phrases,
      sentimentArc: arc,
      toneWarnings,
      habitualPhraseWarnings: habitual,
      proseBalance: balance,
      providers: { lexical: "ready", terms: termsStatus, variants: variantsStatus, knowledge: knowledgeStatus, tone: toneStatus },
    };
  } catch (error) {
    if (!optionalProviderError(error)) throw error;
    lexicalStatus = "unavailable";
    enriched = {
      ...analysis,
      providers: { lexical: "unavailable", terms: "unavailable", variants: "unavailable", ...(typeof input.sceneId === "string" ? { knowledge: knowledgeStatus, tone: toneStatus } : {}) },
      frequentNouns: [], unknownTermCandidates: [], termVariantSuggestions: [], frequentPhrases: [],
      sentimentArc: null, toneWarnings: [], habitualPhraseWarnings: [], proseBalance: null,
    };
  }

  const findings = [...baseFindings, ...metricFindings].sort((left, right) => String(left.class ?? "").localeCompare(String(right.class ?? "")) ||
    Number((left.range as Record<string, unknown> | undefined)?.start ?? 0) - Number((right.range as Record<string, unknown> | undefined)?.start ?? 0) || String(left.fingerprint ?? "").localeCompare(String(right.fingerprint ?? "")));
  const providerStatus = { lexical: lexicalStatus, terms: termsStatus, variants: variantsStatus, ...(typeof input.sceneId === "string" ? { knowledge: knowledgeStatus, tone: toneStatus } : {}) };
  return {
    ...enriched,
    identity: {
      repositoryId: context.scope.repository_id,
      branch: context.scope.branch,
      snapshot: context.snapshot,
      sceneId: typeof input.sceneId === "string" ? input.sceneId : null,
      documentPath: source.documentPath ?? null,
      documentRevision: source.documentRevision ?? null,
      draftGeneration: source.draftGeneration ?? context.snapshot.draft_generation,
      analyzerId: "proprium.diagnostics.cpu",
      analyzerVersion: "1.0.0",
      configRevisions,
      providerIdentity,
      complete: lexicalStatus === "ready" && (typeof input.sceneId !== "string" || knowledgeStatus === "ready"),
      providerStatus,
    },
    findings,
    issues: findings.map((finding) => ({
      id: finding.fingerprint,
      fingerprint: finding.fingerprint,
      kind: finding.kind,
      severity: finding.severity,
      message: finding.message,
      range: finding.range,
    })),
  };
};

const lintRun: Handler = function* (raw, context, host) {
  const input = object(raw, "lint.run input");
  const text = textInput(input, "lint.run", ["text", "documentPath", "documentRevision", "draftGeneration", "ruleSet"]);
  const source = sourceFields(input);
  const config = yield* configuredLintRules(host, context, input.ruleSet);
  const rules = config.rules;
  const analysis = analyzeText(text, rules);
  const bodyStart = bodyOffset(text);
  const body = text.slice(bodyStart);
  const transformedBody = transformText(body, rules);
  const transformed = text.slice(0, bodyStart) + transformedBody;
  if (transformed.length > 1_048_576) throw new DiagnosticActionError("capacity", "Lint preview exceeds the Host result text limit", true);
  const findings = findingsForTextAnalysis(text, analysis, {
    workspaceId: context.scope.workspace_id,
    repositoryId: context.scope.repository_id,
    branch: context.scope.branch,
    generation: context.scope.generation,
    snapshotId: context.snapshot.id,
    ...source,
    configRevision: config.revision,
  });
  return {
    textHash: analysis.textHash,
    warnings: analysis.lintWarnings,
    findings: findings.filter((finding) => finding.class === "format"),
    transformAvailable: transformed !== text,
    ...(transformed !== text ? { proposedText: transformed } : {}),
    configRevision: config.revision,
    identity: {
      repositoryId: context.scope.repository_id,
      branch: context.scope.branch,
      snapshot: context.snapshot,
      documentPath: source.documentPath ?? null,
      documentRevision: source.documentRevision ?? null,
      draftGeneration: source.draftGeneration ?? context.snapshot.draft_generation,
      analyzerId: "proprium.diagnostics.cpu",
      analyzerVersion: "1.0.0",
      configRevisions: { lint: config.revision },
      complete: true,
      providerStatus: { lexical: "disabled" },
    },
  };
};

const SCENE_SECTIONS = ["structural", "continuity", "prose", "plotGoal", "declaredVoice", "speaker", "semanticHypotheses"] as const;
type SceneSection = typeof SCENE_SECTIONS[number];
const sceneRun: Handler = function* (raw, context, host) {
  const input = object(raw, "scene.run input");
  closed(input, ["sceneId", "documentPath", "documentRevision", "draftGeneration", "text", "sections"], "scene.run input");
  if (typeof input.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.sceneId)) throw new DiagnosticActionError("invalid_input", "sceneId must be a stable bounded ID");
  if (input.sections !== undefined && (!Array.isArray(input.sections) || input.sections.length > SCENE_SECTIONS.length || input.sections.some((item) => typeof item !== "string" || !(SCENE_SECTIONS as readonly string[]).includes(item)) || new Set(input.sections).size !== input.sections.length)) throw new DiagnosticActionError("invalid_input", "sections must contain unique supported section IDs");
  const requested = input.sections === undefined ? [...SCENE_SECTIONS] : input.sections as SceneSection[];
  const scene = yield* invokeAction<Record<string, unknown>>(host, "proprium.narrative", "proprium.narrative.scene.context", { scene_id: input.sceneId });
  if (scene.scene_id !== input.sceneId || !safeManuscriptPath(scene.manuscript_path)) throw new DiagnosticActionError("scene_not_found", `Narrative could not resolve ${input.sceneId} to a manuscript`);
  const path = scene.manuscript_path;
  if (input.documentPath !== undefined && input.documentPath !== path) throw new DiagnosticActionError("invalid_path", "documentPath does not match the selected scene's explicit manuscript link");
  const savedRevision = safeRevision(scene.manuscript_revision, "Narrative manuscript revision");
  if (input.documentRevision !== undefined && input.documentRevision !== savedRevision) throw new DiagnosticActionError("snapshot_stale", "Selected scene revision changed before Diagnostics ran", true);
  let text: string;
  let draftGeneration: string | null = null;
  if (input.text !== undefined) {
    if (typeof input.text !== "string") throw new DiagnosticActionError("invalid_input", "text must be a string");
    if (input.draftGeneration !== context.snapshot.draft_generation || typeof input.draftGeneration !== "string") throw new DiagnosticActionError("snapshot_stale", "Draft text requires the current Host draft generation", true);
    text = textInput({ text: input.text }, "scene.run", ["text"]);
    draftGeneration = input.draftGeneration;
  } else {
    if (input.draftGeneration !== undefined) throw new DiagnosticActionError("invalid_input", "draftGeneration requires explicit Draft text");
    const file = yield* readFileVersioned(host, context.snapshot, path, savedRevision);
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
    catch { throw new DiagnosticActionError("invalid_encoding", `Manuscript is not valid UTF-8: ${path}`); }
    if (sha256(text) !== savedRevision) throw new DiagnosticActionError("snapshot_stale", "Host file revision does not match the exact manuscript bytes", true);
  }
  let textHash: string;
  let configRevisions: Record<string, unknown> = {};
  const sections: Record<string, unknown> = {};
  const findings: Array<Record<string, unknown>> = [];
  if (requested.includes("prose")) {
    const prose = yield* invokeLocal(textAnalyze, {
      text, sceneId: input.sceneId, documentPath: path, documentRevision: savedRevision,
      ...(draftGeneration ? { draftGeneration } : {}),
    }, context, host) as Generator<import("../shared/guest.js").HostCall, Record<string, unknown>, unknown>;
    const proseIdentity = prose.identity && typeof prose.identity === "object" ? prose.identity as Record<string, unknown> : {};
    textHash = typeof prose.textHash === "string" ? prose.textHash : "";
    configRevisions = proseIdentity.configRevisions && typeof proseIdentity.configRevisions === "object" ? proseIdentity.configRevisions as Record<string, unknown> : {};
    const proseComplete = proseIdentity.complete === true;
    const proseFindings = Array.isArray(prose.findings) ? prose.findings as Array<Record<string, unknown>> : [];
    sections.prose = { status: proseComplete ? "ready" : "partial", analysis: prose, findings: proseFindings };
    findings.push(...proseFindings);
  } else {
    const config = yield* configuredLintRules(host, context);
    const analysis = analyzeText(text, config.rules);
    textHash = analysis.textHash;
    configRevisions = { lint: config.revision };
  }
  if (requested.includes("structural")) {
    const result = yield* invokeLocal(projectConsistency, { scope: { sceneId: input.sceneId }, pageSize: 100 }, context, host);
    const report = result && typeof result === "object" ? result as Record<string, unknown> : {};
    sections.structural = { status: report.recognized === true ? "ready" : "not_applicable", recognized: report.recognized === true, counts: report.counts, complete: report.complete === true };
    if (result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).findings)) findings.push(...(result as Record<string, unknown>).findings as Array<Record<string, unknown>>);
  }
  if (requested.includes("continuity")) {
    const result = yield* invokeLocal(projectContinuity, { scope: { sceneId: input.sceneId }, pageSize: 100 }, context, host);
    const report = result && typeof result === "object" ? result as Record<string, unknown> : {};
    sections.continuity = { status: report.recognized === true ? "ready" : "not_applicable", recognized: report.recognized === true, counts: report.counts, complete: report.complete === true };
    if (result && typeof result === "object" && Array.isArray((result as Record<string, unknown>).findings)) findings.push(...(result as Record<string, unknown>).findings as Array<Record<string, unknown>>);
  }
  let plotGoalStatus: "ready" | "not_applicable" | "unavailable" = "unavailable";
  if (requested.includes("plotGoal")) {
    const report = yield* invokeLocal(plotGoalCheck, {
      sceneId: input.sceneId,
      documentRevision: savedRevision,
      ...(draftGeneration ? { text, draftGeneration } : {}),
    }, context, host) as Generator<import("../shared/guest.js").HostCall, Record<string, unknown>, unknown>;
    plotGoalStatus = report.status === "ready" || report.status === "not_applicable" ? report.status : "unavailable";
    sections.plotGoal = { status: plotGoalStatus, warnings: report.warnings ?? [], identity: report.identity, providerStatus: report.providerStatus };
    if (Array.isArray(report.warnings)) {
      const reportIdentity = report.identity && typeof report.identity === "object" ? report.identity as Record<string, unknown> : {};
      const plotTextHash = typeof reportIdentity.textHash === "string" ? reportIdentity.textHash : textHash;
      const goalTextHash = typeof reportIdentity.goalTextHash === "string" ? reportIdentity.goalTextHash : plotTextHash;
      findings.push(...(report.warnings as Array<Record<string, unknown>>).map((warning) => {
        const evidence = Array.isArray(warning.evidence) ? warning.evidence.map((source) => {
          const row = source as Record<string, unknown>;
          return {
            path: row.path, revision: row.revision,
            text_hash: row.source === "goal" ? goalTextHash : plotTextHash,
            start: row.start, end: row.end, quote: row.quote,
          };
        }) : [];
        return {
          fingerprint: warning.fingerprint,
          class: "statistical", kind: `plot_goal_${String(warning.kind ?? "signal")}`,
          severity: "warning", basis: "deterministic", message: warning.message,
          analyzer_id: "proprium.diagnostics.plot-goal", analyzer_version: "1.0.0",
          source_path: path, source_revision: savedRevision, text_hash: plotTextHash,
          scene_id: input.sceneId, quote: evidence.map((item) => item.quote).join(" / ").slice(0, 1000), evidence,
          sourceIdentity: warning.sourceIdentity,
        };
      }));
    }
  }
  let speakerStatus: "ready" | "unavailable" = "unavailable";
  if (requested.includes("declaredVoice") || requested.includes("speaker")) {
    try {
      const speaker = yield* invokeAction<Record<string, unknown>>(host, "proprium.speaker", "speaker.voice.check", {
        scene_id: input.sceneId,
        ...(draftGeneration ? { text, draft_generation: draftGeneration } : {}),
      });
      if (speaker.scene_id !== input.sceneId) throw new DiagnosticActionError("snapshot_stale", "Speaker returned evidence for a different scene", true);
      const attributions = boundedProviderRows(speaker.attributions, "Speaker attributions");
      const issues = boundedProviderRows(speaker.issues, "Speaker issues");
      const declaredWarnings = boundedProviderRows(speaker.declared_warnings, "Speaker declared warnings");
      const learnedWarnings = boundedProviderRows(speaker.learned_style_warnings, "Speaker learned-style warnings");
      const stylometricWarnings = boundedProviderRows(speaker.stylometric_warnings, "Speaker stylometric warnings");
      const provenance = object(speaker.provenance, "Speaker provenance");
      if (typeof speaker.speakerEngine !== "string" || typeof speaker.speakerEngineVersion !== "string" || typeof speaker.speakerModuleVersion !== "string" ||
          typeof speaker.tokenizerModel !== "string" || typeof speaker.tokenizerModelVersion !== "string") throw new DiagnosticActionError("dependency_unavailable", "Speaker omitted its engine identity", true);
      speakerStatus = "ready";
      const providerIdentity = {
        speakerEngine: speaker.speakerEngine,
        speakerEngineVersion: speaker.speakerEngineVersion,
        speakerModuleVersion: speaker.speakerModuleVersion,
        adoptedModelIdentity: speaker.adoptedModelIdentity ?? null,
        tokenizerModel: speaker.tokenizerModel,
        tokenizerModelVersion: speaker.tokenizerModelVersion,
        provenance,
      };
      if (requested.includes("declaredVoice")) sections.declaredVoice = { status: "ready", warnings: declaredWarnings, providerIdentity };
      if (requested.includes("speaker")) sections.speaker = {
        status: "ready",
        attributions, issues, declaredWarnings, learnedStyleWarnings: learnedWarnings, stylometricWarnings,
        providerIdentity,
      };
    } catch (error) {
      if (!optionalProviderError(error)) throw error;
      if (requested.includes("declaredVoice")) sections.declaredVoice = { status: "unavailable", reason: "provider_unavailable" };
      if (requested.includes("speaker")) sections.speaker = { status: "unavailable", reason: "provider_unavailable" };
    }
  }
  let semanticStatus: "ready" | "unavailable" = "unavailable";
  if (requested.includes("semanticHypotheses")) {
    sections.semanticHypotheses = { status: "unavailable", reason: "provider_unavailable" };
    // Semantic's index represents saved source, not an unsaved editor draft.
    if (!draftGeneration) {
      try {
        const result = yield* invokeAction<Record<string, unknown>>(host, "proprium.semantic", "proprium.semantic.contradictions.candidates", { limit: 100 });
        if (canonicalJson(result.snapshot) !== canonicalJson(context.snapshot)) throw new DiagnosticActionError("snapshot_stale", "Semantic returned a different snapshot", true);
        if (result.indexAvailable === true) {
          const candidates = boundedProviderRows(result.candidates, "Semantic hypotheses") as Array<Record<string, unknown>>;
          if (typeof result.complete !== "boolean" || !(result.nextCursor === null || typeof result.nextCursor === "string")) throw new DiagnosticActionError("dependency_unavailable", "Semantic returned an invalid candidate page", true);
          const selected = candidates.filter(candidate => {
            const a = object(candidate.evidenceA, "Semantic evidence A");
            const b = object(candidate.evidenceB, "Semantic evidence B");
            return a.sceneId === input.sceneId || b.sceneId === input.sceneId;
          });
          semanticStatus = "ready";
          sections.semanticHypotheses = { status: "ready", candidates: selected, model: result.model, complete: result.complete && result.nextCursor === null };
        } else if (result.indexAvailable !== false) throw new DiagnosticActionError("dependency_unavailable", "Semantic returned an invalid index state", true);
      } catch (error) {
        if (!optionalProviderError(error)) throw error;
      }
    }
  }
  findings.sort((left, right) => String(left.class ?? "").localeCompare(String(right.class ?? "")) ||
    Number((left.range as Record<string, unknown> | undefined)?.start ?? 0) - Number((right.range as Record<string, unknown> | undefined)?.start ?? 0) || String(left.fingerprint ?? "").localeCompare(String(right.fingerprint ?? "")));
  const classCounts: Record<string, number> = {};
  for (const finding of findings) { const key = typeof finding.class === "string" ? finding.class : "other"; classCounts[key] = (classCounts[key] ?? 0) + 1; }
  const providerStatus = {
    ...(requested.includes("prose") ? (() => {
      const prose = sections.prose as Record<string, unknown>;
      const analysis = prose.analysis as Record<string, unknown>;
      const providers = analysis.providers as Record<string, unknown>;
      return {
        lexical: providers.lexical ?? "unavailable",
        terms: providers.terms ?? "unavailable",
        variants: providers.variants ?? "unavailable",
        ...(providers.knowledge !== undefined ? { knowledge: providers.knowledge } : {}),
        ...(providers.tone !== undefined ? { tone: providers.tone } : {}),
      };
    })() : {}),
    ...(requested.includes("plotGoal") ? { plotGoal: plotGoalStatus } : {}),
    ...(requested.includes("declaredVoice") ? { declaredVoice: speakerStatus } : {}),
    ...(requested.includes("speaker") ? { speaker: speakerStatus } : {}),
    ...(requested.includes("semanticHypotheses") ? { semanticHypotheses: semanticStatus } : {}),
  };
  return {
    identity: {
      repositoryId: context.scope.repository_id, branch: context.scope.branch, snapshot: context.snapshot, sceneId: input.sceneId,
      documentPath: path, documentRevision: savedRevision, draftGeneration: draftGeneration ?? context.snapshot.draft_generation,
      textHash, analyzerId: "proprium.diagnostics.cpu", analyzerVersion: "1.0.0", configRevisions,
    },
    sections, findings,
    summary: { findingCount: findings.length, byClass: classCounts },
    providerStatus,
    complete: requested.every((section) => {
      const report = sections[section] as Record<string, unknown> | undefined;
      if (!report || report.status === "unavailable") return false;
      if (section === "prose") return report.status === "ready";
      return report.complete !== false;
    }),
  };
};

function lintEvidence(path: string, revision: string, text: string, bodyStart: number, warning: { offset: number; length: number }): SourceSpan {
  const start = Math.max(bodyStart, bodyStart + warning.offset - 40);
  const end = Math.min(text.length, bodyStart + warning.offset + Math.max(warning.length, 1) + 40, start + 4000);
  return { path, revision, start, end, quote: text.slice(start, end) };
}

const lintPropose: Handler = function* (raw, context, host) {
  const input = object(raw, "lint.propose input");
  closed(input, ["documentPath", "expectedRevision", "textHash", "selectedRuleIds", "idempotencyKey"], "lint.propose input");
  if (!safeManuscriptPath(input.documentPath)) throw new DiagnosticActionError("invalid_path", "documentPath must be a safe manuscript Markdown path");
  const expectedRevision = safeRevision(input.expectedRevision, "expectedRevision");
  const textHash = safeRevision(input.textHash, "textHash");
  const key = idempotencyKey(input, context);
  if (input.selectedRuleIds !== undefined && (!Array.isArray(input.selectedRuleIds) || input.selectedRuleIds.length > 128 || input.selectedRuleIds.some((item) => typeof item !== "string" || !item) || new Set(input.selectedRuleIds).size !== input.selectedRuleIds.length)) throw new DiagnosticActionError("invalid_input", "selectedRuleIds must contain unique nonempty rule IDs");
  const listedRevision = yield* fileRevision(host, context.snapshot, input.documentPath);
  if (listedRevision !== expectedRevision) throw new DiagnosticActionError("snapshot_stale", "Manuscript revision changed since the diagnostic result", true);
  const source = yield* readFileVersioned(host, context.snapshot, input.documentPath, expectedRevision);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes); }
  catch { throw new DiagnosticActionError("invalid_encoding", `Manuscript is not valid UTF-8: ${input.documentPath}`); }
  if (sha256(text) !== expectedRevision) throw new DiagnosticActionError("snapshot_stale", "Host file revision does not match the exact manuscript bytes", true);
  if (Array.from(text).length > MAX_TEXT_CODE_POINTS) throw new DiagnosticActionError("capacity", "Manuscript exceeds the diagnostics formatting limit", true);
  const config = yield* configuredLintRules(host, context);
  const rules = input.selectedRuleIds === undefined ? config.rules : config.rules.filter((rule) => (input.selectedRuleIds as string[]).includes(rule.id));
  if (input.selectedRuleIds !== undefined && (input.selectedRuleIds as string[]).some((id) => !config.rules.some((rule) => rule.id === id))) throw new DiagnosticActionError("invalid_input", "selectedRuleIds contains a rule outside the current configuration");
  const analysis = analyzeText(text, rules);
  if (analysis.textHash !== textHash) throw new DiagnosticActionError("snapshot_stale", "Diagnostic text hash no longer matches the saved manuscript", true);
  const bodyStart = bodyOffset(text);
  const body = text.slice(bodyStart);
  const warnings = lintText(body, rules);
  if (warnings.length > 256) throw new DiagnosticActionError("capacity", "More than 256 lint findings require a narrower rule selection", true);
  const after = text.slice(0, bodyStart) + transformText(body, rules);
  if (after === text) throw new DiagnosticActionError("no_change", "Selected lint rules have no deterministic formatting change");
  const beforeHash = sha256(text);
  const afterHash = sha256(after);
  const evidence = warnings.length ? warnings.map((warning) => lintEvidence(input.documentPath as string, expectedRevision, text, bodyStart, warning)) : changedEvidence(input.documentPath as string, expectedRevision, text, after);
  const content = yield* changeContent(host, context, input.documentPath, after);
  const changeset = makeChangeSet({
    context, actionId: context.action_id, idempotencyKey: key, path: input.documentPath, revision: expectedRevision,
    before: text, after, title: "Diagnostics: lint formatting", reason: "Apply the selected deterministic lint transformations after author review.",
    evidence, content, read_set: [...config.read_set, { path: input.documentPath, revision: expectedRevision }],
  });
  const proposalId = yield* submitChangeSet(host, changeset, content.artifact_id);
  const operationIds = changeset.units.flatMap((unit) => unit.operations.map((operation) => operation.id));
  return { proposalId, operationIds, beforeHash, afterHash, diff: diffSummary(input.documentPath, text, after, beforeHash, afterHash), warnings, expectedRevision, snapshot: context.snapshot };
};

const manuscriptFormatPropose: Handler = function* (raw, context, host) {
  const input = object(raw, "manuscript.format.propose input");
  closed(input, ["sceneId", "expectedRevision", "idempotencyKey"], "manuscript.format.propose input");
  if (typeof input.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.sceneId)) throw new DiagnosticActionError("invalid_input", "sceneId must be a stable bounded ID");
  const expectedRevision = safeRevision(input.expectedRevision, "expectedRevision");
  const key = idempotencyKey(input, context);
  const contextValue = yield* invokeAction<Record<string, unknown>>(host, "proprium.narrative", "proprium.narrative.scene.context", { scene_id: input.sceneId });
  if (contextValue.scene_id !== input.sceneId || !safeManuscriptPath(contextValue.manuscript_path)) throw new DiagnosticActionError("invalid_path", "Narrative did not return a safe explicit manuscript path");
  if (contextValue.manuscript_revision !== expectedRevision) throw new DiagnosticActionError("snapshot_stale", "Scene manuscript changed since the formatting preview", true);
  const chapter = contextValue.chapter && typeof contextValue.chapter === "object" ? contextValue.chapter as Record<string, unknown> : undefined;
  if (typeof chapter?.id !== "string") throw new DiagnosticActionError("snapshot_stale", "Narrative scene context omitted its chapter identity", true);
  const tree = yield* chapterScenes(host, context.snapshot, chapter.id);
  const sourceScene = tree.scenes.find((scene) => scene.id === input.sceneId);
  if (!sourceScene || sourceScene.manuscriptPath !== contextValue.manuscript_path || sourceScene.manuscriptRevision !== expectedRevision) throw new DiagnosticActionError("snapshot_stale", "Narrative scene link changed during the formatting proposal", true);
  const file = yield* readFileVersioned(host, context.snapshot, sourceScene.manuscriptPath, expectedRevision);
  let before: string;
  try { before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes); }
  catch { throw new DiagnosticActionError("invalid_encoding", `Manuscript is not valid UTF-8: ${sourceScene.manuscriptPath}`); }
  if (sha256(before) !== expectedRevision) throw new DiagnosticActionError("snapshot_stale", "Host file revision does not match the exact manuscript bytes", true);
  if (file.bytes.byteLength > MAX_PROPOSAL_BYTES) throw new DiagnosticActionError("capacity", `Manuscript exceeds ${MAX_PROPOSAL_BYTES} bytes`, true);
  const formatted = formatManuscript(before);
  if (!formatted.frontmatterPreserved) throw new DiagnosticActionError("unsupported_format", "Formatter could not preserve Markdown frontmatter");
  if (!formatted.changed) return { frontmatterPreserved: true, changed: false, snapshot: context.snapshot };
  const afterHash = sha256(formatted.text);
  const beforeHash = sha256(before);
  const evidence = changedEvidence(sourceScene.manuscriptPath, expectedRevision, before, formatted.text);
  const content = yield* changeContent(host, context, sourceScene.manuscriptPath, formatted.text);
  const metadataReads = tree.scenes.map((scene) => ({ path: scene.metadataPath, revision: scene.metadataRevision }));
  const changeset = makeChangeSet({
    context, actionId: context.action_id, idempotencyKey: key, path: sourceScene.manuscriptPath, revision: expectedRevision,
    before, after: formatted.text, title: "Diagnostics: format manuscript", reason: "Apply deterministic manuscript formatting after author review.",
    evidence, content, read_set: metadataReads,
  });
  const proposalId = yield* submitChangeSet(host, changeset, content.artifact_id);
  return { proposalId, diff: diffSummary(sourceScene.manuscriptPath, before, formatted.text, beforeHash, afterHash), frontmatterPreserved: true, changed: true, snapshot: context.snapshot };
};

function feedbackSource(identity: Record<string, unknown>): Record<string, unknown> {
  const source: Record<string, unknown> = {
    repositoryId: identity.repositoryId,
    branch: identity.branch,
    generation: identity.generation,
    snapshot: identity.snapshot,
    evidence: identity.sources,
    analyzer: identity.analyzer,
  };
  for (const key of ["configRevisions", "providerIdentity", "modelIdentity", "draftGeneration", "sceneId", "scope"] as const) {
    if (identity[key] !== undefined) source[key] = identity[key];
  }
  return source;
}

function feedbackSourceMatches(existing: unknown, expected: Record<string, unknown>): boolean {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const row = existing as Record<string, unknown>;
  const keys = ["repositoryId", "branch", "generation", "snapshot", "evidence", "analyzer", "configRevisions", "providerIdentity", "modelIdentity", "draftGeneration", "sceneId", "scope"];
  const normalized: Record<string, unknown> = {};
  for (const key of keys) if (row[key] !== undefined) normalized[key] = row[key];
  return canonicalJson(normalized) === canonicalJson(expected);
}

function* feedbackPropose(raw: unknown, context: Parameters<Handler>[1], host: Parameters<Handler>[2]) {
  const input = object(raw, "feedback.propose input");
  closed(input, ["findingFingerprint", "decision", "sourceIdentity", "annotation", "expectedFeedbackRevision", "idempotencyKey"], "feedback.propose input");
  if (typeof input.findingFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(input.findingFingerprint)) throw new DiagnosticActionError("invalid_input", "findingFingerprint must be a SHA-256 fingerprint");
  if (!(input.decision === "false_positive" || input.decision === "intentional" || input.decision === "deferred")) throw new DiagnosticActionError("invalid_input", "decision must be false_positive, intentional, or deferred");
  if (input.annotation !== undefined && (typeof input.annotation !== "string" || new TextEncoder().encode(input.annotation).byteLength > 1000)) throw new DiagnosticActionError("invalid_input", "annotation must be at most 1000 UTF-8 bytes");
  if (input.expectedFeedbackRevision !== undefined && input.expectedFeedbackRevision !== null && (typeof input.expectedFeedbackRevision !== "string" || !/^[a-f0-9]{64}$/u.test(input.expectedFeedbackRevision))) throw new DiagnosticActionError("invalid_input", "expectedFeedbackRevision must be null or a SHA-256 revision");
  const key = idempotencyKey(input, context);
  const identity = object(input.sourceIdentity, "sourceIdentity");
  if (identity.findingFingerprint !== input.findingFingerprint || identity.repositoryId !== context.scope.repository_id || identity.branch !== context.scope.branch ||
      identity.generation !== context.scope.generation || identity.snapshot !== context.snapshot.id) throw new DiagnosticActionError("snapshot_stale", "Finding identity does not belong to this repository snapshot", true);
  if (identity.draftGeneration !== undefined && identity.draftGeneration !== context.snapshot.draft_generation) throw new DiagnosticActionError("snapshot_stale", "Finding Draft generation is no longer current", true);

  const memoryKey = canonicalJson([context.scope.workspace_id, canonicalJson(context.scope), context.snapshot.id, input.findingFingerprint]);
  const remembered = rememberedFindings.get(memoryKey);
  if (!remembered || remembered.scopeKey !== canonicalJson(context.scope) || remembered.snapshotId !== context.snapshot.id ||
      canonicalJson(remembered.sourceIdentity) !== canonicalJson(identity)) {
    throw new DiagnosticActionError("snapshot_stale", "Refresh Diagnostics before deciding on this finding", true);
  }
  if (typeof identity.actionId !== "string" || !identity.actionId.startsWith("proprium.diagnostics.") ||
      !identity.analyzer || typeof identity.analyzer !== "object" || !Array.isArray(identity.sources) || identity.sources.length < 1 || identity.sources.length > 100) {
    throw new DiagnosticActionError("invalid_input", "Finding source identity is incomplete");
  }

  const sourceRows: Array<Record<string, unknown>> = [];
  const readSet: ReadPrecondition[] = [];
  const spans: SourceSpan[] = [];
  const seenPaths = new Map<string, string>();
  for (const [index, rawSource] of identity.sources.entries()) {
    const source = object(rawSource, `sourceIdentity.sources[${index}]`);
    closed(source, ["path", "fileRevision", "entityId", "textHash", "span", "quote"], `sourceIdentity.sources[${index}]`);
    if (typeof source.path !== "string" || source.path.length > 1024 || source.path.startsWith("/") || source.path.includes("\\") || source.path.includes("\0") || source.path.split("/").some((part) => !part || part === "." || part === "..")) throw new DiagnosticActionError("invalid_path", "Finding source contains an unsafe path");
    const revision = safeRevision(source.fileRevision, "Finding source revision");
    if (source.entityId !== undefined && (typeof source.entityId !== "string" || source.entityId.length > 256)) throw new DiagnosticActionError("invalid_input", "Finding entity identity is invalid");
    if (source.textHash !== undefined && (typeof source.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(source.textHash))) throw new DiagnosticActionError("invalid_input", "Finding text hash is invalid");
    let start = 0, end = 0;
    if (source.span !== undefined) {
      const span = object(source.span, `sourceIdentity.sources[${index}].span`);
      closed(span, ["start", "end"], `sourceIdentity.sources[${index}].span`);
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || (span.start as number) < 0 || (span.end as number) < (span.start as number)) throw new DiagnosticActionError("invalid_input", "Finding source span is invalid");
      start = span.start as number; end = span.end as number;
    }
    if (source.quote !== undefined && (typeof source.quote !== "string" || source.quote.length > 4000)) throw new DiagnosticActionError("invalid_input", "Finding source quote is invalid");
    const priorRevision = seenPaths.get(source.path);
    if (priorRevision !== undefined && priorRevision !== revision) throw new DiagnosticActionError("snapshot_stale", "Finding refers to conflicting revisions of one source file", true);
    seenPaths.set(source.path, revision);
    if (priorRevision === undefined) {
      const file = yield* readFileVersioned(host, context.snapshot, source.path, revision);
      if (file.bytes.byteLength > MAX_PROPOSAL_BYTES) throw new DiagnosticActionError("capacity", "Finding evidence file exceeds the feedback verification limit", true);
      readSet.push({ path: source.path, revision });
    }
    sourceRows.push(source);
    spans.push({ path: source.path, revision, start, end, quote: typeof source.quote === "string" ? source.quote : "" });
  }

  let before = "";
  let feedbackRevision: string | null = null;
  try {
    const file = yield* readFileVersioned(host, context.snapshot, FEEDBACK_PATH);
    if (file.bytes.byteLength > MAX_FEEDBACK_BYTES) throw new DiagnosticActionError("capacity", "Feedback file exceeds the Diagnostics limit", true);
    try { before = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); }
    catch { throw new DiagnosticActionError("invalid_encoding", `Feedback file is not valid UTF-8: ${FEEDBACK_PATH}`); }
    feedbackRevision = file.revision;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "file_not_found")) throw error;
  }
  if (input.expectedFeedbackRevision !== undefined && input.expectedFeedbackRevision !== feedbackRevision) throw new DiagnosticActionError("snapshot_stale", "Feedback file revision changed before this decision", true);

  const document = YAML.parseDocument(before || "schemaVersion: 1\nentries: []\n", { strict: true, uniqueKeys: true });
  if (document.errors.length) throw new DiagnosticActionError("unsupported_format", `Invalid feedback YAML: ${document.errors[0].message}`, false, { path: FEEDBACK_PATH });
  if (!isMap(document.contents)) throw new DiagnosticActionError("unsupported_format", "Feedback YAML root must be a mapping", false, { path: FEEDBACK_PATH });
  let decoded: unknown;
  try { decoded = document.toJS({ maxAliasCount: 100 }); }
  catch (error) { throw new DiagnosticActionError("unsupported_format", `Invalid feedback YAML: ${error instanceof Error ? error.message : "alias error"}`, false, { path: FEEDBACK_PATH }); }
  const root = object(decoded, "feedback YAML root");
  if (root.schemaVersion !== 1 || !Array.isArray(root.entries)) throw new DiagnosticActionError("unsupported_format", "Feedback YAML requires schemaVersion: 1 and an entries sequence", false, { path: FEEDBACK_PATH });
  if (root.entries.length >= MAX_FEEDBACK_ENTRIES) throw new DiagnosticActionError("capacity", "Feedback entry limit has been reached", true);
  const entriesNode = document.get("entries", true);
  if (!isSeq(entriesNode)) throw new DiagnosticActionError("unsupported_format", "Feedback entries must be a sequence", false, { path: FEEDBACK_PATH });

  const persistedSource = feedbackSource(identity);
  const index = root.entries.findIndex((rawEntry) => rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry) &&
    (rawEntry as Record<string, unknown>).findingFingerprint === input.findingFingerprint &&
    feedbackSourceMatches((rawEntry as Record<string, unknown>).source, persistedSource));
  const existing = index >= 0 ? root.entries[index] as Record<string, unknown> : undefined;
  const sameAnnotation = existing?.annotation === input.annotation;
  if (existing?.decision === input.decision && sameAnnotation) throw new DiagnosticActionError("no_change", "This finding already has the requested decision");

  const stableTime = yield* host.request<{ timestamp: string }>("workspace.change.timestamp", {});
  if (!stableTime || typeof stableTime.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(stableTime.timestamp)) throw new DiagnosticActionError("storage_unknown", "Host returned an invalid stable change timestamp", true);
  const timestamp = stableTime.timestamp;
  if (index < 0) {
    const entry: Record<string, unknown> = {
      id: `feedback-${sha256(JSON.stringify([context.scope.repository_id, context.scope.branch, input.findingFingerprint, persistedSource])).slice(0, 40)}`,
      findingFingerprint: input.findingFingerprint,
      decision: input.decision,
      source: persistedSource,
      ...(typeof input.annotation === "string" ? { annotation: input.annotation } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    entriesNode.add(document.createNode(entry));
  } else {
    const rowNode = entriesNode.items[index];
    if (!isMap(rowNode)) throw new DiagnosticActionError("unsupported_format", `Feedback entry ${index} must be a mapping`, false, { path: FEEDBACK_PATH });
    rowNode.set("decision", input.decision);
    rowNode.set("updatedAt", timestamp);
    if (typeof input.annotation === "string") rowNode.set("annotation", input.annotation);
    else rowNode.delete("annotation");
    const sourceNode = rowNode.get("source", true);
    if (isMap(sourceNode)) for (const [field, value] of Object.entries(persistedSource)) sourceNode.set(field, value);
    else rowNode.set("source", document.createNode(persistedSource));
  }
  const after = document.toString({ lineWidth: 0 });
  if (new TextEncoder().encode(after).byteLength > MAX_FEEDBACK_BYTES) throw new DiagnosticActionError("capacity", "Proposed feedback file exceeds the Diagnostics limit", true);
  const content = yield* changeContent(host, context, FEEDBACK_PATH, after);
  const changeset = makeChangeSet({
    context, actionId: context.action_id, idempotencyKey: key, path: FEEDBACK_PATH, revision: feedbackRevision,
    before, after, title: "Diagnostics: record finding decision", reason: "Record an author decision for the exact analyzed source identity.",
    evidence: spans, content, read_set: [...readSet, { path: FEEDBACK_PATH, revision: feedbackRevision }],
  });
  const proposalId = yield* submitChangeSet(host, changeset, content.artifact_id);
  return { proposalId, feedbackPath: FEEDBACK_PATH, findingFingerprint: input.findingFingerprint, decision: input.decision, expectedRevision: feedbackRevision, snapshot: context.snapshot };
}

export const guest = createGuest("proprium.diagnostics", {
  "proprium.diagnostics.text.analyze.v1": remembering(textAnalyze),
  "proprium.diagnostics.scene.run.v1": remembering(sceneRun),
  "proprium.diagnostics.lint.run.v1": remembering(lintRun),
  "proprium.diagnostics.lint.propose.v1": lintPropose,
  "proprium.diagnostics.manuscript.format.propose.v1": manuscriptFormatPropose,
  "proprium.diagnostics.project.consistency.run.v1": remembering(projectConsistency),
  "proprium.diagnostics.project.continuity.run.v1": remembering(projectContinuity),
  "proprium.diagnostics.chapter.aspects.review.v1": remembering(chapterAspectsReview),
  "proprium.diagnostics.chapter.aspects.preview.v1": chapterAspectsPreview,
  "proprium.diagnostics.scene.plot-goal.check.v1": remembering(plotGoalCheck),
  "proprium.diagnostics.feedback.propose.v1": feedbackPropose,
});
