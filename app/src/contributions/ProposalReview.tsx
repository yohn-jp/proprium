import { useState } from "react";
import type { ChangeOperation, RepositoryIdentity } from "@scriptorium/contracts";
import { api } from "../api";
import { BrowserJournal, documentKey, journalEntryKey, repositoryKey, type JournalEntry, type JournalProposal } from "../storage/journal";

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
    if (busyId) return;
    setBusyId(record.proposal.id);
    setError("");
    try {
      const pending = await journal.getRepository(repository, authorScope);
      const records: JournalEntry[] = [];
      for (const operation of record.proposal.operations) {
        const current = pending.find((entry) => entry.operation.id === operation.id && entry.operation.generation === operation.generation);
        const entry = current ?? proposalOperationEntry(record, operation);
        if (!current) await journal.put(entry);
        const authorized = await journal.updateState({ ...entry, authorizedAt: Date.now() }, "checkpointing");
        records.push(authorized);
      }
      await api.approve(projectId, {
        proposalId: record.proposal.id,
        operationIds: record.proposal.operations.map((operation) => operation.id),
        authorScope,
      });
      for (const entry of records) {
        const receipt = await api.checkpoint(projectId, entry.operation);
        await journal.updateState(entry, "checkpointed", receipt);
      }
      await journal.removeProposal(repository, authorScope, record.proposal.id);
      onStatus("承認した提案をローカルチェックポイントに保存しました。GitHub へ保存するまで記録を保持します。", "success");
      onChange();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "提案を処理できませんでした。";
      setError(message);
      onStatus(`提案は保持されています。${message}`, "error");
      onChange();
    } finally {
      setBusyId("");
    }
  }

  async function discard(record: JournalProposal): Promise<void> {
    if (busyId || !window.confirm("この未承認の提案をブラウザーの回復記録から削除しますか？")) return;
    setBusyId(record.proposal.id);
    setError("");
    try {
      const pending = await journal.getRepository(repository, authorScope);
      const checkpointed = record.proposal.operations.some((operation) =>
        pending.some((entry) => entry.operation.id === operation.id && entry.operation.generation === operation.generation && entry.state !== "draft"),
      );
      if (checkpointed) throw new Error("チェックポイント済みの操作は提案一覧から削除できません。");
      await journal.removeProposal(repository, authorScope, record.proposal.id);
      onStatus("提案をブラウザーから削除しました。", "success");
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提案を削除できませんでした。");
    } finally {
      setBusyId("");
    }
  }

  if (proposals.length === 0) return null;
  return (
    <section className="proposal-review" aria-labelledby="proposal-review-title">
      <h2 id="proposal-review-title">確認待ちの提案</h2>
      <p>提案の内容を確認し、承認した操作だけローカルチェックポイントに保存できます。</p>
      {error && <p className="status" data-kind="error" role="alert">{error}</p>}
      <ul className="proposal-list">
        {proposals.map((record) => (
          <li key={record.proposal.id}>
            <article className="proposal-card">
              <header>
                <strong>{record.proposal.source === "author" ? "作者の提案" : `${record.proposal.source} 提案`}</strong>
                <span>{new Date(record.createdAt).toLocaleString("ja-JP")}</span>
              </header>
              {record.proposal.operations.map((operation) => (
                <div className="proposal-operation" key={`${operation.id}-${operation.generation}`}>
                  <h3>{operation.message}</h3>
                  <p>{operation.effect} · {operation.writes.length} 件のファイル変更</p>
                  <ul>
                    {operation.writes.map((write) => <li key={write.path}>{write.content === null ? "削除" : "更新"}: <code>{write.path}</code></li>)}
                  </ul>
                </div>
              ))}
              {record.proposal.evidence?.length ? (
                <details>
                  <summary>根拠を確認</summary>
                  <pre>{JSON.stringify(record.proposal.evidence, null, 2)}</pre>
                </details>
              ) : null}
              <div className="proposal-actions">
                <button type="button" onClick={() => void approve(record)} disabled={Boolean(busyId)}>
                  {busyId === record.proposal.id ? "承認内容を保存中…" : "承認して Checkpoint"}
                </button>
                <button type="button" className="quiet-button" onClick={() => void discard(record)} disabled={Boolean(busyId)}>提案を削除</button>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

function proposalOperationEntry(record: JournalProposal, operation: ChangeOperation): JournalEntry {
  if (!record.authorScope) throw new Error("This proposal has no author identity scope and cannot be approved.");
  const path = operation.writes[0]?.path ?? "proposal";
  const key = documentKey(record.repository, path);
  const entry: JournalEntry = {
    version: 1,
    key: "",
    repositoryKey: repositoryKey(record.repository),
    documentKey: key,
    authorScope: record.authorScope,
    repository: record.repository,
    documentPath: path,
    sceneId: record.proposal.id,
    snapshot: record.proposal.snapshot,
    text: "",
    baseText: "",
    operation,
    state: "checkpointing",
    authorizedAt: Date.now(),
    updatedAt: Date.now(),
  };
  entry.key = journalEntryKey(entry);
  return entry;
}
