import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { invokeAction, readNarrativeScene, readText } from "./host.js";
import { PairedError } from "./types.js";
import { sha256 } from "./sha256.js";
import { exactKeys, identity, record } from "./validation.js";

export type Generated = { text: string; provenance: { provider: string; model: string; promptVersion: string; requestId: string; untrusted: true } };
export type GenerateProvider = (host: GuestHost, request: ActionRequest, input: {
  feature: string; prompt: string; promptVersion: string; maxOutputTokens: number; sourceManifest?: unknown;
}) => Generator<HostCall, Generated, unknown>;
export type StateEventCandidate = { kind: "location" | "acquaintance" | "ownership" | "knowledge"; target: string; operation: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; object: string | null;
  payload: Record<string, unknown>; evidence: { path: string; revision: string; start: number; end: number; quote: string }; confidence: 0.5 };
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 4096;

/** Validate provider JSON and retain only unique exact source quotes with UTF-16 offsets. */
function manuscriptBodyOffset(text: string): number {
  const opening = /^---[ \t]*\r?\n/u.exec(text);
  if (!opening) return 0;
  const delimiter = /^---[ \t]*\r?$/gmu; delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(text);
  if (!closing) throw new PairedError("unsupported_format", "Manuscript frontmatter has no closing delimiter");
  const end = closing.index + closing[0].length;
  return end + (text.startsWith("\r\n", end) ? 2 : text.startsWith("\n", end) ? 1 : 0);
}
export function parseStateEventCandidates(output: string, source: { path: string; revision: string; text: string }): {
  events: StateEventCandidate[]; diagnostics: Array<{ code: string; index: number; message: string }>;
} {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/iu, "").replace(/```\s*$/u, "").trim();
  const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned;
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch { throw new PairedError("invalid_input", "Provider did not return valid state-event JSON"); }
  if (!obj(parsed) || !Array.isArray(parsed.events)) throw new PairedError("invalid_input", "Provider state events must be an array");
  if (parsed.events.length > 20) throw new PairedError("capacity", "At most 20 state events are accepted");
  const bodyOffset = manuscriptBodyOffset(source.text);
  const events: StateEventCandidate[] = [], diagnostics: Array<{ code: string; index: number; message: string }> = [];
  parsed.events.forEach((value, index) => {
    if (!obj(value) || !["location", "acquaintance", "ownership", "knowledge"].includes(String(value.kind)) ||
        !nonempty(value.target) || !nonempty(value.operation) || !(value.before === null || obj(value.before)) ||
        !(value.after === null || obj(value.after)) || !(value.object === null || nonempty(value.object)) ||
        !(value.payload === undefined || obj(value.payload)) || !nonempty(value.evidenceQuote)) {
      throw new PairedError("invalid_input", `Provider state event ${index + 1} is malformed`);
    }
    const quote = value.evidenceQuote, start = source.text.indexOf(quote);
    if (start < bodyOffset || source.text.indexOf(quote, start + 1) >= 0) {
      diagnostics.push({ code: "unverified_evidence", index, message: "Quote is missing or occurs more than once in the manuscript" }); return;
    }
    events.push({ kind: value.kind as StateEventCandidate["kind"], target: value.target, operation: value.operation,
      before: value.before as Record<string, unknown> | null, after: value.after as Record<string, unknown> | null,
      object: value.object as string | null, payload: (value.payload ?? {}) as Record<string, unknown>,
      evidence: { path: source.path, revision: source.revision, start, end: start + quote.length, quote }, confidence: 0.5 });
  });
  return { events, diagnostics };
}

function* prepareStateEvents(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, {
  prompt: string; promptVersion: string; provider_invoked: false; sources: Array<{ path: string; revision: string }>;
  manuscript: { path: string; revision: string; text: string };
}, unknown> {
  const row = record(input, "input"); exactKeys(row, ["sceneId"], "input"); const sceneId = identity(row.sceneId, "sceneId");
  const scene = yield* readNarrativeScene(host, request, sceneId);
  const manuscript = yield* readText(host, request, scene.manuscript_path);
  if (manuscript.revision !== scene.manuscript_revision) throw new PairedError("snapshot_stale", "Manuscript changed");
  const state = yield* invokeAction<unknown>(host, request, "proprium.knowledge", "knowledge.world-state.at-scene", { sceneId });
  const previous = JSON.stringify(state, null, 2).slice(0, 8000);
  const front = /^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/u.exec(manuscript.text);
  const body = manuscript.text.slice(front?.[0].length ?? 0).trim();
  const prompt = ["あなたは小説執筆支援アシスタントです。\n主張には根拠の引用を付けてください。引用できない内容は断言しないでください。\n出力は日本語で行ってください。",
    "原稿から客観的な状態変化だけを抽出してください。推測は禁止し、変化が無ければ events: [] を返してください。",
    "各 event は kind, target, operation, before, after, object, payload, evidenceQuote を返します。before/after はオブジェクトか null。evidenceQuote は本文中の連続した完全一致の引用です。人物の信念、読者への開示、将来予測は出力しません。",
    `sceneId: ${sceneId}`, `直前の確定状態: ${previous}`, `本文:\n${body}`,
    'JSONのみを返してください。スキーマ: {"events":[{"kind":"location|acquaintance|ownership|knowledge","target":"entity-id","operation":"...","before":{},"after":{},"object":"entity-id|null","payload":{},"evidenceQuote":"exact quote"}]}'].join("\n\n");
  if (new TextEncoder().encode(prompt).byteLength > 768 * 1024) throw new PairedError("capacity", "State-event prompt exceeds the bounded output size");
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) { hash ^= body.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  const promptVersion = `state-event-extraction:v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  return { prompt, promptVersion, provider_invoked: false,
    sources: [{ path: scene.metadata_path, revision: scene.metadata_revision }, { path: manuscript.path, revision: manuscript.revision }],
    manuscript: { path: manuscript.path, revision: manuscript.revision, text: manuscript.text } };
}

export function* previewStateEvents(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  const prepared = yield* prepareStateEvents(input, host, request);
  return { prompt: prepared.prompt, promptVersion: prepared.promptVersion, provider_invoked: false, sources: prepared.sources };
}

export function* suggestStateEvents(input: unknown, host: GuestHost, request: ActionRequest, generate: GenerateProvider): Generator<HostCall, unknown, unknown> {
  const preview = yield* prepareStateEvents(input, host, request);
  const generated = yield* generate(host, request, { feature: "state-event-draft", prompt: preview.prompt,
    promptVersion: preview.promptVersion, maxOutputTokens: 1024, sourceManifest: preview.sources });
  return { sceneId: (input as { sceneId: string }).sceneId, ...parseStateEventCandidates(generated.text, preview.manuscript),
    citations: preview.sources, provenance: generated.provenance };
}

/** Hand the author's selected, revalidated candidate to Knowledge; Paired does not write state files. */
export function* proposeStateEvent(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, unknown, unknown> {
  const args = record(input, "input"); exactKeys(args, ["sceneId", "candidate"], "input");
  const sceneId = identity(args.sceneId, "sceneId");
  const candidate = record(args.candidate, "candidate");
  exactKeys(candidate, ["kind", "target", "operation", "before", "after", "object", "payload", "evidence", "confidence"], "candidate");
  if (candidate.confidence !== 0.5) throw new PairedError("invalid_input", "State event confidence must be 0.5");
  const evidence = record(candidate.evidence, "candidate.evidence");
  exactKeys(evidence, ["path", "revision", "start", "end", "quote"], "candidate.evidence");
  const scene = yield* readNarrativeScene(host, request, sceneId);
  const file = yield* readText(host, request, scene.manuscript_path);
  if (file.revision !== scene.manuscript_revision || evidence.path !== file.path || evidence.revision !== file.revision) throw new PairedError("snapshot_stale", "State evidence source changed");
  const verified = parseStateEventCandidates(JSON.stringify({ events: [{ ...candidate, evidence: undefined, confidence: undefined, evidenceQuote: evidence.quote }] }), file);
  const event = verified.events[0];
  if (!event || verified.diagnostics.length || event.evidence.start !== evidence.start || event.evidence.end !== evidence.end) throw new PairedError("snapshot_stale", "State evidence no longer matches the unique manuscript span");
  const bodyOffset = manuscriptBodyOffset(file.text); const body = file.text.slice(bodyOffset);
  const manuscriptHash = sha256(new TextEncoder().encode(body));
  return yield* invokeAction(host, request, "proprium.knowledge", "knowledge.state-proposals.create", {
    sceneId, expectedSceneRevision: scene.metadata_revision, manuscriptHash,
    event: { kind: event.kind, subject: event.target, object: event.object,
      payload: { ...event.payload, operation: event.operation, before: event.before, after: event.after }, confidence: 0.5,
      evidence: [{ sceneId, excerpt: event.evidence.quote, startOffset: event.evidence.start - bodyOffset, endOffset: event.evidence.end - bodyOffset }] },
  });
}
