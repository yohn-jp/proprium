import { useEffect, useState, type ReactElement } from "react";
import type { BrowserLocalGit } from "../git/index.js";
import type { CommitSummary, CommitDiff, CommitFileChange } from "../git/protocol.js";
import { TextDiff } from "./TextDiff.js";
import { decodeGitText } from "./git-review-content.js";
import "./git-review.css";

export interface GitHistoryPanelProps {
  git: Pick<BrowserLocalGit, "commitDiff" | "read" | "applyChanges">;
  history: CommitSummary[];
  busy: boolean;
  /** False while the editor has unsaved text or the Host cannot safely refresh its file state. */
  canRestore: boolean;
  onRefresh(): void;
  onRestored(): void | Promise<void>;
}

function changeKind(change: CommitFileChange): string {
  if (change.kind === "added") return "Added";
  if (change.kind === "deleted") return "Deleted";
  return "Modified";
}

function describeCommit(commit: CommitSummary): string {
  return commit.message.split("\n")[0]?.trim() || "(no commit message)";
}

export function GitHistoryPanel({ git, history, busy, canRestore, onRefresh, onRestored }: GitHistoryPanelProps): ReactElement {
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
      if (active) setError(cause instanceof Error ? cause.message : "Could not load this commit's file history.");
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
    const target = `commit ${selectedCommit.oid.slice(0, 10)}`;
    if (!window.confirm(`Restore the ${count} file${count === 1 ? "" : "s"} changed by “${describeCommit(selectedCommit)}” to ${target} in the local worktree? Current contents of those paths will be replaced or removed. Other files are left untouched. This does not create a commit or publish anything.`)) return;

    setRestoring(true);
    setError(null);
    setNotice(null);
    try {
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
      setNotice(`Restored ${count} file${count === 1 ? "" : "s"} to this commit in the local worktree. No commit or publish was created.`);
      try { await onRestored(); }
      catch { setError("The files were restored, but the Host could not refresh the open workspace view. Reload the workspace view before editing these paths."); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The historical files could not be restored.");
    } finally {
      setRestoring(false);
    }
  }

  const parentLabel = details?.parentOid ? details.parentOid.slice(0, 10) : "empty tree";

  return <section className="git-history-review" aria-labelledby="git-history-heading">
    <header className="git-history-heading">
      <div><p className="eyebrow">LOCAL GIT</p><h2 id="git-history-heading">History</h2><p>Local commits on this device. They are not necessarily published to GitHub.</p></div>
      <button type="button" className="text-button" disabled={busy || loading} onClick={onRefresh}>Refresh</button>
    </header>
    <div className="git-history-layout">
      <nav className="git-history-list" aria-label="Local commits">
        {history.length ? <ol>{history.map((commit) => <li key={commit.oid}>
          <button type="button" className={`git-history-commit ${selectedOid === commit.oid ? "is-selected" : ""}`} aria-current={selectedOid === commit.oid ? "true" : undefined} onClick={() => setSelectedOid(commit.oid)}>
            <strong>{describeCommit(commit)}</strong><code>{commit.oid.slice(0, 10)}</code><small>{commit.author.name} · {new Date(commit.timestamp * 1000).toLocaleString()}</small>
          </button>
        </li>)}</ol> : <p className="git-review-empty">No commits in this local workspace.</p>}
      </nav>
      <div className="git-history-detail" aria-live="polite">
        {!selectedCommit && <p>Select a local commit to inspect its files.</p>}
        {selectedCommit && loading && <p role="status">Loading files for this commit…</p>}
        {selectedCommit && error && <p className="git-review-error" role="alert">Could not inspect this commit: {error}</p>}
        {selectedCommit && details && <>
          <header className="git-history-commit-heading"><div><span className="git-review-file-label">{details.parentOid ? "Compared with first parent" : "Root commit · compared with empty tree"}</span><h3>{describeCommit(selectedCommit)}</h3><code>{selectedCommit.oid}</code>
            {selectedCommit.parent.length > 1 && <small>This merge commit is compared with its first parent ({parentLabel}); other parents are not included in this diff.</small>}
          </div>
          <button type="button" className="git-history-restore" disabled={!canRestore || busy || restoring || restoreUnsupported || !details.changes.length} onClick={() => void restoreCommitFiles()}>
            {restoring ? "Restoring…" : `Restore ${details.changes.length} changed file${details.changes.length === 1 ? "" : "s"} to worktree`}
          </button></header>
          <p className="git-history-restore-note">Restore checks the current revision of every affected path. It updates only the local worktree; your existing work on other paths stays in place.</p>
          {!canRestore && <p className="git-review-gate" role="status">Save current editor text before restoring history.</p>}
          {pathCollision && <p className="git-review-gate" role="status">This commit turns a file into a directory or a directory into a file. Browser Git cannot apply those path changes atomically, so review is available but restore is disabled.</p>}
          {unsupportedMode && <p className="git-review-gate" role="status">This commit changes symlink or executable mode metadata that the Browser Git file editor cannot restore. File contents remain available for review.</p>}
          {notice && <p className="git-history-notice" role="status">{notice}</p>}
          {!details.changes.length && <p>This commit has no file changes compared with its first parent.</p>}
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
      ? <p className="git-review-binary" role="status">Binary content · {beforeBytes.byteLength} bytes in {parentLabel}, {afterBytes.byteLength} bytes in commit. This file is not rendered as text; no decoding or conversion was applied.</p>
      : <TextDiff before={before!} after={after!} beforeLabel={parentLabel} afterLabel="Selected commit" />}
  </article>;
}
