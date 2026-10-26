import { useEffect, useState, type ReactElement } from "react";
import type { BrowserLocalGit } from "../git/index.js";
import type { DiffChange } from "../git/protocol.js";
import { TextDiff } from "./TextDiff.js";
import { allChangedPathsReviewed, decodeGitText } from "./git-review-content.js";
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
  if (change.kind === "added") return "New file";
  if (change.kind === "deleted") return "Deleted";
  if (change.kind === "staged") return "Staged";
  return "Modified";
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
      if (active) setError(cause instanceof Error ? cause.message : "Could not load the local diff.");
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
    <div className="git-review-heading"><div><p className="eyebrow">LOCAL GIT</p><h3 id="changed-files-heading">Changed files</h3></div><span role="status">Loading diff…</span></div>
  </section>;

  if (error) return <section className="git-review" aria-labelledby="changed-files-heading">
    <div className="git-review-heading"><div><p className="eyebrow">LOCAL GIT</p><h3 id="changed-files-heading">Changed files</h3></div></div>
    <p className="git-review-error" role="alert">Could not load the changed-file review: {error}</p>
  </section>;

  if (!changes?.length) return <section className="git-review" aria-labelledby="changed-files-heading">
    <div className="git-review-heading"><div><p className="eyebrow">LOCAL GIT</p><h3 id="changed-files-heading">Changed files</h3></div></div>
    <p className="git-review-empty">There are no worktree changes to review.</p>
  </section>;

  const beforeBytes = selected?.headFile?.data ?? new Uint8Array();
  const afterBytes = selected?.worktreeFile?.data ?? new Uint8Array();
  const before = decodeGitText(beforeBytes);
  const after = decodeGitText(afterBytes);
  const isBinary = before === null || after === null;

  return <section className="git-review" aria-labelledby="changed-files-heading">
    <div className="git-review-heading">
      <div><p className="eyebrow">LOCAL GIT · BEFORE COMMIT</p><h3 id="changed-files-heading">Review changed files</h3></div>
      <div className="git-review-heading-actions"><span className="git-review-count">{reviewed.size}/{changes.length} reviewed</span><button type="button" disabled={busy || loading} onClick={() => setManualRefresh((value) => value + 1)}>Refresh diff</button></div>
    </div>
    <p className="git-review-base">Compared with local commit <code>{head?.slice(0, 10) ?? "uncommitted workspace"}</code>. Every changed path must be reviewed before the existing local commit action is enabled.</p>
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
          <span>{reviewed.has(selected.path) ? "Reviewed" : "Not reviewed"}</span>
        </header>
        {isBinary
          ? <p className="git-review-binary" role="status">Binary content · {beforeBytes.byteLength} bytes before, {afterBytes.byteLength} bytes after. Text decoding is unavailable, so the original bytes are shown as binary and are not converted.</p>
          : <TextDiff before={before!} after={after!} beforeLabel="Local commit" afterLabel="Worktree" />}
        <button type="button" className="git-review-mark" disabled={busy} onClick={() => markReviewed(selected.path)}>
          {reviewed.has(selected.path) ? "Reviewed" : "Mark this file reviewed"}
        </button>
      </article>}
    </div>
    {!ready && <p className="git-review-gate" role="status">Review each changed file to enable local commit.</p>}
    {ready && !canCommit && <p className="git-review-gate" role="status">All file diffs are reviewed. Save the current editor text and wait for other workspace activity to finish before committing.</p>}
  </section>;
}
