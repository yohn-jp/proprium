import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { PairedError } from "./types.js";
import { cacheGet, cachePut, invokeAction, readText } from "./host.js";
import { byteLength, countUnicodeScalars, exactKeys, filePath, finiteInteger, identity, record } from "./validation.js";

const MAX_CONTEXT_CHARACTERS = 50_000;
const MAX_SELECTION_CHARACTERS = 5_000;

type PairedHost = GuestHost;
interface ExplicitDraftRef {
  readonly document_path: string;
  readonly revision: string;
  readonly base_snapshot: string;
  readonly base_scene_revision: string;
  readonly draft_generation: string;
  readonly confirmed: true;
}
interface DraftRead extends ExplicitDraftRef {
  readonly path: string;
  readonly text: string;
  readonly total_bytes: number;
}

export interface ContextPart {
  readonly id: string;
  readonly kind: "scene" | "saved_manuscript" | "selection" | "draft";
  readonly identity: Readonly<Record<string, unknown>>;
  readonly path: string | null;
  readonly revision: string | null;
  readonly content: string;
  readonly source_character_count: number;
  readonly included_character_count: number;
  readonly included_byte_count: number;
  readonly token_count: null;
  readonly token_count_status: "not_measured";
  readonly inclusion_reason: string;
  readonly included: boolean;
  readonly truncated: boolean;
  readonly freshness: "current";
  readonly consent: "local" | "explicit";
  readonly origin: "saved" | "explicitly_shared_selection" | "explicitly_shared_draft";
}

export interface WritingContextSnapshot {
  readonly context_id: string;
  readonly scope: ActionRequest["scope"];
  readonly snapshot: ActionRequest["snapshot"];
  readonly target: {
    readonly work_id?: string;
    readonly scene_id: string;
    readonly scene_title: string;
    readonly metadata_path: string;
    readonly metadata_revision: string;
    readonly manuscript_path: string;
    readonly manuscript_revision: string;
  };
  readonly parts: readonly ContextPart[];
  readonly draft: { readonly status: "not_shared" } | { readonly status: "explicitly_shared"; readonly revision: string; readonly draft_generation: string };
}

interface SceneContextValue {
  readonly scene_id: string;
  readonly title: string;
  readonly volume: { readonly id: string; readonly title: string };
  readonly chapter: { readonly id: string; readonly title: string };
  readonly metadata_path: string;
  readonly manuscript_path: string;
  readonly metadata_revision: string;
  readonly manuscript_revision: string;
  readonly diagnostics: readonly unknown[];
}

function validateRange(raw: unknown, text: string) {
  const selection = record(raw, "selection");
  exactKeys(selection, ["start", "end", "text"], "selection");
  const start = finiteInteger(selection.start, "selection.start", 0, text.length);
  const end = finiteInteger(selection.end, "selection.end", start, text.length);
  if (typeof selection.text !== "string" || selection.text.length > MAX_SELECTION_CHARACTERS || end - start !== selection.text.length) {
    throw new PairedError("invalid_input", "Selection range and text length do not match");
  }
  if (text.slice(start, end) !== selection.text) {
    throw new PairedError("snapshot_stale", "Selection text does not match the pinned manuscript revision");
  }
  return { start, end, text: selection.text };
}

function explicitDraftRef(value: unknown): ExplicitDraftRef {
  const row = record(value, "shareDraft");
  exactKeys(row, ["document_path", "revision", "base_snapshot", "base_scene_revision", "draft_generation", "confirmed"], "shareDraft");
  if (row.confirmed !== true) throw new PairedError("capability_denied", "Sharing the current draft requires explicit author confirmation");
  return {
    document_path: filePath(row.document_path, "shareDraft.document_path"),
    revision: identity(row.revision, "shareDraft.revision"),
    base_snapshot: identity(row.base_snapshot, "shareDraft.base_snapshot"),
    base_scene_revision: identity(row.base_scene_revision, "shareDraft.base_scene_revision"),
    draft_generation: identity(row.draft_generation, "shareDraft.draft_generation"),
    confirmed: true,
  };
}

function makePart(input: Omit<ContextPart, "source_character_count" | "included_character_count" | "included_byte_count" | "token_count" | "token_count_status" | "truncated" | "freshness"> & { readonly sourceText: string; readonly included: boolean; readonly truncated?: boolean }): ContextPart {
  const includedText = input.included ? input.content : "";
  return {
    id: input.id,
    kind: input.kind,
    identity: input.identity,
    path: input.path,
    revision: input.revision,
    content: includedText,
    source_character_count: countUnicodeScalars(input.sourceText),
    included_character_count: countUnicodeScalars(includedText),
    included_byte_count: byteLength(includedText),
    token_count: null,
    token_count_status: "not_measured",
    inclusion_reason: input.inclusion_reason,
    included: input.included,
    truncated: input.truncated ?? false,
    freshness: "current",
    consent: input.consent,
    origin: input.origin,
  };
}

function cacheKey(requestId: string): string {
  return `writing-context/${requestId}`;
}

/** Snapshot-bound context assembly using Narrative's explicit scene/manuscript link. */
export function* captureContext(
  input: unknown,
  host: PairedHost,
  request: ActionRequest,
): Generator<HostCall, WritingContextSnapshot, unknown> {
  const row = record(input, "input");
  exactKeys(row, ["target", "range", "include", "shareDraft"], "input");
  const target = record(row.target, "target");
  exactKeys(target, ["sceneId"], "target");
  const sceneId = identity(target.sceneId, "target.sceneId");
  const included = row.include === undefined ? ["scene", "saved_manuscript", ...(row.range === undefined ? [] : ["selection"])] : row.include;
  if (!Array.isArray(included) || included.length > 4 || new Set(included).size !== included.length ||
      included.some((kind) => !["scene", "saved_manuscript", "selection", "draft"].includes(String(kind)))) {
    throw new PairedError("invalid_input", "include must contain unique supported context source kinds");
  }
  if (included.includes("selection") && row.range === undefined) throw new PairedError("invalid_input", "A selection context requires an exact range");
  if (row.range !== undefined && !included.includes("selection")) throw new PairedError("invalid_input", "A supplied range must be explicitly included");
  if (included.includes("draft") !== (row.shareDraft !== undefined)) throw new PairedError("invalid_input", "Draft context requires both draft inclusion and an explicit draft reference");

  const scene = yield* invokeAction<SceneContextValue>(host, request, "proprium.narrative", "proprium.narrative.scene.context", { scene_id: sceneId });
  if (!scene || scene.scene_id !== sceneId) throw new PairedError("scene_not_found", `Scene not found in the pinned workspace: ${sceneId}`);
  const metadataPath = filePath(scene.metadata_path, "scene.metadata_path");
  const manuscriptPath = filePath(scene.manuscript_path, "scene.manuscript_path");
  const metadataRevision = identity(scene.metadata_revision, "scene.metadata_revision");
  const manuscriptRevision = identity(scene.manuscript_revision, "scene.manuscript_revision");
  let manuscript: DraftRead;
  let liveDraft: DraftRead | undefined;
  if (row.shareDraft === undefined) {
    const saved = yield* readText(host, request, manuscriptPath);
    if (saved.revision !== manuscriptRevision) throw new PairedError("snapshot_stale", "Narrative and Host returned different manuscript revisions");
    manuscript = { path: saved.path, revision: saved.revision, text: saved.text, total_bytes: saved.total_bytes,
      document_path: manuscriptPath, base_snapshot: request.snapshot.id, base_scene_revision: metadataRevision,
      draft_generation: "", confirmed: true };
  } else {
    const reference = explicitDraftRef(row.shareDraft);
    if (!request.snapshot.draft_generation || reference.draft_generation !== request.snapshot.draft_generation ||
        reference.document_path !== manuscriptPath || reference.base_scene_revision !== metadataRevision) {
      throw new PairedError("snapshot_stale", "Draft lease is not bound to this Host-issued snapshot and selected scene");
    }
    const savedRequest: ActionRequest = { ...request, snapshot: { ...request.snapshot, id: reference.base_snapshot, draft_generation: null } };
    const saved = yield* readText(host, savedRequest, manuscriptPath);
    if (saved.revision !== manuscriptRevision) throw new PairedError("snapshot_stale", "Draft base revision changed since the Host created its saved-base manifest");
    const live = yield* readText(host, request, manuscriptPath);
    if (live.revision !== reference.revision) throw new PairedError("snapshot_stale", "Host draft lease changed while context was captured");
    manuscript = { ...saved, document_path: manuscriptPath, base_snapshot: reference.base_snapshot,
      base_scene_revision: metadataRevision, draft_generation: reference.draft_generation, confirmed: true };
    liveDraft = { ...live, document_path: manuscriptPath, base_snapshot: reference.base_snapshot,
      base_scene_revision: metadataRevision, draft_generation: reference.draft_generation, confirmed: true };
  }

  const parts: ContextPart[] = [];
  const sceneText = JSON.stringify({ id: scene.scene_id, title: scene.title, volume: scene.volume, chapter: scene.chapter });
  parts.push(makePart({
    id: "scene", kind: "scene", identity: { scene_id: scene.scene_id, volume_id: scene.volume.id, chapter_id: scene.chapter.id },
    path: metadataPath, revision: metadataRevision, content: sceneText, sourceText: sceneText,
    inclusion_reason: "Requested scene identity and structural breadcrumbs", included: included.includes("scene"),
    consent: "local", origin: "saved",
  }));

  const savedText = manuscript.text.length > MAX_CONTEXT_CHARACTERS ? manuscript.text.slice(0, MAX_CONTEXT_CHARACTERS) : manuscript.text;
  parts.push(makePart({
    id: "saved-manuscript", kind: "saved_manuscript", identity: { scene_id: scene.scene_id, manuscript_path: manuscriptPath },
    path: manuscriptPath, revision: manuscript.revision, content: savedText, sourceText: manuscript.text,
    inclusion_reason: included.includes("saved_manuscript") ? "Requested saved scene manuscript" : "Saved scene manuscript omitted by request",
    included: included.includes("saved_manuscript"), truncated: included.includes("saved_manuscript") && savedText.length < manuscript.text.length,
    consent: "local", origin: "saved",
  }));

  if (row.range !== undefined) {
    const selectionSource = liveDraft ?? manuscript;
    const range = validateRange(row.range, selectionSource.text);
    parts.push(makePart({
      id: "selection", kind: "selection", identity: { scene_id: scene.scene_id, start: range.start, end: range.end },
      path: manuscriptPath, revision: selectionSource.revision, content: range.text, sourceText: range.text,
      inclusion_reason: "Explicitly provided as the selected passage", included: true,
      consent: "explicit", origin: "explicitly_shared_selection",
    }));
  }

  let draft: WritingContextSnapshot["draft"] = { status: "not_shared" };
  if (liveDraft) {
    const boundedDraft = liveDraft.text.length > MAX_CONTEXT_CHARACTERS ? liveDraft.text.slice(0, MAX_CONTEXT_CHARACTERS) : liveDraft.text;
    parts.push(makePart({
      id: "draft", kind: "draft", identity: { scene_id: scene.scene_id, manuscript_path: manuscriptPath, base_snapshot: liveDraft.base_snapshot },
      path: manuscriptPath, revision: liveDraft.revision, content: boundedDraft, sourceText: liveDraft.text,
      inclusion_reason: "Explicitly shared current unsaved editor draft", included: true,
      truncated: boundedDraft.length < liveDraft.text.length, consent: "explicit", origin: "explicitly_shared_draft",
    }));
    draft = { status: "explicitly_shared", revision: liveDraft.revision, draft_generation: liveDraft.draft_generation };
  }

  const context: WritingContextSnapshot = {
    context_id: request.request_id,
    scope: request.scope,
    snapshot: request.snapshot,
    target: {
      scene_id: scene.scene_id,
      scene_title: scene.title,
      metadata_path: metadataPath,
      metadata_revision: metadataRevision,
      manuscript_path: manuscriptPath,
      manuscript_revision: manuscriptRevision,
    },
    parts,
    draft,
  };
  yield* cachePut(host, request, cacheKey(request.request_id), context);
  return context;
}

export function* readContextManifest(input: unknown, host: PairedHost, request: ActionRequest): Generator<HostCall, Record<string, unknown>, unknown> {
  const row = record(input, "input");
  exactKeys(row, ["contextId"], "input");
  const id = identity(row.contextId, "contextId");
  const context = yield* cacheGet<WritingContextSnapshot>(host, request, cacheKey(id));
  if (!context) throw new PairedError("file_not_found", "Writing context is no longer available; capture it again");
  if (context.snapshot.id !== request.snapshot.id || context.scope.workspace_id !== request.scope.workspace_id ||
      context.scope.generation !== request.scope.generation || context.scope.branch !== request.scope.branch ||
      context.scope.repository_id !== request.scope.repository_id) {
    throw new PairedError("snapshot_stale", "Writing context belongs to a different pinned workspace snapshot");
  }
  return {
    context_id: context.context_id,
    scope: context.scope,
    snapshot: context.snapshot,
    external_host_final_prompt_observed: false,
    draft: context.draft,
    parts: context.parts.map(({ content: _content, ...part }) => part),
  };
}
