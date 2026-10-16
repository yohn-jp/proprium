import { useState } from "react";
import type { ChangeOperation, ProposalStatus, RepositoryIdentity } from "@scriptorium/contracts";
import { api } from "../api";
import { BrowserJournal, proposalOperationEntry, type JournalEntry, type JournalProposal } from "../storage/journal";

function operationKey(operation: ChangeOperation): string {
  return operation.id + "\u0000" + operation.generation;
}

function checkpointFor(status: ProposalStatus | undefined, operation: ChangeOperation) {
  return status?.checkpoints.find((receipt) => receipt.operationId === operation.id && receipt.generation === operation.generation);
}

export function ProposalReview({
  projectId,
  repository,
  authorScope,
  journal,
  proposals,
  onChange,
  onStatus,
}: {
  projectId: string;
  repository: RepositoryIdentity;
  authorScope: string;
  journal: BrowserJournal;
  proposals: JournalProposal[];
  onChange: () => void;
  onStatus: (message: string, kind?: "normal" | "error" | "success") => void;
}) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  async function approve(record: JournalProposal): Promise<void> {
    if (busyId || record.authorScope !== authorScope) return;
    setBusyId(record.proposal.id);
    setError("");
    try {
      const pending = await journal.getRepository(repository, authorScope);
      const status = record.status;
      const published = new Set(status?.publishedOperationIds ?? []);
      const alreadyApproved = new Set(status?.approvedOperationIds ?? []);
      const entries: JournalEntry[] = [];
      const needsApproval: string[] = [];
      for (const operation of record.proposal.operations) {
        if (published.has(operation.id) || checkpointFor(status, operation)) continue;
        const current = pending.find((entry) => entry.operation.id === operation.id && entry.operation.generation === operation.generation);
        const entry = current ?? proposalOperationEntry(repository, authorScope, record.proposal, operation);
        // Persist the exact operation and author scope before either approval or checkpointing.
        await journal.put(entry);
        const authorized = await journal.updateState({
          ...entry,
          proposalId: record.proposal.id,
          authorizedAt: entry.authorizedAt ?? Date.now(),
        }, "checkpointing");
        entries.push(authorized);
        if (!alreadyApproved.has(operation.id)) needsApproval.push(operation.id);
      }
      if (entries.length === 0) {
        onStatus("この提案の操作はすでに Checkpoint 済みです。GitHub への公開待ちです。", "normal");
        onChange();
        return;
      }
      if (needsApproval.length > 0) {
        await api.approve(projectId, {
          proposalId: record.proposal.id,
          operationIds: needsApproval,
          authorScope,
        });
      }
      for (const entry of entries) {
        const receipt = await api.checkpoint(projectId, entry.operation);
        await journal.updateState(entry, "checkpointed", receipt);
      }
      onStatus("確認した操作をローカル Checkpoint に保存しました。GitHub への公開まで回復記録を保持します。", "success");
      onChange();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "提案を処理できませんでした。";
      setError(message);
      onStatus("提案はブラウザー回復記録に保持されています。" + message, "error");
      onChange();
    } finally {
      setBusyId("");
    }
  }

  async function dismiss(record: JournalProposal): Promise<void> {
    if (busyId || record.authorScope !== authorScope || !window.confirm("この未承認提案をブラウザーの一覧から隠しますか？サーバー上の提案は削除されません。")) return;
    setBusyId(record.proposal.id);
    setError("");
    try {
      const status = record.status;
      if ((status?.approvedOperationIds.length ?? 0) > 0 || (status?.checkpoints.length ?? 0) > 0) {
        throw new Error("承認済みまたは Checkpoint 済みの提案は一覧から隠せません。");
      }
      const pending = await journal.getRepository(repository, authorScope);
      const authorized = record.proposal.operations.some((operation) => pending.some((entry) =>
        entry.operation.id === operation.id && entry.operation.generation === operation.generation && entry.state !== "draft",
      ));
      if (authorized) throw new Error("承認処理が始まった提案は一覧から隠せません。");
      await journal.dismissProposal(repository, authorScope, record.proposal.id);
      onStatus("提案をこのブラウザーの一覧から隠しました。Core 上の提案記録は保持しています。", "success");
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提案を隠せませんでした。");
    } finally {
      setBusyId("");
    }
  }

  if (proposals.length === 0) return null;
  return (
    <section className="proposal-review" aria-labelledby="proposal-review-title">
      <h2 id="proposal-review-title">確認待ちの提案</h2>
      <p>外部ツールやモジュールの操作内容と根拠を確認し、明示的に承認した操作だけ Checkpoint に保存できます。</p>
      {error && <p className="status" data-kind="error" role="alert">{error}</p>}
      <ul className="proposal-list">
        {proposals.map((record) => {
          const status = record.status;
          const published = new Set(status?.publishedOperationIds ?? []);
          const pendingOperations = record.proposal.operations.filter((operation) =>
            !published.has(operation.id) && !checkpointFor(status, operation),
          );
          const needsApproval = pendingOperations.some((operation) => !status?.approvedOperationIds.includes(operation.id));
          const completed = pendingOperations.length === 0;
          return (
            <li key={record.proposal.id}>
              <article className="proposal-card">
                <header>
                  <strong>{record.proposal.source === "author" ? "作者の提案" : record.proposal.source + " 提案"}</strong>
                  <span>{new Date(record.createdAt).toLocaleString("ja-JP")}</span>
                </header>
                <p>提案 ID: <code>{record.proposal.id}</code> · 作者スコープ: <code>{record.authorScope ?? "未割り当て"}</code></p>
                {status?.stale && <p className="status" data-kind="error" role="status">提案の基準リモートが現在の HEAD より古くなっています。Checkpoint 時に Core が競合を確認します。</p>}
                {record.proposal.operations.map((operation) => {
                  const isPublished = published.has(operation.id);
                  const receipt = checkpointFor(status, operation);
                  const isApproved = status?.approvedOperationIds.includes(operation.id) ?? false;
                  return (
                    <div className="proposal-operation" key={operationKey(operation)}>
                      <h3>{operation.message}</h3>
                      <p>{operation.effect} · operation <code>{operation.id}</code> · generation {operation.generation} · {operation.writes.length} 件のファイル変更</p>
                      {isPublished ? <p>GitHub 保存済み</p> : receipt ? <p>ローカル Checkpoint 済み · {receipt.localCommit.slice(0, 12)}</p> : isApproved ? <p>作者承認済み · Checkpoint 待ち</p> : <p>承認待ち</p>}
                      <ul>
                        {operation.writes.map((write) => (
                          <li key={write.path}>
                            <details>
                              <summary>{write.content === null ? "削除" : "更新"}: <code>{write.path}</code></summary>
                              <pre>{write.content === null ? "ファイルを削除" : write.encoding === "base64" ? "バイナリ内容を含む変更" : write.content}</pre>
                            </details>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                {record.proposal.evidence?.length ? (
                  <details>
                    <summary>根拠を確認</summary>
                    <pre>{JSON.stringify(record.proposal.evidence, null, 2)}</pre>
                  </details>
                ) : null}
                <div className="proposal-actions">
                  <button type="button" onClick={() => void approve(record)} disabled={Boolean(busyId) || completed}>
                    {busyId === record.proposal.id ? "承認内容を保存中…" : completed ? "Checkpoint 完了" : needsApproval ? "承認して Checkpoint" : "承認済みを Checkpoint"}
                  </button>
                  <button type="button" className="quiet-button" onClick={() => void dismiss(record)} disabled={Boolean(busyId) || (status?.approvedOperationIds.length ?? 0) > 0 || (status?.checkpoints.length ?? 0) > 0}>
                    この提案を隠す
                  </button>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
