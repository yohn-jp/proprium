export type DiagnosticsFindingState = "all" | "open" | "decided";

export function filterDiagnosticsFindings<
  Finding extends { fingerprint: string; kind: string; severity: string },
  Decision extends { findingFingerprint: string },
>(
  findings: readonly Finding[],
  decisions: readonly Decision[],
  filters: { kind: string; severity: string; state: DiagnosticsFindingState },
): Finding[] {
  const decisionsByFingerprint = new Set(decisions.map((item) => item.findingFingerprint));
  return findings.filter((finding) => {
    if (filters.kind !== "all" && finding.kind !== filters.kind) return false;
    if (filters.severity !== "all" && finding.severity !== filters.severity) return false;
    const decided = decisionsByFingerprint.has(finding.fingerprint);
    return filters.state === "all" || (filters.state === "decided" ? decided : !decided);
  });
}
