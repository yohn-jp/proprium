import type { ActionRequest } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../../shared/guest.js";
import { PairedError } from "./types.js";
import { filePath, identity } from "./validation.js";
import { sha256 } from "./sha256.js";

const INLINE_CONTENT_LIMIT = 128 * 1024;
const ARTIFACT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_ARTIFACT_LIMIT = 128 * 1024 * 1024;
const MAX_HOST_CHUNK_BYTES = 256 * 1024;

export type ContentReference = { readonly content: number[] } |
  { readonly content_artifact: string; readonly artifact_id: string };

/** Encode exact generated text inline when small; stream larger bytes to the Host artifact broker. */
export function* createContentReference(
  host: GuestHost,
  request: ActionRequest,
  pathValue: string,
  text: string,
): Generator<HostCall, ContentReference, unknown> {
  const path = filePath(pathValue);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= INLINE_CONTENT_LIMIT) return { content: Array.from(bytes) };
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const created = yield* host.request<unknown>("artifact.create", {
    media_type: path.endsWith(".md") ? "text/markdown" : "application/octet-stream",
    filename,
    scope: request.scope,
    snapshot: request.snapshot,
  });
  const receipt = created && typeof created === "object" && !Array.isArray(created) ? created as Record<string, unknown> : undefined;
  const artifactId = identity(receipt ? receipt.artifact_id : created, "artifact_id", 512);
  const maxBytes = receipt?.max_bytes ?? DEFAULT_ARTIFACT_LIMIT;
  const maxChunk = receipt?.max_chunk_bytes ?? ARTIFACT_CHUNK_BYTES;
  try {
    if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1 || !Number.isSafeInteger(maxChunk) || (maxChunk as number) < 1 || (maxChunk as number) > MAX_HOST_CHUNK_BYTES) {
      throw new PairedError("storage_unknown", "Host returned invalid artifact limits");
    }
    if (bytes.byteLength > (maxBytes as number)) throw new PairedError("artifact_too_large", "Content exceeds the negotiated Host artifact limit");
    const chunkSize = Math.min(ARTIFACT_CHUNK_BYTES, maxChunk as number);
    let sequence = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      const chunk = Array.from(bytes.slice(offset, offset + chunkSize));
      yield* host.request("artifact.append", { artifact_id: artifactId, sequence: sequence++, bytes: chunk });
    }
    yield* host.request("artifact.seal", { artifact_id: artifactId, sha256: sha256(bytes), total_bytes: bytes.byteLength });
  } catch (error) {
    try { yield* host.request("artifact.discard", { artifact_id: artifactId }); } catch { /* Host releases temporary artifacts on failed/cancelled requests. */ }
    throw error;
  }
  return { content_artifact: artifactId, artifact_id: artifactId };
}

export function* discardTemporaryArtifact(host: GuestHost, artifactId: string): Generator<HostCall, void, unknown> {
  yield* host.request("artifact.discard", { artifact_id: artifactId });
}
