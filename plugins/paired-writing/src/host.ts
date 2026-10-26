import type { ActionRequest, ActionResult } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { HOST_OPERATIONS } from "../../shared/operations.js";
import { PairedError } from "./types.js";
import { sha256 } from "./sha256.js";

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, i) => equalJson(item, right[i]));
  const a = Object.keys(left as object).sort();
  const b = Object.keys(right as object).sort();
  return a.length === b.length && a.every((key, i) => key === b[i] && equalJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

export function* invokeAction<T>(
  host: GuestHost,
  request: ActionRequest,
  pluginId: string,
  actionId: string,
  input: Record<string, unknown>,
): Generator<HostCall, T, unknown> {
  const result = yield* host.request<ActionResult<T>>(HOST_OPERATIONS.invoke, {
    plugin_id: pluginId,
    action_id: actionId,
    input,
  });
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new PairedError("invalid_input", `Host returned a malformed result for ${actionId}`);
  }
  if (!result.ok) throw new PairedError(result.error.code, result.error.message, result.error.details, result.error.retryable);
  if (!equalJson(result.scope, request.scope) || !equalJson(result.snapshot, request.snapshot)) {
    throw new PairedError("snapshot_stale", `Host action ${actionId} returned data outside the pinned scope/snapshot`);
  }
  return result.value;
}

/** Confirm a legacy Story project ID against Host-registered workspace bindings. */
export function* verifyLegacyProjectBinding(
  host: GuestHost,
  request: ActionRequest,
  projectId: string,
): Generator<HostCall, void, unknown> {
  const binding = yield* host.request<{
    readonly scope: ActionRequest["scope"];
    readonly snapshot: ActionRequest["snapshot"];
    readonly legacy_project_ids: readonly string[];
  }>("workspace.identity.read", {});
  if (!binding || !equalJson(binding.scope, request.scope) || !equalJson(binding.snapshot, request.snapshot)) {
    throw new PairedError("snapshot_stale", "Host identity binding differs from the request's pinned scope or snapshot");
  }
  if (!Array.isArray(binding.legacy_project_ids) || binding.legacy_project_ids.some((id) => typeof id !== "string")) {
    throw new PairedError("dependency_unavailable", "Host did not provide verified legacy project bindings");
  }
  if (!binding.legacy_project_ids.includes(projectId)) {
    throw new PairedError("conflict", "NarrativeChangeSet projectId is not registered to the selected Host workspace", { project_id: projectId });
  }
}

export interface PinnedFile {
  readonly path: string;
  readonly revision: string;
  readonly text: string;
  readonly total_bytes: number;
}

/** Stream a pinned UTF-8 file in bounded Host ranges without changing source bytes. */
export function* readText(
  host: GuestHost,
  request: ActionRequest,
  path: string,
): Generator<HostCall, PinnedFile, unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const chunks: string[] = [];
  const maximumBytes = 16 * 1024 * 1024;
  let offset = 0;
  let revision: string | undefined;
  let totalBytes: number | undefined;
  while (totalBytes === undefined || offset < totalBytes) {
    const range = yield* host.request<{
      readonly revision: string;
      readonly total_bytes: number;
      readonly offset: number;
      readonly bytes: number[];
      readonly next_offset: number | null;
    }>(HOST_OPERATIONS.read, {
      snapshot: request.snapshot,
      path,
      offset,
      length: 65_536,
    });
    if (!range || !Array.isArray(range.bytes) || range.offset !== offset || !Number.isSafeInteger(range.total_bytes) || range.total_bytes < 0) {
      throw new PairedError("invalid_input", `Host returned an invalid byte range for ${path}`);
    }
    if (!revision) revision = range.revision;
    if (revision !== range.revision) throw new PairedError("snapshot_stale", `File revision changed while reading ${path}`);
    if (totalBytes === undefined) totalBytes = range.total_bytes;
    if (totalBytes !== range.total_bytes || totalBytes > maximumBytes) {
      throw new PairedError(totalBytes > maximumBytes ? "capacity" : "snapshot_stale", `File size changed or exceeds the bounded Paired read for ${path}`);
    }
    if (range.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new PairedError("invalid_input", `Host returned invalid bytes for ${path}`);
    }
    if (range.bytes.length === 0 && offset < totalBytes) throw new PairedError("snapshot_stale", `Host returned an incomplete range for ${path}`);
    try { chunks.push(decoder.decode(new Uint8Array(range.bytes), { stream: range.next_offset !== null })); }
    catch { throw new PairedError("invalid_encoding", `File is not valid UTF-8: ${path}`); }
    const expectedNext = offset + range.bytes.length;
    if (range.next_offset !== null && range.next_offset !== expectedNext) throw new PairedError("invalid_input", `Host range cursor is invalid for ${path}`);
    if (range.next_offset === null && expectedNext !== totalBytes) throw new PairedError("snapshot_stale", `Host ended the file read before EOF for ${path}`);
    offset = expectedNext;
    if (range.next_offset === null) break;
  }
  if (totalBytes === undefined || !revision) throw new PairedError("file_not_found", `File was not available at the selected snapshot: ${path}`);
  try { chunks.push(decoder.decode()); }
  catch { throw new PairedError("invalid_encoding", `File is not valid UTF-8: ${path}`); }
  return { path, revision, text: chunks.join(""), total_bytes: totalBytes };
}

/** Use a Host-issued staging token as the snapshot ID while preserving its original snapshot binding. */
export function withStagingSnapshot(request: ActionRequest, stagingSnapshot: string): ActionRequest {
  if (!stagingSnapshot) throw new PairedError("invalid_input", "Staging snapshot must be a Host-issued opaque ID");
  return { ...request, snapshot: { ...request.snapshot, id: stagingSnapshot } };
}

function cacheAddress(request: ActionRequest, key: string): Record<string, unknown> {
  return {
    plugin_id: "proprium.paired-writing",
    snapshot: request.snapshot,
    schema_version: 1,
    config_digest: sha256(new TextEncoder().encode("paired-context-manifest-v1")),
    key,
  };
}

export function* cacheGet<T>(host: GuestHost, request: ActionRequest, key: string): Generator<HostCall, T | undefined, unknown> {
  return yield* host.request<T | undefined>(HOST_OPERATIONS.cacheGet, cacheAddress(request, key));
}

export function* cachePut(host: GuestHost, request: ActionRequest, key: string, value: unknown): Generator<HostCall, void, unknown> {
  yield* host.request(HOST_OPERATIONS.cachePut, { ...cacheAddress(request, key), value });
}
