import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { BrowserJournal, repositoryKey, type JournalEntry } from "../../../storage/journal.js";
import type { WorkspaceIdentity } from "../git/protocol.js";
import {
  discoverWorkspaceDrafts,
  journalRepositoryForWorkspace,
  WORKSPACE_DRAFTS_CHANGED_EVENT,
} from "./workspace-drafts.js";

interface Props {
  workspace: WorkspaceIdentity;
  authorScope: string;
  worktreePaths?: readonly string[];
  onOpenDraft(entry: JournalEntry): void | Promise<void>;
}

interface DraftChangeEvent extends CustomEvent<{ repositoryKey: string; authorScope: string }> {}

/** A workspace-level recovery list that also finds journaled files absent from Git. */
export function WorkspaceDraftRecovery({ workspace, authorScope, worktreePaths, onOpenDraft }: Props): ReactElement {
  const repo = useMemo(() => journalRepositoryForWorkspace(workspace), [workspace]);
  const expectedRepositoryKey = useMemo(() => repositoryKey(repo), [repo]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openingKey, setOpeningKey] = useState("");
  const reloadGeneration = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const generation = ++reloadGeneration.current;
    setLoading(true);
    setError("");
    let journal: BrowserJournal | null = null;
    try {
      journal = await BrowserJournal.open();
      const recovered = await journal.getRepository(repo, authorScope);
      if (generation === reloadGeneration.current) setEntries(discoverWorkspaceDrafts(recovered, workspace, authorScope));
    } catch (reason) {
      if (generation === reloadGeneration.current) {
        setError(reason instanceof Error ? reason.message : "保護された下書きを読み込めませんでした。");
        setEntries([]);
      }
    } finally {
      journal?.close();
      if (generation === reloadGeneration.current) setLoading(false);
    }
  }, [repo, workspace, authorScope]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const refresh = (event: Event): void => {
      const detail = (event as DraftChangeEvent).detail;
      if (detail?.repositoryKey === expectedRepositoryKey && detail.authorScope === authorScope) void reload();
    };
    window.addEventListener(WORKSPACE_DRAFTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(WORKSPACE_DRAFTS_CHANGED_EVENT, refresh);
  }, [expectedRepositoryKey, authorScope, reload]);

  async function open(entry: JournalEntry): Promise<void> {
    if (openingKey) return;
    setOpeningKey(entry.key);
    setError("");
    try {
      // Re-read the selected record so stale UI state cannot authorize another draft.
      const journal = await BrowserJournal.open();
      let latest: JournalEntry | undefined;
      try { latest = (await journal.getRepository(repo, authorScope)).find((candidate) => candidate.key === entry.key); }
      finally { journal.close(); }
      if (!latest || !discoverWorkspaceDrafts([latest], workspace, authorScope).length) {
        throw new Error("この下書きはWorkspaceまたは作者の範囲が変わったため開けません。保護記録は保持しています。");
      }
      await onOpenDraft(latest);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "下書きを開けませんでした。保護記録は保持しています。");
    } finally {
      setOpeningKey("");
    }
  }

  return <section className="workspace-draft-recovery" aria-labelledby="workspace-draft-recovery-heading">
    <div className="workspace-draft-recovery-heading">
      <h2 id="workspace-draft-recovery-heading">保護された下書き</h2>
      <button type="button" className="quiet-button" disabled={loading} onClick={() => void reload()}>更新</button>
    </div>
    {loading ? <p role="status">保護された下書きを確認しています…</p> : error ? <p role="alert">{error}</p> : entries.length ? <ul className="workspace-draft-recovery-list" aria-label="保護された下書き">
      {entries.map((entry) => {
        const existsInWorktree = worktreePaths?.includes(entry.documentPath);
        return <li key={entry.key}>
          <button type="button" className="workspace-draft-recovery-item" disabled={!!openingKey} onClick={() => void open(entry)}>
            <strong>{entry.documentPath}</strong>
            <small>{new Date(entry.updatedAt).toLocaleString()} · {entry.text.length}字</small>
            <small>{existsInWorktree === undefined ? "保護されたブラウザー下書き" : existsInWorktree ? "保護された下書き" : "Gitファイル一覧にない下書き"}</small>
            <span>{openingKey === entry.key ? "開いています…" : "下書きを開く"}</span>
          </button>
        </li>;
      })}
    </ul> : <p className="workspace-draft-recovery-empty">保護された下書きはありません。</p>}
  </section>;
}
