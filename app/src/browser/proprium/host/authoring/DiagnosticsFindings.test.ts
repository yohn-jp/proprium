import assert from "node:assert/strict";
import test from "node:test";
import { filterDiagnosticsFindings } from "./diagnosticsFindingsModel.js";

test("Diagnostics findings filters compose kind, severity and active feedback state", () => {
  const findings = [
    { fingerprint: "a", kind: "format", severity: "warning" },
    { fingerprint: "b", kind: "embedding_midband", severity: "warning" },
    { fingerprint: "c", kind: "embedding_midband", severity: "error" },
  ];
  const decisions = [{ findingFingerprint: "b" }];
  assert.deepEqual(filterDiagnosticsFindings(findings, decisions, { kind: "all", severity: "all", state: "all" }).map((row) => row.fingerprint), ["a", "b", "c"]);
  assert.deepEqual(filterDiagnosticsFindings(findings, decisions, { kind: "embedding_midband", severity: "warning", state: "all" }).map((row) => row.fingerprint), ["b"]);
  assert.deepEqual(filterDiagnosticsFindings(findings, decisions, { kind: "all", severity: "all", state: "open" }).map((row) => row.fingerprint), ["a", "c"]);
  assert.deepEqual(filterDiagnosticsFindings(findings, decisions, { kind: "all", severity: "all", state: "decided" }).map((row) => row.fingerprint), ["b"]);
});
