import type {
  DiagnosticsEvidence,
  DiagnosticsFinding,
  DiagnosticsFindingsReport,
  HostValidatedDiagnosticSourceIdentity,
} from "./DiagnosticsFindings.js";
import type { DiagnosticsMarginMarker } from "../../../../editor/cm/diagnosticMargin.js";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeSourcePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every(part => part.length > 0 && part !== "." && part !== ".." && part !== ".git");
}

function evidenceRows(value: unknown): DiagnosticsEvidence[] {
  if (!Array.isArray(value)) return [];
  const rows: DiagnosticsEvidence[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !safeSourcePath(raw.path)) continue;
    const revision = string(raw.revision) ?? string(raw.fileRevision);
    if (!validRevision(revision)) continue;
    const quote = string(raw.quote);
    if (quote === null || quote.length > 4000) continue;
    const start = Number.isSafeInteger(raw.start) && (raw.start as number) >= 0 ? raw.start as number : undefined;
    const end = Number.isSafeInteger(raw.end) && (raw.end as number) >= 0 ? raw.end as number : undefined;
    rows.push({
      ...(typeof raw.sceneId === "string" ? { sceneId: raw.sceneId } : {}),
      path: raw.path,
      revision,
      ...(start !== undefined && end !== undefined && end >= start ? { start, end } : {}),
      quote,
    });
  }
  return rows;
}

function validatedIdentity(
  value: unknown,
  fingerprint: string,
  expected: { repositoryId: number | null; branch: string; generation: string; snapshotId: string },
): HostValidatedDiagnosticSourceIdentity | undefined {
  if (!isRecord(value) || value.findingFingerprint !== fingerprint ||
      typeof value.actionId !== "string" || !value.actionId.startsWith("proprium.diagnostics.") ||
      value.repositoryId !== expected.repositoryId || value.branch !== expected.branch ||
      value.generation !== expected.generation || value.snapshot !== expected.snapshotId ||
      !isRecord(value.analyzer) || typeof value.analyzer.id !== "string" || typeof value.analyzer.version !== "string" ||
      !Array.isArray(value.sources) || value.sources.length > 100) return undefined;

  // Keep the exact signed result object. The guest compares it byte-for-byte
  // (canonical JSON) with the identity it remembered when it produced the report.
  for (const source of value.sources) {
    if (!isRecord(source) || !safeSourcePath(source.path) || !validRevision(source.fileRevision)) return undefined;
    if (source.quote !== undefined && (typeof source.quote !== "string" || source.quote.length > 4000)) return undefined;
    if (source.span !== undefined && (!isRecord(source.span) || !Number.isSafeInteger(source.span.start) ||
        !Number.isSafeInteger(source.span.end) || (source.span.start as number) < 0 ||
        (source.span.end as number) < (source.span.start as number))) return undefined;
  }
  return value as unknown as HostValidatedDiagnosticSourceIdentity;
}

function normalizeFinding(
  value: unknown,
  expected: { repositoryId: number | null; branch: string; generation: string; snapshotId: string },
): DiagnosticsFinding | null {
  if (!isRecord(value) || !/^[a-f0-9]{64}$/u.test(string(value.fingerprint) ?? "") ||
      typeof value.kind !== "string" || typeof value.severity !== "string" || typeof value.message !== "string") return null;
  const fingerprint = value.fingerprint as string;
  const evidence = evidenceRows(value.evidence);
  const identity = validatedIdentity(value.sourceIdentity, fingerprint, expected);
  const first = evidence[0];
  const rawRange = isRecord(value.range) ? value.range : null;
  const start = Number.isSafeInteger(rawRange?.start) ? rawRange!.start as number : undefined;
  const end = Number.isSafeInteger(rawRange?.end) ? rawRange!.end as number : undefined;
  const path = string(value.source_path) ?? first?.path;
  const revision = string(value.source_revision) ?? first?.revision;
  const quote = string(value.quote) ?? first?.quote;
  return {
    fingerprint,
    kind: value.kind,
    severity: value.severity,
    message: value.message,
    ...(typeof value.basis === "string" ? { basis: value.basis } : {}),
    ...(path ? { path } : {}),
    ...(validRevision(revision) ? { revision } : {}),
    ...(start !== undefined && end !== undefined && end >= start ? { span: { start, end } } : {}),
    ...(quote !== null && quote !== undefined ? { quote } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(identity ? { sourceIdentity: identity } : {}),
  };
}

/** Converts only the signed Diagnostics scene result shape into the Host view model. */
export function normalizeDiagnosticsSceneReport(
  value: unknown,
  expected: { repositoryId: number | null; branch: string; generation: string; snapshotId: string },
): DiagnosticsFindingsReport {
  if (!isRecord(value) || !isRecord(value.identity) || !isRecord(value.identity.snapshot) ||
      value.identity.snapshot.id !== expected.snapshotId || value.identity.repositoryId !== expected.repositoryId ||
      value.identity.branch !== expected.branch || !Array.isArray(value.findings) || typeof value.complete !== "boolean") {
    throw new Error("Diagnostics returned a report for a different snapshot or an invalid result.");
  }
  const identity = value.identity;
  if (typeof identity.sceneId !== "string" || !safeSourcePath(identity.documentPath) ||
      !validRevision(identity.documentRevision) || typeof identity.textHash !== "string") {
    throw new Error("Diagnostics report is missing its source identity.");
  }
  const findings = value.findings.map(row => normalizeFinding(row, expected));
  if (findings.some(row => row === null)) throw new Error("Diagnostics report contains a malformed finding; it was not hidden or discarded.");
  const normalizedFindings = findings as DiagnosticsFinding[];
  const sections = isRecord(value.sections) ? value.sections : {};
  const semantic = isRecord(sections.semanticHypotheses) ? sections.semanticHypotheses : null;
  const semanticHypotheses = semantic && (typeof semantic.complete === "boolean") &&
    (semantic.nextCursor === null || typeof semantic.nextCursor === "string")
    ? { complete: semantic.complete, nextCursor: semantic.nextCursor as string | null }
    : undefined;
  return {
    identity: identity as unknown as DiagnosticsFindingsReport["identity"],
    findings: normalizedFindings,
    ...(isRecord(value.feedback) ? { feedback: value.feedback as unknown as DiagnosticsFindingsReport["feedback"] } : {}),
    ...(semanticHypotheses ? { semanticHypotheses } : {}),
    ...(Object.keys(sections).length ? { sections } : {}),
    complete: value.complete,
  };
}

/** Build gutter rows only from exact source identities and quotes in the current saved document. */
export function diagnosticsMarginMarkers(report: DiagnosticsFindingsReport | null, active: {
  readonly path: string;
  readonly revision: string;
  readonly text: string;
  readonly sceneId: string;
  readonly isCurrentSavedScene: boolean;
}): DiagnosticsMarginMarker[] {
  if (!report || !active.isCurrentSavedScene || report.identity.sceneId !== active.sceneId ||
      report.identity.documentPath !== active.path || report.identity.documentRevision !== active.revision) return [];
  const markers: DiagnosticsMarginMarker[] = [];
  for (const finding of report.findings) {
    const identity = finding.sourceIdentity;
    if (!identity || identity.findingFingerprint !== finding.fingerprint) continue;
    const severity = finding.severity;
    if (severity !== "error" && severity !== "warning" && severity !== "info") continue;
    for (const source of identity.sources) {
      const span = source.span;
      const quote = source.quote;
      if (source.path !== active.path || source.fileRevision !== active.revision || !span || typeof quote !== "string" ||
          !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start ||
          span.end > active.text.length || quote.length < 1 || active.text.slice(span.start, span.end) !== quote ||
          !finding.evidence?.some(evidence => evidence.path === source.path && evidence.revision === source.fileRevision &&
            evidence.start === span.start && evidence.end === span.end && evidence.quote === quote)) continue;
      markers.push({ findingFingerprint: finding.fingerprint, message: finding.message, severity,
        path: source.path, revision: source.fileRevision, start: span.start, end: span.end, quote,
        sourceIdentity: identity as unknown as Readonly<Record<string, unknown>> });
      break;
    }
  }
  return markers;
}

export function mergeDiagnosticsSceneReports(
  prior: DiagnosticsFindingsReport,
  next: DiagnosticsFindingsReport,
): DiagnosticsFindingsReport {
  if (prior.identity.snapshot.id !== next.identity.snapshot.id || prior.identity.sceneId !== next.identity.sceneId ||
      prior.identity.documentPath !== next.identity.documentPath || prior.identity.documentRevision !== next.identity.documentRevision) {
    throw new Error("Diagnostics page belongs to a different report snapshot.");
  }
  const findings = new Map(prior.findings.map(row => [row.fingerprint, row]));
  for (const finding of next.findings) findings.set(finding.fingerprint, finding);
  const sections = { ...(prior.sections ?? {}), ...(next.sections ?? {}) };
  const semantic = isRecord(sections.semanticHypotheses) ? sections.semanticHypotheses : null;
  const semanticComplete = semantic?.status === "ready" && semantic.complete === true && semantic.nextCursor === null;
  const complete = Object.values(sections).every(section => {
    if (!isRecord(section) || section.status === "unavailable") return false;
    if (section.status === "partial") return false;
    if (section.complete === false) return section === semantic && semanticComplete;
    if (section === semantic && !semanticComplete) return false;
    return true;
  });
  const counts: Record<string, number> = {};
  for (const finding of findings.values()) {
    const rawClass = (finding as DiagnosticsFinding & { class?: unknown }).class;
    const key = typeof rawClass === "string" ? rawClass : "other";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { ...next, identity: prior.identity, findings: [...findings.values()], sections,
    semanticHypotheses: semantic && typeof semantic.nextCursor === "string" ? { complete: semantic.complete === true, nextCursor: semantic.nextCursor } : { complete: true, nextCursor: null },
    complete,
    ...(isRecord(next.feedback) ? { feedback: next.feedback } : prior.feedback ? { feedback: prior.feedback } : {}),
    ...(isRecord(next.summary) ? { summary: { findingCount: findings.size, byClass: counts } } : {}),
  };
}
