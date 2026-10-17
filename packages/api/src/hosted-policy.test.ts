import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createHostedAuthorizationPolicy,
  createHostedGitCredentialProvider,
  HostedAuthorizationError,
  type HostedRuntimeAssignment,
} from "./hosted-policy.js";

const NOW = Date.parse("2026-10-17T03:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW / 1000);
const REPOSITORY_ID = 342_100_801;
const INSTANCE_ID = "instance_123";
const RUNTIME_EPOCH = 7;
const ISSUER = "https://gateway.example.test";
const AUDIENCE = "https://instance.example.test";
const CONTROL_ISSUER = "https://control.example.test";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const runtimeIdentityPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function publicJwkFor(keyPair: typeof pair, kid: string) {
  const rawPublicJwk = keyPair.publicKey.export({ format: "jwk" });
  return {
  kty: "EC",
  crv: "P-256",
  x: rawPublicJwk.x,
  y: rawPublicJwk.y,
  use: "sig",
  alg: "ES256",
    kid,
  };
}

const publicJwk = publicJwkFor(pair, "hosted-test-key");
const runtimeIdentityJwk = publicJwkFor(runtimeIdentityPair, "runtime-identity-key");

function signJwt(payload: Record<string, unknown>, keyPair: typeof pair, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: keyPair.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function jwt(payload: Record<string, unknown>): string {
  return signJwt(payload, pair, "hosted-test-key");
}

function runtimeIdentityJwt(payload: Record<string, unknown>): string {
  return signJwt(payload, runtimeIdentityPair, "runtime-identity-key");
}

function accessGrant(overrides: Record<string, unknown> = {}): string {
  return jwt({
    iss: ISSUER,
    sub: "github-user-42",
    aud: AUDIENCE,
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    permissions: ["read", "write"],
    sessionRevision: 4,
    authorizationRevision: 9,
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 120,
    jti: "grant-1",
    ...overrides,
  });
}

function assignment(overrides: Partial<HostedRuntimeAssignment> = {}): HostedRuntimeAssignment {
  return {
    contractVersion: "scriptorium-platform/v1",
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    repositoryLocator: "https://github.com/yohn-jp/novel",
    defaultBranchPolicy: "repository-default",
    runtimeEpoch: RUNTIME_EPOCH,
    credentialBrokerLocator: `${ISSUER}/internal/github/credential`,
    controlServicePolicy: {
      issuer: CONTROL_ISSUER,
      jwksUrl: `${CONTROL_ISSUER}/.well-known/control-jwks.json`,
      audience: "scriptorium-platform-control",
    },
    grantPolicy: {
      issuer: ISSUER,
      jwksUrl: `${ISSUER}/.well-known/jwks.json`,
      audience: AUDIENCE,
    },
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Content-Type": "application/json" } });
}

function receipt(overrides: Record<string, unknown> = {}): string {
  return jwt({
    contractVersion: "praetorium-mutation/v1",
    iss: ISSUER,
    sub: "github-user-42",
    aud: "praetorium-git-publisher",
    repositoryId: REPOSITORY_ID,
    instanceId: INSTANCE_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    operationId: "batch-1",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    action: "publish",
    authorizationRevision: 9,
    sessionRevision: 4,
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 30,
    jti: "receipt-1",
    ...overrides,
  });
}

function grantFetch(extra?: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/jwks.json") return response({ keys: [publicJwk] });
    if (extra) return extra(url, init);
    throw new Error("unexpected upstream request");
  }) as typeof fetch;
}

test("hosted access grants bind issuer, audience, repository, instance, epoch and permission", async () => {
  const policy = createHostedAuthorizationPolicy({
    assignment: assignment(),
    now: () => NOW,
    fetch: grantFetch(),
  });
  const principal = await policy.authenticate(accessGrant(), "write");
  assert.deepEqual(principal, {
    userId: "github-user-42",
    permissions: ["read", "write"],
    repositoryId: REPOSITORY_ID,
    instanceId: INSTANCE_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    sessionRevision: 4,
    authorizationRevision: 9,
    expiresAt: (NOW_SECONDS + 120) * 1000,
  });

  await assert.rejects(
    policy.authenticate(accessGrant({ runtimeEpoch: RUNTIME_EPOCH - 1 })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ repositoryId: REPOSITORY_ID + 1 })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ instanceId: "another-instance" })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ iss: "https://forged.example.test" })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ permissions: ["read"] }), "write"),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 403,
  );
  await assert.rejects(
    policy.authenticate(accessGrant({ aud: "https://another-instance.example.test" })),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
  assert.equal((await policy.authenticate(accessGrant({ sub: "github-user-99" }), "read")).userId, "github-user-99");
});

test("publication authorization exchanges the verified user grant for the existing signed receipt", async () => {
  const grant = accessGrant();
  const mutationReceipt = receipt();
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const fetcher = grantFetch(async (url, init) => {
    calls.push({
      url: url.toString(),
      authorization: new Headers(init?.headers).get("Authorization"),
      body: JSON.parse(String(init?.body)) as unknown,
    });
    return response({
      contractVersion: "praetorium-mutation/v1",
      receipt: mutationReceipt,
      operationId: "batch-1",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      expiresAt: new Date((NOW_SECONDS + 30) * 1000).toISOString(),
    }, 201);
  });
  const policy = createHostedAuthorizationPolicy({ assignment: assignment(), now: () => NOW, fetch: fetcher });
  const issued = await policy.authorizePublication(grant, {
    operationId: "batch-1",
    payloadDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.deepEqual(issued, {
    receipt: mutationReceipt,
    operationId: "batch-1",
    payloadDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.deepEqual(calls, [{
    url: `${ISSUER}/api/repositories/${REPOSITORY_ID}/mutation-authorizations`,
    authorization: `Bearer ${grant}`,
    body: { operationId: "batch-1", payloadDigest: `sha256:${"a".repeat(64)}` },
  }]);
});

test("publication rechecks current Gateway authorization and rejects a receipt with a stale author revision", async () => {
  const grant = accessGrant();
  const input = { operationId: "batch-1", payloadDigest: `sha256:${"a".repeat(64)}` };
  const policy = createHostedAuthorizationPolicy({
    assignment: assignment(),
    now: () => NOW,
    fetch: grantFetch(async () => response({ error: { code: "FORBIDDEN" } }, 403)),
  });
  await assert.rejects(
    policy.authorizePublication(grant, input),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 403,
  );

  const staleReceipt = receipt({ authorizationRevision: 10 });
  const stalePolicy = createHostedAuthorizationPolicy({
    assignment: assignment(),
    now: () => NOW,
    fetch: grantFetch(async () => response({
      contractVersion: "praetorium-mutation/v1",
      receipt: staleReceipt,
      operationId: input.operationId,
      payloadDigest: input.payloadDigest,
      expiresAt: new Date((NOW_SECONDS + 30) * 1000).toISOString(),
    }, 201)),
  });
  await assert.rejects(
    stalePolicy.authorizePublication(grant, input),
    (error: unknown) => error instanceof HostedAuthorizationError && error.status === 401,
  );
});

test("broker provider rereads runtime identity and asks the assigned Gateway for read and write credentials", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-hosted-auth-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identityPath = path.join(directory, "runtime-identity.jwt");
  await fs.writeFile(identityPath, runtimeIdentityJwt({
    contractVersion: "praetorium-runtime-identity/v1",
    iss: CONTROL_ISSUER,
    aud: "praetorium-git-broker",
    sub: "runtime-77",
    runtimeId: "runtime-77",
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    installationId: 927,
    runtimeEpoch: RUNTIME_EPOCH,
    leaseId: "lease-19",
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 120,
    jti: "identity-1",
  }));
  const brokerRequests: Array<Record<string, unknown>> = [];
  const mutationReceipt = receipt();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/control-jwks.json") return response({ keys: [publicJwk] });
    if (url.pathname === "/.well-known/runtime-identity-jwks.json") return response({ keys: [runtimeIdentityJwk] });
    if (url.pathname === "/internal/github/credential") {
      brokerRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = JSON.parse(String(init?.body)) as { operation: string };
      const permission = body.operation === "fetch" ? "read" : "write";
      return response({
        username: "x-access-token",
        token: `ghs-${permission}-scoped`,
        repositoryId: REPOSITORY_ID,
        permission,
        runtimeEpoch: RUNTIME_EPOCH,
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      });
    }
    throw new Error("unexpected upstream request");
  }) as typeof fetch;
  const provider = createHostedGitCredentialProvider({
    assignment: assignment(),
    runtimeIdentityPath: identityPath,
    now: () => NOW,
    fetch: fetcher,
  });
  const binding = { repositoryId: REPOSITORY_ID, instanceId: INSTANCE_ID, runtimeEpoch: RUNTIME_EPOCH };
  const readCredential = await provider.getCredential({ operation: "fetch", ...binding });
  const writeCredential = await provider.getCredential({
    operation: "publish",
    ...binding,
    mutationReceipt,
    operationId: "batch-1",
    payloadDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.equal(readCredential.permission, "read");
  assert.equal(writeCredential.permission, "write");
  assert.equal(brokerRequests[0]?.["operation"], "fetch");
  assert.equal(brokerRequests[1]?.["operation"], "publish");
  assert.equal((brokerRequests[0]?.["proof"] as Record<string, unknown>)?.["installationId"], 927);
  assert.equal(brokerRequests[1]?.["mutationReceipt"], mutationReceipt);
});

test("broker refuses a different repository binding before contacting the credential endpoint", async () => {
  let contactedBroker = false;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-hosted-auth-binding-"));
  try {
    const identityPath = path.join(directory, "runtime-identity.jwt");
    await fs.writeFile(identityPath, "unused");
    const provider = createHostedGitCredentialProvider({
      assignment: assignment(),
      runtimeIdentityPath: identityPath,
      now: () => NOW,
      fetch: grantFetch(async () => {
        contactedBroker = true;
        return response({});
      }),
    });
    await assert.rejects(provider.getCredential({
      operation: "fetch",
      repositoryId: REPOSITORY_ID + 1,
      instanceId: INSTANCE_ID,
      runtimeEpoch: RUNTIME_EPOCH,
    }), (error: unknown) => error instanceof HostedAuthorizationError && error.status === 403);
    assert.equal(contactedBroker, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("broker refuses a renewed runtime proof from an old epoch before issuing a GitHub credential", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-hosted-auth-old-proof-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identityPath = path.join(directory, "runtime-identity.jwt");
  await fs.writeFile(identityPath, runtimeIdentityJwt({
    contractVersion: "praetorium-runtime-identity/v1",
    iss: CONTROL_ISSUER,
    aud: "praetorium-git-broker",
    sub: "runtime-77",
    runtimeId: "runtime-77",
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    installationId: 927,
    runtimeEpoch: RUNTIME_EPOCH - 1,
    leaseId: "lease-19",
    iat: NOW_SECONDS,
    nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 120,
    jti: "identity-old-epoch",
  }));
  let contactedBroker = false;
  const provider = createHostedGitCredentialProvider({
    assignment: assignment(),
    runtimeIdentityPath: identityPath,
    now: () => NOW,
    fetch: (async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === "/.well-known/control-jwks.json") return response({ keys: [publicJwk] });
      if (new URL(String(input)).pathname === "/.well-known/runtime-identity-jwks.json") return response({ keys: [runtimeIdentityJwk] });
      contactedBroker = true;
      return response({});
    }) as typeof fetch,
  });
  await assert.rejects(provider.getCredential({
    operation: "fetch",
    repositoryId: REPOSITORY_ID,
    instanceId: INSTANCE_ID,
    runtimeEpoch: RUNTIME_EPOCH,
  }), (error: unknown) => error instanceof HostedAuthorizationError && error.status === 503);
  assert.equal(contactedBroker, false);
});
