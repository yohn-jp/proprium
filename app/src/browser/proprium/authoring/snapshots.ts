import { validateGitPath } from "../git/protocol.js";

const DEFAULT_PAGE_SIZE = 128;
const MAX_PAGE_SIZE = 256;
const MAX_READ_CHUNK = 256 * 1024;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const MAX_CURSORS = 4096;
const MAX_VERIFIED_FILES = 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

/** Host-issued identity of the currently selected repository and branch. */
export interface AuthoringScope {
  readonly workspace_id: string;
  readonly repository_id: number | null;
  readonly branch: string;
  readonly generation: string;
}

/** Opaque Host snapshot. draft_generation is present only for an opted-in draft view. */
export interface AuthoringSnapshot {
  readonly id: string;
  readonly local_commit: string | null;
  readonly worktree_generation: string;
  readonly draft_generation: string | null;
}

export interface SnapshotLease {
  readonly scope: AuthoringScope;
  readonly snapshot: AuthoringSnapshot;
  /** Private Host adapter token. Never serialize this token to plugin code. */
  readonly host_token: unknown;
}

export interface SnapshotFile {
  readonly path: string;
  /** SHA-256 of the exact bytes at the lease's snapshot. */
  readonly revision: string;
  readonly byte_length: number;
  readonly media_type: string;
}

export interface SnapshotPage {
  readonly items: readonly SnapshotFile[];
  readonly next_cursor: string | null;
}

export interface SnapshotRange {
  readonly bytes: Uint8Array;
  readonly total_bytes: number;
  readonly offset: number;
  readonly revision: string;
}

/**
 * Trusted Host adapter over a pinned directory view. Implementations must bind all
 * operations to host_token and retain the listed bytes or fail with snapshot_stale.
 * In particular, a live worktree read is not a valid implementation of this port.
 */
export interface SnapshotPort {
  pin(scope: AuthoringScope, options: { readonly include_draft: boolean }): Promise<SnapshotLease>;
  assert_current(lease: SnapshotLease): Promise<void>;
  list(lease: SnapshotLease, query: {
    readonly prefix: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<SnapshotPage>;
  stat(lease: SnapshotLease, path: string): Promise<SnapshotFile | null>;
  read_range(lease: SnapshotLease, path: string, offset: number, length: number): Promise<SnapshotRange>;
}

export type AuthoringSnapshotErrorCode =
  | "invalid_input"
  | "invalid_path"
  | "file_not_found"
  | "snapshot_stale"
  | "invalid_encoding"
  | "storage_unknown"
  | "capacity";

export class AuthoringSnapshotError extends Error {
  constructor(readonly code: AuthoringSnapshotErrorCode, message: string) {
    super(message);
    this.name = "AuthoringSnapshotError";
  }
}

interface CursorState {
  readonly snapshot_id: string;
  readonly scope_key: string;
  readonly prefix: string;
  readonly source_cursor: string;
  readonly last_path: string;
  readonly expires_at: number;
}

interface CachedVerification {
  readonly scope_key: string;
  readonly snapshot_id: string;
  readonly path: string;
  readonly revision: string;
}

/**
 * Revision-pinned, bounded access used by authoring plugins. It never materializes
 * repository contents: list returns metadata pages and read verifies one selected
 * file through bounded chunks before returning the requested byte range.
 */
export class AuthoringSnapshotReader {
  private readonly cursors = new Map<string, CursorState>();
  private readonly verified = new Map<string, CachedVerification>();

  constructor(private readonly port: SnapshotPort, private readonly now = () => Date.now()) {}

  pin(scope: AuthoringScope, include_draft = false): Promise<SnapshotLease> {
    validateScope(scope);
    if (typeof include_draft !== "boolean") throw invalid("include_draft must be boolean");
    return this.port.pin(Object.freeze({ ...scope }), { include_draft }).then(lease => {
      validateLease(lease, scope, include_draft);
      return freezeLease(lease);
    });
  }

  async list(lease: SnapshotLease, options: {
    readonly prefix?: string;
    readonly cursor?: string | null;
    readonly limit?: number;
  } = {}): Promise<SnapshotPage> {
    validateLease(lease, lease.scope, lease.snapshot.draft_generation !== null);
    const prefix = options.prefix ?? "";
    validatePrefix(prefix);
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalid(`limit must be between 1 and ${MAX_PAGE_SIZE}`);

    const scope_key = scopeKey(lease.scope);
    let source_cursor: string | null = null;
    let last_path: string | null = null;
    if (options.cursor !== undefined && options.cursor !== null) {
      const saved = this.cursors.get(options.cursor);
      if (!saved || saved.expires_at <= this.now()) {
        this.cursors.delete(options.cursor);
        throw invalid("cursor is unknown or expired");
      }
      if (saved.snapshot_id !== lease.snapshot.id || saved.scope_key !== scope_key || saved.prefix !== prefix) {
        throw invalid("cursor belongs to a different snapshot, scope or prefix");
      }
      source_cursor = saved.source_cursor;
      last_path = saved.last_path;
    }

    await this.assertCurrent(lease);
    const page = await this.port.list(lease, { prefix, cursor: source_cursor, limit });
    await this.assertCurrent(lease);
    if (!page || !Array.isArray(page.items) || page.items.length > limit ||
        !(page.next_cursor === null || (typeof page.next_cursor === "string" && page.next_cursor.length > 0 && page.next_cursor.length <= 2048))) {
      throw new AuthoringSnapshotError("storage_unknown", "Host returned an invalid or oversized file page.");
    }
    const items = page.items.map(item => validateFile(item, prefix));
    for (let index = 0; index < items.length; index += 1) {
      const path = items[index]!.path;
      if (last_path !== null && compareUtf8Path(last_path, path) >= 0) {
        throw new AuthoringSnapshotError("storage_unknown", "Host file pages are not in strict UTF-8 byte order.");
      }
      last_path = path;
    }
    let next_cursor: string | null = null;
    if (page.next_cursor !== null) {
      if (items.length === 0 || last_path === null) throw new AuthoringSnapshotError("storage_unknown", "Host returned a continuation cursor without a file.");
      this.pruneCursors();
      if (this.cursors.size >= MAX_CURSORS) throw new AuthoringSnapshotError("capacity", "Too many active file-list cursors.");
      next_cursor = crypto.randomUUID();
      this.cursors.set(next_cursor, Object.freeze({
        snapshot_id: lease.snapshot.id,
        scope_key,
        prefix,
        source_cursor: page.next_cursor,
        last_path,
        expires_at: this.now() + CURSOR_TTL_MS,
      }));
    }
    return Object.freeze({ items: Object.freeze(items), next_cursor });
  }

  async read(lease: SnapshotLease, path: string, options: {
    readonly offset?: number;
    readonly length?: number;
  } = {}): Promise<SnapshotRange & { readonly next_offset: number | null }> {
    validateLease(lease, lease.scope, lease.snapshot.draft_generation !== null);
    validatePath(path);
    const offset = options.offset ?? 0;
    const length = options.length ?? 65_536;
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalid("offset must be a non-negative safe integer");
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_READ_CHUNK) throw invalid(`length must be between 0 and ${MAX_READ_CHUNK}`);

    await this.assertCurrent(lease);
    const file = validateFile(await this.port.stat(lease, path), "", path);
    if (offset > file.byte_length) throw invalid("offset is beyond end of file");
    const read_length = Math.min(length, file.byte_length - offset);
    const bytes = await this.readAndVerify(lease, file, offset, read_length);
    await this.assertCurrent(lease);
    const next = offset + bytes.byteLength;
    return Object.freeze({
      bytes,
      total_bytes: file.byte_length,
      offset,
      revision: file.revision,
      next_offset: next < file.byte_length ? next : null,
    });
  }

  release(lease: SnapshotLease): void {
    for (const [token, cursor] of this.cursors) {
      if (cursor.snapshot_id === lease.snapshot.id && cursor.scope_key === scopeKey(lease.scope)) this.cursors.delete(token);
    }
    const keyPrefix = `${scopeKey(lease.scope)}\u0000${lease.snapshot.id}\u0000`;
    for (const key of this.verified.keys()) if (key.startsWith(keyPrefix)) this.verified.delete(key);
  }

  private async readAndVerify(lease: SnapshotLease, file: SnapshotFile, offset: number, length: number): Promise<Uint8Array> {
    const cacheKey = `${scopeKey(lease.scope)}\u0000${lease.snapshot.id}\u0000${file.path}\u0000${file.revision}`;
    if (!this.verified.has(cacheKey)) {
      const hash = new StreamingSha256();
      let consumed = 0;
      let selected: Uint8Array | undefined;
      const selectedEnd = offset + length;
      while (consumed < file.byte_length) {
        const chunkLength = Math.min(MAX_READ_CHUNK, file.byte_length - consumed);
        const chunk = await this.port.read_range(lease, file.path, consumed, chunkLength);
        if (!chunk || chunk.offset !== consumed || chunk.total_bytes !== file.byte_length || chunk.revision !== file.revision ||
            !(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength !== chunkLength) {
          throw new AuthoringSnapshotError("snapshot_stale", `Pinned bytes for ${file.path} no longer match the listed revision.`);
        }
        hash.update(chunk.bytes);
        const chunkEnd = consumed + chunk.bytes.byteLength;
        const copyStart = Math.max(offset, consumed);
        const copyEnd = Math.min(selectedEnd, chunkEnd);
        if (copyEnd > copyStart) {
          const slice = chunk.bytes.subarray(copyStart - consumed, copyEnd - consumed);
          if (!selected) selected = new Uint8Array(length);
          selected.set(slice, copyStart - offset);
        }
        consumed = chunkEnd;
      }
      if (hash.hex() !== file.revision) {
        throw new AuthoringSnapshotError("snapshot_stale", `SHA-256 verification failed for ${file.path}.`);
      }
      if (length > 0 && (!selected || selected.byteLength !== length)) {
        throw new AuthoringSnapshotError("storage_unknown", `Host did not return the requested range for ${file.path}.`);
      }
      this.rememberVerified(cacheKey, {
        scope_key: scopeKey(lease.scope), snapshot_id: lease.snapshot.id, path: file.path, revision: file.revision,
      });
      return selected ?? new Uint8Array();
    }
    if (length === 0) return new Uint8Array();
    const response = await this.port.read_range(lease, file.path, offset, length);
    if (!response || response.offset !== offset || response.total_bytes !== file.byte_length || response.revision !== file.revision ||
        !(response.bytes instanceof Uint8Array) || response.bytes.byteLength !== length) {
      throw new AuthoringSnapshotError("snapshot_stale", `Pinned bytes for ${file.path} no longer match the listed revision.`);
    }
    return response.bytes.slice();
  }

  private rememberVerified(key: string, value: CachedVerification): void {
    this.verified.delete(key);
    this.verified.set(key, Object.freeze(value));
    while (this.verified.size > MAX_VERIFIED_FILES) {
      const oldest = this.verified.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.verified.delete(oldest);
    }
  }

  private pruneCursors(): void {
    const current = this.now();
    for (const [token, cursor] of this.cursors) if (cursor.expires_at <= current) this.cursors.delete(token);
  }

  private async assertCurrent(lease: SnapshotLease): Promise<void> {
    try { await this.port.assert_current(lease); }
    catch (error) {
      if (error instanceof AuthoringSnapshotError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "snapshot_stale") throw new AuthoringSnapshotError("snapshot_stale", error instanceof Error ? error.message : "Snapshot is stale.");
      throw new AuthoringSnapshotError("storage_unknown", "Host could not verify the pinned workspace snapshot.");
    }
  }
}

function validateScope(scope: AuthoringScope): void {
  if (!scope || typeof scope !== "object" || typeof scope.workspace_id !== "string" || !scope.workspace_id || scope.workspace_id.length > 256 ||
      !(scope.repository_id === null || (Number.isSafeInteger(scope.repository_id) && scope.repository_id > 0)) ||
      typeof scope.branch !== "string" || !scope.branch || scope.branch.length > 256 ||
      typeof scope.generation !== "string" || !scope.generation || scope.generation.length > 256) throw invalid("Workspace scope is invalid");
}

function validateLease(lease: SnapshotLease, expectedScope: AuthoringScope, includeDraft: boolean): void {
  validateScope(expectedScope);
  if (!lease || !lease.scope || !lease.snapshot || typeof lease.host_token === "undefined") throw invalid("Host snapshot lease is invalid");
  validateScope(lease.scope);
  const snapshot = lease.snapshot;
  if (scopeKey(lease.scope) !== scopeKey(expectedScope) || typeof snapshot.id !== "string" || !snapshot.id || snapshot.id.length > 256 ||
      !(snapshot.local_commit === null || (typeof snapshot.local_commit === "string" && snapshot.local_commit.length <= 256)) ||
      typeof snapshot.worktree_generation !== "string" || !snapshot.worktree_generation || snapshot.worktree_generation.length > 256 ||
      !(snapshot.draft_generation === null || (typeof snapshot.draft_generation === "string" && snapshot.draft_generation.length > 256)) ||
      (includeDraft ? snapshot.draft_generation === null : snapshot.draft_generation !== null)) {
    throw invalid("Host snapshot lease does not match its requested scope or draft selection");
  }
}

function freezeLease(lease: SnapshotLease): SnapshotLease {
  return Object.freeze({
    scope: Object.freeze({ ...lease.scope }),
    snapshot: Object.freeze({ ...lease.snapshot }),
    host_token: lease.host_token,
  });
}

function validateFile(value: SnapshotFile | null, prefix: string, expectedPath?: string): SnapshotFile {
  if (!value || typeof value !== "object") throw new AuthoringSnapshotError("file_not_found", `File ${expectedPath ?? ""} is absent from this snapshot.`);
  validatePath(value.path);
  if ((expectedPath !== undefined && value.path !== expectedPath) || !value.path.startsWith(prefix) ||
      typeof value.revision !== "string" || !SHA256.test(value.revision) ||
      !Number.isSafeInteger(value.byte_length) || value.byte_length < 0 ||
      typeof value.media_type !== "string" || value.media_type.length < 1 || value.media_type.length > 256) {
    throw new AuthoringSnapshotError("storage_unknown", "Host returned invalid file metadata.");
  }
  return Object.freeze({ path: value.path, revision: value.revision, byte_length: value.byte_length, media_type: value.media_type });
}

function validatePath(path: string): void {
  try { validateGitPath(path); }
  catch { throw new AuthoringSnapshotError("invalid_path", "Expected a safe repository-relative UTF-8 file path."); }
}

function validatePrefix(prefix: string): void {
  if (typeof prefix !== "string" || prefix.length > 1024 || prefix.startsWith("/") || prefix.includes("\\") || prefix.includes("\0")) {
    throw invalid("prefix is not a safe repository-relative path prefix");
  }
  if (!prefix) return;
  const partial = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (!partial) throw invalid("prefix is invalid");
  for (const segment of partial.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment === ".git") throw invalid("prefix contains a forbidden path component");
  }
}

function compareUtf8Path(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

function scopeKey(scope: AuthoringScope): string {
  return JSON.stringify([scope.workspace_id, scope.repository_id, scope.branch, scope.generation]);
}

function invalid(message: string): AuthoringSnapshotError {
  return new AuthoringSnapshotError("invalid_input", message);
}

/** Small streaming SHA-256 so even very large selected files stay chunk-bounded. */
class StreamingSha256 {
  private static readonly K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  private readonly state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private buffered = 0;
  private bytes = 0;
  private finished?: string;

  update(data: Uint8Array): void {
    if (this.finished) throw new Error("SHA-256 digest is already finalized");
    this.bytes += data.byteLength;
    let offset = 0;
    if (this.buffered) {
      const count = Math.min(64 - this.buffered, data.byteLength);
      this.block.set(data.subarray(0, count), this.buffered);
      this.buffered += count;
      offset = count;
      if (this.buffered === 64) { this.transform(this.block); this.buffered = 0; }
    }
    while (offset + 64 <= data.byteLength) { this.transform(data.subarray(offset, offset + 64)); offset += 64; }
    if (offset < data.byteLength) {
      this.block.set(data.subarray(offset), 0);
      this.buffered = data.byteLength - offset;
    }
  }

  hex(): string {
    if (this.finished) return this.finished;
    const bitLength = this.bytes * 8;
    this.block[this.buffered++] = 0x80;
    if (this.buffered > 56) {
      this.block.fill(0, this.buffered);
      this.transform(this.block);
      this.buffered = 0;
    }
    this.block.fill(0, this.buffered, 56);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    const view = new DataView(this.block.buffer);
    view.setUint32(56, high, false);
    view.setUint32(60, low, false);
    this.transform(this.block);
    this.finished = [...this.state].map(word => word.toString(16).padStart(8, "0")).join("");
    return this.finished;
  }

  private transform(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!; const y = words[index - 2]!;
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + sum1 + choice + StreamingSha256.K[index]! + words[index]!) >>> 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const result = [a!,b!,c!,d!,e!,f!,g!,h!];
    for (let index = 0; index < 8; index += 1) this.state[index] = (this.state[index]! + result[index]!) >>> 0;
  }
}

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
