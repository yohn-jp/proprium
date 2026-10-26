import type { ActionRequest, ChangeSet } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { propose } from "../../shared/operations.js";
import { PairedError } from "./types.js";
import { invokeAction, readText } from "./host.js";
import { buildRewriteFallbackSuggestions, buildRewriteLocalSuggestions } from "./rewrite-local.js";
import { exactKeys, filePath, finiteInteger, identity, record } from "./validation.js";
import { canonicalJson, sha256 } from "./sha256.js";
import { createContentReference, discardTemporaryArtifact } from "./artifact-content.js";

function span(input: unknown, text: string) {
  const selection = record(input, "selection");
  exactKeys(selection, ["start", "end", "text"], "selection");
  const start = finiteInteger(selection.start, "selection.start", 0, text.length);
  const end = finiteInteger(selection.end, "selection.end", start, text.length);
  if (typeof selection.text !== "string" || selection.text.length > 20_000 || end - start !== selection.text.length) {
    throw new PairedError("invalid_input", "Selection range and text length do not match");
  }
  if (text.slice(start, end) !== selection.text) {
    throw new PairedError("snapshot_stale", "Selected text does not match the pinned manuscript revision");
  }
  return { start, end, text: selection.text };
}

type SuggestInput = { sceneId: string; manuscriptRevision: string; selection: unknown; instruction?: string };
type ProposeInput = { sceneId: string; manuscriptPath: string; manuscriptRevision: string; selection: unknown; replacement: string; rationale: string; evidence: unknown[] };

function validateRewriteInput(input: unknown, includeInstruction: true): SuggestInput;
function validateRewriteInput(input: unknown, includeInstruction: false): ProposeInput;
function validateRewriteInput(input: unknown, includeInstruction: boolean): SuggestInput | ProposeInput {
  const row = record(input, "input");
  exactKeys(row, includeInstruction
    ? ["sceneId", "manuscriptRevision", "selection", "instruction"]
    : ["sceneId", "manuscriptPath", "manuscriptRevision", "selection", "replacement", "rationale", "evidence"], "input");
  const sceneId = identity(row.sceneId, "sceneId");
  const manuscriptRevision = identity(row.manuscriptRevision, "manuscriptRevision");
  if (includeInstruction) {
    if (row.instruction !== undefined && (typeof row.instruction !== "string" || row.instruction.length > 4_000)) {
      throw new PairedError("invalid_input", "instruction must be at most 4,000 characters");
    }
    return { sceneId, manuscriptRevision, selection: row.selection, ...(row.instruction === undefined ? {} : { instruction: row.instruction as string }) };
  }
  const manuscriptPath = filePath(row.manuscriptPath, "manuscriptPath");
  if (typeof row.replacement !== "string" || row.replacement.length > 100_000) {
    throw new PairedError("invalid_input", "replacement must be at most 100,000 characters");
  }
  if (typeof row.rationale !== "string" || row.rationale.length > 2_000) {
    throw new PairedError("invalid_input", "rationale must be at most 2,000 characters");
  }
  if (!Array.isArray(row.evidence) || row.evidence.length < 1 || row.evidence.length > 8) {
    throw new PairedError("invalid_input", "evidence must contain 1 to 8 source spans");
  }
  return { sceneId, manuscriptPath, manuscriptRevision, selection: row.selection, replacement: row.replacement, rationale: row.rationale, evidence: row.evidence };
}

interface SceneValue {
  readonly scene_id: string;
  readonly title: string;
  readonly metadata_path: string;
  readonly metadata_revision: string;
  readonly manuscript_path: string;
  readonly manuscript_revision: string;
  readonly diagnostics: readonly unknown[];
}
interface PinnedFile {
  readonly path: string;
  readonly revision: string;
  readonly text: string;
  readonly total_bytes: number;
}

function* selectedSource(input: unknown, host: GuestHost, request: ActionRequest, includeInstruction: boolean): Generator<HostCall, { parsed: SuggestInput | ProposeInput; scene: SceneValue; manuscript: PinnedFile; selection: { start: number; end: number; text: string } }, unknown> {
  const parsed = validateRewriteInput(input, includeInstruction as true) as SuggestInput | ProposeInput;
  const scene = yield* invokeAction<SceneValue>(host, request, "proprium.narrative", "proprium.narrative.scene.context", { scene_id: parsed.sceneId });
  if (!scene || scene.scene_id !== parsed.sceneId) throw new PairedError("scene_not_found", `Scene not found: ${parsed.sceneId}`);
  if (scene.manuscript_revision !== parsed.manuscriptRevision) throw new PairedError("snapshot_stale", "Manuscript revision changed since the selection was made");
  const path = filePath(scene.manuscript_path, "scene.manuscript_path");
  if ("manuscriptPath" in parsed && parsed.manuscriptPath !== path) throw new PairedError("invalid_path", "The supplied path does not match the scene's explicit manuscript link");
  const manuscript = yield* readText(host, request, path);
  if (manuscript.revision !== parsed.manuscriptRevision) throw new PairedError("snapshot_stale", "Manuscript bytes do not match the requested revision");
  return { parsed, scene, manuscript, selection: span(parsed.selection, manuscript.text) };
}

export function* suggestRewrite(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, Record<string, unknown>, unknown> {
  const source = yield* selectedSource(input, host, request, true);
  const sentence = source.selection.text;
  const candidates = buildRewriteFallbackSuggestions({ sentence });
  if (candidates.length !== 3 || new Set(candidates.map((candidate) => candidate.text)).size !== 3) {
    throw new PairedError("unsupported_format", "The local rewrite fallback could not produce three distinct candidates");
  }
  const local = buildRewriteLocalSuggestions(sentence);
  const sourceSpan = {
    path: source.manuscript.path,
    revision: source.manuscript.revision,
    start: source.selection.start,
    end: source.selection.end,
    quote: sentence,
  };
  return {
    sceneId: source.scene.scene_id,
    selection: { start: source.selection.start, end: source.selection.end, text: sentence },
    suggestions: candidates,
    ...(local.sentenceSplit ? { sentenceSplit: local.sentenceSplit } : {}),
    ...(local.tellToShow ? { tellToShow: local.tellToShow } : {}),
    citations: [sourceSpan],
    sourceRevisions: [
      { path: source.scene.metadata_path, revision: source.scene.metadata_revision },
      { path: source.manuscript.path, revision: source.manuscript.revision },
    ],
    provenance: {
      snapshot: request.snapshot,
      provider: "local",
      model: "scriptorium-rewrite-heuristics",
      modelVersion: "source-heuristic-v1",
      promptVersion: "rewrite@1:local-fallback-v1",
      promptReceivedByExternalHost: false,
      instruction_included: Boolean((source.parsed as SuggestInput).instruction),
      generatedAt: null,
    },
  };
}

export function* proposeRewrite(input: unknown, host: GuestHost, request: ActionRequest): Generator<HostCall, { proposal_id: string; preview: unknown }, unknown> {
  if (!request.idempotency_key) throw new PairedError("invalid_input", "The Host must provide an idempotency key for a proposal");
  const source = yield* selectedSource(input, host, request, false);
  const proposal = source.parsed as ProposeInput;
  if (proposal.replacement === source.selection.text) throw new PairedError("invalid_input", "Replacement is unchanged");
  const evidence = proposal.evidence.map((item, index) => {
    const row = record(item, `evidence[${index}]`);
    exactKeys(row, ["path", "revision", "start", "end", "quote"], `evidence[${index}]`);
    if (filePath(row.path, `evidence[${index}].path`) !== source.manuscript.path || row.revision !== source.manuscript.revision ||
        row.start !== source.selection.start || row.end !== source.selection.end || row.quote !== source.selection.text) {
      throw new PairedError("snapshot_stale", `Evidence ${index} does not identify the selected text in the pinned source`);
    }
    return { path: row.path as string, revision: row.revision as string, start: row.start as number, end: row.end as number, quote: row.quote as string };
  });
  const updated = source.manuscript.text.slice(0, source.selection.start) + proposal.replacement + source.manuscript.text.slice(source.selection.end);
  const changeSetId = `paired-cs-${sha256(new TextEncoder().encode(canonicalJson([
    request.scope.workspace_id, request.scope.generation, "paired.rewrite.propose", request.idempotency_key,
  ])))}`;
  const contentReference = yield* createContentReference(host, request, source.manuscript.path, updated);
  const operationContent = "content" in contentReference ? { content: contentReference.content } : { content_artifact: contentReference.content_artifact };
  const temporaryArtifactId = "artifact_id" in contentReference ? contentReference.artifact_id : undefined;
  const operationId = `${changeSetId}/op/1`;
  const changeSet: ChangeSet = {
    id: changeSetId,
    idempotency_key: request.idempotency_key,
    scope: request.scope,
    snapshot: request.snapshot,
    title: `Rewrite selection in ${source.scene.title}`,
    reason: proposal.rationale,
    read_set: [
      { path: source.scene.metadata_path, revision: source.scene.metadata_revision },
      { path: source.manuscript.path, revision: source.manuscript.revision },
    ],
    units: [{
      id: `${changeSetId}/unit/1`,
      label: "Replace the selected passage",
      depends_on: [],
      source_operation_ids: [operationId],
      operations: [{
        id: operationId,
        kind: "replace",
        path: source.manuscript.path,
        expected_revision: source.manuscript.revision,
        ...operationContent,
      }],
    }],
    evidence,
  };
  try {
    return yield* propose(host, changeSet) as Generator<HostCall, { proposal_id: string; preview: unknown }, unknown>;
  } catch (error) {
    if (temporaryArtifactId && (error as { code?: string })?.code !== "storage_unknown") {
      try { yield* discardTemporaryArtifact(host, temporaryArtifactId); } catch { /* Host cleanup also releases abandoned request artifacts. */ }
    }
    throw error;
  }
}
