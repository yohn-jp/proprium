import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticsMarginMarkers, mergeDiagnosticsSceneReports, normalizeDiagnosticsSceneReport } from "./diagnosticsHostModel.js";

const scope = { repositoryId: 42, branch: "main", generation: "workspace-7", snapshotId: "snapshot-1" };
const revision = "a".repeat(64);
const fingerprint = "b".repeat(64);
const quote = "本文。";
const reportValue = (identityOverrides: Record<string, unknown> = {}, sourceIdentityOverrides: Record<string, unknown> = {}) => ({
  identity: { repositoryId: scope.repositoryId, branch: scope.branch, snapshot: { id: scope.snapshotId },
    sceneId: "sc-1", documentPath: "manuscript/a.md", documentRevision: revision, draftGeneration: null,
    textHash: "c".repeat(64), analyzerId: "proprium.diagnostics.cpu", analyzerVersion: "1.0.0", configRevisions: {}, ...identityOverrides },
  sections: { prose: { status: "ready", complete: true }, semanticHypotheses: { status: "ready", complete: false, nextCursor: "next" } },
  findings: [{ fingerprint, kind: "rhythm", severity: "warning", basis: "deterministic", message: "連続しています。",
    range: { start: 0, end: quote.length }, quote,
    evidence: [{ path: "manuscript/a.md", revision, start: 0, end: quote.length, quote }],
    sourceIdentity: { actionId: "proprium.diagnostics.text.analyze.v1", repositoryId: scope.repositoryId, branch: scope.branch,
      generation: scope.generation, snapshot: scope.snapshotId, findingFingerprint: fingerprint,
      analyzer: { id: "proprium.diagnostics.cpu", version: "1.0.0" },
      sources: [{ path: "manuscript/a.md", fileRevision: revision, span: { start: 0, end: quote.length }, quote }], ...sourceIdentityOverrides } }],
  complete: false,
});

test("normalizes only reports and identities bound to the current signed action scope", () => {
  const report = normalizeDiagnosticsSceneReport(reportValue(), scope);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0]?.sourceIdentity?.findingFingerprint, fingerprint);
  assert.equal(report.semanticHypotheses?.nextCursor, "next");

  const foreign = normalizeDiagnosticsSceneReport(reportValue({}, { snapshot: "foreign" }), scope);
  assert.equal(foreign.findings[0]?.sourceIdentity, undefined);
});

test("gutter markers require a current saved scene, exact revision and matching source quote", () => {
  const report = normalizeDiagnosticsSceneReport(reportValue(), scope);
  const active = { path: "manuscript/a.md", revision, text: quote, sceneId: "sc-1", isCurrentSavedScene: true };
  assert.equal(diagnosticsMarginMarkers(report, active).length, 1);
  assert.equal(diagnosticsMarginMarkers(report, { ...active, isCurrentSavedScene: false }).length, 0);
  assert.equal(diagnosticsMarginMarkers(report, { ...active, revision: "d".repeat(64) }).length, 0);
  assert.equal(diagnosticsMarginMarkers(report, { ...active, text: "別の本文。" }).length, 0);
});

test("Semantic pages merge only within the same scene and snapshot", () => {
  const first = normalizeDiagnosticsSceneReport(reportValue(), scope);
  const second = normalizeDiagnosticsSceneReport({ ...reportValue(),
    sections: { semanticHypotheses: { status: "ready", complete: true, nextCursor: null } },
    findings: [{ fingerprint: "d".repeat(64), kind: "embedding_midband", severity: "warning", message: "候補" }],
    complete: true,
  }, scope);
  const merged = mergeDiagnosticsSceneReports(first, second);
  assert.equal(merged.findings.length, 2);
  assert.deepEqual(merged.semanticHypotheses, { complete: true, nextCursor: null });
  assert.equal(merged.complete, true);
  assert.throws(() => mergeDiagnosticsSceneReports(first, { ...second,
    identity: { ...second.identity, snapshot: { id: "foreign" } } }), /different report snapshot/u);
});
