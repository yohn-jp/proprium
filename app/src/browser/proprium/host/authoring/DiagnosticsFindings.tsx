import { useMemo, useState } from "react";
import { filterDiagnosticsFindings, type DiagnosticsFindingState } from "./diagnosticsFindingsModel.js";
import "./DiagnosticsFindings.css";

export { filterDiagnosticsFindings } from "./diagnosticsFindingsModel.js";
export type { DiagnosticsFindingState } from "./diagnosticsFindingsModel.js";

export type DiagnosticsFeedbackDecision = "false_positive" | "intentional" | "deferred" | "legacy_dismissed";

export interface DiagnosticsEvidence {
  readonly sceneId?: string;
  readonly path: string;
  readonly revision: string;
  readonly start?: number;
  readonly end?: number;
  readonly quote: string;
}

/** This identity is Host-validated. The component never sends it back to the guest. */
export interface HostValidatedDiagnosticSourceIdentity {
  readonly actionId: string;
  readonly repositoryId: number | null;
  readonly branch: string;
  readonly generation: string;
  readonly snapshot: string;
  readonly findingFingerprint: string;
  readonly analyzer: { readonly id: string; readonly version: string };
  readonly sources: readonly {
    readonly path: string;
    readonly fileRevision: string;
    readonly textHash?: string;
    readonly span?: { readonly start: number; readonly end: number };
    readonly quote?: string;
  }[];
}

export interface DiagnosticsFinding {
  readonly fingerprint: string;
  readonly kind: string;
  readonly severity: string;
  readonly message: string;
  readonly basis?: "deterministic" | "hypothesis" | string;
  readonly path?: string;
  readonly revision?: string;
  readonly span?: { readonly start: number; readonly end: number };
  readonly quote?: string;
  readonly evidence?: readonly DiagnosticsEvidence[];
  readonly sourceIdentity?: HostValidatedDiagnosticSourceIdentity;
}

export interface AppliedDiagnosticsDecision {
  readonly findingFingerprint: string;
  readonly decision: DiagnosticsFeedbackDecision;
  readonly annotation?: string;
  readonly updatedAt: string;
}

export interface StaleDiagnosticsDecision {
  readonly findingFingerprint: string;
  readonly decision: DiagnosticsFeedbackDecision;
  readonly updatedAt: string;
  readonly sourcePaths: readonly string[];
}

export interface DiagnosticsLegacyMigrationRow {
  readonly rowId: string;
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly candidateId?: string;
  readonly timestamp?: string;
  readonly disposition: "importable" | "already_imported" | "unresolved" | "conflict" | "invalid";
  readonly detail: string;
  readonly rawLine: string;
  readonly targetFingerprint?: string;
  readonly sourcePaths: readonly string[];
}

export interface DiagnosticsLegacyMigrationReport {
  readonly sources: readonly {
    readonly path: string;
    readonly revision: string;
    readonly error?: string;
  }[];
  readonly feedbackRevision: string | null;
  readonly rows: readonly DiagnosticsLegacyMigrationRow[];
  readonly complete: boolean;
  readonly error?: string;
}

export interface DiagnosticsFindingsReport {
  readonly identity: {
    readonly repositoryId: number | null;
    readonly branch: string;
    readonly snapshot: { readonly id: string };
    readonly sceneId: string;
    readonly documentPath: string;
    readonly documentRevision: string;
    readonly draftGeneration: string | null;
    readonly textHash: string;
  };
  readonly findings: readonly DiagnosticsFinding[];
  readonly feedback?: {
    readonly revision: string | null;
    readonly decisions: readonly AppliedDiagnosticsDecision[];
    readonly staleDecisions?: readonly StaleDiagnosticsDecision[];
  };
  readonly semanticHypotheses?: {
    readonly nextCursor: string | null;
    readonly complete: boolean;
  };
  readonly complete: boolean;
}

function evidenceFor(finding: DiagnosticsFinding): DiagnosticsEvidence[] {
  if (finding.evidence?.length) return [...finding.evidence];
  if (finding.path && finding.revision) return [{
    path: finding.path,
    revision: finding.revision,
    ...(finding.span ? { start: finding.span.start, end: finding.span.end } : {}),
    quote: finding.quote ?? "",
  }];
  return [];
}

function decisionLabel(decision: DiagnosticsFeedbackDecision): string {
  switch (decision) {
    case "intentional": return "意図した所見";
    case "false_positive": return "誤検出";
    case "deferred": return "後で確認";
    case "legacy_dismissed": return "過去の却下（理由未記録）";
  }
}

export interface DiagnosticsFindingsProps {
  readonly report: DiagnosticsFindingsReport | null;
  readonly onFeedback: (event: Event, findingFingerprint: string, decision: Exclude<DiagnosticsFeedbackDecision, "legacy_dismissed">) => Promise<void>;
  readonly onSelect: (event: Event, findingFingerprint: string, evidenceIndex?: number) => void;
  readonly onLoadMore?: (event: Event, cursor: string) => Promise<void>;
  readonly migration?: DiagnosticsLegacyMigrationReport | null;
  readonly onInspectLegacy?: (event: Event) => Promise<void>;
  readonly onMigrateLegacy?: (event: Event, selectedRowIds: readonly string[]) => Promise<void>;
}

export function DiagnosticsFindings({ report, onFeedback, onSelect, onLoadMore, migration, onInspectLegacy, onMigrateLegacy }: DiagnosticsFindingsProps) {
  const [kind, setKind] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [state, setState] = useState<DiagnosticsFindingState>("all");
  const [selectedLegacyRows, setSelectedLegacyRows] = useState<Set<string>>(new Set());
  const [busyFinding, setBusyFinding] = useState<string | null>(null);
  const [busyMigration, setBusyMigration] = useState(false);
  const [notice, setNotice] = useState("");

  const findings = report?.findings ?? [];
  const decisions = report?.feedback?.decisions ?? [];
  const kinds = useMemo(() => [...new Set(findings.map((finding) => finding.kind))].sort(), [findings]);
  const severities = useMemo(() => [...new Set(findings.map((finding) => finding.severity))].sort(), [findings]);
  const visible = useMemo(() => filterDiagnosticsFindings(findings, decisions, { kind, severity, state }), [findings, decisions, kind, severity, state]);
  const decisionsByFingerprint = useMemo(() => new Map(decisions.map((item) => [item.findingFingerprint, item])), [decisions]);
  const importableRows = migration?.rows.filter((row) => row.disposition === "importable") ?? [];

  async function submitFeedback(event: Event, findingFingerprint: string, decision: Exclude<DiagnosticsFeedbackDecision, "legacy_dismissed">) {
    setBusyFinding(findingFingerprint);
    setNotice("");
    try {
      await onFeedback(event, findingFingerprint, decision);
      setNotice("Host Review に提案を送りました。承認されるまでは所見の状態は変わりません。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "所見の判断を提案できませんでした。");
    } finally {
      setBusyFinding(null);
    }
  }

  async function inspectLegacy(event: Event) {
    if (!onInspectLegacy) return;
    setBusyMigration(true);
    setNotice("");
    try {
      await onInspectLegacy(event);
      setSelectedLegacyRows(new Set());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "過去の却下記録を確認できませんでした。");
    } finally {
      setBusyMigration(false);
    }
  }

  async function proposeLegacy(event: Event) {
    if (!onMigrateLegacy) return;
    setBusyMigration(true);
    setNotice("");
    try {
      await onMigrateLegacy(event, [...selectedLegacyRows]);
      setNotice("Host Review に移行提案を送りました。元のJSONLは変更されません。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "過去の却下記録を提案できませんでした。");
    } finally {
      setBusyMigration(false);
    }
  }

  return <section className="diagnostics-findings" aria-label="診断所見と過去の判断">
    <header className="diagnostics-findings__header">
      <div><h2>診断所見</h2><p>根拠を確認し、判断はHost Reviewで提案します。</p></div>
      {report && <span className="diagnostics-findings__report-state" role="status">{report.complete ? "このレポートの分析は完了" : "このレポートは一部未完了"}</span>}
    </header>
    {!report ? <p className="diagnostics-findings__empty">診断結果はありません。</p> : <>
      <div className="diagnostics-findings__filters" role="group" aria-label="所見フィルター">
        <label>種類<select aria-label="所見の種類" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">すべて</option>{kinds.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>重大度<select aria-label="所見の重大度" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">すべて</option>{severities.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>判断<select aria-label="判断状態" value={state} onChange={(event) => setState(event.target.value as DiagnosticsFindingState)}><option value="all">すべて</option><option value="open">未判断</option><option value="decided">判断済み</option></select></label>
      </div>
      <p className="diagnostics-findings__count" role="status" aria-live="polite">{visible.length} / {findings.length} 件を表示</p>
      {report.feedback?.staleDecisions?.length ? <aside className="diagnostics-findings__stale" role="status">
        <strong>現在の根拠には適用されない過去の判断が {report.feedback.staleDecisions.length} 件あります。</strong>
        <ul>{report.feedback.staleDecisions.map((item) => <li key={`${item.findingFingerprint}:${item.updatedAt}`}>
          {decisionLabel(item.decision)} · {item.sourcePaths.join("、") || "出典不明"} · {item.updatedAt}
        </li>)}</ul>
      </aside> : null}
      {visible.length ? <ol className="diagnostics-findings__list">{visible.map((finding) => {
        const decision = decisionsByFingerprint.get(finding.fingerprint);
        const evidence = evidenceFor(finding);
        const canDecide = Boolean(finding.sourceIdentity?.sources.length && finding.sourceIdentity.findingFingerprint === finding.fingerprint);
        return <li key={finding.fingerprint} data-fingerprint={finding.fingerprint}>
          <article className="diagnostics-finding">
            <header><span className={`diagnostics-finding__severity diagnostics-finding__severity--${finding.severity}`}>{finding.severity}</span><span>{finding.kind}</span>{finding.basis === "hypothesis" && <span>候補</span>}</header>
            <h3>{finding.message}</h3>
            {finding.quote && <blockquote>{finding.quote}</blockquote>}
            {evidence.length > 0 && <ul className="diagnostics-finding__evidence" aria-label="根拠">
              {evidence.map((source, index) => <li key={`${source.path}:${source.revision}:${source.start ?? "file"}:${index}`}>
                <div><code>{source.path}</code><small> revision {source.revision.slice(0, 12)}</small></div>
                {source.quote && <blockquote>{source.quote}</blockquote>}
                <button type="button" disabled={busyFinding === finding.fingerprint} onClick={(event) => onSelect(event.nativeEvent, finding.fingerprint, index)}>
                  {source.start !== undefined && source.end !== undefined ? `根拠 ${index + 1} を開く` : `出典 ${index + 1} を開く`}
                </button>
              </li>)}
            </ul>}
            {decision ? <p className="diagnostics-finding__decision" role="status">{decisionLabel(decision.decision)} · {decision.updatedAt}{decision.annotation ? ` · ${decision.annotation}` : ""}</p>
              : <p className="diagnostics-finding__decision diagnostics-finding__decision--open">未判断</p>}
            {canDecide && <div className="diagnostics-finding__actions" aria-label="所見の判断">
              <button type="button" disabled={busyFinding === finding.fingerprint} onClick={(event) => void submitFeedback(event.nativeEvent, finding.fingerprint, "intentional")}>意図した所見</button>
              <button type="button" disabled={busyFinding === finding.fingerprint} onClick={(event) => void submitFeedback(event.nativeEvent, finding.fingerprint, "false_positive")}>誤検出</button>
              <button type="button" disabled={busyFinding === finding.fingerprint} onClick={(event) => void submitFeedback(event.nativeEvent, finding.fingerprint, "deferred")}>後で確認</button>
            </div>}
          </article>
        </li>;
      })}</ol> : <p className="diagnostics-findings__empty">このフィルターに一致する所見はありません。</p>}
      {report.semanticHypotheses && !report.semanticHypotheses.complete && report.semanticHypotheses.nextCursor && onLoadMore &&
        <button type="button" onClick={(event) => void onLoadMore(event.nativeEvent, report.semanticHypotheses!.nextCursor!)}>意味候補をさらに表示</button>}
    </>}

    <details className="diagnostics-findings__migration">
      <summary>過去のSemantic却下を確認・移行</summary>
      <p>移行は明示的なHost Reviewで提案します。元のJSONLは削除も書き換えもしません。理由がない記録は「過去の却下」として保持します。</p>
      {onInspectLegacy && <button type="button" disabled={busyMigration} onClick={(event) => void inspectLegacy(event.nativeEvent)}>過去の記録を確認</button>}
      {migration?.error && <p role="alert">{migration.error}</p>}
      {migration && <p role="status">{migration.complete ? "移行元をすべて確認しました。" : "一部の移行元を確認できませんでした。未解決の行はそのまま残してください。"}</p>}
      {migration?.sources.map((source) => <p key={`${source.path}:${source.revision}`}>
        出典: <code>{source.path}</code> · revision {source.revision.slice(0, 12)}
        {source.error && <span role="alert"> · {source.error}</span>}
      </p>)}
      {migration?.rows.length ? <ul className="diagnostics-migration__rows">{migration.rows.map((row) => {
        const selected = selectedLegacyRows.has(row.rowId);
        const canSelect = row.disposition === "importable";
        return <li key={row.rowId}>
          {canSelect && <label><input type="checkbox" checked={selected} onChange={(event) => setSelectedLegacyRows((current) => {
            const next = new Set(current);
            if (event.target.checked) next.add(row.rowId); else next.delete(row.rowId);
            return next;
          })} /> 移行対象</label>}
          <strong>{row.disposition}</strong><p>{row.detail}</p>
          {row.candidateId && <code>{row.candidateId}</code>}
          <small><code>{row.sourcePath}</code> · revision {row.sourceRevision.slice(0, 12)}{row.sourcePaths.length > 0 ? ` · ${row.sourcePaths.join("、")}` : ""}</small>
          <pre>{row.rawLine}</pre>
        </li>;
      })}</ul> : migration && <p className="diagnostics-findings__empty">移行候補はありません。</p>}
      {onMigrateLegacy && importableRows.length > 0 && <button type="button" disabled={busyMigration || selectedLegacyRows.size === 0} onClick={(event) => void proposeLegacy(event.nativeEvent)}>
        選択した {selectedLegacyRows.size} 件をHost Reviewへ提案
      </button>}
    </details>
    {notice && <p className="diagnostics-findings__notice" role="status" aria-live="polite">{notice}</p>}
  </section>;
}
