import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SnapshotReader } from "@scriptorium/contracts";
import {
  metadataForRuntime,
  normalizeRemoteRevision,
  parseQuiesceRequest,
  parseRuntimeAssignment,
  parseRuntimeControlCredential,
  scanRemotePersistence,
  sha256Digest,
} from "./platform-runtime.js";

const ASSIGNMENT = {
  contractVersion: "scriptorium-platform/v1",
  instanceId: "instance-1",
  repositoryId: 42,
  repositoryLocator: "https://github.com/owner/book",
  defaultBranchPolicy: "repository-default",
  runtimeEpoch: 3,
  imageDigest: `sha256:${"a".repeat(64)}`,
  compositionManifestDigest: `sha256:${"b".repeat(64)}`,
  enabledModuleIds: ["story", "mcp"],
  credentialBrokerLocator: "https://praetorium.example/internal/github/credential",
  controlServicePolicy: {
    issuer: "https://praetorium.example",
    jwksUrl: "https://praetorium.example/.well-known/control-jwks.json",
    audience: "praetorium-runtime-control",
  },
  grantPolicy: {
    issuer: "https://praetorium.example",
    jwksUrl: "https://praetorium.example/.well-known/grant-jwks.json",
    audience: "https://praetorium.example/scriptorium",
  },
} as const;

function snapshotReader(files: Record<string, string>, remoteCommit = "c".repeat(40)): SnapshotReader {
  const snapshot = {
    repository: { provider: "github" as const, repositoryId: "42", defaultBranch: "main", ownerScope: "owner", url: ASSIGNMENT.repositoryLocator },
    remoteCommit,
  };
  return {
    snapshot,
    async read(filePath, encoding = "utf8") {
      const content = files[filePath];
      return content === undefined ? null : {
        content: encoding === "base64" ? Buffer.from(content, "utf8").toString("base64") : content,
        revision: `sha256:${"d".repeat(64)}`,
      };
    },
    async list(prefix) {
      return Object.keys(files).filter((filePath) => filePath === prefix || filePath.startsWith(`${prefix}/`)).sort();
    },
  };
}

describe("hosted runtime platform contract", () => {
  it("parses only a structured immutable assignment and quiesce request", () => {
    const assignment = parseRuntimeAssignment(ASSIGNMENT);
    assert.equal(assignment.repositoryId, 42);
    assert.deepEqual(assignment.enabledModuleIds, ["story", "mcp"]);
    assert.throws(() => parseRuntimeAssignment({ ...ASSIGNMENT, githubToken: "secret" }), /assignment is invalid/u);

    const request = parseQuiesceRequest({
      contractVersion: "scriptorium-platform/v1",
      operationId: "operation-1",
      instanceId: "instance-1",
      runtimeEpoch: 3,
      reason: "redeploy",
      deadline: "2026-10-17T00:00:30.000Z",
    });
    assert.equal(request.reason, "redeploy");
    assert.throws(() => parseQuiesceRequest({ ...request, extra: true }), /request is invalid/u);
  });

  it("binds private controls to assignment, operation, payload and lifetime", () => {
    const value = {
      contractVersion: "praetorium-runtime-control/v1",
      iss: ASSIGNMENT.controlServicePolicy.issuer,
      sub: "control-plane",
      aud: ASSIGNMENT.controlServicePolicy.audience,
      instanceId: ASSIGNMENT.instanceId,
      repositoryId: ASSIGNMENT.repositoryId,
      runtimeEpoch: ASSIGNMENT.runtimeEpoch,
      operationId: "operation-1",
      action: "quiesce",
      payloadDigest: sha256Digest("body"),
      iat: 100,
      nbf: 100,
      exp: 130,
      jti: "credential-1",
    };
    assert.equal(parseRuntimeControlCredential(value, {
      issuer: ASSIGNMENT.controlServicePolicy.issuer,
      audience: ASSIGNMENT.controlServicePolicy.audience,
      instanceId: ASSIGNMENT.instanceId,
      repositoryId: ASSIGNMENT.repositoryId,
      runtimeEpoch: ASSIGNMENT.runtimeEpoch,
      operationId: "operation-1",
      action: "quiesce",
      payloadDigest: sha256Digest("body"),
      nowSeconds: 110,
    }).jti, "credential-1");
    assert.throws(() => parseRuntimeControlCredential(value, {
      issuer: ASSIGNMENT.controlServicePolicy.issuer,
      audience: ASSIGNMENT.controlServicePolicy.audience,
      instanceId: ASSIGNMENT.instanceId,
      repositoryId: ASSIGNMENT.repositoryId,
      runtimeEpoch: ASSIGNMENT.runtimeEpoch + 1,
      operationId: "operation-1",
      action: "quiesce",
      payloadDigest: sha256Digest("body"),
      nowSeconds: 110,
    }), /binding mismatch/u);
  });

  it("reports the exact remote metadata format pairs only after a complete scan", async () => {
    const files = {
      "meta/scriptorium/operations/v1/op-1.json": JSON.stringify({ version: 1, operation: { id: "op-1" } }),
      "meta/scriptorium/publications/v1/batch-1.json": JSON.stringify({ version: 1, batchId: "batch-1" }),
      "meta/scriptorium/proposals/v1/proposal-legacy.json": JSON.stringify({ version: 1, proposalId: "proposal-legacy" }),
      "meta/scriptorium/proposals/v2/bindings/proposal-binding.json": JSON.stringify({ version: 2, proposalId: "proposal-binding" }),
      "meta/scriptorium/proposals/v2/complete/proposal-complete.json": JSON.stringify({ version: 2, proposalId: "proposal-complete" }),
    };
    const commit = "c".repeat(40);
    const observed = await scanRemotePersistence(snapshotReader(files), commit);
    assert.equal(observed.state, "verified");
    assert.equal(observed.observedRemoteCommit, commit);
    assert.deepEqual(observed.formats, [
      { formatId: "scriptorium.git-operations", version: 1 },
      { formatId: "scriptorium.git-proposal-binding", version: 2 },
      { formatId: "scriptorium.git-proposal-complete", version: 2 },
      { formatId: "scriptorium.git-proposal-legacy", version: 1 },
      { formatId: "scriptorium.git-publications", version: 1 },
    ]);

    const malformed = await scanRemotePersistence(snapshotReader({
      ...files,
      "meta/scriptorium/proposals/v2/other/proposal.json": "{}",
    }), commit);
    assert.equal(malformed.state, "unknown");
    const wrongIdentity = await scanRemotePersistence(snapshotReader({
      "meta/scriptorium/operations/v1/op-1.json": JSON.stringify({ version: 1, operation: { id: "different" } }),
    }), commit);
    assert.equal(wrongIdentity.state, "unknown");
    assert.equal((await scanRemotePersistence(snapshotReader(files), "not-a-commit")).state, "unknown");
  });

  it("normalizes the empty Core remote sentinel and verifies a complete empty scan", async () => {
    assert.equal(normalizeRemoteRevision(""), null);
    assert.equal(normalizeRemoteRevision(null), null);
    assert.equal(normalizeRemoteRevision("not-a-commit"), undefined);
    assert.deepEqual(await scanRemotePersistence(snapshotReader({}, ""), null), {
      state: "verified",
      observedRemoteCommit: null,
      formats: [],
    });
  });

  it("classifies supported module-owned formats and fails closed on unknown paths or versions", async () => {
    const commit = "e".repeat(40);
    const files = {
      "meta/scriptorium/modules/assistant/model-settings.json": JSON.stringify({ defaultPresetId: "default", presets: [{ id: "default", model: "local" }] }),
      "meta/scriptorium/modules/diagnostics/lint-rules.yaml": "rules: []\n",
      "meta/scriptorium/modules/nlp/feature-settings.json": JSON.stringify({ externalEnabled: {} }),
      "meta/scriptorium/modules/publishing/share-grants.jsonl": JSON.stringify({ version: 1, id: "grant-1" }),
      "meta/scriptorium/modules/semantic/settings.json": JSON.stringify({ schemaVersion: 1, rerankerEnabled: false }),
      "meta/scriptorium/modules/speaker/adopted-model.json": JSON.stringify({ version: 1, featureNames: ["x"], weights: [0], bias: 0, highProbabilityThreshold: 0.5, trainedAt: "2026-10-17T00:00:00.000Z" }),
      "meta/scriptorium/modules/story/v1/series.json": JSON.stringify({ version: 1, series: [], bindings: [] }),
      "meta/scriptorium/modules/story/legacy/files/meta/old.json": "opaque legacy bytes",
    };
    const observed = await scanRemotePersistence(snapshotReader(files), commit);
    assert.equal(observed.state, "verified");
    assert.equal(observed.observedRemoteCommit, commit);
    assert.deepEqual(observed.formats.map(({ formatId, version }) => ({ formatId, version })), [
      { formatId: "scriptorium.module-assistant.model-settings", version: 1 },
      { formatId: "scriptorium.module-diagnostics.lint-rules", version: 1 },
      { formatId: "scriptorium.module-nlp.feature-settings", version: 1 },
      { formatId: "scriptorium.module-publishing.share-grants", version: 1 },
      { formatId: "scriptorium.module-semantic.settings", version: 1 },
      { formatId: "scriptorium.module-speaker.adopted-model", version: 1 },
      { formatId: "scriptorium.module-story.legacy-files", version: 1 },
      { formatId: "scriptorium.module-story.series", version: 1 },
    ]);

    assert.equal((await scanRemotePersistence(snapshotReader({
      ...files,
      "meta/scriptorium/modules/story/future-data.json": "{}",
    }), commit)).state, "unknown");
    assert.equal((await scanRemotePersistence(snapshotReader({
      "meta/scriptorium/modules/story/v1/series.json": JSON.stringify({ version: 2, series: [], bindings: [] }),
    }), commit)).state, "unknown");
    assert.equal((await scanRemotePersistence(snapshotReader({ "meta/scriptorium/unclassified.json": "{}" }), commit)).state, "unknown");
  });

  it("declares the actual hosted listener and quiesce shutdown action", () => {
    const metadata = metadataForRuntime({ producerRevision: "1".repeat(40), port: 3000, shutdownTimeoutSeconds: 25 });
    assert.equal(metadata.listener.port, 3000);
    assert.equal(metadata.paths.shutdown, "/api/platform/v1/quiesce");
    assert.equal(metadata.paths.status, "/api/platform/v1/status");
  });
});
