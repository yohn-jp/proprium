import { useEffect, useState, type ReactElement } from "react";
import type { BrowserLocalGit } from "../git/index.js";
import type { CommitSummary, CommitDiff, CommitFileChange } from "../git/protocol.js";
import { TextDiff } from "./TextDiff.js";
import { decodeGitText, localizeGitReviewError } from "./git-review-content.js";
import "./git-review.css";

export interface GitHistoryPanelProps {
  git: Pick<BrowserLocalGit, "commitDiff" | "read" | "applyChanges">;
  history: CommitSummary[];
  busy: boolean;
  /** False while the editor has unsaved text or the Host cannot safely refresh its file state. */
  canRestore: boolean;
  onRefresh(): void;
  onRestored(): void | Promise<void>;
  onRestoreBusyChange?(busy: boolean): void;
  beforeRestore?(): Promise<boolean>;
}

function changeKind(change: CommitFileChange): string {
  if (change.kind === "added") return "追加";
  if (change.kind === "deleted") return "削除";
  return "変更";
}

function describeCommit(commit: CommitSummary): string {
  return commit.message.split("\n")[0]?.trim() || "（コミットメッセージなし）";
}

export function GitHistoryPanel({ git, history, busy, canRestore, onRefresh, onRestored, onRestoreBusyChange, beforeRestore }: GitHistoryPanelProps): ReactElement {
  const [selectedOid, setSelectedOid] = useState<string | null>(history[0]?.oid ?? null);
  const [details, setDetails] = useState<CommitDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!history.some((commit) => commit.oid === selectedOid)) setSelectedOid(history[0]?.oid ?? null);
  }, [history, selectedOid]);

  useEffect(() => {
    if (!selectedOid) { setDetails(null); setError(null); return; }
    let active = true;
    setLoading(true);
    setDetails(null);
    setError(null);
    setNotice(null);
    void git.commitDiff(selectedOid).then((next) => {
      if (active) setDetails(next);
    }).catch((cause: unknown) => {
      if (active) setError(localizeGitReviewError(cause, "このコミットの変更ファイルを読み込めませんでした。"));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [git, selectedOid]);

  const selectedCommit = history.find((commit) => commit.oid === selectedOid) ?? null;
  const historyPaths = (details?.changes.map((change) => change.path) ?? []).sort();
  const pathCollision = historyPaths.some((path, index) => historyPaths[index + 1]?.startsWith(`${path}/`));
  const unsupportedMode = Boolean(details?.changes.some((change) =>
    change.parentMode === "120000" || change.commitMode === "120000" ||
    change.parentMode !== null && change.commitMode !== null && change.parentMode !== change.commitMode));
  const restoreUnsupported = pathCollision || unsupportedMode;

  async function restoreCommitFiles(): Promise<void> {
    if (!selectedCommit || !details || !canRestore || busy || restoring || !details.changes.length) return;
    const count = details.changes.length;
    const target = `コミット ${selectedCommit.oid.slice(0, 10)}`;
    if (!window.confirm(`「${describeCommit(selectedCommit)}」で変更された${count}件のファイルを、ローカル作業ツリーで${target}の内容に戻しますか？対象ファイルの現在の内容は置き換えるか削除します。他のファイルは変更しません。コミットやGitHubへの公開は行いません。`)) return;

    setRestoring(true); onRestoreBusyChange?.(true);
    setError(null);
    setNotice(null);
    try {
      if (beforeRestore && !(await beforeRestore())) throw new Error("編集中の本文または作品が変わりました。端末に保存してから復元してください。");
      const changes = await Promise.all(details.changes.map(async (change) => {
        const current = await git.read(change.path);
        return {
          path: change.path,
          content: change.commitFile?.data ?? null,
          expectedRevision: current.revision,
        };
      }));
      // applyChanges rechecks every file revision under the Browser Git workspace lock.
      await git.applyChanges(changes);
      setNotice(`${count}件のファイルを、このコミットの内容にローカル作業ツリーで戻しました。コミットや公開は行っていません。`);
      try { await onRestored(); }
      catch { setError("ファイルは復元されましたが、開いているワークスペースを更新できませんでした。対象ファイルを編集する前に、ワークスペースを再読み込みしてください。"); }
    } catch (cause) {
      setError(localizeGitReviewError(cause, "履歴のファイルを復元できませんでした。現在の状態を確認してから、もう一度お試しください。"));
    } finally {
      setRestoring(false); onRestoreBusyChange?.(false);
    }
  }

  const parentLabel = details?.parentOid ? details.parentOid.slice(0, 10) : "空のツリー";

  return <section className="git-history-review" aria-labelledby="git-history-heading">
    <header className="git-history-heading">
      <div><p className="eyebrow">ローカルGit</p><h2 id="git-history-heading">履歴</h2><p>この端末にあるコミットの履歴です。GitHubに公開されていない場合があります。</p></div>
      <button type="button" className="text-button" disabled={busy || loading || restoring} onClick={onRefresh}>履歴を更新</button>
    </header>
    <div className="git-history-layout">
      <nav className="git-history-list" aria-label="Local commits">
        {history.length ? <ol>{history.map((commit) => <li key={commit.oid}>
          <button type="button" className={`git-history-commit ${selectedOid === commit.oid ? "is-selected" : ""}`} aria-current={selectedOid === commit.oid ? "true" : undefined} disabled={busy || restoring} onClick={() => setSelectedOid(commit.oid)}>
            <strong>{describeCommit(commit)}</strong><code>{commit.oid.slice(0, 10)}</code><small>{commit.author.name} · {new Date(commit.timestamp * 1000).toLocaleString("ja-JP")}</small>
          </button>
        </li>)}</ol> : <p className="git-review-empty">このワークスペースにローカルコミットはありません。</p>}
      </nav>
      <div className="git-history-detail" aria-live="polite">
        {!selectedCommit && <p>コミットを選択すると、変更されたファイルを確認できます。</p>}
        {selectedCommit && loading && <p role="status">コミットのファイルを読み込み中…</p>}
        {selectedCommit && error && <p className="git-review-error" role="alert">このコミットを確認できませんでした。{error}</p>}
        {selectedCommit && details && <>
          <header className="git-history-commit-heading"><div><span className="git-review-file-label">{details.parentOid ? "最初の親コミットとの差分" : "最初のコミット · 空のツリーとの差分"}</span><h3>{describeCommit(selectedCommit)}</h3><code>{selectedCommit.oid}</code>
            {selectedCommit.parent.length > 1 && <small>マージコミットは最初の親コミット（{parentLabel}）との差分を表示しています。他の親コミットの差分は含みません。</small>}
          </div>
          <button type="button" className="git-history-restore" disabled={!canRestore || busy || restoring || restoreUnsupported || !details.changes.length} onClick={() => void restoreCommitFiles()}>
            {restoring ? "復元中…" : `このコミットで変更された${details.changes.length}件を作業ツリーに復元`}
          </button></header>
          <p className="git-history-restore-note">対象ファイルの現在のリビジョンを確認してから復元します。ローカル作業ツリーだけを更新し、他のファイルはそのまま残します。</p>
          {!canRestore && <p className="git-review-gate" role="status">履歴を復元する前に、編集中の文章を保存してください。</p>}
          {pathCollision && <p className="git-review-gate" role="status">このコミットではファイルとディレクトリの構成が変わっています。ブラウザー内のGitではこの変更をまとめて適用できないため、確認のみ可能です。</p>}
          {unsupportedMode && <p className="git-review-gate" role="status">このコミットには、現在のブラウザー内のGitで復元できないシンボリックリンクまたは実行権限の変更があります。ファイル内容の確認はできます。</p>}
          {notice && <p className="git-history-notice" role="status">{notice}</p>}
          {!details.changes.length && <p>最初の親コミットから変更されたファイルはありません。</p>}
          <div className="git-history-files">
            {details.changes.map((change) => <HistoryFile key={change.path} change={change} parentLabel={parentLabel} />)}
          </div>
        </>}
      </div>
    </div>
  </section>;
}

function HistoryFile({ change, parentLabel }: { change: CommitFileChange; parentLabel: string }): ReactElement {
  const beforeBytes = change.parentFile?.data ?? new Uint8Array();
  const afterBytes = change.commitFile?.data ?? new Uint8Array();
  const before = decodeGitText(beforeBytes);
  const after = decodeGitText(afterBytes);
  const isBinary = before === null || after === null;
  return <article className="git-history-file" aria-label={`${change.path} ${changeKind(change)}`}>
    <header><span className="git-review-file-label">{changeKind(change)}</span><h4>{change.path}</h4></header>
    {isBinary
      ? <p className="git-review-binary" role="status">バイナリファイル · {parentLabel}では{beforeBytes.byteLength.toLocaleString("ja-JP")}バイト、コミット時は{afterBytes.byteLength.toLocaleString("ja-JP")}バイト。テキストとしては表示せず、デコードや変換もしていません。</p>
      : <TextDiff before={before!} after={after!} beforeLabel={parentLabel} afterLabel="選択中のコミット" />}
  </article>;
}
