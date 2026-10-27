import { AuthoringError, type Scope, type Snapshot } from "./types.js";

export const PROVIDER_OUTPUT_LIMIT = 1024 * 1024;
export const PROVIDER_DEADLINE_MS = 120_000;
const REQUEST_LIMIT = 1024 * 1024;
const CONSENT_TTL_MS = 30_000;

export interface ProviderRequestInput {
  readonly request_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly purpose: string;
  readonly payload: unknown;
  readonly source_manifest: unknown;
  readonly max_output_bytes: number;
}

/** These fields are supplied by the trusted Host invocation, never the guest. */
export interface ProviderRequestContext {
  readonly plugin_id: string;
  readonly action_id: string;
  readonly scope: Scope;
  readonly snapshot: Snapshot;
}

export interface ProviderModelConfiguration {
  readonly model_id: string;
  readonly label: string;
  /** A Host-maintained estimate. Omit when the cost is not known. */
  readonly estimated_cost?: string;
}

/** Static Host configuration. The guest cannot select an endpoint or credential. */
export interface ProviderConfiguration {
  readonly provider_id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly credential_handle: string;
  readonly models: readonly ProviderModelConfiguration[];
}

export interface ProviderCredentialResolver {
  resolve(handle: string): Promise<string | undefined>;
}

export type ProviderStatus =
  | { readonly state: "completed" }
  | { readonly state: "pending" | "not_found" | "unknown" };

/**
 * Optional provider-specific status lookup. It must query the existing request
 * ID only; the broker never calls the provider request endpoint a second time.
 */
export type ProviderStatusQuery = (input: {
  readonly provider_id: string;
  readonly endpoint: string;
  readonly request_id: string;
  readonly credential: string;
  readonly signal: AbortSignal;
}) => Promise<ProviderStatus>;

export interface ProviderBrokerOptions {
  readonly providers?: readonly ProviderConfiguration[];
  readonly credentials?: ProviderCredentialResolver;
  readonly gestures: GestureAuthority;
  readonly fetcher?: typeof fetch;
  readonly queryStatus?: ProviderStatusQuery;
  readonly now?: () => number;
  /** Tests may shorten the request deadline; production defaults to 120 seconds. */
  readonly deadline_ms?: number;
}

export interface GestureAuthority {
  issue(event: Event): object;
  consume(token: object): boolean;
}

export interface ProviderRequestPreview {
  readonly request: ProviderRequestInput;
  readonly context: ProviderRequestContext;
  readonly destination: {
    readonly provider_id: string;
    readonly provider_label: string;
    readonly endpoint: string;
    readonly model_id: string;
    readonly model_label: string;
    readonly estimated_cost?: string;
  };
  readonly source_manifest_sha256: string;
  readonly output_limit_bytes: number;
}

export interface ProviderRequestResult {
  readonly request_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly scope: Scope;
  readonly snapshot: Snapshot;
  readonly source_manifest_sha256: string;
  readonly output: unknown;
  readonly untrusted: true;
}

export class ProviderRequestError extends AuthoringError {
  constructor(code: "invalid_input" | "provider_unavailable" | "capability_denied" | "external_state_unknown" | "cancelled" | "capacity" | "idempotency_conflict",
    message: string) {
    super(code, message);
    this.name = "ProviderRequestError";
  }
}

/** Host UI resolves this only after a fresh click on the exact immutable preview. */
export type ProviderConsentRequest = (broker: ProviderRequestBroker, preview: ProviderRequestPreview,
  send: (consent: object, signal?: AbortSignal) => Promise<ProviderRequestResult>,
  signal?: AbortSignal) => Promise<ProviderRequestResult>;

interface NormalizedProvider {
  readonly provider_id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly credential_handle: string;
  readonly models: ReadonlyMap<string, ProviderModelConfiguration>;
}

interface PreparedState {
  readonly provider: NormalizedProvider;
  readonly request: ProviderRequestInput;
  readonly context: ProviderRequestContext;
  readonly body: string;
  readonly fingerprint: string;
  readonly namespace: string;
  readonly sourceManifestSha256: string;
  readonly outputLimit: number;
  readonly model: ProviderModelConfiguration;
}

interface ConsentGrant {
  readonly fingerprint: string;
  readonly expiresAt: number;
}

type Attempt =
  | { readonly fingerprint: string; state: "sending"; readonly promise: Promise<ProviderRequestResult> }
  | { readonly fingerprint: string; state: "complete"; readonly result: ProviderRequestResult }
  | { readonly fingerprint: string; state: "failed"; readonly error: ProviderRequestError };

/**
 * Host-owned provider broker. Provider configuration and credentials never
 * cross the guest boundary; provider responses are bounded and marked untrusted.
 */
export class ProviderRequestBroker {
  private readonly providers = new Map<string, NormalizedProvider>();
  private readonly prepared = new WeakMap<object, PreparedState>();
  private readonly consents = new WeakMap<object, ConsentGrant>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly now: () => number;
  private readonly fetcher?: typeof fetch;
  private readonly deadline: number;

  constructor(private readonly options: ProviderBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.deadline = boundedDeadline(options.deadline_ms ?? PROVIDER_DEADLINE_MS);
    for (const candidate of options.providers ?? []) {
      const normalized = normalizeProvider(candidate);
      if (normalized && !this.providers.has(normalized.provider_id)) this.providers.set(normalized.provider_id, normalized);
    }
  }

  /** A pure, local preflight; it does not resolve credentials or use the network. */
  async prepare(input: ProviderRequestInput, context: ProviderRequestContext): Promise<ProviderRequestPreview> {
    const request = normalizeRequest(input);
    const trustedContext = normalizeContext(context);
    const provider = this.providers.get(request.provider_id);
    if (!provider || !provider.models.has(request.model_id) || !this.options.credentials || !this.fetcher) {
      throw providerUnavailable();
    }
    const model = provider.models.get(request.model_id)!;
    const body = canonicalJson(request);
    if (byteLength(body) > REQUEST_LIMIT) throw new ProviderRequestError("capacity", "Provider request exceeds the 1 MiB request limit.");
    const sourceManifestSha256 = await sha256(canonicalJson(request.source_manifest));
    const fingerprint = await sha256(canonicalJson({
      request,
      context: trustedContext,
      destination: { provider_id: provider.provider_id, endpoint: provider.endpoint, model },
    }));
    const namespace = `${trustedContext.plugin_id}\u0000${trustedContext.action_id}\u0000${request.request_id}`;
    const preview: ProviderRequestPreview = deepFreeze({
      request,
      context: trustedContext,
      destination: {
        provider_id: provider.provider_id,
        provider_label: provider.label,
        endpoint: provider.endpoint,
        model_id: model.model_id,
        model_label: model.label,
        ...(model.estimated_cost === undefined ? {} : { estimated_cost: model.estimated_cost }),
      },
      source_manifest_sha256: sourceManifestSha256,
      output_limit_bytes: request.max_output_bytes,
    });
    this.prepared.set(preview as object, {
      provider,
      request,
      context: trustedContext,
      body,
      fingerprint,
      namespace,
      sourceManifestSha256,
      outputLimit: request.max_output_bytes,
      model,
    });
    return preview;
  }

  /** Mint only from a fresh trusted click on the exact preview shown by Host UI. */
  authorize(event: Event, preview: ProviderRequestPreview): object {
    const state = this.prepared.get(preview as object);
    if (!state) throw denied();
    let gesture: object;
    try { gesture = this.options.gestures.issue(event); }
    catch { throw denied(); }
    if (!this.options.gestures.consume(gesture)) throw denied();
    const token = Object.freeze({});
    this.consents.set(token, { fingerprint: state.fingerprint, expiresAt: this.now() + CONSENT_TTL_MS });
    return token;
  }

  /** Send exactly the previewed request once. `signal` may cancel an unsent request. */
  async request(preview: ProviderRequestPreview, consent: object, signal?: AbortSignal): Promise<ProviderRequestResult> {
    const state = this.prepared.get(preview as object);
    if (!state) throw denied();
    const oldAttempt = this.attempts.get(state.namespace);
    if (oldAttempt) {
      if (oldAttempt.fingerprint !== state.fingerprint) {
        throw new ProviderRequestError("idempotency_conflict", "This request ID was already used for different provider input.");
      }
      if (oldAttempt.state === "complete") return structuredClone(oldAttempt.result);
      if (oldAttempt.state === "failed") throw oldAttempt.error;
      return oldAttempt.promise;
    }

    const grant = this.consents.get(consent);
    if (!grant || grant.fingerprint !== state.fingerprint || this.now() > grant.expiresAt) throw denied();
    this.consents.delete(consent);
    if (signal?.aborted) throw new ProviderRequestError("cancelled", "Provider request was cancelled before submission.");
    if (!this.options.credentials || !this.fetcher) throw providerUnavailable();

    let credential: string | undefined;
    try { credential = await this.options.credentials.resolve(state.provider.credential_handle); }
    catch { throw providerUnavailable(); }
    if (!credential || !credential.trim()) throw providerUnavailable();
    if (signal?.aborted) throw new ProviderRequestError("cancelled", "Provider request was cancelled before submission.");
    if (!/^[\x21-\x7e]{1,8192}$/u.test(credential)) throw providerUnavailable();
    // Prevent an accidental guest-supplied copy of a Host credential from being disclosed.
    if (state.body.includes(credential)) throw new ProviderRequestError("invalid_input", "Provider input contains Host credential material.");

    const promise = this.send(state, credential, signal);
    this.attempts.set(state.namespace, { fingerprint: state.fingerprint, state: "sending", promise });
    try {
      const result = await promise;
      this.attempts.set(state.namespace, { fingerprint: state.fingerprint, state: "complete", result });
      return structuredClone(result);
    } catch (error) {
      const normalized = error instanceof ProviderRequestError ? error : providerUnavailable();
      this.attempts.set(state.namespace, { fingerprint: state.fingerprint, state: "failed", error: normalized });
      throw normalized;
    }
  }

  /** Static capability status; this never resolves credentials or contacts a provider. */
  status(): { available: boolean; provider_ids: string[] } {
    return { available: this.providers.size > 0 && Boolean(this.options.credentials && this.fetcher), provider_ids: [...this.providers.keys()].sort() };
  }

  /** Shared UI/MCP/plugin route. Caller identity never substitutes for request consent. */
  async requestWithConsent(input: ProviderRequestInput, context: ProviderRequestContext,
    approve: ProviderConsentRequest | undefined, assertCurrent: () => Promise<void>, signal?: AbortSignal): Promise<ProviderRequestResult> {
    if (!approve) throw providerUnavailable();
    const cancelled = () => new ProviderRequestError("cancelled", "Provider request was cancelled before sending.");
    if (signal?.aborted) throw cancelled();
    const preview = await this.prepare(input, context);
    let sending = false;
    const send = async (consent: object, approvalSignal?: AbortSignal): Promise<ProviderRequestResult> => {
      if (signal?.aborted || approvalSignal?.aborted) throw cancelled();
      await assertCurrent();
      if (signal?.aborted || approvalSignal?.aborted) throw cancelled();
      const signals = [signal, approvalSignal].filter((value): value is AbortSignal => value !== undefined);
      sending = true;
      return this.request(preview, consent, signals.length ? AbortSignal.any(signals) : undefined);
    };
    return new Promise<ProviderRequestResult>((resolve, reject) => {
      // Once sending starts, the broker owns cancellation/unknown-outcome semantics.
      const abort = () => { if (!sending) reject(cancelled()); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { signal.removeEventListener("abort", abort); reject(cancelled()); return; }
      Promise.resolve().then(() => approve(this, preview, send, signal)).then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", abort));
    });
  }

  private async send(state: PreparedState, credential: string, callerSignal?: AbortSignal): Promise<ProviderRequestResult> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort("deadline"), this.deadline);
    const onCallerAbort = () => controller.abort("caller");
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const response = await this.fetcher!(state.provider.endpoint, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "authorization": `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: state.body,
        signal: controller.signal,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      if (response.redirected || response.status >= 500) throw await this.uncertain(state, credential);
      if (!response.ok) throw providerUnavailable();
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw providerUnavailable();
      const bytes = await readBounded(response, state.outputLimit);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const output = JSON.parse(text) as unknown;
      const encodedOutput = canonicalJson(output);
      if (encodedOutput.includes(credential)) throw providerUnavailable();
      const result: ProviderRequestResult = deepFreeze({
        request_id: state.request.request_id,
        provider_id: state.provider.provider_id,
        model_id: state.request.model_id,
        scope: state.context.scope,
        snapshot: state.context.snapshot,
        source_manifest_sha256: state.sourceManifestSha256,
        output,
        untrusted: true as const,
      });
      return result;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      // The request reached fetch; a transport failure or abort may have completed remotely.
      throw await this.uncertain(state, credential);
    } finally {
      clearTimeout(deadline);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async uncertain(state: PreparedState, credential: string): Promise<ProviderRequestError> {
    const query = this.options.queryStatus;
    if (query) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        // A status query is the only allowed follow-up; this callback cannot replay the request body.
        const status = await query({
          provider_id: state.provider.provider_id,
          endpoint: state.provider.endpoint,
          request_id: state.request.request_id,
          credential,
          signal: controller.signal,
        });
        // Completion state without the lost response still cannot be returned as a suggestion.
        void status.state;
      } catch { /* Preserve the non-disclosing uncertain outcome. */ }
      finally { clearTimeout(timeout); }
    }
    return new ProviderRequestError("external_state_unknown", "Provider completion is unknown; the request was not retried.");
  }
}

function normalizeProvider(candidate: ProviderConfiguration): NormalizedProvider | undefined {
  try {
    if (!candidate || !ID.test(candidate.provider_id) || !boundedLabel(candidate.label, 128) ||
      !validEndpoint(candidate.endpoint) || !TOKEN_HANDLE.test(candidate.credential_handle) ||
      !Array.isArray(candidate.models) || candidate.models.length < 1 || candidate.models.length > 128) return undefined;
    const models = new Map<string, ProviderModelConfiguration>();
    for (const model of candidate.models) {
      if (!model || !ID.test(model.model_id) || !boundedLabel(model.label, 128) ||
        (model.estimated_cost !== undefined && !boundedLabel(model.estimated_cost, 256)) || models.has(model.model_id)) return undefined;
      models.set(model.model_id, Object.freeze({ ...model }));
    }
    return Object.freeze({
      provider_id: candidate.provider_id,
      label: candidate.label,
      endpoint: new URL(candidate.endpoint).toString(),
      credential_handle: candidate.credential_handle,
      models,
    });
  } catch { return undefined; }
}

function normalizeRequest(input: ProviderRequestInput): ProviderRequestInput {
  if (!isPlainObject(input) || !exactKeys(input, ["request_id", "provider_id", "model_id", "purpose", "payload", "source_manifest", "max_output_bytes"])) {
    throw invalid();
  }
  const value = cloneJson(input) as Record<string, unknown>;
  if (typeof value.request_id !== "string" || !REQUEST_ID.test(value.request_id) ||
      typeof value.provider_id !== "string" || !ID.test(value.provider_id) ||
      typeof value.model_id !== "string" || !ID.test(value.model_id) ||
      typeof value.purpose !== "string" || value.purpose.trim().length === 0 || value.purpose.length > 512 ||
      !isJsonContainer(value.payload) || !isPlainObject(value.source_manifest) ||
      !Number.isSafeInteger(value.max_output_bytes) || (value.max_output_bytes as number) < 1 || (value.max_output_bytes as number) > PROVIDER_OUTPUT_LIMIT) {
    throw invalid();
  }
  rejectCredentialFields(value.payload);
  rejectCredentialFields(value.source_manifest);
  return deepFreeze(value as unknown as ProviderRequestInput);
}

function normalizeContext(context: ProviderRequestContext): ProviderRequestContext {
  if (!isPlainObject(context) || !exactKeys(context, ["plugin_id", "action_id", "scope", "snapshot"])) throw denied();
  const value = cloneJson(context) as Record<string, unknown>;
  const scope = value.scope as Record<string, unknown> | undefined;
  const snapshot = value.snapshot as Record<string, unknown> | undefined;
  if (typeof value.plugin_id !== "string" || !ID.test(value.plugin_id) ||
      typeof value.action_id !== "string" || !ID.test(value.action_id) ||
      !isPlainObject(scope) || typeof scope.workspace_id !== "string" || !scope.workspace_id || scope.workspace_id.length > 256 ||
      !(scope.repository_id === null || Number.isSafeInteger(scope.repository_id)) ||
      typeof scope.branch !== "string" || !scope.branch || scope.branch.length > 256 ||
      typeof scope.generation !== "string" || !scope.generation || scope.generation.length > 256 ||
      !isPlainObject(snapshot) || typeof snapshot.id !== "string" || !snapshot.id || snapshot.id.length > 256 ||
      !(snapshot.local_commit === null || typeof snapshot.local_commit === "string") ||
      typeof snapshot.worktree_generation !== "string" || !snapshot.worktree_generation || snapshot.worktree_generation.length > 256 ||
      !(snapshot.draft_generation === null || typeof snapshot.draft_generation === "string") ||
      (snapshot.remote_commit !== undefined && !(snapshot.remote_commit === null || typeof snapshot.remote_commit === "string"))) throw denied();
  return deepFreeze(value as unknown as ProviderRequestContext);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOKEN_HANDLE = /^[A-Za-z0-9._:-]{1,256}$/u;
const CREDENTIAL_FIELD = /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credentials?|password|bearer)$/iu;

function validEndpoint(value: string): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function boundedLabel(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactKeys(value: object, wanted: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === wanted.length && keys.every(key => typeof key === "string" && wanted.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return isPlainObject(value) || Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(jsonValue(value, new Set<object>()));
}

function jsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw invalid();
  if (ancestors.has(value)) throw invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw invalid();
        out.push(jsonValue(value[index], ancestors));
      }
      return out;
    }
    if (!isPlainObject(value)) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw invalid();
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw invalid();
      out[key] = jsonValue(descriptor.value, ancestors);
    }
    if (Reflect.ownKeys(value).length !== keys.length) throw invalid();
    return out;
  } finally { ancestors.delete(value); }
}

function rejectCredentialFields(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectCredentialFields(item); return; }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_FIELD.test(key)) throw invalid();
    rejectCredentialFields(value[key]);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw providerUnavailable();
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ProviderRequestError("capacity", "Provider response exceeded the approved output limit.");
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function boundedDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > PROVIDER_DEADLINE_MS) throw new RangeError("Provider deadline must be between 1 and 120000 ms");
  return value;
}

function invalid(): ProviderRequestError { return new ProviderRequestError("invalid_input", "Provider request input is invalid or exceeds its bounds."); }
function denied(): ProviderRequestError { return new ProviderRequestError("capability_denied", "A fresh Host consent for this exact provider request is required."); }
function providerUnavailable(): ProviderRequestError { return new ProviderRequestError("provider_unavailable", "The configured provider is unavailable."); }
