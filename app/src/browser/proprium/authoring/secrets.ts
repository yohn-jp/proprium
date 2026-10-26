import { AuthoringError, type Scope } from "./types.js";

export type PublishingShareScope = Readonly<{ kind: "project" | "volume" | "chapter" | "scene"; id: string }>;
export type PublishingSecretState = "pending" | "approved" | "rejected" | "expired" | "revealed";

export interface ShareProviderConfiguration {
  readonly service_id: string;
  readonly origin: string;
  readonly host_public_origin: string;
  readonly reader_version: 1;
  readonly max_expiry_hours: number;
  /** Fixed owner-managed endpoint table. Provider responses never select a URL. */
  readonly endpoints: Readonly<{ capabilities: string; metadata: string; read_scene: string }>;
}

export interface SecretCreateRequest {
  readonly request_id: string;
  /** Stable Host hash of workspace/plugin/action/idempotency_key. */
  readonly idempotency_id: string;
  /** Host's canonical typed ActionRequest digest; prevents same-ID payload substitution. */
  readonly request_digest: string;
  readonly consent_fingerprint: string;
  readonly scope: Scope;
  readonly repository_id: number;
  readonly branch: string;
  readonly remote_commit: string;
  readonly grant_scope: PublishingShareScope;
  readonly expires_at: string;
  readonly provider: ShareProviderConfiguration;
  readonly provider_capability: { readonly available: true; readonly service_id: string; readonly max_expiry_hours: number };
  readonly destination_consent: object;
}

export interface GestureAuthority {
  consume(token: object): boolean;
}
export interface DestinationConsentRequest {
  readonly service_id: string;
  readonly origin: string;
  readonly host_public_origin: string;
  readonly repository_id: number;
  readonly branch: string;
  readonly remote_commit: string;
  readonly grant_scope: PublishingShareScope;
  readonly expires_at: string;
}

/** Consent tokens are Host-minted after a real gesture and bind the exact egress. */
export class ShareDestinationConsentAuthority {
  private readonly grants = new WeakMap<object, DestinationConsentRequest>();
  issue(event: Event, request: DestinationConsentRequest): object {
    if (!event.isTrusted) throw denied("A trusted user gesture is required to consent to sharing.");
    const token = Object.freeze({});
    this.grants.set(token, structuredClone(request));
    return token;
  }
  consume(token: object, request: DestinationConsentRequest): boolean {
    const grant = this.grants.get(token);
    if (!grant || canonicalConsent(grant) !== canonicalConsent(request)) return false;
    this.grants.delete(token);
    return true;
  }
}

export interface SecretHandle {
  readonly handle: string;
  readonly sha256: string;
}

interface PendingSecret {
  readonly request_id: string;
  readonly idempotency_id: string;
  readonly scope: Scope;
  readonly repository_id: number;
  readonly branch: string;
  readonly service_id: string;
  readonly grant_scope: PublishingShareScope;
  readonly expires_at: string;
  readonly token_ascii: Uint8Array;
  readonly request_digest: string;
  readonly consent_fingerprint: string;
  proposal_id?: string;
  grant_id?: string;
  state: PublishingSecretState;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const GRANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class PublishingSecretError extends AuthoringError {
  constructor(code: string, message: string) { super(code, message); this.name = "PublishingSecretError"; }
}

/**
 * The raw bearer lives only in this page's memory. Its ASCII bytes are never
 * persisted, sent to a guest, added to a receipt, or returned by an action.
 */
export class PublishingSecretBroker {
  private readonly byHandle = new Map<string, PendingSecret>();
  private readonly byIdempotency = new Map<string, string>();
  private readonly byInvocation = new Map<string, string>();
  private readonly byProposal = new Map<string, string>();

  constructor(private readonly gestures: GestureAuthority, private readonly consent: ShareDestinationConsentAuthority,
    private readonly now = () => Date.now()) {}

  async create(request: SecretCreateRequest, gesture: object): Promise<SecretHandle> {
    if (!this.gestures.consume(gesture)) throw denied("Share creation needs a fresh owner gesture.");
    validateCreate(request, this.now());
    const consent: DestinationConsentRequest = {
      service_id: request.provider.service_id,
      origin: httpsOrigin(request.provider.origin),
      host_public_origin: httpsOrigin(request.provider.host_public_origin),
      repository_id: request.repository_id,
      branch: request.branch,
      remote_commit: request.remote_commit,
      grant_scope: request.grant_scope,
      expires_at: request.expires_at,
    };
    const consent_fingerprint = canonicalConsent(consent);
    const old = this.byIdempotency.get(request.idempotency_id);
    if (old) {
      const prior = this.byHandle.get(old);
      if (prior && Date.parse(prior.expires_at) <= this.now()) {
        this.destroy(old, "expired");
        throw new PublishingSecretError("file_not_found", "The one-time share token expired. Create a replacement proposal.");
      }
      if (prior && prior.request_digest === request.request_digest && prior.consent_fingerprint === consent_fingerprint) {
        this.byInvocation.set(request.request_id, request.idempotency_id);
        return { handle: old, sha256: await sha256(prior.token_ascii) };
      }
      if (prior) throw new PublishingSecretError("idempotency_conflict", "This action key already names a different share request or provider authorization.");
      throw new PublishingSecretError("storage_unknown", "An earlier share token attempt cannot be recovered. Create a replacement after checking pending proposals.");
    }
    if (!this.consent.consume(request.destination_consent, consent)) throw denied("Share destination or selected content has not been explicitly approved.");
    const encoded = encodeBase64Url(cryptoRandomBytes(32));
    const tokenBytes = new TextEncoder().encode(encoded);
    const digest = await sha256(tokenBytes);
    const handle = encodeBase64Url(cryptoRandomBytes(24));
    const secret: PendingSecret = {
      request_id: request.request_id,
      idempotency_id: request.idempotency_id,
      scope: Object.freeze({ ...request.scope }),
      repository_id: request.repository_id,
      branch: request.branch,
      service_id: request.provider.service_id,
      grant_scope: Object.freeze({ ...request.grant_scope }),
      expires_at: request.expires_at,
      token_ascii: tokenBytes,
      request_digest: request.request_digest,
      consent_fingerprint,
      state: "pending",
    };
    this.byHandle.set(handle, secret);
    this.byIdempotency.set(request.idempotency_id, handle);
    this.byInvocation.set(request.request_id, request.idempotency_id);
    return Object.freeze({ handle, sha256: digest });
  }

  /** Called only after the Host has durably admitted the matching proposal. */
  associateProposal(idempotencyId: string, proposalId: string, grantId: string): void {
    const handle = this.byIdempotency.get(idempotencyId);
    const secret = handle && this.byHandle.get(handle);
    if (!secret || secret.state !== "pending" || !validOpaque(proposalId) || !GRANT.test(grantId) ||
        this.byProposal.has(proposalId)) throw new PublishingSecretError("invalid_input", "Share proposal association is invalid.");
    secret.proposal_id = proposalId;
    secret.grant_id = grantId;
    this.byProposal.set(proposalId, handle);
  }

  /** Rejection/cancellation removes the raw token before any UI result is returned. */
  rejectProposal(proposalId: string): void { this.destroyProposal(proposalId, "rejected"); }
  cancelRequest(requestId: string): void {
    const idempotencyId = this.byInvocation.get(requestId);
    const handle = idempotencyId && this.byIdempotency.get(idempotencyId);
    if (handle) this.destroy(handle, "rejected");
  }

  /** Host calls this only after its durable local writer receipt says the proposal applied. */
  markApplied(proposalId: string): void {
    const handle = this.byProposal.get(proposalId);
    const secret = handle && this.byHandle.get(handle);
    if (!secret || secret.state !== "pending" || Date.parse(secret.expires_at) <= this.now()) {
      if (handle) this.destroy(handle, "expired");
      throw new PublishingSecretError("file_not_found", "The one-time share token is unavailable.");
    }
    secret.state = "approved";
  }

  /** The only method that reveals a raw URL. It requires UI authority and consumes the buffer. */
  revealApprovedUrl(handle: string, caller: "ui" | "mcp" | "plugin", gesture: object,
    publicOrigin: string): string {
    if (caller !== "ui" || !this.gestures.consume(gesture)) throw denied("Only an explicit owner gesture can reveal a share URL.");
    const secret = this.byHandle.get(handle);
    if (!secret || secret.state !== "approved" || !secret.proposal_id || !secret.grant_id) {
      throw new PublishingSecretError("file_not_found", "The one-time share URL is unavailable.");
    }
    if (Date.parse(secret.expires_at) <= this.now()) {
      this.destroy(handle, "expired");
      throw new PublishingSecretError("file_not_found", "The one-time share URL is unavailable.");
    }
    const expected = safeOrigin(publicOrigin);
    const token = new TextDecoder("ascii", { fatal: true }).decode(secret.token_ascii);
    if (!TOKEN.test(token)) {
      this.destroy(handle, "rejected");
      throw new PublishingSecretError("storage_unknown", "The one-time share URL could not be verified.");
    }
    const url = new URL(`/r/publishing/${secret.repository_id}/${encodeURIComponent(secret.grant_id)}`, expected);
    url.hash = new URLSearchParams({ token }).toString();
    secret.token_ascii.fill(0);
    secret.state = "revealed";
    this.byHandle.delete(handle);
    this.byIdempotency.delete(secret.idempotency_id);
    for (const [request, key] of this.byInvocation) if (key === secret.idempotency_id) this.byInvocation.delete(request);
    this.byProposal.delete(secret.proposal_id);
    return url.href;
  }

  /** Safe metadata is intentionally hash-free after the action result leaves its guest. */
  status(proposalId: string): PublishingSecretState | "unavailable" {
    const handle = this.byProposal.get(proposalId);
    const secret = handle && this.byHandle.get(handle);
    if (!secret) return "unavailable";
    if (Date.parse(secret.expires_at) <= this.now()) {
      this.destroy(handle!, "expired");
      return "expired";
    }
    return secret.state;
  }

  /** Clear ephemeral material on page close, plugin cancellation, or explicit disable. */
  clear(): void { for (const handle of [...this.byHandle.keys()]) this.destroy(handle, "rejected"); }

  private destroyProposal(proposalId: string, state: "rejected" | "expired"): void {
    const handle = this.byProposal.get(proposalId);
    if (handle) this.destroy(handle, state);
  }
  private destroy(handle: string, state: "rejected" | "expired"): void {
    const secret = this.byHandle.get(handle);
    if (!secret) return;
    secret.token_ascii.fill(0);
    secret.state = state;
    this.byHandle.delete(handle);
    this.byIdempotency.delete(secret.idempotency_id);
    for (const [request, key] of this.byInvocation) if (key === secret.idempotency_id) this.byInvocation.delete(request);
    if (secret.proposal_id) this.byProposal.delete(secret.proposal_id);
  }
}

export interface ReaderRouteSecret {
  readonly repository_id: number;
  readonly grant_id: string;
  readonly lease: object;
}

/** Keeps the fragment token in a WeakMap and removes it from browser history first. */
export class ReaderSecretLeaseVault {
  private readonly tokens = new WeakMap<object, { readonly bearer: string; readonly repository_id: number; readonly grant_id: string }>();

  takeFromLocation(location: Pick<Location, "pathname" | "search" | "hash">,
    history: Pick<History, "state" | "replaceState">): ReaderRouteSecret {
    const match = /^\/r\/publishing\/([1-9]\d{0,15})\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/?$/u.exec(location.pathname);
    const repository_id = match ? Number(match[1]) : NaN;
    const grant_id = match?.[2] ?? "";
    const fragments = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
    const bearer = fragments.get("token") ?? "";
    const valid = Number.isSafeInteger(repository_id) && repository_id > 0 && GRANT.test(grant_id) &&
      TOKEN.test(bearer) && [...fragments.keys()].every(key => key === "token") && fragments.getAll("token").length === 1;
    // Erase the bearer before checking service configuration or making any request.
    history.replaceState(history.state, "", location.pathname);
    if (!valid) throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    const lease = Object.freeze({});
    this.tokens.set(lease, { bearer, repository_id, grant_id });
    return Object.freeze({ repository_id, grant_id, lease });
  }

  withBearer<T>(lease: object, expected: { readonly repository_id: number; readonly grant_id: string },
    use: (bearer: string) => Promise<T>): Promise<T> {
    const secret = this.tokens.get(lease);
    if (!secret || secret.repository_id !== expected.repository_id || secret.grant_id !== expected.grant_id) {
      throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    }
    return use(secret.bearer);
  }

  clear(lease: object): void { this.tokens.delete(lease); }
}

export interface ShareReaderCapabilities {
  readonly available: boolean;
  readonly service_id: string;
  readonly origin: string;
  readonly host_public_origin: string;
  readonly reader_version: 1;
  readonly max_expiry_hours: number;
  readonly reason?: "provider_unavailable" | "repository_unavailable" | "service_unavailable" | "external_state_unknown" | "unsupported_reader_version";
}
export interface ShareReaderMetadata {
  readonly remote_snapshot: { readonly repository_id: number; readonly branch: string; readonly remote_commit: string };
  readonly scope: PublishingShareScope;
  readonly label: string;
  readonly expires_at: string;
  readonly items: readonly { readonly id: string; readonly kind: string; readonly title: string; readonly parent_id: string | null }[];
  readonly next_cursor: string | null;
}
export interface ShareReaderScenePage {
  readonly remote_snapshot: { readonly repository_id: number; readonly branch: string; readonly remote_commit: string };
  readonly scene: { readonly id: string; readonly title: string; readonly revision: string; readonly total_bytes: number; readonly offset: number; readonly bytes: Uint8Array; readonly next_offset: number | null };
}
export interface ShareReaderTransport {
  capabilities(input: { repository_id: number; branch: string; remote_commit: string | null }, signal?: AbortSignal): Promise<ShareReaderCapabilities>;
  metadata(input: { service_id: string; repository_id: number; grant_id: string; cursor?: string; limit?: number }, bearer: string,
    signal?: AbortSignal): Promise<ShareReaderMetadata>;
  read_scene(input: { service_id: string; repository_id: number; grant_id: string; scene_id: string; expected_remote_commit: string; offset?: number; length?: number }, bearer: string,
    signal?: AbortSignal): Promise<ShareReaderScenePage>;
}

/**
 * HTTPS JSON transport for the one configured provider. It has no endpoint
 * discovery, credential fallback, cookie access or redirect following.
 */
export class FixedOriginShareReaderTransport implements ShareReaderTransport {
  constructor(private readonly config: ShareProviderConfiguration, private readonly fetcher: typeof fetch = fetch) {
    validateConfiguration(config);
  }
  async capabilities(input: { repository_id: number; branch: string; remote_commit: string | null }, signal?: AbortSignal): Promise<ShareReaderCapabilities> {
    return this.post("capabilities", input, undefined, signal);
  }
  async metadata(input: { service_id: string; repository_id: number; grant_id: string; cursor?: string; limit?: number }, bearer: string,
    signal?: AbortSignal): Promise<ShareReaderMetadata> {
    return this.post("metadata", input, bearer, signal);
  }
  async read_scene(input: { service_id: string; repository_id: number; grant_id: string; scene_id: string; expected_remote_commit: string; offset?: number; length?: number }, bearer: string,
    signal?: AbortSignal): Promise<ShareReaderScenePage> {
    return this.post("read_scene", input, bearer, signal);
  }
  private async post<T>(operation: keyof ShareProviderConfiguration["endpoints"], payload: unknown, bearer?: string,
    signal?: AbortSignal): Promise<T> {
    const endpoint = this.config.endpoints[operation];
    if (bearer !== undefined && !TOKEN.test(bearer)) throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json" };
    if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST", headers, body: JSON.stringify(payload), signal, redirect: "error",
        credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", mode: "cors",
      });
    } catch {
      throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    }
    // The provider intentionally gives indistinguishable responses for invalid,
    // expired, revoked and out-of-scope bearer requests.
    if (response.status === 401 || response.status === 404) throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    if (response.status === 409) throw new PublishingSecretError("snapshot_stale", "This shared reading link is unavailable.");
    if (!response.ok) throw new PublishingSecretError(response.status >= 500 ? "provider_unavailable" : "provider_unavailable", "This shared reading link is unavailable.");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    const text = await boundedResponseText(response, 1024 * 1024);
    let decoded: unknown;
    try { decoded = JSON.parse(text) as unknown; }
    catch { throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable."); }
    if (operation === "read_scene") {
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
      const scene = (decoded as { scene?: Record<string, unknown> }).scene;
      const bytes = scene?.bytes;
      if (!scene || !Array.isArray(bytes) || bytes.length > 256 * 1024 ||
          bytes.some(byte => !Number.isSafeInteger(byte) || byte < 0 || byte > 255)) {
        throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
      }
      return { ...(decoded as object), scene: { ...scene, bytes: Uint8Array.from(bytes) } } as T;
    }
    return decoded as T;
  }
}

/** Fixed-origin HTTPS adapter. Endpoint locations come from local static Host config. */
export class PublishingShareReaderAdapter {
  constructor(private readonly configuration: ShareProviderConfiguration | null, private readonly transport: ShareReaderTransport | null) {}

  async capabilities(repository_id: number, branch: string, remote_commit: string | null, signal?: AbortSignal): Promise<ShareReaderCapabilities> {
    if (!this.configuration || !this.transport || !repository_id || !branch || !remote_commit) return unavailableCapabilities(this.configuration);
    const value = await this.transport.capabilities({ repository_id, branch, remote_commit }, signal);
    validateCapabilities(value, this.configuration);
    return value;
  }

  takeRouteFromLocation(location: Pick<Location, "pathname" | "search" | "hash">,
    history: Pick<History, "state" | "replaceState">): ReaderRouteSecret {
    return this.vault.takeFromLocation(location, history);
  }

  async metadata(route: ReaderRouteSecret, cursor?: string, limit = 100, signal?: AbortSignal): Promise<ShareReaderMetadata> {
    const config = this.requireConfigured();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (cursor !== undefined && cursor.length > 2048)) throw invalid("Reader page request is invalid.");
    const result = await this.vaultRequest(route, bearer => this.transport!.metadata({ service_id: config.service_id,
      repository_id: route.repository_id, grant_id: route.grant_id, ...(cursor ? { cursor } : {}), limit }, bearer, signal));
    validateMetadata(result, route.repository_id);
    return result;
  }

  async readScene(route: ReaderRouteSecret, scene_id: string, expected_remote_commit: string, offset = 0,
    length = 65536, signal?: AbortSignal): Promise<ShareReaderScenePage> {
    const config = this.requireConfigured();
    if (!GRANT.test(scene_id) || !SHA256.test(expected_remote_commit) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024) throw invalid("Reader scene range is invalid.");
    const result = await this.vaultRequest(route, bearer => this.transport!.read_scene({ service_id: config.service_id,
      repository_id: route.repository_id, grant_id: route.grant_id, scene_id, expected_remote_commit, offset, length }, bearer, signal));
    validateScenePage(result, route.repository_id, scene_id, expected_remote_commit, offset, length);
    return result;
  }

  clear(route: ReaderRouteSecret): void { this.vault.clear(route.lease); }
  private readonly vault = new ReaderSecretLeaseVault();
  private vaultRequest<T>(route: ReaderRouteSecret, use: (bearer: string) => Promise<T>): Promise<T> {
    return this.vault.withBearer(route.lease, route, async bearer => {
      try { return await use(bearer); }
      catch { throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable."); }
    });
  }
  private requireConfigured(): ShareProviderConfiguration {
    if (!this.configuration || !this.transport) throw new PublishingSecretError("provider_unavailable", "The sharing service is unavailable.");
    validateConfiguration(this.configuration);
    return this.configuration;
  }
}

export function readonlyReaderHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
}

function validateCreate(request: SecretCreateRequest, now: number): void {
  if (!request || !validOpaque(request.request_id) || !SHA256.test(request.idempotency_id) ||
      !SHA256.test(request.request_digest) || !validScope(request.scope) ||
      !Number.isSafeInteger(request.repository_id) || request.repository_id < 1 || request.scope.repository_id !== request.repository_id ||
      !request.branch || request.scope.branch !== request.branch || !SHA256.test(request.remote_commit) ||
      !request.grant_scope || !["volume", "chapter", "scene"].includes(request.grant_scope.kind) || !GRANT.test(request.grant_scope.id) ||
      !Number.isFinite(Date.parse(request.expires_at)) || Date.parse(request.expires_at) <= now ||
      !request.provider_capability?.available || request.provider_capability.service_id !== request.provider.service_id ||
      request.provider_capability.max_expiry_hours !== request.provider.max_expiry_hours || !request.destination_consent ||
      !validProviderPair(request.provider)) throw denied("The configured provider, current remote snapshot, or explicit sharing consent is unavailable.");
  const hours = (Date.parse(request.expires_at) - now) / 3_600_000;
  if (hours > request.provider.max_expiry_hours || hours > 87600) throw invalid("Share expiry exceeds the provider limit.");
}
function validProviderPair(value: ShareProviderConfiguration): boolean {
  try {
    validateConfiguration(value);
    return value.reader_version === 1 && Number.isSafeInteger(value.max_expiry_hours) && value.max_expiry_hours >= 1 && value.max_expiry_hours <= 87600;
  } catch { return false; }
}
function validateConfiguration(config: ShareProviderConfiguration): void {
  const origin = httpsOrigin(config.origin), publicOrigin = httpsOrigin(config.host_public_origin);
  if (!config.service_id || config.service_id.length > 128 || config.reader_version !== 1 ||
      !Number.isSafeInteger(config.max_expiry_hours) || config.max_expiry_hours < 1 || config.max_expiry_hours > 87600 ||
      !config.endpoints) throw new PublishingSecretError("provider_unavailable", "The configured reader service is unavailable.");
  for (const endpoint of Object.values(config.endpoints)) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password || parsed.hash || parsed.search) {
      throw new PublishingSecretError("provider_unavailable", "The configured reader service is unavailable.");
    }
  }
  if (!publicOrigin) throw new PublishingSecretError("provider_unavailable", "The configured reader service is unavailable.");
}
function validateCapabilities(value: ShareReaderCapabilities, config: ShareProviderConfiguration): void {
  if (!value || value.service_id !== config.service_id || value.origin !== httpsOrigin(config.origin) ||
      value.host_public_origin !== httpsOrigin(config.host_public_origin) || value.reader_version !== 1 ||
      !Number.isSafeInteger(value.max_expiry_hours) || value.max_expiry_hours < 1 || value.max_expiry_hours > config.max_expiry_hours ||
      typeof value.available !== "boolean" || (value.available && value.reason !== undefined) ||
      (!value.available && !value.reason)) throw new PublishingSecretError("provider_unavailable", "The configured reader service is unavailable.");
}
function validateMetadata(value: ShareReaderMetadata, repository_id: number): void {
  if (!value || value.remote_snapshot?.repository_id !== repository_id || !SHA256.test(value.remote_snapshot.remote_commit) ||
      !value.remote_snapshot.branch || !value.scope || !["project", "volume", "chapter", "scene"].includes(value.scope.kind) ||
      !GRANT.test(value.scope.id) || !value.label || value.label.length > 120 ||
      !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now() ||
      !Array.isArray(value.items) || value.items.length > 200 ||
      !(value.next_cursor === null || typeof value.next_cursor === "string" && value.next_cursor.length <= 2048) ||
      value.items.some(item => !item || !GRANT.test(item.id) || !["volume", "chapter", "scene"].includes(item.kind) || !item.title || item.title.length > 1000 ||
        !(item.parent_id === null || typeof item.parent_id === "string" && GRANT.test(item.parent_id)))) {
    throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
  }
}
function validateScenePage(value: ShareReaderScenePage, repo: number, scene: string, expected: string, offset: number, length: number): void {
  const result = value?.scene; const snapshot = value?.remote_snapshot;
  if (!snapshot || snapshot.repository_id !== repo || !SHA256.test(snapshot.remote_commit) || snapshot.remote_commit !== expected ||
      !snapshot.branch || !result || result.id !== scene || !result.title || result.title.length > 1000 || !SHA256.test(result.revision) ||
      !Number.isSafeInteger(result.total_bytes) || result.total_bytes < 0 || result.offset !== offset ||
      !(result.bytes instanceof Uint8Array) || result.bytes.byteLength > length || offset + result.bytes.byteLength > result.total_bytes ||
      !(result.next_offset === null || result.next_offset === offset + result.bytes.byteLength && result.next_offset < result.total_bytes) ||
      (result.next_offset === null) !== (offset + result.bytes.byteLength === result.total_bytes)) {
    throw new PublishingSecretError(snapshot?.remote_commit === expected ? "provider_unavailable" : "snapshot_stale", "This shared reading link is unavailable.");
  }
}
function unavailableCapabilities(config: ShareProviderConfiguration | null): ShareReaderCapabilities {
  return { available: false, service_id: config?.service_id ?? "unavailable", origin: config?.origin ?? "https://invalid.example",
    host_public_origin: config?.host_public_origin ?? "https://invalid.example", reader_version: 1,
    max_expiry_hours: config?.max_expiry_hours ?? 1, reason: "provider_unavailable" };
}
function safeOrigin(value: string): string {
  const parsed = httpsOrigin(value);
  if (parsed !== value.replace(/\/$/u, "")) throw denied("The owner page origin does not match its fixed static Host configuration.");
  return parsed;
}
function httpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== value.replace(/\/$/u, "") || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PublishingSecretError("provider_unavailable", "The configured HTTPS origin is invalid.");
  }
  return parsed.origin;
}
function validScope(scope: Scope): boolean {
  return !!scope && typeof scope.workspace_id === "string" && !!scope.workspace_id &&
    (scope.repository_id === null || Number.isSafeInteger(scope.repository_id) && scope.repository_id > 0) &&
    typeof scope.branch === "string" && !!scope.branch && typeof scope.generation === "string" && !!scope.generation;
}
function canonicalConsent(request: DestinationConsentRequest): string {
  return JSON.stringify([request.service_id, request.origin, request.host_public_origin, request.repository_id,
    request.branch, request.remote_commit, request.grant_scope.kind, request.grant_scope.id, request.expires_at]);
}
function validOpaque(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value); }
function denied(message: string): PublishingSecretError { return new PublishingSecretError("capability_denied", message); }
function invalid(message: string): PublishingSecretError { return new PublishingSecretError("invalid_input", message); }
function cryptoRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) throw new PublishingSecretError("storage_unknown", "Secure random tokens are unavailable.");
  return crypto.getRandomValues(new Uint8Array(length));
}
async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new PublishingSecretError("storage_unknown", "Secure token hashing is unavailable.");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function encodeBase64Url(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!; const b = bytes[i + 1]; const c = bytes[i + 2];
    value += BASE64URL[a >> 2]! + BASE64URL[(a & 3) << 4 | (b === undefined ? 0 : b >> 4)]!;
    if (b !== undefined) value += BASE64URL[(b & 15) << 2 | (c === undefined ? 0 : c >> 6)]!;
    if (c !== undefined) value += BASE64URL[c & 63]!;
  }
  return value;
}
async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximum) throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable.");
    return text;
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0; let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable."); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch { throw new PublishingSecretError("provider_unavailable", "This shared reading link is unavailable."); }
  finally { reader.releaseLock(); }
}
