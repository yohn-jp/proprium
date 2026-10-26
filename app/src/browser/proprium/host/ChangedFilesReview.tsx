import { useEffect, useState, type ReactElement } from "react";
import type { BrowserLocalGit } from "../git/index.js";
import type { DiffChange } from "../git/protocol.js";
import { TextDiff } from "./TextDiff.js";
import { allChangedPathsReviewed, decodeGitText, localizeGitReviewError } from "./git-review-content.js";
import "./git-review.css";

export interface ChangedFilesReviewProps {
  git: Pick<BrowserLocalGit, "diff">;
  head: string | null;
  /** Change whenever a worktree write or refresh may have changed the diff. */
  refreshKey: string | number;
  busy: boolean;
  canCommit: boolean;
  /** The parent uses this to keep its existing commit action disabled until all paths are reviewed. */
  onReviewReady(ready: boolean): void;
}

function changeKind(change: DiffChange): string {
  if (change.kind === "added") return "新規";
  if (change.kind === "deleted") return "削除";
  if (change.kind === "staged") return "ステージ済み";
  return "変更";
}

export function ChangedFilesReview({ git, head, refreshKey, busy, canCommit, onReviewReady }: ChangedFilesReviewProps): ReactElement {
  const [changes, setChanges] = useState<DiffChange[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualRefresh, setManualRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setChanges(null);
    setReviewed(new Set());
    setError(null);
    void git.diff().then((next) => {
      if (!active) return;
      setChanges(next);
      setSelectedPath((current) => next.some((change) => change.path === current) ? current : next[0]?.path ?? null);
    }).catch((cause: unknown) => {
      if (active) setError(localizeGitReviewError(cause, "ローカルの差分を読み込めませんでした。"));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [git, head, refreshKey, manualRefresh]);

  const selected = changes?.find((change) => change.path === selectedPath) ?? changes?.[0] ?? null;
  const ready = allChangedPathsReviewed(changes?.map((change) => change.path) ?? [], reviewed);
  useEffect(() => { onReviewReady(ready); }, [onReviewReady, ready]);

  function markReviewed(path: string): void {
    setReviewed((current) => new Set(current).add(path));
  }

  if (loading) return <section className="git-review" aria-labelledby="changed-files-heading" aria-busy="true">
    <div className="git-review-heading"><div><p className="eyebrow">ローカルGit</p><h3 id="changed-files-heading">変更ファイル</h3></div><span role="status">差分を読み込み中…</span></div>
  </section>;

  if (error) return <section className="git-review" aria-labelledby="changed-files-heading">
    <div className="git-review-heading"><div><p className="eyebrow">ローカルGit</p><h3 id="changed-files-heading">変更ファイル</h3></div><button type="button" disabled={busy} onClick={() => setManualRefresh((value) => value + 1)}>差分を更新</button></div>
    <p className="git-review-error" role="alert">変更ファイルの差分を読み込めませんでした。{error}</p>
  </section>;

  if (!changes?.length) return <section className="git-review" aria-labelledby="changed-files-heading">
    <div className="git-review-heading"><div><p className="eyebrow">ローカルGit</p><h3 id="changed-files-heading">変更ファイル</h3></div><button type="button" disabled={busy} onClick={() => setManualRefresh((value) => value + 1)}>差分を更新</button></div>
    <p className="git-review-empty">確認する変更はありません。</p>
  </section>;

  const beforeBytes = selected?.headFile?.data ?? new Uint8Array();
  const afterBytes = selected?.worktreeFile?.data ?? new Uint8Array();
  const before = decodeGitText(beforeBytes);
  const after = decodeGitText(afterBytes);
  const isBinary = before === null || after === null;

  return <section className="git-review" aria-labelledby="changed-files-heading">
    <div className="git-review-heading">
      <div><p className="eyebrow">ローカルGit · コミット前</p><h3 id="changed-files-heading">変更を確認</h3></div>
      <div className="git-review-heading-actions"><span className="git-review-count">{reviewed.size}/{changes.length}件確認済み</span><button type="button" disabled={busy || loading} onClick={() => setManualRefresh((value) => value + 1)}>差分を更新</button></div>
    </div>
    <p className="git-review-base">ローカルコミット <code>{head?.slice(0, 10) ?? "未コミット"}</code> との差分です。すべてのファイルの変更を確認すると、コミット操作が有効になります。</p>
    <div className="git-review-layout">
      <nav className="git-review-files" aria-label="Changed files">
        <ul>
          {changes.map((change) => <li key={change.path}>
            <button type="button" className={`git-review-file ${selected?.path === change.path ? "is-selected" : ""}`} aria-current={selected?.path === change.path ? "true" : undefined} onClick={() => setSelectedPath(change.path)}>
              <span className="git-review-file-label">{changeKind(change)}</span><code>{change.path}</code>
              {reviewed.has(change.path) && <span className="git-review-checked" aria-label="Reviewed">✓</span>}
            </button>
          </li>)}
        </ul>
      </nav>
      {selected && <article className="git-review-detail" aria-label={`Diff for ${selected.path}`}>
        <header className="git-review-file-heading"><div><span className="git-review-file-label">{changeKind(selected)}</span><h4>{selected.path}</h4></div>
          <span>{reviewed.has(selected.path) ? "確認済み" : "未確認"}</span>
        </header>
        {isBinary
          ? <p className="git-review-binary" role="status">バイナリファイル · 変更前 {beforeBytes.byteLength.toLocaleString("ja-JP")} バイト、変更後 {afterBytes.byteLength.toLocaleString("ja-JP")} バイト。テキストとしては表示せず、デコードや変換もしていません。</p>
          : <TextDiff before={before!} after={after!} beforeLabel="コミット時" afterLabel="作業ツリー" />}
        <button type="button" className="git-review-mark" disabled={busy} onClick={() => markReviewed(selected.path)}>
          {reviewed.has(selected.path) ? "確認済み" : "このファイルの変更を確認した"}
        </button>
      </article>}
    </div>
    {!ready && <p className="git-review-gate" role="status">各ファイルの変更を確認すると、ローカルコミットできます。</p>}
    {ready && !canCommit && <p className="git-review-gate" role="status">すべての変更を確認しました。コミットする前に編集中の文章を保存し、他の処理が終わるまでお待ちください。</p>}
  </section>;
}
