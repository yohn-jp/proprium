import YAML from "yaml";
import type { ActionRequest, ChangeUnit, ReadPrecondition } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { PairedError } from "./types.js";
import { invokeAction, readText, withStagingSnapshot } from "./host.js";
import { assertBoundedJson, filePath, identity, isRecord } from "./validation.js";
import { canonicalJson, sha256 } from "./sha256.js";
import { createContentReference } from "./artifact-content.js";

interface SourceEvidence {
  readonly id: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly range?: { readonly start: number; readonly end: number };
}
interface NarrativeSourceOperation extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly evidenceIds: string[];
}
interface SceneContextValue {
  readonly scene_id: string;
  readonly title: string;
  readonly metadata_path: string;
  readonly metadata_revision: string;
  readonly manuscript_path: string;
  readonly manuscript_revision: string;
}

const LEGACY_MANUSCRIPT_ID_PREFIX = "ms-";

function legacyManuscriptId(path: string): string {
  return `${LEGACY_MANUSCRIPT_ID_PREFIX}${path.slice("manuscript/".length).replace(/\//g, "-").replace(/\.md$/, "")}`;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

interface ParsedMarkdown {
  readonly prefix: string;
  readonly raw: Record<string, unknown>;
  readonly rawBody: string;
  readonly body: string;
  readonly leftTrim: number;
}

function parseMarkdown(text: string, path: string): ParsedMarkdown {
  const opening = /^---[ \t]*\r?\n/.exec(text);
  if (!opening) return { prefix: "", raw: {}, rawBody: text, body: text.trim(), leftTrim: text.length - text.trimStart().length };
  const delimiter = /^---[ \t]*\r?$/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(text);
  if (!closing) throw new PairedError("unsupported_format", `Unclosed manuscript frontmatter: ${path}`);
  let bodyStart = closing.index + closing[0].length;
  if (text.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (text.startsWith("\n", bodyStart)) bodyStart += 1;
  let raw: unknown;
  try { raw = YAML.parse(text.slice(opening[0].length, closing.index)); }
  catch { throw new PairedError("unsupported_format", `Invalid manuscript frontmatter: ${path}`); }
  if (raw !== null && !isRecord(raw)) throw new PairedError("unsupported_format", `Manuscript frontmatter must be a mapping: ${path}`);
  const rawBody = text.slice(bodyStart);
  assertBoundedJson(raw ?? {}, `frontmatter for ${path}`);
  return {
    prefix: text.slice(0, bodyStart),
    raw: (raw ?? {}) as Record<string, unknown>,
    rawBody,
    body: rawBody.trim(),
    leftTrim: rawBody.length - rawBody.trimStart().length,
  };
}

function legacyEntityRevision(raw: Record<string, unknown>, body: string): string {
  const hash = sha256(new TextEncoder().encode(canonicalJson({ raw, body })));
  return `\"sha256-${hash}\"`;
}

function evidenceSpan(
  evidence: SourceEvidence,
  manuscriptId: string,
  path: string,
  fileRevision: string,
  markdown: ParsedMarkdown,
): { path: string; revision: string; start: number; end: number; quote: string } | undefined {
  if (evidence.sourceKind !== "manuscript" || evidence.sourceId !== manuscriptId || evidence.range === undefined) return undefined;
  const sourceRevision = legacyEntityRevision(markdown.raw, markdown.body);
  if (evidence.revision !== sourceRevision && evidence.revision !== fileRevision) {
    throw new PairedError("snapshot_stale", `Evidence ${evidence.id} revision does not match the selected manuscript snapshot`);
  }
  const { start, end } = evidence.range;
  if (end > markdown.body.length) throw new PairedError("snapshot_stale", `Evidence ${evidence.id} range exceeds the source manuscript body`);
  return {
    path,
    revision: fileRevision,
    start: markdown.prefix.length + markdown.leftTrim + start,
    end: markdown.prefix.length + markdown.leftTrim + end,
    quote: markdown.body.slice(start, end),
  };
}

/** Compile one recovered manuscript.replace-range using its explicit Narrative link. */
export function* compileManuscriptReplacement(
  operation: NarrativeSourceOperation,
  sourceEvidence: readonly SourceEvidence[],
  sourceOperationIndex: number,
  changeSetId: string,
  host: GuestHost,
  request: ActionRequest,
  options: { readonly stagingSnapshot?: string; readonly baseReadSet?: readonly ReadPrecondition[]; readonly metadataPath?: string } = {},
): Generator<HostCall, { unit: ChangeUnit; read_set: ReadPrecondition[]; evidence: Array<{ path: string; revision: string; start: number; end: number; quote: string }>; temporary_artifacts: string[] }, unknown> {
  if (operation.kind !== "manuscript.replace-range") throw new PairedError("unsupported_schema", "Paired manuscript compiler received an unowned source operation");
  const target = operation.target as Record<string, unknown>;
  const sceneId = identity(target.sceneId, `operation ${operation.id}.target.sceneId`);
  const manuscriptId = identity(target.manuscriptId, `operation ${operation.id}.target.manuscriptId`);
  const scene = options.metadataPath === undefined
    ? yield* invokeAction<SceneContextValue>(host, request, "proprium.narrative", "proprium.narrative.scene.context", { scene_id: sceneId })
    : undefined;
  if (scene && scene.scene_id !== sceneId) throw new PairedError("scene_not_found", `Scene not found: ${sceneId}`);
  const metadataPath = filePath(options.metadataPath ?? scene!.metadata_path, "scene.metadata_path");
  const readRequest = options.stagingSnapshot === undefined ? request : withStagingSnapshot(request, options.stagingSnapshot);
  let path: string;
  let metadataBaseRevision: string | null;
  let manuscriptBaseRevision: string | null | undefined;
  if (options.stagingSnapshot === undefined) {
    path = filePath(scene!.manuscript_path, "scene.manuscript_path");
    metadataBaseRevision = identity(scene!.metadata_revision, "scene.metadata_revision");
  } else {
    const metadata = yield* readText(host, readRequest, metadataPath);
    let raw: unknown;
    try { raw = YAML.parse(metadata.text); }
    catch { throw new PairedError("unsupported_format", `Invalid staged scene metadata: ${metadataPath}`); }
    if (!isRecord(raw) || raw.id !== sceneId || typeof raw.manuscript !== "string") {
      throw new PairedError("unsupported_format", `Staged scene metadata does not contain its exact manuscript link: ${metadataPath}`);
    }
    path = filePath(raw.manuscript, "scene.manuscript");
    const stagedMetadataBase = options.baseReadSet?.find((entry) => entry.path === metadataPath);
    metadataBaseRevision = stagedMetadataBase ? stagedMetadataBase.revision : scene ? identity(scene.metadata_revision, "scene.metadata_revision") : null;
    manuscriptBaseRevision = originalRevision(options.baseReadSet, path);
  }
  if (!path.startsWith("manuscript/") || !path.endsWith(".md") || legacyManuscriptId(path) !== manuscriptId) {
    throw new PairedError("conflict", `Manuscript identity ${manuscriptId} is not the linked manuscript for scene ${sceneId}`, { source_operation_id: operation.id });
  }
  const file = yield* readText(host, readRequest, path);
  if (options.stagingSnapshot === undefined && file.revision !== scene!.manuscript_revision) throw new PairedError("snapshot_stale", "Narrative and Host returned different manuscript revisions");
  if (manuscriptBaseRevision === undefined) manuscriptBaseRevision = file.revision;
  const markdown = parseMarkdown(file.text, path);
  const precondition = operation.precondition as Record<string, unknown>;
  if (precondition.kind === "content-hash" && precondition.value !== fnv1a(markdown.body)) {
    throw new PairedError("snapshot_stale", `Manuscript body hash does not match source operation ${operation.id}`, { source_operation_id: operation.id });
  }
  if (precondition.kind === "revision" && precondition.value !== file.revision && precondition.value !== legacyEntityRevision(markdown.raw, markdown.body)) {
    throw new PairedError("snapshot_stale", `Manuscript revision does not match source operation ${operation.id}`, { source_operation_id: operation.id });
  }
  if (precondition.kind !== "content-hash" && precondition.kind !== "revision") {
    throw new PairedError("invalid_input", `Invalid manuscript precondition for source operation ${operation.id}`);
  }
  const range = operation.range as { start: number; end: number };
  if (range.end > markdown.body.length) throw new PairedError("invalid_input", `Manuscript range exceeds the selected body for source operation ${operation.id}`);

  const replacement = String(operation.replacement);
  const bodyStart = markdown.leftTrim + range.start;
  const bodyEnd = markdown.leftTrim + range.end;
  const updatedText = markdown.prefix + markdown.rawBody.slice(0, bodyStart) + replacement + markdown.rawBody.slice(bodyEnd);
  const contentReference = yield* createContentReference(host, request, path, updatedText);
  const operationContent = "content" in contentReference ? { content: contentReference.content } : { content_artifact: contentReference.content_artifact };
  const temporaryArtifactId = "artifact_id" in contentReference ? contentReference.artifact_id : undefined;
  const operationId = `${changeSetId}/op/${sourceOperationIndex + 1}`;
  const unitId = `${changeSetId}/unit/${sourceOperationIndex + 1}`;
  const evidence = sourceEvidence.flatMap((item) => {
    if (!operation.evidenceIds.includes(item.id)) return [];
    if (item.range !== undefined && item.sourceKind !== "manuscript") {
      throw new PairedError("dependency_unavailable", `Cannot verify ranged ${item.sourceKind} evidence ${item.id} in the Paired manuscript compiler`);
    }
    if (item.sourceKind === "manuscript" && item.sourceId !== manuscriptId && item.range !== undefined) {
      throw new PairedError("dependency_unavailable", `Cannot resolve manuscript evidence ${item.id} outside the target scene`);
    }
    const mapped = evidenceSpan(item, manuscriptId, path, file.revision, markdown);
    if (item.range !== undefined && item.sourceKind === "manuscript" && item.sourceId === manuscriptId && !mapped) {
      throw new PairedError("invalid_input", `Could not map manuscript evidence ${item.id}`);
    }
    if (mapped && file.text.slice(mapped.start, mapped.end) !== mapped.quote) throw new PairedError("snapshot_stale", `Evidence ${item.id} no longer matches the manuscript bytes`);
    return mapped ? [mapped] : [];
  });
  const unit: ChangeUnit = {
    id: unitId,
    label: `Replace manuscript range for ${operation.id}`,
    depends_on: [],
    source_operation_ids: [operation.id],
    operations: [{
      id: operationId,
      path,
      kind: manuscriptBaseRevision === null ? "create" : "replace",
      expected_revision: manuscriptBaseRevision,
      ...operationContent,
    }],
  };
  return { unit, read_set: [{ path, revision: manuscriptBaseRevision }, { path: metadataPath, revision: metadataBaseRevision }], evidence,
    temporary_artifacts: temporaryArtifactId ? [temporaryArtifactId] : [] };
}

function originalRevision(readSet: readonly ReadPrecondition[] | undefined, path: string): string | null | undefined {
  return readSet?.find((entry) => entry.path === path)?.revision;
}
