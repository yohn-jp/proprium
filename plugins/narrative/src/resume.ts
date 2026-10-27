import { stringify } from "yaml";
import type { ActionRequest, NarrativeHost, ProposalValue } from "./contracts.js";
import type { HostCall } from "../../shared/guest.js";
import { fail } from "./errors.js";
import { readFileRevision, readTextFile, fileOperation, propose } from "./actions.js";
import { readWorkSnapshot, validateManuscriptPath, type MetadataFile, type WorkSnapshot } from "./workspace.js";
import { parseYamlRecord, updateYamlSequenceMapFields, appendYamlSequenceValue } from "./yaml-source.js";

const MARKER_PATH = "meta/proprium/plugins/proprium.narrative/resume.v1.yaml";
type Row = Record<string, unknown>;
type Marker = {
  deviceId: string;
  repositoryId: number;
  branch: string;
  sceneId: string;
  manuscriptPath: string;
  manuscriptRevision: string;
  sentenceIndex: number | null;
  scrollTop: number;
  updatedAt: string;
  [key: string]: unknown;
};
type IdentityResult = {
  device_id: string;
  legacy_project_ids: string[];
  publication?: {
    remote_commit: string | null;
    files: Array<{ path: string; revision: string | null; remote_confirmed: boolean }>;
  };
};

function record(value: unknown, label: string): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("invalid_input", `${label} must be an object`);
  return value as Row;
}
function exactKeys(value: Row, allowed: string[], required: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("invalid_input", `Unknown ${label} field: ${key}`);
  for (const key of required) if (!(key in value)) fail("invalid_input", `Missing ${label} field: ${key}`);
}
function inputString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid_input", `${name} must be a non-empty string`);
  return value;
}
function validateIdentity(value: unknown): IdentityResult {
  const row = record(value, "workspace.identity.read result");
  if (typeof row.device_id !== "string" || !row.device_id || row.device_id.length > 256 ||
      !Array.isArray(row.legacy_project_ids) || row.legacy_project_ids.some((id) => typeof id !== "string")) {
    fail("invalid_input", "Host returned an invalid workspace identity");
  }
  let publication: IdentityResult["publication"];
  if (row.publication !== undefined) {
    const raw = record(row.publication, "workspace.identity.read publication");
    if (!(raw.remote_commit === null || typeof raw.remote_commit === "string") || !Array.isArray(raw.files)) {
      fail("invalid_input", "Host returned invalid publication provenance");
    }
    const files = raw.files.map((value) => {
      const file = record(value, "workspace.identity.read publication file");
      if (typeof file.path !== "string" || !(file.revision === null || typeof file.revision === "string") || typeof file.remote_confirmed !== "boolean") {
        fail("invalid_input", "Host returned invalid file publication provenance");
      }
      return { path: file.path, revision: file.revision, remote_confirmed: file.remote_confirmed };
    });
    publication = { remote_commit: raw.remote_commit as string | null, files };
  }
  return { device_id: row.device_id, legacy_project_ids: row.legacy_project_ids as string[], ...(publication ? { publication } : {}) };
}
function validUtc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}
function validateMarker(value: unknown): Marker {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("unsupported_format", "Resume marker must be a YAML mapping", { path: MARKER_PATH });
  }
  const row = value as Row;
  const required = ["deviceId", "repositoryId", "branch", "sceneId", "manuscriptPath", "manuscriptRevision", "sentenceIndex", "scrollTop", "updatedAt"];
  for (const key of required) if (!(key in row)) fail("unsupported_format", `Resume marker is missing ${key}`);
  if (typeof row.deviceId !== "string" || !row.deviceId || row.deviceId.length > 256 ||
      !Number.isSafeInteger(row.repositoryId) || Number(row.repositoryId) < 1 ||
      typeof row.branch !== "string" || !row.branch || row.branch.length > 256 ||
      typeof row.sceneId !== "string" || !row.sceneId || row.sceneId.length > 256 ||
      typeof row.manuscriptRevision !== "string" || !/^[a-f0-9]{64}$/u.test(row.manuscriptRevision) ||
      !(row.sentenceIndex === null || Number.isSafeInteger(row.sentenceIndex) && Number(row.sentenceIndex) > 0) ||
      typeof row.scrollTop !== "number" || !Number.isFinite(row.scrollTop) || row.scrollTop < 0 || !validUtc(row.updatedAt)) {
    fail("unsupported_format", "Resume marker fields are invalid");
  }
  try { validateManuscriptPath(row.manuscriptPath); }
  catch { fail("unsupported_format", "Resume marker manuscriptPath is invalid"); }
  return row as Marker;
}
function parseMarkerFile(text: string): { parsed: ReturnType<typeof parseYamlRecord>; rows: Marker[] } {
  const parsed = parseYamlRecord(text, MARKER_PATH);
  if (parsed.value.schemaVersion !== 1 || !Array.isArray(parsed.value.positions)) fail("unsupported_format", "Portable resume marker file must be schemaVersion 1 with a positions sequence", { path: MARKER_PATH });
  const rows = parsed.value.positions.map((item) => validateMarker(item));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([row.deviceId, row.repositoryId, row.branch]);
    if (keys.has(key)) fail("ambiguous_identity", "Portable resume file has duplicate device/repository/branch entries", { path: MARKER_PATH, device_id: row.deviceId, repository_id: row.repositoryId, branch: row.branch });
    keys.add(key);
  }
  return { parsed, rows };
}
function currentScene(work: WorkSnapshot, id: string): { file: MetadataFile; title: string; manuscript_path: string } | undefined {
  const duplicate = work.duplicatePaths.get(id);
  if (duplicate) fail("ambiguous_identity", `Scene ${id} is ambiguous`, { paths: duplicate });
  const row = work.byId.get(id);
  if (!row || row.kind !== "scene") return undefined;
  const file = work.files.get(row.metadata_path);
  if (!file) fail("unsupported_format", `Scene metadata could not be read: ${row.metadata_path}`, { path: row.metadata_path });
  return { file, title: row.title, manuscript_path: validateManuscriptPath(row.manuscript_path) };
}
function cursor(snapshot: string, repositoryId: number, branch: string, revision: string | null, offset: number): string {
  return `rsm1|${encodeURIComponent(snapshot)}|${repositoryId}|${encodeURIComponent(branch)}|${revision === null ? "~" : encodeURIComponent(revision)}|${offset}`;
}
function cursorOffset(value: string | undefined, snapshot: string, repositoryId: number, branch: string, revision: string | null): number {
  if (value === undefined) return 0;
  const parts = value.split("|");
  let decodedSnapshot: string, decodedBranch: string, decodedRevision: string | null;
  try {
    decodedSnapshot = decodeURIComponent(parts[1] ?? "");
    decodedBranch = decodeURIComponent(parts[3] ?? "");
    decodedRevision = parts[4] === "~" ? null : decodeURIComponent(parts[4] ?? "");
  } catch { fail("invalid_input", "Portable resume cursor is malformed"); }
  if (parts.length !== 6 || parts[0] !== "rsm1" || decodedSnapshot !== snapshot || parts[2] !== String(repositoryId) ||
      decodedBranch !== branch || decodedRevision !== revision || !/^\d+$/u.test(parts[5]!)) fail("snapshot_stale", "Portable resume cursor does not match this snapshot");
  const offset = Number(parts[5]);
  if (!Number.isSafeInteger(offset)) fail("invalid_input", "Portable resume cursor offset is invalid");
  return offset;
}
function parseListInput(value: unknown): { cursor?: string; limit: number } {
  const input = record(value, "input"); exactKeys(input, ["cursor", "limit"], [], "input");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor)) fail("invalid_input", "cursor must be a non-empty string");
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) fail("invalid_input", "limit must be an integer from 1 to 100");
  return { ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}), limit: Number(limit) };
}
function publicationState(identity: IdentityResult, revision: string | null): "local_only" | "remote_confirmed" {
  return identity.publication?.files.some((file) => file.path === MARKER_PATH && file.revision === revision && file.remote_confirmed) ? "remote_confirmed" : "local_only";
}
export function* listPortableResumeMarks(host: NarrativeHost, request: ActionRequest, value: unknown): Generator<HostCall, unknown, unknown> {
  const input = parseListInput(value);
  const repositoryId = request.scope.repository_id;
  if (repositoryId === null) return { items: [], next_cursor: null, source_revision: null };
  const identity = validateIdentity(yield* host.request<unknown>("workspace.identity.read", {
    paths: [MARKER_PATH],
  }));
  const markerFile = yield* readTextFile(host, request, MARKER_PATH, true);
  if (markerFile.revision === null) {
    if (input.cursor !== undefined) fail("snapshot_stale", "Portable resume cursor refers to a marker file that is no longer present");
    return { items: [], next_cursor: null, source_revision: null };
  }
  const { rows } = parseMarkerFile(markerFile.text);
  const offset = cursorOffset(input.cursor, request.snapshot.id, repositoryId, request.scope.branch, markerFile.revision);
  const applicable = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.repositoryId === repositoryId && row.branch === request.scope.branch);
  if (offset > applicable.length) fail("snapshot_stale", "Portable resume cursor is beyond the selected marker list");
  const page = applicable.slice(offset, offset + input.limit);
  const work = yield* readWorkSnapshot(host, request);
  const items: Array<Record<string, unknown>> = [];
  for (const { row } of page) {
    const scene = currentScene(work, row.sceneId);
    let availability: "ready" | "stale" | "missing" = "missing";
    let currentTitle = row.sceneId;
    if (scene) {
      currentTitle = scene.title;
      if (scene.manuscript_path !== row.manuscriptPath) availability = "stale";
      else {
        try {
          const currentRevision = yield* readFileRevision(host, request, row.manuscriptPath);
          availability = currentRevision === row.manuscriptRevision ? "ready" : "stale";
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === "file_not_found") availability = "missing";
          else throw error;
        }
      }
    }
    items.push({
      device_id: row.deviceId,
      scene_id: row.sceneId,
      title: currentTitle,
      manuscript_path: row.manuscriptPath,
      manuscript_revision: row.manuscriptRevision,
      sentence_index: row.sentenceIndex,
      scroll_top: row.scrollTop,
      updated_at: row.updatedAt,
      availability,
      publication: publicationState(identity, markerFile.revision),
    });
  }
  const nextOffset = offset + page.length;
  return {
    items,
    next_cursor: nextOffset < applicable.length ? cursor(request.snapshot.id, repositoryId, request.scope.branch, markerFile.revision, nextOffset) : null,
    source_revision: markerFile.revision,
  };
}

function parseProposeInput(value: unknown): {
  scene_id: string;
  expected_manuscript_revision: string;
  expected_marker_revision: string | null;
  sentence_index: number | null;
  scroll_top: number;
} {
  const input = record(value, "input");
  exactKeys(input, ["scene_id", "expected_manuscript_revision", "expected_marker_revision", "sentence_index", "scroll_top"],
    ["scene_id", "expected_manuscript_revision", "expected_marker_revision", "sentence_index", "scroll_top"], "input");
  const scene_id = inputString(input.scene_id, "scene_id");
  const expected_manuscript_revision = inputString(input.expected_manuscript_revision, "expected_manuscript_revision");
  if (!(input.expected_marker_revision === null || typeof input.expected_marker_revision === "string")) fail("invalid_input", "expected_marker_revision must be a revision or null");
  if (!(input.sentence_index === null || Number.isSafeInteger(input.sentence_index) && Number(input.sentence_index) > 0)) fail("invalid_input", "sentence_index must be null or a positive integer");
  if (typeof input.scroll_top !== "number" || !Number.isFinite(input.scroll_top) || input.scroll_top < 0) fail("invalid_input", "scroll_top must be finite and nonnegative");
  return {
    scene_id,
    expected_manuscript_revision,
    expected_marker_revision: input.expected_marker_revision as string | null,
    sentence_index: input.sentence_index as number | null,
    scroll_top: input.scroll_top,
  };
}
function timestampValue(value: unknown): string {
  const row = record(value, "workspace.change.timestamp result");
  const timestamp = row.timestamp;
  if (!validUtc(timestamp)) fail("invalid_input", "Host returned an invalid workspace timestamp");
  return timestamp;
}

export function* proposePortableResumeMark(host: NarrativeHost, request: ActionRequest, value: unknown): Generator<HostCall, ProposalValue, unknown> {
  const input = parseProposeInput(value);
  if (request.scope.repository_id === null) fail("capability_denied", "Portable resume requires a bound GitHub repository");
  if (request.snapshot.draft_generation !== null) fail("dirty_draft", "Save locally first before proposing a portable reading position");
  const identity = validateIdentity(yield* host.request<unknown>("workspace.identity.read", {}));
  const work = yield* readWorkSnapshot(host, request);
  const scene = currentScene(work, input.scene_id);
  if (!scene) fail("scene_not_found", `Scene ${input.scene_id} was not found`);
  const manuscriptRevision = yield* readFileRevision(host, request, scene.manuscript_path);
  if (manuscriptRevision !== input.expected_manuscript_revision) fail("snapshot_stale", "The saved manuscript revision changed", {
    path: scene.manuscript_path, expected: input.expected_manuscript_revision, actual: manuscriptRevision,
  });
  const markerFile = yield* readTextFile(host, request, MARKER_PATH, true);
  if (markerFile.revision !== input.expected_marker_revision) fail("snapshot_stale", "The portable resume marker revision changed", {
    path: MARKER_PATH, expected: input.expected_marker_revision, actual: markerFile.revision,
  });
  const timestampResult = yield* host.request<unknown>("workspace.change.timestamp", {});
  const updatedAt = timestampValue(timestampResult);
  const marker: Marker = {
    deviceId: identity.device_id,
    repositoryId: request.scope.repository_id,
    branch: request.scope.branch,
    sceneId: scene.file.row!.id,
    manuscriptPath: scene.manuscript_path,
    manuscriptRevision,
    sentenceIndex: input.sentence_index,
    scrollTop: input.scroll_top,
    updatedAt,
  };
  let changed: string;
  if (markerFile.revision === null) {
    changed = stringify({ schemaVersion: 1, positions: [marker] }, { lineWidth: 0, simpleKeys: true });
  } else {
    const { parsed, rows } = parseMarkerFile(markerFile.text);
    const matches = rows.flatMap((row, index) => row.deviceId === marker.deviceId && row.repositoryId === marker.repositoryId && row.branch === marker.branch ? [index] : []);
    if (matches.length > 1) fail("ambiguous_identity", "Portable resume file has duplicate entries for this device and repository", { path: MARKER_PATH });
    if (matches.length === 1) {
      const index = matches[0]!;
      changed = updateYamlSequenceMapFields(parsed.source, MARKER_PATH, "positions", index, {
        sceneId: marker.sceneId,
        manuscriptPath: marker.manuscriptPath,
        manuscriptRevision: marker.manuscriptRevision,
        sentenceIndex: marker.sentenceIndex,
        scrollTop: marker.scrollTop,
        updatedAt: marker.updatedAt,
      });
    } else {
      changed = appendYamlSequenceValue(parsed.source, MARKER_PATH, "positions", marker, "deviceId");
    }
  }
  const reads: Array<{ path: string; revision: string | null }> = work.entries.map((entry) => ({ path: entry.path, revision: entry.revision }));
  reads.push({ path: scene.manuscript_path, revision: manuscriptRevision }, { path: MARKER_PATH, revision: markerFile.revision });
  return yield* propose(host, request, "proprium.narrative.resume.mark.propose", `Save reading position for ${scene.title}`,
    `Save this device's portable position for scene ${scene.file.row!.id}`, reads,
    [fileOperation(MARKER_PATH, markerFile.revision, changed)]);
}
