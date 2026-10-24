import type { RemoteObservation } from "@scriptorium/contracts";

export interface ApplicationStatusProps {
  status: { message: string; kind: "normal" | "error" | "success" };
  globalError: string;
  journalOpenError: string;
  isolatedRecoveryCount: number;
  remoteState: RemoteObservation["state"] | null;
}

export function hasApplicationStatus({ status, globalError, journalOpenError, isolatedRecoveryCount, remoteState }: ApplicationStatusProps): boolean {
  return Boolean(status.message || globalError || journalOpenError || isolatedRecoveryCount > 0 || (remoteState && remoteState !== "fresh"));
}

export function ApplicationStatus({
  status,
  globalError,
  journalOpenError,
  isolatedRecoveryCount,
  remoteState,
}: ApplicationStatusProps) {
  const needsAttention = Boolean(status.kind === "error" && status.message || globalError || journalOpenError || isolatedRecoveryCount > 0 || remoteState && remoteState !== "fresh");

  return (
    <details className="application-status" open={needsAttention || undefined} data-attention={needsAttention || undefined}>
      <summary>保存と接続 <span>{needsAttention ? "要確認" : status.message ? "更新あり" : "詳細"}</span></summary>
      <div className="application-status-content">
        {!hasApplicationStatus({ status, globalError, journalOpenError, isolatedRecoveryCount, remoteState }) && <p>新しい通知はありません。原稿の保護範囲は保存状態から確認できます。</p>}
        {status.message && <div className="topbar-status" role={status.kind === "error" ? "alert" : "status"}
          aria-live={status.kind === "error" ? "assertive" : "polite"} data-kind={status.kind}>{status.message}</div>}
        {globalError && <p className="status" data-kind="error" role="alert">{globalError}</p>}
        {journalOpenError && <p className="status" data-kind="error" role="alert">{journalOpenError}</p>}
        {isolatedRecoveryCount > 0 && <p className="status" role="status">別の作者スコープまたは未割り当ての回復記録 {isolatedRecoveryCount} 件を保持しています。現在のセッションには復元しません。</p>}
        {remoteState && remoteState !== "fresh" && <p className="status" data-kind="error" role="alert">リモート確認状態: {remoteState}。最後に確認できた原稿を表示しています。</p>}
      </div>
    </details>
  );
}
