import type { ActionResult, ChangeSet, Scope, Snapshot } from "../../app/src/browser/proprium/authoring/types.js";
import type { ArtifactMetadata, CacheKey } from "../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "./guest.js";
export type { ArtifactMetadata, CacheKey };

/** Canonical JSON payloads for the versioned Host capability broker. */
export interface FileEntry { path: string; revision: string; byte_length: number; media_type: string }
export interface FilePage { entries: FileEntry[]; next_cursor: string | null }
export interface FileChunk { revision: string; total_bytes: number; offset: number; bytes: number[]; next_offset: number | null }
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

export interface VersionedFile { bytes: Uint8Array; revision: string }

/** Read exact pinned bytes while retaining and checking the Host's source revision. */
export function* readFileVersioned(host: GuestHost, snapshot: Snapshot, path: string,
  expectedRevision?: string): Generator<HostCall, VersionedFile, unknown> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let revision: string | undefined;
  let total: number | undefined;
  do {
    const chunk = yield* host.request<FileChunk>(HOST_OPERATIONS.read, { snapshot, path, offset, length: 65536 });
    if (!chunk || typeof chunk.revision !== "string" || !/^[a-f0-9]{64}$/u.test(chunk.revision) ||
        (expectedRevision !== undefined && chunk.revision !== expectedRevision) ||
        chunk.offset !== offset || (revision !== undefined && chunk.revision !== revision) ||
        (total !== undefined && chunk.total_bytes !== total) || !Array.isArray(chunk.bytes) ||
        chunk.bytes.length > 65536 || chunk.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) ||
        !Number.isSafeInteger(chunk.total_bytes) || chunk.total_bytes < offset + chunk.bytes.length ||
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
  if (!revision) throw Object.assign(new Error("Host returned no file revision"), { code: "snapshot_stale" });
  return { bytes, revision };
}

/** Compatibility helper for callers that need only bytes. */
export function* readFile(host: GuestHost, snapshot: Snapshot, path: string): Generator<HostCall, Uint8Array, unknown> {
  return (yield* readFileVersioned(host, snapshot, path)).bytes;
}

export function* invokeAction<T>(host: GuestHost, plugin_id: string, action_id: string,
  input: Record<string, unknown>): Generator<HostCall, T, unknown> {
  const response = yield* host.request<ActionResult<T>>(HOST_OPERATIONS.invoke, { plugin_id, action_id, input });
  if (!response.ok) throw response.error;
  return response.value;
}

export function* propose(host: GuestHost, changeset: ChangeSet): Generator<HostCall, unknown, unknown> {
  return yield* host.request(HOST_OPERATIONS.propose, { changeset });
}
