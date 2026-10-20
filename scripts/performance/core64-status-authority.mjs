#!/usr/bin/env node
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signJwt } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createServer } from "../../packages/api/dist/server.js";
import { RUNTIME_STATUS_PATH, sha256Digest } from "../../packages/api/dist/platform-runtime.js";

const assignment = {
  contractVersion: "scriptorium-platform/v1",
  instanceId: "c64-status-synthetic-instance",
  repositoryId: 64001,
  repositoryLocator: "https://github.com/scriptorium-perf/status-fixture",
  defaultBranchPolicy: "repository-default",
  runtimeEpoch: 3,
  imageDigest: "sha256:" + "a".repeat(64),
  compositionManifestDigest: "sha256:" + "b".repeat(64),
  enabledModuleIds: [],
  credentialBrokerLocator: "https://control.example.invalid/internal/github/credential",
  controlServicePolicy: {
    issuer: "https://control.example.invalid",
    jwksUrl: "https://control.example.invalid/.well-known/control-jwks.json",
    audience: "praetorium-runtime-control",
  },
  grantPolicy: {
    issuer: "https://control.example.invalid",
    jwksUrl: "https://control.example.invalid/.well-known/grant-jwks.json",
    audience: "https://c64-status-synthetic.instances.example",
  },
};
const repository = {
  provider: "github",
  repositoryId: "64001",
  defaultBranch: "main",
  ownerScope: "scriptorium-perf",
  url: "https://github.com/scriptorium-perf/status-fixture.git",
};
const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicJwk = {
  ...keyPair.publicKey.export({ format: "jwk" }),
  use: "sig",
  alg: "ES256",
  kid: "c64-status-test-key",
};

function token(operationId) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const header = encode({ alg: "ES256", kid: publicJwk.kid, typ: "JWT" });
  const claims = encode({
    contractVersion: "praetorium-runtime-control/v1",
    iss: assignment.controlServicePolicy.issuer,
    sub: "c64-status-synthetic-control",
    aud: assignment.controlServicePolicy.audience,
    instanceId: assignment.instanceId,
    repositoryId: assignment.repositoryId,
    runtimeEpoch: assignment.runtimeEpoch,
    operationId,
    action: "status",
    payloadDigest: sha256Digest(""),
    iat: now,
    nbf: now,
    exp: now + 30,
    jti: "status-" + operationId,
  });
  const unsigned = header + "." + claims;
  const signature = signJwt("sha256", Buffer.from(unsigned, "ascii"), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return unsigned + "." + signature.toString("base64url");
}

function quantile(values, q) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered.length ? ordered[Math.max(0, Math.ceil(q * ordered.length) - 1)] : null;
}

function summarize(values) {
  return {
    n: values.length,
    p50Ms: quantile(values, 0.50),
    p95Ms: quantile(values, 0.95),
    p99Ms: quantile(values, 0.99),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

function makeFakeStore(recordCount, race = false) {
  const remoteRevision = "a".repeat(40);
  const changedRevision = "b".repeat(40);
  const paths = Array.from({ length: recordCount }, (_, index) =>
    "meta/scriptorium/operations/v1/op-" + index + ".json");
  const records = new Map(paths.map((recordPath, index) => [
    recordPath,
    JSON.stringify({ version: 1, operation: { id: "op-" + index } }),
  ]));
  let observeCalls = 0;
  let listCalls = 0;
  let readCalls = 0;
  const pinnedReads = [];
  const store = {
    async observe() {
      observeCalls += 1;
      const commit = race && observeCalls === 2 ? changedRevision : remoteRevision;
      return {
        snapshot: { repository, remoteCommit: commit },
        checkpointHead: commit,
        observedAt: new Date().toISOString(),
        state: "fresh",
        pending: [],
      };
    },
    async reader(_projectId, _view = "remote", pinned) {
      pinnedReads.push(pinned ?? null);
      const snapshot = { repository, remoteCommit: pinned ?? remoteRevision };
      return {
        snapshot,
        async list(prefix) {
          listCalls += 1;
          assert.equal(prefix, "meta/scriptorium");
          return [...paths];
        },
        async read(recordPath) {
          readCalls += 1;
          const content = records.get(recordPath);
          return content === undefined ? null : { content, revision: "c".repeat(40) };
        },
      };
    },
    async listProposals() { return []; },
  };
  return {
    store,
    counts: () => ({ observeCalls, listCalls, readCalls, pinnedReads: [...pinnedReads] }),
    remoteRevision,
    changedRevision,
  };
}

async function startApi(store, staticDir) {
  const server = createServer({
    store,
    staticDir,
    trustProxy: true,
    hosted: {
      assignment,
      projectId: "project-1",
      authorization: {
        async authenticate() { throw new Error("hosted grant auth must not handle signed status"); },
        async authorizePublication() { throw new Error("publication is outside this synthetic fixture"); },
      },
      controlFetch: async (input) => {
        assert.equal(String(input), assignment.controlServicePolicy.jwksUrl);
        return Response.json({ keys: [publicJwk] });
      },
    },
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    base: "http://127.0.0.1:" + address.port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function measureFixture(recordCount, samples, temporaryRoot) {
  const fixture = makeFakeStore(recordCount);
  const api = await startApi(fixture.store, temporaryRoot);
  const latencies = [];
  const perRequest = [];
  try {
    for (let index = 0; index < samples; index += 1) {
      const before = fixture.counts();
      const started = performance.now();
      const response = await fetch(api.base + RUNTIME_STATUS_PATH, {
        headers: { Authorization: "Bearer " + token("synthetic-status-" + recordCount + "-" + index) },
      });
      const wallMs = performance.now() - started;
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.persistence.state, "verified");
      assert.equal(body.persistence.observedRemoteCommit, fixture.remoteRevision);
      const after = fixture.counts();
      assert.equal(after.observeCalls - before.observeCalls, 2, "every completed remote status scan must retain its paired observations");
      assert.deepEqual(after.pinnedReads.slice(before.pinnedReads.length), [fixture.remoteRevision]);
      assert.equal(after.listCalls - before.listCalls, 1);
      assert.equal(after.readCalls - before.readCalls, recordCount);
      latencies.push(wallMs);
      perRequest.push({
        wallMs,
        observedCalls: after.observeCalls - before.observeCalls,
        scannedRecords: after.readCalls - before.readCalls,
        persistenceState: body.persistence.state,
      });
    }
    return {
      fakePersistenceRecords: recordCount,
      samples,
      wallMs: summarize(latencies),
      perRequest,
      counts: fixture.counts(),
    };
  } finally {
    await api.close();
  }
}

async function verifyUnknownOnRace(temporaryRoot) {
  const fixture = makeFakeStore(100, true);
  const api = await startApi(fixture.store, temporaryRoot);
  try {
    const response = await fetch(api.base + RUNTIME_STATUS_PATH, {
      headers: { Authorization: "Bearer " + token("synthetic-status-remote-race") },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const counts = fixture.counts();
    assert.equal(counts.observeCalls, 2);
    assert.deepEqual(counts.pinnedReads, [fixture.remoteRevision]);
    assert.equal(body.persistence.state, "unknown", "a remote revision change during the pinned scan must not report verified persistence");
    assert.equal(body.lastConfirmedRemoteRevision, fixture.changedRevision);
    return {
      observeCalls: counts.observeCalls,
      pinnedReadCommit: counts.pinnedReads[0],
      finalObservedCommit: body.lastConfirmedRemoteRevision,
      persistenceState: body.persistence.state,
      scannedRecords: counts.readCalls,
    };
  } finally {
    await api.close();
  }
}

const [, , outputPath = path.join(os.tmpdir(), "core64-status-authority.json"), sampleText = "20"] = process.argv;
const samples = Number(sampleText);
assert.ok(Number.isSafeInteger(samples) && samples >= 5 && samples <= 100, "sample count must be between 5 and 100");
const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "scriptorium-c64-status-authority-"));
try {
  const fixtures = [];
  for (const recordCount of [1, 100]) fixtures.push(await measureFixture(recordCount, samples, temporaryRoot));
  const race = await verifyUnknownOnRace(temporaryRoot);
  const result = {
    schemaVersion: 1,
    candidate: "C41",
    source: "local synthetic API process with signed status credentials, controlled Core store, and in-memory fake persistence rows",
    hostedOrK3sEvidence: "NOT_CHECKED: no authorized hosted or k3s fixture was supplied",
    invariants: {
      stableStatusUsesPairedRemoteObservations: true,
      readerPinnedToFirstObservation: true,
      remoteMismatchReturnsUnknown: race.persistenceState === "unknown",
    },
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch, kernel: os.release() },
    fixtures,
    remoteRace: race,
  };
  await fsp.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    outputPath,
    fixtures: fixtures.map(({ fakePersistenceRecords, wallMs, counts }) => ({ fakePersistenceRecords, wallMs, observeCalls: counts.observeCalls })),
    remoteRace: race,
    hostedOrK3sEvidence: result.hostedOrK3sEvidence,
  }, null, 2) + "\n");
} finally {
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
