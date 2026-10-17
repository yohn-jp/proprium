import { createPublicKey, verify as verifySignature } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import type {
  GitCredentialProvider,
  GitCredentialRequest,
  HostedGitCredential,
  PublicationAuthorizationRequest,
} from "@scriptorium/core";

const MAX_JWKS_BYTES = 16 * 1024;
const MAX_BROKER_RESPONSE_BYTES = 8 * 1024;
const MAX_GRANT_RESPONSE_BYTES = 16 * 1024;
const JWKS_CACHE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const ACCESS_GRANT_LIFETIME_SECONDS = 300;
const PUBLISH_RECEIPT_AUDIENCE = "praetorium-git-publisher";
const RUNTIME_IDENTITY_JWKS_PATH = "/.well-known/runtime-identity-jwks.json";

const HttpsUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "expected an HTTPS URL");

const JwkSchema = z.strictObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  use: z.literal("sig"),
  alg: z.literal("ES256"),
  kid: z.string().min(1).max(128),
});
const JwksSchema = z.strictObject({ keys: z.array(JwkSchema).min(1).max(8) });
const JwtHeaderSchema = z.strictObject({
  alg: z.literal("ES256"),
  kid: z.string().min(1).max(128),
  typ: z.literal("JWT"),
});

const PermissionSchema = z.enum(["read", "write", "maintain", "admin"]);
const AccessGrantSchema = z.strictObject({
  iss: z.string().url(),
  sub: z.string().min(1),
  aud: z.string().url(),
  instanceId: z.string().min(1),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  runtimeEpoch: z.number().int().nonnegative(),
  permissions: z.array(PermissionSchema).min(1),
  sessionRevision: z.number().int().nonnegative(),
  authorizationRevision: z.number().int().nonnegative(),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
}).refine((grant) => grant.exp > grant.iat && grant.exp - grant.iat <= ACCESS_GRANT_LIFETIME_SECONDS && grant.nbf <= grant.exp,
  "invalid access grant lifetime");

const RuntimeIdentitySchema = z.strictObject({
  contractVersion: z.literal("praetorium-runtime-identity/v1"),
  iss: z.string().url().startsWith("https://"),
  aud: z.literal("praetorium-git-broker"),
  sub: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  repositoryId: z.number().int().positive().safe(),
  installationId: z.number().int().positive().safe(),
  runtimeEpoch: z.number().int().positive().safe(),
  leaseId: z.string().min(1).max(128),
  iat: z.number().int().nonnegative().safe(),
  nbf: z.number().int().nonnegative().safe(),
  exp: z.number().int().positive().safe(),
  jti: z.string().min(1).max(128),
}).refine((identity) => identity.sub === identity.runtimeId && identity.nbf === identity.iat &&
  identity.exp > identity.iat && identity.exp - identity.iat <= ACCESS_GRANT_LIFETIME_SECONDS,
"invalid runtime identity lifetime");

const MutationReceiptSchema = z.strictObject({
  contractVersion: z.literal("praetorium-mutation/v1"),
  iss: z.string().url(),
  sub: z.string().min(1).max(128),
  aud: z.string().min(1).max(512),
  repositoryId: z.number().int().positive().safe(),
  instanceId: z.string().min(1).max(128),
  runtimeEpoch: z.number().int().positive().safe(),
  operationId: z.string().min(1).max(128),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  action: z.literal("publish"),
  authorizationRevision: z.number().int().nonnegative().safe(),
  sessionRevision: z.number().int().nonnegative().safe(),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1).max(128),
}).refine((receipt) => receipt.exp > receipt.iat && receipt.exp - receipt.iat <= 60 && receipt.nbf <= receipt.exp,
  "invalid mutation receipt lifetime");

const MutationAuthorizationResponseSchema = z.strictObject({
  contractVersion: z.literal("praetorium-mutation/v1"),
  receipt: z.string().min(16).max(16_384),
  operationId: z.string().min(1).max(128),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expiresAt: z.string().datetime(),
});

const GitCredentialSchema = z.strictObject({
  username: z.literal("x-access-token"),
  token: z.string().min(1).max(4_096).refine((value) => !/[\s\u0000-\u001f\u007f]/u.test(value)),
  repositoryId: z.number().int().positive().safe(),
  permission: z.enum(["read", "write"]),
  runtimeEpoch: z.number().int().positive().safe(),
  expiresAt: z.string().datetime(),
});

export interface HostedRuntimeAssignment {
  readonly contractVersion: "scriptorium-platform/v1";
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly repositoryLocator: string;
  readonly defaultBranchPolicy: string;
  readonly runtimeEpoch: number;
  readonly credentialBrokerLocator: string;
  readonly controlServicePolicy: {
    readonly issuer: string;
    readonly jwksUrl: string;
    readonly audience: string;
  };
  readonly grantPolicy: {
    readonly issuer: string;
    readonly jwksUrl: string;
    readonly audience: string;
  };
}

export interface HostedPrincipal {
  readonly userId: string;
  readonly permissions: readonly z.infer<typeof PermissionSchema>[];
  readonly repositoryId: number;
  readonly instanceId: string;
  readonly runtimeEpoch: number;
  readonly sessionRevision: number;
  readonly authorizationRevision: number;
  readonly expiresAt: number;
}

export interface HostedAuthorizationPolicy {
  authenticate(token: string, requiredPermission?: z.infer<typeof PermissionSchema>): Promise<HostedPrincipal>;
  authorizePublication(
    token: string,
    input: PublicationAuthorizationRequest,
  ): Promise<{ readonly receipt: string; readonly operationId: string; readonly payloadDigest: string }>;
}

export class HostedAuthorizationError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 502 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "HostedAuthorizationError";
  }
}

type PublicJwk = z.infer<typeof JwkSchema>;
interface JwksCacheEntry {
  readonly expiresAt: number;
  readonly keys: ReadonlyMap<string, ReturnType<typeof createPublicKey>>;
}
const jwksCaches = new WeakMap<typeof fetch, Map<string, JwksCacheEntry>>();

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid compact JWT encoding");
  const decoded = Buffer.from(value, "base64url");
  if (!decoded.length || decoded.toString("base64url") !== value) throw new Error("non-canonical compact JWT encoding");
  return decoded;
}

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value))) as unknown;
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.ok) throw new Error("upstream request failed");
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("upstream response was not JSON");
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > maximumBytes))
    throw new Error("upstream response exceeded its limit");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("upstream response body was missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("upstream response exceeded its limit");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function loadJwks(
  jwksUrl: string,
  now: number,
  fetcher: typeof fetch,
  refresh = false,
): Promise<ReadonlyMap<string, ReturnType<typeof createPublicKey>>> {
  let cache = jwksCaches.get(fetcher);
  if (!cache) {
    cache = new Map();
    jwksCaches.set(fetcher, cache);
  }
  const cached = cache.get(jwksUrl);
  if (!refresh && cached && cached.expiresAt > now) return cached.keys;
  let response: Response;
  try {
    response = await fetcher(jwksUrl, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = JwksSchema.parse(await readBoundedJson(response, MAX_JWKS_BYTES));
    const keys = new Map<string, ReturnType<typeof createPublicKey>>();
    for (const item of parsed.keys) {
      if (keys.has(item.kid)) throw new Error("duplicate key ID");
      keys.set(item.kid, createPublicKey({ key: item, format: "jwk" }));
    }
    const entry = { expiresAt: now + JWKS_CACHE_TTL_MS, keys };
    cache.set(jwksUrl, entry);
    while (cache.size > 16) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      cache.delete(first);
    }
    return keys;
  } catch {
    if (cached && cached.expiresAt > now) return cached.keys;
    throw new HostedAuthorizationError(503, "authorization_keys_unavailable", "The authorization signing keys are unavailable");
  }
}

/** Verify an existing Praetorium ES256 JWT using the issuer's published JWKS. `now` is milliseconds. */
export async function verifyCompactJwt(
  token: string,
  jwksUrl: string,
  expectedIssuer: string,
  expectedAudience: string,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (!Number.isSafeInteger(now) || now < 0 || token.length < 1 || token.length > 16_384)
    throw new HostedAuthorizationError(401, "invalid_token", "The hosted credential is invalid");
  let jwks: string;
  try {
    const parsed = new URL(HttpsUrlSchema.parse(jwksUrl));
    if (parsed.hash) throw new Error("JWKS URL fragment is forbidden");
    jwks = parsed.toString();
  } catch {
    throw new HostedAuthorizationError(503, "authorization_policy_invalid", "The hosted authorization policy is unavailable");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new HostedAuthorizationError(401, "invalid_token", "The hosted credential is invalid");
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: z.infer<typeof JwtHeaderSchema>;
  let payload: Record<string, unknown>;
  let signature: Buffer;
  try {
    header = JwtHeaderSchema.parse(decodeJson(encodedHeader));
    const decodedPayload = objectValue(decodeJson(encodedPayload));
    if (!decodedPayload) throw new Error("JWT claims must be an object");
    payload = decodedPayload;
    signature = decodeBase64Url(encodedSignature);
  } catch {
    throw new HostedAuthorizationError(401, "invalid_token", "The hosted credential is invalid");
  }
  const nowSeconds = Math.floor(now / 1000);
  const { iss, aud, iat, nbf, exp } = payload;
  if (typeof iss !== "string" || iss !== expectedIssuer || typeof aud !== "string" || aud !== expectedAudience ||
      !Number.isSafeInteger(iat) || !Number.isSafeInteger(nbf) || !Number.isSafeInteger(exp) ||
      (iat as number) < 0 || (nbf as number) < 0 || (exp as number) <= (iat as number) ||
      (exp as number) - (iat as number) > ACCESS_GRANT_LIFETIME_SECONDS || (nbf as number) > (exp as number) ||
      (iat as number) > nowSeconds || (nbf as number) > nowSeconds || (exp as number) <= nowSeconds || signature.length !== 64) {
    throw new HostedAuthorizationError(401, "invalid_token", "The hosted credential is invalid or expired");
  }
  let key = (await loadJwks(jwks, now, fetcher)).get(header.kid);
  if (!key) key = (await loadJwks(jwks, now, fetcher, true)).get(header.kid);
  if (!key) throw new HostedAuthorizationError(401, "unknown_signing_key", "The hosted credential is invalid");
  let valid = false;
  try {
    valid = verifySignature("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"), {
      key,
      dsaEncoding: "ieee-p1363",
    }, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new HostedAuthorizationError(401, "invalid_signature", "The hosted credential is invalid");
  return payload;
}

function validateAssignment(assignment: HostedRuntimeAssignment): HostedRuntimeAssignment {
  if (!assignment || assignment.contractVersion !== "scriptorium-platform/v1" ||
      typeof assignment.instanceId !== "string" || assignment.instanceId.length < 1 || assignment.instanceId.length > 128 ||
      !Number.isSafeInteger(assignment.repositoryId) || assignment.repositoryId <= 0 ||
      !Number.isSafeInteger(assignment.runtimeEpoch) || assignment.runtimeEpoch <= 0 ||
      typeof assignment.defaultBranchPolicy !== "string" || assignment.defaultBranchPolicy.length < 1 ||
      assignment.defaultBranchPolicy.length > 512 || typeof assignment.repositoryLocator !== "string") {
    throw new TypeError("Hosted runtime assignment binding is invalid");
  }
  try {
    const repository = new URL(assignment.repositoryLocator);
    if (repository.protocol !== "https:" || repository.hostname !== "github.com" || repository.port ||
        repository.username || repository.password || repository.search || repository.hash ||
        !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.pathname))
      throw new Error("repository locator must be a canonical GitHub HTTPS URL");
    const issuer = new URL(HttpsUrlSchema.parse(assignment.grantPolicy.issuer));
    if (issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.origin !== assignment.grantPolicy.issuer)
      throw new Error("grant issuer must be an HTTPS origin");
    HttpsUrlSchema.parse(assignment.grantPolicy.jwksUrl);
    HttpsUrlSchema.parse(assignment.grantPolicy.audience);
    HttpsUrlSchema.parse(assignment.controlServicePolicy.issuer);
    HttpsUrlSchema.parse(assignment.controlServicePolicy.jwksUrl);
    const broker = new URL(HttpsUrlSchema.parse(assignment.credentialBrokerLocator));
    if (broker.origin !== issuer.origin || broker.pathname !== "/internal/github/credential" || broker.search || broker.hash)
      throw new Error("credential broker must use the assigned Gateway route");
  } catch {
    throw new TypeError("Hosted runtime assignment URLs are invalid");
  }
  return assignment;
}

export function createHostedAuthorizationPolicy(options: {
  readonly assignment: HostedRuntimeAssignment;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): HostedAuthorizationPolicy {
  const assignment = validateAssignment(options.assignment);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  async function authenticate(token: string, requiredPermission?: z.infer<typeof PermissionSchema>): Promise<HostedPrincipal> {
    const clock = now();
    const payload = await verifyCompactJwt(
      token,
      assignment.grantPolicy.jwksUrl,
      assignment.grantPolicy.issuer,
      assignment.grantPolicy.audience,
      clock,
      fetcher,
    );
    const parsed = AccessGrantSchema.safeParse(payload);
    if (!parsed.success || parsed.data.repositoryId !== assignment.repositoryId ||
        parsed.data.instanceId !== assignment.instanceId || parsed.data.runtimeEpoch !== assignment.runtimeEpoch) {
      throw new HostedAuthorizationError(401, "grant_binding_mismatch", "The hosted credential is not valid for this runtime");
    }
    if (requiredPermission && !parsed.data.permissions.includes(requiredPermission)) {
      throw new HostedAuthorizationError(403, "permission_denied", "The hosted credential does not allow this action");
    }
    return {
      userId: parsed.data.sub,
      permissions: parsed.data.permissions,
      repositoryId: parsed.data.repositoryId,
      instanceId: parsed.data.instanceId,
      runtimeEpoch: parsed.data.runtimeEpoch,
      sessionRevision: parsed.data.sessionRevision,
      authorizationRevision: parsed.data.authorizationRevision,
      expiresAt: parsed.data.exp * 1000,
    };
  }

  return {
    authenticate,
    async authorizePublication(token, input) {
      const principal = await authenticate(token, "write");
      if (!input || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.operationId) ||
          !/^sha256:[a-f0-9]{64}$/u.test(input.payloadDigest)) {
        throw new HostedAuthorizationError(400, "invalid_publication_authorization", "The publication authorization request is invalid");
      }
      let response: Response;
      try {
        response = await fetcher(`${assignment.grantPolicy.issuer}/api/repositories/${assignment.repositoryId}/mutation-authorizations`, {
          method: "POST",
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new HostedAuthorizationError(503, "publication_authorization_unavailable", "The publication authorization service is unavailable");
      }
      if (!response.ok) {
        cancelResponse(response);
        if (response.status === 401)
          throw new HostedAuthorizationError(401, "access_grant_expired", "The hosted access grant is no longer valid");
        if (response.status === 403)
          throw new HostedAuthorizationError(403, "permission_denied", "The current user is not authorized to publish");
        if (response.status === 400)
          throw new HostedAuthorizationError(400, "invalid_publication_authorization", "The publication authorization request is invalid");
        throw new HostedAuthorizationError(503, "publication_authorization_unavailable", "The publication authorization service is unavailable");
      }
      let body: unknown;
      try { body = await readBoundedJson(response, MAX_GRANT_RESPONSE_BYTES); }
      catch {
        throw new HostedAuthorizationError(502, "publication_authorization_invalid", "The publication authorization response is invalid");
      }
      const issued = MutationAuthorizationResponseSchema.safeParse(body);
      if (!issued.success || issued.data.operationId !== input.operationId || issued.data.payloadDigest !== input.payloadDigest) {
        throw new HostedAuthorizationError(503, "publication_authorization_invalid", "The publication authorization response is invalid");
      }
      const receiptPayload = await verifyCompactJwt(
        issued.data.receipt,
        assignment.grantPolicy.jwksUrl,
        assignment.grantPolicy.issuer,
        PUBLISH_RECEIPT_AUDIENCE,
        now(),
        fetcher,
      );
      const receipt = MutationReceiptSchema.safeParse(receiptPayload);
      if (!receipt.success || receipt.data.sub !== principal.userId ||
          receipt.data.repositoryId !== assignment.repositoryId || receipt.data.instanceId !== assignment.instanceId ||
          receipt.data.runtimeEpoch !== assignment.runtimeEpoch || receipt.data.operationId !== input.operationId ||
          receipt.data.payloadDigest !== input.payloadDigest ||
          Date.parse(issued.data.expiresAt) !== receipt.data.exp * 1000) {
        throw new HostedAuthorizationError(503, "publication_authorization_invalid", "The publication authorization response is invalid");
      }
      if (receipt.data.authorizationRevision !== principal.authorizationRevision ||
          receipt.data.sessionRevision !== principal.sessionRevision) {
        throw new HostedAuthorizationError(401, "access_grant_stale", "A fresh hosted access grant is required");
      }
      return { receipt: issued.data.receipt, operationId: input.operationId, payloadDigest: input.payloadDigest };
    },
  };
}

function proofFromIdentity(token: string, claims: z.infer<typeof RuntimeIdentitySchema>): {
  readonly serviceToken: string;
  readonly runtimeId: string;
  readonly instanceId: string;
  readonly repositoryId: number;
  readonly installationId: number;
  readonly runtimeEpoch: number;
  readonly leaseId: string;
} {
  return {
    serviceToken: token,
    runtimeId: claims.runtimeId,
    instanceId: claims.instanceId,
    repositoryId: claims.repositoryId,
    installationId: claims.installationId,
    runtimeEpoch: claims.runtimeEpoch,
    leaseId: claims.leaseId,
  };
}

/** Read the renewable runtime identity on every operation and request a one-repository GitHub token. */
export function createHostedGitCredentialProvider(options: {
  readonly assignment: HostedRuntimeAssignment;
  readonly runtimeIdentityPath?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): GitCredentialProvider {
  const assignment = validateAssignment(options.assignment);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const runtimeIdentityPath = options.runtimeIdentityPath ?? "/run/scriptorium/runtime-identity.jwt";

  async function runtimeProof() {
    let token: string;
    try {
      token = (await fs.readFile(runtimeIdentityPath, "utf8")).trim();
    } catch {
      throw new HostedAuthorizationError(503, "runtime_identity_unavailable", "The runtime identity is unavailable");
    }
    const identityJwksUrl = new URL(RUNTIME_IDENTITY_JWKS_PATH, assignment.controlServicePolicy.issuer).toString();
    const payload = await verifyCompactJwt(
      token,
      identityJwksUrl,
      assignment.controlServicePolicy.issuer,
      "praetorium-git-broker",
      now(),
      fetcher,
    );
    const parsed = RuntimeIdentitySchema.safeParse(payload);
    if (!parsed.success || parsed.data.instanceId !== assignment.instanceId ||
        parsed.data.repositoryId !== assignment.repositoryId || parsed.data.runtimeEpoch !== assignment.runtimeEpoch) {
      throw new HostedAuthorizationError(503, "runtime_identity_binding_mismatch", "The runtime identity does not match this assignment");
    }
    return proofFromIdentity(token, parsed.data);
  }

  return {
    async getCredential(request: GitCredentialRequest): Promise<HostedGitCredential> {
      if (request.repositoryId !== assignment.repositoryId || request.instanceId !== assignment.instanceId ||
          request.runtimeEpoch !== assignment.runtimeEpoch) {
        throw new HostedAuthorizationError(403, "git_credential_binding_mismatch", "The Git credential request does not match this runtime");
      }
      if (request.operation === "publish" &&
          (!/^[A-Za-z0-9_-]{1,128}$/u.test(request.operationId) ||
            !/^sha256:[a-f0-9]{64}$/u.test(request.payloadDigest) ||
            request.mutationReceipt.length < 16 || request.mutationReceipt.length > 16_384)) {
        throw new HostedAuthorizationError(403, "git_credential_authorization_invalid", "The Git publication is not authorized");
      }
      const proof = await runtimeProof();
      const body = request.operation === "fetch"
        ? { operation: "fetch", proof }
        : {
            operation: "publish",
            proof,
            mutationReceipt: request.mutationReceipt,
            operationId: request.operationId,
            payloadDigest: request.payloadDigest,
          };
      let response: Response;
      try {
        response = await fetcher(assignment.credentialBrokerLocator, {
          method: "POST",
          redirect: "error",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new HostedAuthorizationError(503, "git_credential_unavailable", "The Git credential service is unavailable");
      }
      if (!response.ok) {
        cancelResponse(response);
        if (response.status === 401 || response.status === 403)
          throw new HostedAuthorizationError(403, "git_credential_denied", "The Git credential request was denied");
        throw new HostedAuthorizationError(503, "git_credential_unavailable", "The Git credential service is unavailable");
      }
      let credentialValue: unknown;
      try { credentialValue = await readBoundedJson(response, MAX_BROKER_RESPONSE_BYTES); }
      catch {
        throw new HostedAuthorizationError(502, "git_credential_invalid", "The Git credential response is invalid");
      }
      const parsed = GitCredentialSchema.safeParse(credentialValue);
      const requiredPermission = request.operation === "fetch" ? "read" : "write";
      const expiration = parsed.success ? Date.parse(parsed.data.expiresAt) : Number.NaN;
      if (!parsed.success || parsed.data.repositoryId !== assignment.repositoryId ||
          parsed.data.runtimeEpoch !== assignment.runtimeEpoch || parsed.data.permission !== requiredPermission ||
          expiration <= now()) {
        throw new HostedAuthorizationError(503, "git_credential_invalid", "The Git credential response is invalid");
      }
      return parsed.data;
    },
  };
}
