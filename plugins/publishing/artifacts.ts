import type { ActionRequest, Snapshot } from "../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost, HostCall } from "../shared/guest.js";
import { crc32, safeRelativePath } from "./domain.js";

// The canon allows up to 256 KiB, but JSON number[] expands enough to exceed
// the v2 HostCall's 1 MiB encoded limit at that size. Keep the transport
// default at 64 KiB raw so every encoded append stays bounded.
export const ARTIFACT_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_ARTIFACT_LIMIT = 128 * 1024 * 1024;

export interface CreatedArtifact { artifact_id: string; max_bytes?: number; max_chunk_bytes?: number }
export interface SealedArtifact {
  artifact_id: string;
  media_type: string;
  filename: string;
  scope: ActionRequest["scope"];
  snapshot: Snapshot;
  total_bytes: number;
  sha256: string;
}

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number { return (value >>> bits) | (value << (32 - bits)); }

/** Streaming SHA-256 so sealing a large export does not need a second copy. */
export class Sha256 {
  private readonly state = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly buffer = new Uint8Array(64);
  private buffered = 0;
  private totalBytes = 0;
  private finished = false;

  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest is already finalized");
    this.totalBytes += bytes.byteLength;
    let offset = 0;
    if (this.buffered) {
      const length = Math.min(64 - this.buffered, bytes.byteLength);
      this.buffer.set(bytes.subarray(0, length), this.buffered);
      this.buffered += length; offset += length;
      if (this.buffered === 64) { this.compress(this.buffer); this.buffered = 0; }
    }
    while (offset + 64 <= bytes.byteLength) { this.compress(bytes.subarray(offset, offset + 64)); offset += 64; }
    if (offset < bytes.byteLength) {
      this.buffer.set(bytes.subarray(offset), 0);
      this.buffered = bytes.byteLength - offset;
    }
    return this;
  }

  digest(): string {
    if (this.finished) throw new Error("SHA-256 digest is already finalized");
    this.finished = true;
    const bitLength = this.totalBytes * 8;
    this.buffer[this.buffered++] = 0x80;
    if (this.buffered > 56) {
      this.buffer.fill(0, this.buffered);
      this.compress(this.buffer); this.buffered = 0;
    }
    this.buffer.fill(0, this.buffered, 56);
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.compress(this.buffer);
    return [...this.state].map(word => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]!; const y = words[index - 2]!;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index++) {
      const s1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + s1 + choice + K[index]! + words[index]!) >>> 0;
      const s0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a!) >>> 0; this.state[1] = (this.state[1]! + b!) >>> 0;
    this.state[2] = (this.state[2]! + c!) >>> 0; this.state[3] = (this.state[3]! + d!) >>> 0;
    this.state[4] = (this.state[4]! + e!) >>> 0; this.state[5] = (this.state[5]! + f!) >>> 0;
    this.state[6] = (this.state[6]! + g!) >>> 0; this.state[7] = (this.state[7]! + h!) >>> 0;
  }
}

export class ArtifactSink {
  private id: string | undefined;
  private maxBytes = DEFAULT_ARTIFACT_LIMIT;
  private chunkBytes = ARTIFACT_CHUNK_BYTES;
  private sequence = 0;
  private totalBytes = 0;
  private readonly digestState = new Sha256();
  private sealed = false;

  constructor(
    private readonly host: GuestHost,
    private readonly request: ActionRequest,
    private readonly filename: string,
    private readonly mediaType: string,
  ) {}

  *create(): Generator<HostCall, string, unknown> {
    if (this.id) throw new Error("Artifact already exists");
    const value = yield* this.host.request<CreatedArtifact>("artifact.create", {
      media_type: this.mediaType,
      filename: this.filename,
      scope: this.request.scope,
      snapshot: this.request.snapshot,
    });
    if (!value || typeof value.artifact_id !== "string" || !value.artifact_id) {
      throw Object.assign(new Error("Host did not create the export artifact"), { code: "storage_unknown" });
    }
    if ((value.max_bytes !== undefined && (!Number.isSafeInteger(value.max_bytes) || value.max_bytes < 1)) ||
        (value.max_chunk_bytes !== undefined && (!Number.isSafeInteger(value.max_chunk_bytes) || value.max_chunk_bytes < 1 || value.max_chunk_bytes > 256 * 1024))) {
      yield* this.host.request("artifact.discard", { artifact_id: value.artifact_id });
      throw Object.assign(new Error("Host returned an invalid artifact limit"), { code: "invalid_input" });
    }
    this.id = value.artifact_id;
    this.maxBytes = value.max_bytes ?? DEFAULT_ARTIFACT_LIMIT;
    this.chunkBytes = Math.min(ARTIFACT_CHUNK_BYTES, value.max_chunk_bytes ?? ARTIFACT_CHUNK_BYTES);
    return this.id;
  }

  *append(bytes: Uint8Array): Generator<HostCall, void, unknown> {
    if (!this.id || this.sealed) throw new Error("Artifact is not writable");
    if (this.totalBytes + bytes.byteLength > this.maxBytes) {
      throw Object.assign(new Error("Export exceeds the negotiated Host artifact limit"), { code: "artifact_too_large", retryable: false });
    }
    for (let offset = 0; offset < bytes.byteLength; offset += this.chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + this.chunkBytes));
      yield* this.host.request("artifact.append", {
        artifact_id: this.id,
        sequence: this.sequence++,
        bytes: Array.from(chunk),
      });
      this.digestState.update(chunk);
      this.totalBytes += chunk.byteLength;
    }
  }

  *seal(): Generator<HostCall, SealedArtifact, unknown> {
    if (!this.id || this.sealed) throw new Error("Artifact cannot be sealed");
    const sha256 = this.digestState.digest();
    yield* this.host.request("artifact.seal", {
      artifact_id: this.id,
      sha256,
      total_bytes: this.totalBytes,
    });
    this.sealed = true;
    return {
      artifact_id: this.id,
      media_type: this.mediaType,
      filename: this.filename,
      scope: this.request.scope,
      snapshot: this.request.snapshot,
      total_bytes: this.totalBytes,
      sha256,
    };
  }

  *discard(): Generator<HostCall, void, unknown> {
    if (!this.id || this.sealed) return;
    const id = this.id;
    this.id = undefined;
    yield* this.host.request("artifact.discard", { artifact_id: id });
  }
}

interface ZipCentralEntry { name: Uint8Array; crc: number; size: number; localOffset: number }

/** Writes EPUB local entries and central directory directly to the Host artifact sink. */
export class StoredZipArtifactWriter {
  private readonly entries: ZipCentralEntry[] = [];
  private readonly paths = new Set<string>();
  private localOffset = 0;
  private centralSize = 0;
  private started = false;

  constructor(private readonly sink: ArtifactSink) {}

  *start(): Generator<HostCall, string, unknown> {
    this.started = true;
    return yield* this.sink.create();
  }

  *add(path: string, bytes: Uint8Array): Generator<HostCall, void, unknown> {
    if (!this.started) throw new Error("EPUB artifact writer is not active");
    if (!safeRelativePath(path) || path.length === 0 || this.paths.has(path) || bytes.byteLength > 0xffffffff || this.entries.length >= 0xffff) {
      throw Object.assign(new Error("Invalid EPUB entry"), { code: "invalid_input" });
    }
    if (this.entries.length === 0 && (path !== "mimetype" || new TextDecoder().decode(bytes) !== "application/epub+zip")) {
      throw Object.assign(new Error("EPUB mimetype must be the first entry"), { code: "invalid_input" });
    }
    const name = new TextEncoder().encode(path);
    if (name.byteLength > 0xffff) throw Object.assign(new Error("EPUB entry path is too long"), { code: "invalid_input" });
    const crc = crc32(bytes);
    const localOffset = this.localOffset;
    const header = new Uint8Array(30 + name.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true); view.setUint16(10, 0, true); view.setUint16(12, 0x0021, true);
    view.setUint32(14, crc, true); view.setUint32(18, bytes.byteLength, true); view.setUint32(22, bytes.byteLength, true);
    view.setUint16(26, name.byteLength, true); view.setUint16(28, 0, true); header.set(name, 30);
    yield* this.sink.append(header);
    yield* this.sink.append(bytes);
    this.localOffset += header.byteLength + bytes.byteLength;
    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true); centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0x0021, true); centralView.setUint32(16, crc, true);
    centralView.setUint32(20, bytes.byteLength, true); centralView.setUint32(24, bytes.byteLength, true);
    centralView.setUint16(28, name.byteLength, true); centralView.setUint16(30, 0, true); centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true); centralView.setUint16(36, 0, true); centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true); central.set(name, 46);
    this.entries.push({ name, crc, size: bytes.byteLength, localOffset });
    this.centralSize += central.byteLength;
    // Keep each central directory record with its entry for deterministic close.
    this.centralRecords.push(central);
    this.paths.add(path);
  }

  private readonly centralRecords: Uint8Array[] = [];

  *finish(): Generator<HostCall, SealedArtifact, unknown> {
    if (!this.started || this.entries.length === 0 || this.entries[0] === undefined) throw new Error("EPUB artifact has no entries");
    for (const record of this.centralRecords) yield* this.sink.append(record);
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true); view.setUint16(4, 0, true); view.setUint16(6, 0, true);
    view.setUint16(8, this.entries.length, true); view.setUint16(10, this.entries.length, true);
    view.setUint32(12, this.centralSize, true); view.setUint32(16, this.localOffset, true); view.setUint16(20, 0, true);
    yield* this.sink.append(end);
    return yield* this.sink.seal();
  }
}

export function* writeBytesToArtifact(host: GuestHost, request: ActionRequest, filename: string, mediaType: string,
  source: Iterable<Uint8Array>): Generator<HostCall, SealedArtifact, unknown> {
  const sink = new ArtifactSink(host, request, filename, mediaType);
  yield* sink.create();
  let completed = false;
  try {
    for (const chunk of source) yield* sink.append(chunk);
    const artifact = yield* sink.seal();
    completed = true;
    return artifact;
  } finally {
    if (!completed) yield* sink.discard();
  }
}
