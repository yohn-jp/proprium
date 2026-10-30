import assert from "node:assert/strict";
import test from "node:test";
import { currentDiagnosticsMarginMarkers, type DiagnosticsMarginMarker } from "./diagnosticMargin.js";

function fixture(overrides: Partial<DiagnosticsMarginMarker> = {}): DiagnosticsMarginMarker {
  const marker: DiagnosticsMarginMarker = {
    findingFingerprint: "a".repeat(64), message: "同じ文が続いています", severity: "warning",
    path: "manuscript/chapter.md", revision: "b".repeat(40), start: 1, end: 5, quote: "🌸です",
    sourceIdentity: {
      actionId: "proprium.diagnostics.scene.run.v1", repositoryId: 17, branch: "main", generation: "g1", snapshot: "s1",
      findingFingerprint: "a".repeat(64), analyzer: { id: "proprium.diagnostics.cpu", version: "1.0.0" },
      sources: [{ path: "manuscript/chapter.md", fileRevision: "b".repeat(40), span: { start: 1, end: 5 }, quote: "🌸です" }],
    },
    ...overrides,
  };
  return marker;
}

test("retains a current UTF-16 source span with matching repository-bound identity", () => {
  const markers = currentDiagnosticsMarginMarkers([fixture()], "前🌸です後", { path: "manuscript/chapter.md", revision: "b".repeat(40) });
  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.start, 1);
  assert.equal(markers[0]?.quote, "🌸です");
});

test("drops stale path, saved revision and source quote before rendering", () => {
  const markers = [
    fixture({ path: "manuscript/other.md" }),
    fixture({ revision: "c".repeat(40) }),
    fixture({ quote: "different" }),
  ];
  assert.deepEqual(currentDiagnosticsMarginMarkers(markers, "前🌸です後", { path: "manuscript/chapter.md", revision: "b".repeat(40) }), []);
});

test("rejects mismatched fingerprint, span, unsafe range and malformed severity", () => {
  const original = fixture();
  const wrongIdentity = fixture({ findingFingerprint: "c".repeat(64) });
  const wrongSpan = fixture({ start: 0 });
  const overflow = fixture({ end: 999 });
  const invalidSeverity = fixture({ severity: "critical" as DiagnosticsMarginMarker["severity"] });
  assert.deepEqual(currentDiagnosticsMarginMarkers([original, wrongIdentity, wrongSpan, overflow, invalidSeverity],
    "前🌸です後", { path: original.path, revision: original.revision }), [original]);
});

test("orders multiple current findings by source offset and stable fingerprint", () => {
  const first = fixture({ findingFingerprint: "b".repeat(64), start: 0, end: 1, quote: "A", sourceIdentity: {
    ...fixture().sourceIdentity, findingFingerprint: "b".repeat(64),
    sources: [{ path: "manuscript/chapter.md", fileRevision: "b".repeat(40), span: { start: 0, end: 1 }, quote: "A" }],
  } });
  const second = fixture({ findingFingerprint: "d".repeat(64), start: 1, end: 2, quote: "B", sourceIdentity: {
    ...fixture().sourceIdentity, findingFingerprint: "d".repeat(64),
    sources: [{ path: "manuscript/chapter.md", fileRevision: "b".repeat(40), span: { start: 1, end: 2 }, quote: "B" }],
  } });
  assert.deepEqual(currentDiagnosticsMarginMarkers([second, first], "AB", { path: first.path, revision: first.revision }), [first, second]);
});
