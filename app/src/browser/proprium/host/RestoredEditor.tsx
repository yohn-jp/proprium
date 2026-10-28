import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { SceneEditor, type ScratchDraftBinding, type ScratchDraftPayload } from "../../../editor/SceneEditor.js";
import type { ResolveEditorTerms } from "../../../editor/terms.js";
import { BrowserJournal, documentKey, repositoryKey, type JournalEntry } from "../../../storage/journal.js";
import type { RepositoryIdentity, SnapshotId } from "@scriptorium/contracts";
import type { BrowserLocalGit } from "../git/index.js";
import type { WorkspaceIdentity } from "../git/protocol.js";
import { discoverWorkspaceDrafts, draftBaseMatches, journalRepositoryForWorkspace, notifyWorkspaceDraftsChanged, workspaceBreadcrumb } from "./workspace-drafts.js";
import type { HostWritingResume, WritingResumeSelection } from "./writing-resume.js";

interface Props {
  workspace: WorkspaceIdentity;
  file: { data: Uint8Array | null; path: string; text: string | null; revision: { oid: string | null }; dirty: boolean };
  head: string | null;
  published: boolean;
  localCommitted: boolean;
  busy: boolean;
  readOnly?: boolean;
  checkpointBusy?: boolean;
  publishBusy?: boolean;
  authorScope: string;
  author: { name: string; email: string };
  onChange(text: string): void;
  onSave(): void;
  onCommit(): void;
  onPublish(): void;
  hostFileActions?: ReactNode;
  onHistory(): void;
  canPublish: boolean;
  onRegisterFlush(flush: (() => Promise<string | null>) | null): void;
  onRegisterQuickAppend?(append: ((text: string, operationId: string) => Promise<void>) | null,
    matchesAppliedOperation?: ((text: string, operationId: string) => boolean) | null): void;
  git: BrowserLocalGit;
  onScratchApplied(): Promise<void>;
  onCompositionChange?(composing: boolean): void;
  resolveTerms?: ResolveEditorTerms;
  onTermNavigate?(targetPath: string, termId: string, event: Event): void;
  hostNavigationSelection?: { readonly requestId: string; readonly start: number; readonly end: number };
  onHostNavigationSelectionApplied?(requestId: string): void;
  onWritingPosition?(path: string, sentenceIndex: number | null, scrollTop: number, selection: WritingResumeSelection | null): void;
  hostResume?: HostWritingResume & { readonly requestId: number };
  onHostResumeApplied?(requestId: number, restored: boolean): void;
}

/** The recovered Scriptorium editor, with Browser Host-owned storage and Git ports. */
export function RestoredEditor(props: Props): ReactElement {
  const { workspace, file, head, published, busy, checkpointBusy = false, publishBusy = false, authorScope, onRegisterFlush } = props;
  const repo = useMemo<RepositoryIdentity>(() => journalRepositoryForWorkspace(workspace), [workspace]);
  const snapshot = useMemo<SnapshotId>(() => ({ repository: repo, remoteCommit: published ? head ?? "" : "", ...(head ? { overlayCommit: head } : {}) }), [repo, head, published]);
  const journalRef = useRef<BrowserJournal | null>(null);
  const inputFlushRef = useRef<(() => Promise<string | null>) | null>(null);
  const inputAppendRef = useRef<((text: string) => string | null) | null>(null);
  const appendOperationsRef = useRef(new Map<string, string>());
  const latest = useRef(props); latest.current = props;
  const generation = useRef(Date.now());
  const [journalReady, setJournalReady] = useState(false);
  const [journalError, setJournalError] = useState("");
  const [storedText, setStoredText] = useState<string | null>(file.dirty ? null : file.text);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [recoveryEntries, setRecoveryEntries] = useState<JournalEntry[]>([]);
  const activeRef = useRef(true);
  const fileVersion = useRef({ path: file.path, revision: file.revision.oid, value: 0 });
  const resumeRequest = useMemo(() => props.hostResume ? { id: props.hostResume.requestId, repositoryKey: repositoryKey(repo), sceneId: file.path,
    cursorSentenceIndex: props.hostResume.position.sentence_index, scrollTop: props.hostResume.position.scroll_top,
    ...(props.hostResume.selection ? { selection: props.hostResume.selection } : {}) } : null, [props.hostResume, repo, file.path]);
  const resumeApplied = useCallback((id: number, restored?: boolean) => latest.current.onHostResumeApplied?.(id, restored === true), []);
  if (fileVersion.current.path !== file.path || fileVersion.current.revision !== file.revision.oid) fileVersion.current = { path: file.path, revision: file.revision.oid, value: fileVersion.current.value + 1 };

  useEffect(() => {
    let disposed = false; activeRef.current = true;
    void BrowserJournal.open().then(async journal => {
      if (disposed) { journal.close(); return; }
      journalRef.current = journal;
      const recovered = await journal.getRepository(repo, authorScope);
      if (!disposed) { setEntries(recovered); setRecoveryEntries(recovered); generation.current = Math.max(generation.current, ...recovered.map(entry => entry.operation.generation)); setJournalReady(true); }
    }).catch(error => { if (!disposed) setJournalError(error instanceof Error ? error.message : "下書きの回復記録を開けませんでした。"); });
    return () => { disposed = true; activeRef.current = false; journalRef.current?.close(); journalRef.current = null; };
  }, [repo, authorScope]);

  const draftEntry = useCallback((path: string, text: string, id: string, writes = [{ path, revision: null as string | null, content: text }]): JournalEntry => ({
    version: 1, key: "", repositoryKey: repositoryKey(repo), documentKey: documentKey(repo, path), authorScope, repository: repo,
    documentPath: path, sceneId: path, snapshot, text, baseText: file.text ?? "", state: "draft", updatedAt: Date.now(),
    operation: { id, generation: ++generation.current, repository: repo, baseRemoteCommit: snapshot.remoteCommit, effect: path.startsWith("meta/scratch/") ? "metadata" : "manuscript", reads: [{ path, revision: writes[0]?.revision ?? null }], writes, message: `Draft ${path}` },
  }), [repo, authorScope, snapshot, file.path, file.revision.oid]);

  const persistText = useCallback(async (text: string, operationId: string = crypto.randomUUID()): Promise<void> => {
    const journal = journalRef.current;
    if (!journal) throw new Error("下書きの回復記録を利用できません。入力はエディターに保持されています。");
    const entry = draftEntry(file.path, text, operationId);
    // The recovered journal uses content SHA-256 revisions; Browser Git uses Git blob OIDs.
    // Translate only this recovery value, preserving the original journal contract.
    const base = latest.current.file.data;
    if (base !== null) {
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(base));
      const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      entry.operation.reads[0]!.revision = revision;
      entry.operation.writes[0]!.revision = revision;
    }
    if (!(await journal.putLatestDraft(entry))) throw new Error("別の操作による新しい下書きがあります。回復記録を確認してください。");
    if (activeRef.current) { setStoredText(text); setJournalError(""); setEntries(await journal.getRepository(repo, authorScope)); notifyWorkspaceDraftsChanged(workspace, authorScope); }
  }, [draftEntry, file.path, repo, authorScope, workspace]);

  useEffect(() => {
    if (!file.dirty || file.text === null || !journalReady) return;
    const text = file.text;
    const timer = setTimeout(() => { void persistText(text).catch(error => { if (activeRef.current) setJournalError(error instanceof Error ? error.message : "下書きを保護できませんでした。"); }); }, 350);
    return () => clearTimeout(timer);
  }, [file.dirty, file.text, journalReady, persistText]);

  const flush = useCallback(async (): Promise<string | null> => {
    const text = await inputFlushRef.current?.() ?? latest.current.file.text;
    if (text !== null && (latest.current.file.dirty || text !== latest.current.file.text)) await persistText(text);
    await scratchFlushRef.current?.();
    return text;
  }, [persistText]);
  useEffect(() => { onRegisterFlush(flush); return () => onRegisterFlush(null); }, [flush, onRegisterFlush]);
  const registerInputFlush = useCallback((next: (() => Promise<string | null>) | null) => { inputFlushRef.current = next; }, []);
  const registerInputAppend = useCallback((next: ((text: string) => string | null) | null) => { inputAppendRef.current = next; }, []);
  const appendQuickText = useCallback(async (text: string, operationId: string): Promise<void> => {
    if (!journalReady || !journalRef.current) throw new Error("下書きの回復記録を利用できません。エディターは変更されていません。");
    if (!text.trim() || !/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw new Error("追記する文章または操作 ID が不正です。");
    const priorText = appendOperationsRef.current.get(operationId);
    if (priorText !== undefined && priorText !== text) throw new Error("同じ操作 ID で異なる文章を追記できません。");
    let nextText: string | null;
    if (priorText !== undefined) {
      nextText = await inputFlushRef.current?.() ?? latest.current.file.text;
    } else {
      if (latest.current.file.dirty) throw new Error("原稿に未保存の変更があります。保存してから追記してください。");
      const before = await inputFlushRef.current?.();
      if (before === null || before !== latest.current.file.text) throw new Error("表示中の原稿が最新の保存済み本文と一致しません。");
      nextText = inputAppendRef.current?.(text) ?? null;
      if (nextText !== null) {
        appendOperationsRef.current.set(operationId, text);
        while (appendOperationsRef.current.size > 128) appendOperationsRef.current.delete(appendOperationsRef.current.keys().next().value!);
      }
    }
    if (nextText === null) throw new Error("原稿エディターを利用できません。");
    await persistText(nextText, operationId);
  }, [journalReady, persistText]);
  const matchesAppliedAppend = useCallback((text: string, operationId: string): boolean =>
    appendOperationsRef.current.get(operationId) === text, []);
  useEffect(() => {
    props.onRegisterQuickAppend?.(appendQuickText, matchesAppliedAppend);
    return () => props.onRegisterQuickAppend?.(null, null);
  }, [appendQuickText, matchesAppliedAppend, props.onRegisterQuickAppend]);
  const scratchFlushRef = useRef<(() => Promise<JournalEntry | null>) | null>(null);
  const registerScratchFlush = useCallback((next: (() => Promise<JournalEntry | null>) | null) => { scratchFlushRef.current = next; }, []);
  const draftScratch = async (draft: ScratchDraftPayload, binding: ScratchDraftBinding): Promise<JournalEntry> => {
    if (binding.repositoryKey !== repositoryKey(repo) || binding.sceneId !== file.path) throw new Error("スクラッチのWorkspaceが変わっています。");
    const path = `meta/scratch/${draft.id}.md`;
    const writes = [{ path, revision: null as string | null, content: draft.text, encoding: "utf8" as "utf8" | "base64" }, ...draft.attachments.map((attachment, index) => ({ path: `meta/scratch/${draft.id}/${index}-${attachment.filename.replace(/[^A-Za-z0-9._-]/gu, "_")}`, revision: null, content: attachment.dataBase64, encoding: "base64" as const }))];
    const entry = draftEntry(path, draft.text, draft.id, writes);
    entry.sceneId = binding.sceneId;
    const journal = journalRef.current;
    if (!journal || !(await journal.putLatestDraft(entry))) throw new Error("スクラッチを保護できませんでした。入力を保持しています。");
    setEntries(await journal.getRepository(repo, authorScope)); notifyWorkspaceDraftsChanged(workspace, authorScope); return entry;
  };
  const checkpointScratch = async (entry: JournalEntry): Promise<void> => {
    if (entry.repositoryKey !== repositoryKey(repo) || entry.authorScope !== authorScope) throw new Error("スクラッチの所有Workspaceが一致しません。");
    const changes = entry.operation.writes.map(write => ({ path: write.path, expectedRevision: { oid: write.revision }, content: write.content === null ? null : write.encoding === "base64" ? Uint8Array.from(atob(write.content), char => char.charCodeAt(0)) : new TextEncoder().encode(write.content) }));
    if (!props.author.name.trim() || !props.author.email.includes("@")) throw new Error("Git author name/emailを設定してください。");
    const before = await props.git.status();
    if (before.entries.length) throw new Error("先に既存の変更をCheckpointしてください。スクラッチは回復記録に保持しています。");
    await props.git.checkpointScratch(changes, before.head, `Scratch ${entry.sceneId}`, props.author);
    await journalRef.current?.removeEntry(entry); setEntries(await journalRef.current?.getRepository(repo, authorScope) ?? []); await props.onScratchApplied();
  };
  const recovered = discoverWorkspaceDrafts(recoveryEntries, workspace, authorScope).filter(entry => entry.documentPath === file.path && entry.text !== file.text);
  const restoreDraft = async (entry: JournalEntry): Promise<void> => {
    const current = latest.current;
    if (!discoverWorkspaceDrafts([entry], current.workspace, current.authorScope).length || entry.documentPath !== current.file.path) {
      setJournalError("この下書きは現在のWorkspaceまたは作者の範囲と一致しません。回復記録は保持しています。");
      return;
    }
    if (current.file.dirty && current.file.text !== entry.text) {
      setJournalError("現在のエディターに未保存の入力があります。先にその入力を保護してください。回復記録は保持しています。");
      return;
    }
    if (!(await draftBaseMatches(entry, current.file.data))) {
      setJournalError("下書きの基準ファイルが変更されています。上書きせず、回復記録を保持しています。");
      return;
    }
    const stillCurrent = latest.current;
    if (stillCurrent.file.path !== entry.documentPath || stillCurrent.file.revision.oid !== current.file.revision.oid ||
        stillCurrent.file.data !== current.file.data || stillCurrent.file.dirty ||
        stillCurrent.workspace.localWorkspaceId !== current.workspace.localWorkspaceId ||
        stillCurrent.workspace.branch !== current.workspace.branch) {
      setJournalError("エディターまたはWorkspaceが変わっています。上書きせず、回復記録を保持しています。");
      return;
    }
    stillCurrent.onChange(entry.text);
    setRecoveryEntries(existing => existing.filter(item => item.key !== entry.key));
  };
  return <>
    {recovered.length > 0 && <section className="recovery-list" aria-label="回復できる下書き"><h2>回復できる下書き</h2>{recovered.map(entry => <div key={entry.key}><p>{new Date(entry.updatedAt).toLocaleString()} · {entry.text.length}字</p><button type="button" onClick={() => void restoreDraft(entry)}>この下書きをエディターで開く</button></div>)}</section>}
    <SceneEditor readOnly={props.readOnly} projectId={workspace.localWorkspaceId} authorScope={authorScope} repositoryKey={repositoryKey(repo)} snapshot={snapshot} historySnapshot={snapshot}
      scene={{ id: file.path, title: file.path.split("/").at(-1) ?? file.path, text: file.text ?? "", revision: file.revision.oid ?? "" }} path={file.path} breadcrumb={workspaceBreadcrumb(workspace)}
      text={file.text ?? ""} textRevision={fileVersion.current.value} flushPendingReactPublish={() => undefined}
      onTextChange={props.onChange} onRetryDraft={() => { void persistText(file.text ?? "").catch(error => setJournalError(String(error))); }}
      onCursorPositionChange={(_sceneId, sentenceIndex, scrollTop, selection) => props.onWritingPosition?.(file.path, sentenceIndex, scrollTop, selection ?? null)}
      onReadingPageChange={() => undefined}
      resumeRequest={resumeRequest} onResumeRequestApplied={resumeApplied}
      durability={published ? "saved" : checkpointBusy ? "checkpointing" : props.localCommitted && !file.dirty ? "checkpointed" : "draft"} draftStored={!file.dirty || storedText === file.text} journalError={journalError}
      conflict={null} canResolveDraft={false} onRebase={() => undefined} onRestoreRemote={() => undefined}
      resolveTerms={props.resolveTerms} onTermNavigate={props.onTermNavigate}
      hostNavigationSelection={props.hostNavigationSelection} onHostNavigationSelectionApplied={props.onHostNavigationSelectionApplied}
      canCheckpoint={!busy} checkpointBusy={checkpointBusy} onCheckpoint={props.onCommit} canPublish={props.canPublish && !busy} publishBusy={publishBusy} onPublish={props.onPublish} hostFileActions={props.hostFileActions}
      onHistory={props.onHistory} historyOpen={false} historyExternal={true} onRestoreHistoryBody={props.onChange}
      scratchEntries={entries.filter(entry => entry.documentPath.startsWith("meta/scratch/"))} onDraftScratch={draftScratch} onCheckpointScratch={checkpointScratch}
      registerScratchFlush={registerScratchFlush} registerNavigationFlush={registerInputFlush} scratchBusy={busy} pendingCount={file.dirty ? 1 : 0}
      registerQuickAppend={registerInputAppend}
      onCompositionChange={props.onCompositionChange} />
  </>;
}
