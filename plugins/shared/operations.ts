import type { ActionResult, ChangeSet, Scope, Snapshot } from "../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost } from "./guest.js";

/** Canonical JSON payloads for the versioned Host capability broker. */
export interface FileEntry { path: string; revision: string; byte_length: number; media_type: string }
export interface FilePage { entries: FileEntry[]; next_cursor: string | null }
export interface FileChunk { revision: string; total_bytes: number; offset: number; bytes: number[]; next_offset: number | null }
export interface CacheKey {
  plugin_id: string;
  snapshot: Snapshot;
  schema_version: number;
  config_digest: string;
  model_digest?: string;
  key: string;
}
export interface ArtifactMetadata {
  artifact_id: string;
  media_type: string;
  filename: string;
  scope: Scope;
  snapshot: Snapshot;
  total_bytes: number;
  sha256: string;
}
export const HOST_OPERATIONS = {
  list: "workspace.file.list",
  read: "workspace.file.read",
  invoke: "workspace.plugin.invoke",
  propose: "workspace.change.propose",
  stage: "workspace.change.stage",
  cacheGet: "workspace.derived.cache.get",
  cachePut: "workspace.derived.cache.put",
  cacheEvict: "workspace.derived.cache.evict",
  preferencesRead: "plugin.preferences.read",
} as const;

export function* readFile(host: GuestHost, snapshot: Snapshot, path: string): Generator<unknown, Uint8Array, unknown> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let revision: string | undefined;
  let total: number | undefined;
  do {
    const chunk = yield* host.request<FileChunk>(HOST_OPERATIONS.read, { snapshot, path, offset, length: 65536 });
    if (chunk.offset !== offset || (revision !== undefined && chunk.revision !== revision) ||
        (total !== undefined && chunk.total_bytes !== total) || !Array.isArray(chunk.bytes) ||
        chunk.bytes.length > 65536 || chunk.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
        chunk.total_bytes < offset + chunk.bytes.length ||
        (chunk.next_offset !== null && (chunk.next_offset !== offset + chunk.bytes.length || chunk.next_offset <= offset))) {
      throw Object.assign(new Error("Inconsistent pinned file chunks"), { code: "snapshot_stale" });
    }
    revision = chunk.revision; total = chunk.total_bytes;
    parts.push(Uint8Array.from(chunk.bytes));
    offset += chunk.bytes.length;
    if (chunk.next_offset === null) {
      if (offset !== total) throw Object.assign(new Error("Incomplete file bytes"), { code: "snapshot_stale" });
      break;
    }
  } while (true);
  const bytes = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) { bytes.set(part, position); position += part.length; }
  return bytes;
}

export function* invokeAction<T>(host: GuestHost, plugin_id: string, action_id: string,
  input: Record<string, unknown>): Generator<unknown, T, unknown> {
  const response = yield* host.request<ActionResult<T>>(HOST_OPERATIONS.invoke, { plugin_id, action_id, input });
  if (!response.ok) throw response.error;
  return response.value;
}

export function* propose(host: GuestHost, changeset: ChangeSet): Generator<unknown, unknown, unknown> {
  return yield* host.request(HOST_OPERATIONS.propose, { changeset });
}
