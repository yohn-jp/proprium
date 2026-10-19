import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  assertChangeOperation,
  assertProjectPath,
  snapshotKey,
  type ChangeOperation,
  type BrowserEditorDocument,
  type ChangeProposal,
  type ModuleStatus,
  type RecentActivityDeviceType,
  type RemoteObservation,
  type RepositoryIdentity,
  type SnapshotId,
  type UiContribution,
} from "@scriptorium/contracts";
import { ApiError, api, type Project, type SceneRead, type Tree, type TreeRead } from "../api";
import { WorkspaceContribution } from "../contributions/ContributionHost";
import { workspaceContributions } from "../contributions/catalog";
import { Workspace } from "../workspace/Workspace";
import { ManuscriptHistoryPanel } from "../editor/ManuscriptHistoryPanel";
import type { EditorTermSpan } from "../editor/terms";
import { ProposalReview } from "../contributions/ProposalReview";
import { PublicModuleView, publicModuleIdForPath } from "../contributions/PublicModuleView";
import { ThemeControl } from "../components/ThemeControl";
import { JobInbox } from "../components/JobInbox";
import { SceneEditor, type ResumeRequest, type ScratchDraftBinding, type ScratchDraftPayload } from "../editor/SceneEditor";
import { replaceDocumentBody } from "../editor/ruby";
import { formatHandoffHint, mergeContinueCandidates, sceneExistsInTree, sceneTitleInTree, type ContinueCandidate } from "../resume/continueCandidates";
import { useRecentActivityResume } from "../resume/useRecentActivityResume";
import { loadThemeMode, persistThemeMode, type ThemeMode } from "../theme";
import { clearDraft, loadDraft } from "../drafts";
import type { ApplicationShell, ApplicationShellProps, UiMode } from "./contracts";
import { applicationPath, parseApplicationLocation, readUiModePreference, rememberUiMode, switchApplicationPath, type ApplicationResource } from "./navigation";
import { canRetainRecoveredEditorDuringSceneLoad, isEditorTextSafeToFlush, isNonDraftEntryAcknowledgedByReceipt, isSameSceneEditorLoad, isUnchangedEntryConfirmedByReceipt, mayWriteEditor, recoveryStatusForJournalOpen, type EditorRecoveryStatus } from "./recovery";
import {
  BrowserJournal,
  documentKey,
  journalEntryKey,
  proposalOperationEntry,
  repositoryKey,
  requestPersistentStorage,
  stableJson,
  type JournalEntry,
  type JournalProposal,
} from "../storage/journal";

const ACTIVE_PROJECT_KEY = "scriptorium:active-project";

interface LegacyDraftRecord {
  key: string;
  projectId: string;
  sceneId: string;
  text: string;
  revision: string;
  savedAt: number;
}

function readLegacyDrafts(): LegacyDraftRecord[] {
  const records: LegacyDraftRecord[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      try {
        const key = window.localStorage.key(index);
        if (!key?.startsWith("scriptorium:draft:")) continue;
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        if (item.version !== 1 || typeof item.projectId !== "string" || typeof item.sceneId !== "string" ||
            typeof item.text !== "string" || typeof item.revision !== "string" || typeof item.savedAt !== "number") continue;
        records.push({
          key,
          projectId: item.projectId,
          sceneId: item.sceneId,
          text: item.text,
          revision: item.revision,
          savedAt: item.savedAt,
        });
      } catch {
        // One malformed legacy key must not hide later recoverable records.
      }
    }
  } catch {
    // Legacy storage remains untouched if the browser blocks enumeration.
  }
  return records.sort((left, right) => right.savedAt - left.savedAt);
}

function localStorageIfAvailable(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface EditorSession {
  read: SceneRead;
  remote: SceneRead;
  text: string;
  baseText: string;
  entry: JournalEntry | null;
  conflict: SceneRead | null;
  draftStored: boolean;
  journalError: string;
  recoveryStatus: EditorRecoveryStatus;
}

interface WorkState {
  project: Project;
  observation: RemoteObservation;
  tree: TreeRead;
  selectedSceneId: string;
  editor: EditorSession | null;
  loadingScene: boolean;
  recoveryStatus: EditorRecoveryStatus;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "セッションの有効期限が切れました。もう一度ログインしてください。";
    if (error.status === 409 || error.status === 412) return "保存先が更新されています。保護された下書きを残して競合を確認してください。";
    return error.message;
  }
  return error instanceof Error ? error.message : "処理に失敗しました。";
}

function projectLabel(project: Project): string {
  try {
    const url = new URL(project.url);
    return `${url.hostname}${url.pathname.replace(/\.git$/u, "").replace(/\/$/u, "")}`;
  } catch {
    return project.url;
  }
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return repositoryKey(left) === repositoryKey(right);
}

function recoveryKeyForProject(projectId: string, repository: RepositoryIdentity, authorScope: string): string {
  return JSON.stringify([projectId, repositoryKey(repository), authorScope]);
}

function recoveryKeyForNavigation(projectId: string, repository: RepositoryIdentity, authorScope: string, navigation: number): string {
  return JSON.stringify([recoveryKeyForProject(projectId, repository, authorScope), navigation]);
}

function draftTimerKey(entry: JournalEntry): string {
  return JSON.stringify([entry.authorScope, entry.documentKey]);
}

function sameRemoteSnapshot(left: SnapshotId, right: SnapshotId): boolean {
  return sameRepository(left.repository, right.repository) && left.remoteCommit === right.remoteCommit;
}

function safeManuscriptLink(metadata: string, path: string): string {
  if (/^manuscript\s*:/mu.test(metadata)) return metadata;
  const separator = metadata.endsWith("\n") || metadata.length === 0 ? "" : "\n";
  return `${metadata}${separator}manuscript: ${JSON.stringify(path)}\n`;
}

function sceneTreeLocation(tree: Tree, sceneId: string): Pick<ApplicationResource, "volumeId" | "chapterId"> | null {
  for (const volume of tree.volumes) {
    for (const chapter of volume.chapters) {
      if (chapter.scenes.some((scene) => scene.id === sceneId)) {
        return { volumeId: volume.id, chapterId: chapter.id };
      }
    }
  }
  return null;
}

function resourceForWork(work: WorkState | null): ApplicationResource | null {
  if (!work) return null;
  const sceneId = work.selectedSceneId || undefined;
  const location = sceneId ? sceneTreeLocation(work.tree.tree, sceneId) : null;
  return {
    projectId: work.project.id,
    ...(location ?? {}),
    ...(sceneId ? { sceneId } : {}),
  };
}

function buildOperation(
  read: SceneRead,
  text: string,
  id: string,
  generation: number,
): ChangeOperation {
  const documentPath = read.document.path;
  const metadataPath = read.metadata.path;
  assertProjectPath(documentPath);
  assertProjectPath(metadataPath);
  const writes: ChangeOperation["writes"] = [{
    path: documentPath,
    revision: read.document.revision,
    content: replaceDocumentBody(read.document.content, text),
  }];
  const reads: ChangeOperation["reads"] = [{ path: documentPath, revision: read.document.revision }];
  if (!/^manuscript\s*:/mu.test(read.metadata.content)) {
    reads.push({ path: metadataPath, revision: read.metadata.revision });
    writes.push({
      path: metadataPath,
      revision: read.metadata.revision,
      content: safeManuscriptLink(read.metadata.content, documentPath),
    });
  }
  const operation: ChangeOperation = {
    id,
    generation,
    repository: read.snapshot.repository,
    baseRemoteCommit: read.snapshot.remoteCommit,
    effect: "manuscript",
    reads,
    writes,
    message: "loom(scene): " + read.scene.id + "\n\nLoom-Manuscript: " + read.scene.id + "\nLoom-File: " + documentPath + "\nLoom-Char-Count: " + text.length,
  };
  assertChangeOperation(operation);
  return operation;
}

function proposalIdFor(operation: ChangeOperation): string {
  return `author-${operation.id}-${operation.generation}`;
}

function proposalOperationIds(proposal: ChangeProposal): string[] {
  return proposal.operations.map((operation) => operation.id);
}

function proposalIsFullyPublished(record: JournalProposal): boolean {
  const originalIds = record.status?.operationIds ?? proposalOperationIds(record.proposal);
  const published = new Set(record.status?.publishedOperationIds ?? []);
  return originalIds.length > 0 && originalIds.every((id) => published.has(id));
}

function makeEntry(
  repository: RepositoryIdentity,
  authorScope: string,
  sceneId: string,
  read: SceneRead,
  text: string,
  baseText: string,
  operation: ChangeOperation,
  state: JournalEntry["state"],
  documentPath = read.document.path,
): JournalEntry {
  const key = documentKey(repository, documentPath);
  const entry: JournalEntry = {
    version: 1,
    key: "",
    repositoryKey: repositoryKey(repository),
    documentKey: key,
    authorScope,
    repository,
    documentPath,
    sceneId,
    snapshot: read.snapshot,
    text,
    baseText,
    operation,
    state,
    updatedAt: Date.now(),
  };
  entry.key = journalEntryKey(entry);
  return entry;
}

function safeScratchFilename(filename: string): string {
  const basename = filename.split(/[\\/]/u).at(-1) ?? "capture.jpg";
  const safe = basename.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "").slice(0, 100);
  return safe || "capture.jpg";
}

function buildScratchOperation(read: SceneRead, draft: ScratchDraftPayload): { operation: ChangeOperation; path: string } {
  const path = `meta/scratch/${draft.id}.md`;
  assertProjectPath(path);
  const attachments = draft.attachments.map((attachment, index) => {
    const filename = safeScratchFilename(attachment.filename);
    const attachmentPath = attachment.path ?? `meta/scratch/assets/${draft.id}/${index + 1}-${filename}`;
    assertProjectPath(attachmentPath);
    return { ...attachment, filename, path: attachmentPath };
  });
  const content = [
    "---",
    `id: ${JSON.stringify(draft.id)}`,
    `sceneId: ${JSON.stringify(read.scene.id)}`,
    ...(draft.createdAt ? [`createdAt: ${JSON.stringify(draft.createdAt)}`] : []),
    "attachments:",
    ...attachments.map((attachment) => `  - path: ${JSON.stringify(attachment.path)}\n    filename: ${JSON.stringify(attachment.filename)}\n    mimeType: ${JSON.stringify(attachment.mimeType)}`),
    "---",
    "",
    draft.text || (attachments.length > 0 ? "カメラ取り込み" : ""),
    ...(attachments.length > 0 ? ["", "Attachments:", ...attachments.map((attachment) => `- [${attachment.filename}](assets/${draft.id}/${attachment.path.split("/").at(-1)})`)] : []),
    "",
  ].join("\n");
  const writes: ChangeOperation["writes"] = [{ path, revision: null, content }];
  for (const attachment of attachments) {
    writes.push({ path: attachment.path, revision: null, content: attachment.dataBase64, encoding: "base64" });
  }
  const operation: ChangeOperation = {
    id: draft.id,
    generation: draft.generation,
    repository: read.snapshot.repository,
    baseRemoteCommit: read.snapshot.remoteCommit,
    effect: "metadata",
    reads: writes.map((write) => ({ path: write.path, revision: null })),
    writes,
    message: `Write scratch: ${read.scene.title.replace(/[\r\n]+/gu, " ").slice(0, 120)}`,
  };
  assertChangeOperation(operation);
  return { operation, path };
}

export function App({ initialTheme }: { initialTheme?: ThemeMode } = {}) {
  const mode = parseApplicationLocation(window.location.pathname)?.mode ?? readUiModePreference() ?? "desktop";
  return <ThemedApplication initialTheme={initialTheme} mode={mode} Shell={DefaultApplicationShell} allowPublicModule />;
}

export function SharedApplication({
  mode,
  Shell,
  initialTheme,
}: {
  mode: UiMode;
  Shell: ApplicationShell;
  initialTheme?: ThemeMode;
}) {
  return <ThemedApplication initialTheme={initialTheme} mode={mode} Shell={Shell} allowPublicModule={false} />;
}

function DefaultApplicationShell({ mode, header, library, editor, tools, status, onSwitchMode, panels, workspaceScope, beforeLayoutChange, requestedPanel }: ApplicationShellProps) {
  return (
    <div className="workspace">
      {header}
      <button type="button" className="quiet-button" onClick={() => void onSwitchMode()}>
        {mode === "desktop" ? "モバイル版へ" : "デスクトップ版へ"}
      </button>
      {panels && workspaceScope ? <>
        {status}
        <Workspace mode={mode} scope={workspaceScope} panels={panels} beforeLayoutChange={beforeLayoutChange} requestedPanel={requestedPanel} />
      </> : <div className="workspace-grid">
        {library}
        <main className="writing-area" aria-label="執筆">
          {status}
          {editor}
          {tools}
        </main>
      </div>}
    </div>
  );
}

function ThemedApplication({
  initialTheme,
  mode,
  Shell,
  allowPublicModule,
}: {
  initialTheme?: ThemeMode;
  mode: UiMode;
  Shell: ApplicationShell;
  allowPublicModule: boolean;
}) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => initialTheme ?? loadThemeMode());
  const [themeError, setThemeError] = useState("");
  const changeTheme = useCallback((mode: ThemeMode) => {
    try {
      persistThemeMode(mode);
      setThemeMode(mode);
      setThemeError("");
    } catch {
      setThemeError("外観の設定を保存できませんでした。");
    }
  }, []);
  const publicModuleId = allowPublicModule ? publicModuleIdForPath(window.location.pathname) : null;
  return publicModuleId
    ? <PublicModuleView moduleId={publicModuleId} themeMode={themeMode} onThemeChange={changeTheme} themeError={themeError} />
    : <AuthorWorkspace themeMode={themeMode} onThemeChange={changeTheme} themeError={themeError} mode={mode} Shell={Shell} />;
}

function AuthorWorkspace({
  themeMode,
  onThemeChange,
  themeError,
  mode,
  Shell,
}: {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  themeError: string;
  mode: UiMode;
  Shell: ApplicationShell;
}) {
  const [authState, setAuthState] = useState<"checking" | "signed-out" | "ready">("checking");
  const [hostedMode, setHostedMode] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [authorScope, setAuthorScope] = useState("owner");
  const authorScopeRef = useRef("owner");
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [journal, setJournal] = useState<BrowserJournal | null>(null);
  const [journalOpenError, setJournalOpenError] = useState("");
  const journalOpenErrorRef = useRef("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [work, setWork] = useState<WorkState | null>(null);
  const [resumeRequest, setResumeRequest] = useState<ResumeRequest | null>(null);
  const [status, setStatus] = useState<{ message: string; kind: "normal" | "error" | "success" }>({ message: "", kind: "normal" });
  const [globalError, setGlobalError] = useState("");
  const [projectActionError, setProjectActionError] = useState<{ projectId: string; code?: string; message: string } | null>(null);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [proposals, setProposals] = useState<JournalProposal[]>([]);
  const [isolatedRecoveryCount, setIsolatedRecoveryCount] = useState(0);
  const [legacyDrafts, setLegacyDrafts] = useState<LegacyDraftRecord[]>([]);
  const [modules, setModules] = useState<ModuleStatus[]>([]);
  const [contributions, setContributions] = useState<UiContribution[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [panelRequest, setPanelRequest] = useState<{ id: string; sequence: number }>();
  const [inspectedDocument, setInspectedDocument] = useState<{ snapshot: SnapshotId; path: string; content: string; revision: string } | null>(null);
  const [busy, setBusy] = useState("");
  const navigationRef = useRef(0);
  const workRef = useRef<WorkState | null>(null);
  const journalRef = useRef<BrowserJournal | null>(null);
  const draftQueueRef = useRef<Promise<void>>(Promise.resolve());
  const scratchFlushRef = useRef<() => Promise<JournalEntry | null>>(async () => null);
  const editorFlushRef = useRef<() => Promise<string | null>>(async () => null);
  const draftTimersRef = useRef(new Map<string, number>());
  const pendingDraftsRef = useRef(new Map<string, JournalEntry>());
  const generationRef = useRef(0);
  const observationBusyRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const sceneLoadRef = useRef(0);
  const recoveredProjectsRef = useRef(new Set<string>());
  const reconciliationRef = useRef(new Map<string, Promise<boolean>>());
  const proposalPollsRef = useRef(new Map<string, Promise<void>>());
  const resumeRequestSequenceRef = useRef(0);
  const requestedResourceRef = useRef(parseApplicationLocation(`${window.location.pathname}${window.location.search}`)?.resource ?? null);
  const stablePathRef = useRef(`${window.location.pathname}${window.location.search}`);
  const activeRepositoryKey = work ? repositoryKey(work.observation.snapshot.repository) : "";
  const recentResume = useRecentActivityResume({
    binding: work ? { projectId: work.project.id, authorScope, repositoryKey: activeRepositoryKey } : null,
    enabled: authState === "ready" && canWrite,
  });

  const registerScratchFlush = useCallback((flush: (() => Promise<JournalEntry | null>) | null) => {
    scratchFlushRef.current = flush ?? (async () => null);
  }, []);

  const registerNavigationFlush = useCallback((flush: (() => Promise<string | null>) | null) => {
    editorFlushRef.current = flush ?? (async () => null);
  }, []);

  function updateApplicationLocation(resource: ApplicationResource | null, replace = false): void {
    const current = `${window.location.pathname}${window.location.search}`;
    const priorResource = parseApplicationLocation(current)?.resource ?? null;
    const search = new URLSearchParams(window.location.search);
    if (resource?.sceneId && resource.sceneId !== priorResource?.sceneId && search.get("view") === "library") {
      search.set("view", "writing");
    }
    const path = applicationPath(mode, resource, search.toString());
    if (path !== current) {
      const sameDocument = Boolean(resource?.projectId && resource.sceneId &&
        priorResource?.projectId === resource.projectId && priorResource.sceneId === resource.sceneId);
      const historyState = window.history.state;
      if (replace || sameDocument) window.history.replaceState(historyState, "", path);
      else window.history.pushState(historyState, "", path);
      stablePathRef.current = path;
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    }
    stablePathRef.current = path;
  }

  const updateWork = useCallback((updater: (current: WorkState | null) => WorkState | null) => {
    const next = updater(workRef.current);
    workRef.current = next;
    setWork(next);
  }, []);

  const readCurrentEditor = useCallback((): BrowserEditorDocument | null => {
    const current = workRef.current;
    const editor = current?.editor;
    if (!current || current.recoveryStatus !== "ready" || !editor || editor.recoveryStatus !== "ready" || current.loadingScene ||
        current.selectedSceneId !== editor.read.scene.id || !sameRepository(current.observation.snapshot.repository, editor.read.snapshot.repository)) return null;
    const cloneSnapshot = (snapshot: SnapshotId): SnapshotId => ({
      ...snapshot,
      repository: { ...snapshot.repository },
    });
    return {
      sceneId: editor.read.scene.id,
      documentPath: editor.read.document.path,
      documentRevision: editor.read.document.revision,
      sceneRevision: editor.read.scene.revision,
      text: editor.text,
      snapshot: cloneSnapshot(editor.read.snapshot),
      baseSnapshot: cloneSnapshot(editor.remote.snapshot),
      baseSceneRevision: editor.remote.metadata.revision,
    };
  }, []);

  function isCurrentProject(nav: number, projectId: string, repository: RepositoryIdentity): boolean {
    const current = workRef.current;
    return navigationRef.current === nav && current?.project.id === projectId &&
      sameRepository(current.observation.snapshot.repository, repository);
  }

  function isCurrentEditor(nav: number, projectId: string, repository: RepositoryIdentity, documentPath: string, sceneId: string): boolean {
    const current = workRef.current;
    return isCurrentProject(nav, projectId, repository) && current?.editor?.read.document.path === documentPath &&
      current.editor.read.scene.id === sceneId && current.selectedSceneId === sceneId && !current.loadingScene &&
      current.recoveryStatus === "ready" && current.editor.recoveryStatus === "ready";
  }

  const refreshJournal = useCallback(async (repository?: RepositoryIdentity, expectedNavigation?: number) => {
    const currentJournal = journalRef.current;
    if (!currentJournal) return;
    try {
      const [allEntries, allProposals] = await Promise.all([
        currentJournal.getAllEntries(),
        currentJournal.getAllProposals(),
      ]);
      if (expectedNavigation !== undefined && navigationRef.current !== expectedNavigation) return;
      setIsolatedRecoveryCount(allEntries.filter((entry) => entry.authorScope !== authorScopeRef.current).length + allProposals.filter((record) => record.authorScope !== authorScopeRef.current).length);
      setEntries(allEntries.filter((entry) => entry.authorScope === authorScopeRef.current && (!repository || sameRepository(entry.repository, repository))));
      const visibleProposals = repository
        ? allProposals.filter((record) => record.authorScope === authorScopeRef.current && record.dismissedAt === undefined &&
          !proposalIsFullyPublished(record) &&
          sameRepository(record.repository, repository))
        : allProposals.filter((record) => record.authorScope === authorScopeRef.current && record.dismissedAt === undefined &&
          !proposalIsFullyPublished(record));
      setProposals(visibleProposals);
      if (repository) {
        const active = workRef.current;
        const activeEditor = active?.editor;
        const activeEntry = activeEditor?.entry;
        const conflictEntry = activeEditor && activeEntry && active?.selectedSceneId === activeEditor.read.scene.id &&
            sameRepository(active.observation.snapshot.repository, repository)
          ? allEntries.find((entry) => entry.authorScope === authorScopeRef.current && entry.state === "conflict" &&
            entry.documentPath === activeEditor.read.document.path && entry.operation.id === activeEntry.operation.id &&
            entry.operation.generation === activeEntry.operation.generation)
          : undefined;
        const editorSnapshotIsCurrent = activeEditor && sameRemoteSnapshot(activeEditor.remote.snapshot, active.observation.snapshot);
        if (conflictEntry && editorSnapshotIsCurrent && (activeEditor?.entry?.state !== "conflict" || !activeEditor.conflict)) {
          updateWork((current) => current?.editor?.read.document.path === conflictEntry.documentPath &&
              current.editor.entry?.operation.id === conflictEntry.operation.id &&
              current.editor.entry.operation.generation === conflictEntry.operation.generation &&
              sameRepository(current.observation.snapshot.repository, repository)
            ? {
              ...current,
              editor: {
                ...current.editor,
                entry: conflictEntry,
                text: conflictEntry.text,
                conflict: current.editor.conflict ?? current.editor.remote,
                draftStored: true,
              },
            }
            : current);
        }
      }
    } catch (error) {
      if (expectedNavigation === undefined || navigationRef.current === expectedNavigation) setGlobalError(messageOf(error));
    }
  }, []);

  const importRemoteProposals = useCallback(async (
    projectId: string,
    repository: RepositoryIdentity,
    scope: string,
    expectedNavigation?: number,
  ) => {
    const currentJournal = journalRef.current;
    if (!currentJournal || !scope) return;
    const owner = repositoryKey(repository);
    const pollKey = JSON.stringify([projectId, owner, scope]);
    const inFlight = proposalPollsRef.current.get(pollKey);
    if (inFlight) return inFlight;
    const poll = (async () => {
      let response: Awaited<ReturnType<typeof api.proposalStatuses>>;
      let receipts: Awaited<ReturnType<BrowserJournal["getPublicationReceipts"]>>;
      let localProposals: JournalProposal[];
      try {
        [response, receipts, localProposals] = await Promise.all([
          api.proposalStatuses(projectId),
          currentJournal.getPublicationReceipts(repository, scope),
          currentJournal.getProposals(repository, scope),
        ]);
      } catch (error) {
        if (expectedNavigation === undefined || isCurrentProject(expectedNavigation, projectId, repository)) {
          setStatus({ message: `外部提案を確認できませんでした。${messageOf(error)}`, kind: "error" });
        }
        return;
      }
      const failures: string[] = [];
      let restoredAny = false;
      for (const status of response.proposals) {
        if (status?.payloadComplete !== false) continue;
        const remoteProposal = status.proposal;
        const privateRecord = localProposals.find((record) => record.proposal.id === remoteProposal.id);
        const originalIds = status.operationIds;
        if (!privateRecord || !Array.isArray(originalIds) ||
            JSON.stringify(proposalOperationIds(privateRecord.proposal)) !== JSON.stringify(originalIds)) continue;
        try {
          const restored = await api.propose(projectId, privateRecord.proposal);
          if (stableJson(restored) !== stableJson(privateRecord.proposal)) {
            throw new Error("Core に保存された元の提案がブラウザー回復記録と一致しません。");
          }
          restoredAny = true;
        } catch (error) {
          failures.push(`${remoteProposal.id}: 元の提案を照合できませんでした。${messageOf(error)}`);
        }
      }
      if (restoredAny) {
        try {
          response = await api.proposalStatuses(projectId);
        } catch (error) {
          failures.push(`提案の復元後の状態を確認できませんでした。${messageOf(error)}`);
        }
      }
      const acknowledged = new Set(receipts.flatMap((receipt) => receipt.acknowledged.map((item) => `${item.operationId}\u0000${item.generation}`)));
      for (const status of response.proposals) {
        try {
          const proposal = status?.proposal;
          if (!proposal || proposal.snapshot?.repository == null || repositoryKey(proposal.snapshot.repository) !== owner ||
              !Array.isArray(proposal.operations) || proposal.operations.length === 0 ||
              !Array.isArray(status.approvedOperationIds) || !Array.isArray(status.checkpoints) ||
              !Array.isArray(status.publishedOperationIds ?? []) || typeof status.stale !== "boolean") {
            throw new Error("Core から不正な提案状態が返されました。");
          }
          if (status.payloadComplete === false && (!/^[a-f0-9]{64}$/u.test(status.originalDigest ?? "") ||
              !Array.isArray(status.operationIds) || status.operationIds.length < proposal.operations.length ||
              new Set(status.operationIds).size !== status.operationIds.length ||
              !proposal.operations.every((operation) => status.operationIds!.includes(operation.id)))) {
            throw new Error("Core から元の提案との結び付きがない部分回復状態が返されました。");
          }
          const originalIds = status.operationIds ?? proposalOperationIds(proposal);
          const publishedIds = new Set(status.publishedOperationIds ?? []);
          const fullyAcknowledged = originalIds.length > 0 && originalIds.every((id) => publishedIds.has(id));
          if (fullyAcknowledged) {
            await currentJournal.removeProposal(repository, scope, proposal.id).catch(() => undefined);
            continue;
          }
          const checkpointByOperation = new Map(status.checkpoints.map((receipt) => [`${receipt.operationId}\u0000${receipt.generation}`, receipt]));
          // Persist the full operation, provenance and evidence before exposing the proposal in React.
          await currentJournal.putProposal(repository, scope, proposal, status);
          for (const operation of proposal.operations) {
            if (publishedIds.has(operation.id)) continue;
            const receipt = checkpointByOperation.get(`${operation.id}\u0000${operation.generation}`);
            if (!receipt) continue;
            const exactReceipt = acknowledged.has(`${operation.id}\u0000${operation.generation}`) ? undefined : receipt;
            if (!exactReceipt) continue;
            const entry = proposalOperationEntry(repository, scope, proposal, operation, "checkpointing");
            await currentJournal.put(entry);
            await currentJournal.updateState(entry, "checkpointed", exactReceipt);
          }
        } catch (error) {
          failures.push(`${status?.proposal?.id ?? "提案"}: ${messageOf(error)}`);
        }
      }
      if (expectedNavigation === undefined || isCurrentProject(expectedNavigation, projectId, repository)) {
        if (failures.length) setStatus({ message: `外部提案を回復記録へ取り込めませんでした。${failures.join(" / ")}`, kind: "error" });
      }
    })();
    proposalPollsRef.current.set(pollKey, poll);
    try {
      await poll;
      if (expectedNavigation === undefined || isCurrentProject(expectedNavigation, projectId, repository)) {
        await refreshJournal(repository, expectedNavigation);
      }
    } finally {
      if (proposalPollsRef.current.get(pollKey) === poll) proposalPollsRef.current.delete(pollKey);
    }
  }, [refreshJournal]);

  const refreshContributionContext = useCallback(() => refreshRef.current(), []);
  const refreshProposals = useCallback(() => {
    const current = workRef.current;
    const repository = current?.observation.snapshot.repository;
    if (current && repository) void importRemoteProposals(current.project.id, repository, authorScopeRef.current, navigationRef.current);
  }, [importRemoteProposals]);

  useEffect(() => {
    let cancelled = false;
    void BrowserJournal.open().then(async (opened) => {
      if (cancelled) {
        opened.close();
        return;
      }
      journalRef.current = opened;
      journalOpenErrorRef.current = "";
      setJournal(opened);
      setLegacyDrafts(readLegacyDrafts());
      void requestPersistentStorage().catch(() => undefined);
      await refreshJournal();
    }).catch((error) => {
      if (!cancelled) {
        const message = messageOf(error);
        journalOpenErrorRef.current = message;
        setJournalOpenError(message);
        updateWork((current) => current?.editor
          ? { ...current, recoveryStatus: "unavailable", editor: { ...current.editor, recoveryStatus: "unavailable", journalError: message } }
          : current ? { ...current, recoveryStatus: "unavailable" }
          : current);
      }
    });
    void api.version().then(async (version) => {
      if (cancelled) return null;
      setHostedMode(version.hosted);
      return api.session();
    }).then(async (session) => {
      if (!session) return;
      if (cancelled) return;
      const scope = session.authorScope || "owner";
      setCanWrite(session.permissions ? session.permissions.includes("write") : true);
      authorScopeRef.current = scope;
      setAuthorScope(scope);
      void refreshJournal();
      setAuthState("ready");
      try {
        const registered = await api.projects();
        if (cancelled) return;
        setProjects(registered);
        const stored = localStorageIfAvailable()?.getItem(ACTIVE_PROJECT_KEY) ?? null;
        const requested = requestedResourceRef.current;
        const routeProject = requested?.projectId ? registered.find((project) => project.id === requested.projectId) : undefined;
        if (requested?.projectId && !routeProject) {
          setGlobalError("この直接リンクの作品は現在のアカウントで開けません。");
          return;
        }
        const next = routeProject ?? registered.find((project) => project.id === stored) ?? registered[0];
        if (next) {
          await activateProject(next, false, scope);
          if (cancelled) return;
          const active = workRef.current;
          if (requested?.sceneId) {
            const location = active?.project.id === requested.projectId && active ? sceneTreeLocation(active.tree.tree, requested.sceneId) : null;
            if (!active || active.project.id !== requested.projectId || !location ||
                (requested.volumeId && requested.volumeId !== location.volumeId) ||
                (requested.chapterId && requested.chapterId !== location.chapterId)) {
              setGlobalError("直接リンクのシーンが作品構成に見つからないか、URL の巻・章と一致しません。");
              return;
            }
            await loadScene(active.project.id, requested.sceneId, active.tree, active.observation.snapshot.repository);
          }
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setAuthState("signed-out");
        } else {
          setGlobalError(messageOf(error));
        }
      }
    }).catch((error) => {
      if (!cancelled) {
        if (error instanceof ApiError && error.status === 401) setAuthState("signed-out");
        else setGlobalError(messageOf(error));
      }
    });
    return () => {
      cancelled = true;
    };
  // The initial authentication probe is intentionally one-shot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadJournalForWork = useCallback(async (repository: RepositoryIdentity, expectedNavigation?: number) => {
    await refreshJournal(repository, expectedNavigation);
  }, [refreshJournal]);

  const replayAuthorizedEntry = useCallback(async (projectId: string, entry: JournalEntry, author: string) => {
    const currentJournal = journalRef.current;
    if (!currentJournal) throw new Error("ブラウザー回復ストレージを開けません。");
    if (entry.authorScope !== author) throw new Error("別の作者スコープの回復記録は再生できません。");
    if (entry.state !== "checkpointing" && entry.state !== "checkpointed") return entry;
    const stableProposalId = entry.proposalId ?? proposalIdFor(entry.operation);
    const prepared = await currentJournal.updateState({ ...entry, proposalId: stableProposalId, authorizedAt: entry.authorizedAt ?? Date.now() }, "checkpointing");
    const proposal: ChangeProposal = {
      id: stableProposalId,
      snapshot: prepared.snapshot,
      operations: [prepared.operation],
      source: "author",
    };
    const accepted = await api.propose(projectId, proposal);
    await currentJournal.putProposal(prepared.repository, author, accepted);
    const assigned = await currentJournal.updateState({ ...prepared, proposalId: accepted.id }, "checkpointing");
    await api.approve(projectId, {
      proposalId: accepted.id,
      operationIds: [assigned.operation.id],
      authorScope: author,
    });
    const receipt = await api.checkpoint(projectId, assigned.operation);
    const checkpointed = await currentJournal.updateState(assigned, "checkpointed", receipt);
    await currentJournal.removeProposal(prepared.repository, author, accepted.id).catch(() => undefined);
    return checkpointed;
  }, []);

  const reconcileProject = useCallback((projectId: string, repository: RepositoryIdentity, author: string, expectedNavigation?: number): Promise<boolean> => {
    const nav = expectedNavigation ?? navigationRef.current;
    const key = recoveryKeyForNavigation(projectId, repository, author, nav);
    const running = reconciliationRef.current.get(key);
    if (running) return running;
    const isCurrent = () => navigationRef.current === nav && workRef.current?.project.id === projectId &&
      sameRepository(workRef.current.observation.snapshot.repository, repository);
    const task = (async (): Promise<boolean> => {
      const currentJournal = journalRef.current;
      if (!currentJournal) return false;
      try {
        const persisted = await currentJournal.getRepository(repository, author);
        if (!isCurrent()) return false;
        const pendingEntries = persisted.filter((entry) => entry.state === "checkpointing" || entry.state === "checkpointed");
        let complete = true;
        for (const entry of pendingEntries) {
          if (!isCurrent()) return false;
          try {
            await replayAuthorizedEntry(projectId, entry, author);
          } catch (error) {
            const conflict = error instanceof ApiError && (error.status === 409 || error.status === 412);
            if (conflict) {
              try {
                await currentJournal.updateState(entry, "conflict");
              } catch {
                complete = false;
              }
            } else {
              complete = false;
              if (isCurrent()) setStatus({ message: `チェックポイント回復を完了できません。記録を保持しています。${messageOf(error)}`, kind: "error" });
            }
          }
        }
        if (pendingEntries.length > 0 && complete) {
          const reconciled = await api.reconcile(projectId);
          if (!isCurrent()) return false;
          for (const result of reconciled.operations) {
            const match = pendingEntries.find((entry) => entry.operation.id === result.operationId);
            if (!match) continue;
            if (result.state === "conflict") await currentJournal.updateState(match, "conflict");
            else if (result.receipt) await currentJournal.updateState(match, "checkpointed", result.receipt);
          }
        }
        if (!complete) throw new Error("チェックポイント回復の結果を確認できませんでした。");
        await reloadJournalForWork(repository, nav);
        if (!isCurrent()) return false;
        updateWork((current) => current?.project.id === projectId && sameRepository(current.observation.snapshot.repository, repository)
          ? { ...current, recoveryStatus: "ready" }
          : current);
        return true;
      } catch (error) {
        if (isCurrent()) {
          updateWork((current) => current?.project.id === projectId && sameRepository(current.observation.snapshot.repository, repository)
            ? {
              ...current,
              recoveryStatus: "unavailable",
              editor: current.editor
                ? { ...current.editor, recoveryStatus: "unavailable", journalError: `回復記録を照合できません。記録を保持しています。${messageOf(error)}` }
                : null,
            }
            : current);
          setStatus({ message: `回復記録を照合できません。記録を保持しています。${messageOf(error)}`, kind: "error" });
        }
        return false;
      }
    })();
    reconciliationRef.current.set(key, task);
    void task.finally(() => {
      if (reconciliationRef.current.get(key) === task) reconciliationRef.current.delete(key);
    }).catch(() => undefined);
    return task;
  }, [reloadJournalForWork, replayAuthorizedEntry, updateWork]);

  const loadScene = useCallback(async (projectId: string, sceneId: string, tree: TreeRead, preferredRepository?: RepositoryIdentity) => {
    const sceneRequest = ++sceneLoadRef.current;
    const nav = navigationRef.current;
    const journalAuthorScope = authorScopeRef.current;
    const requestedRepository = preferredRepository ?? tree.snapshot.repository;
    const sceneEditorLoadIdentity = (current: WorkState | null) => ({
      currentProjectId: current?.project.id,
      requestedProjectId: projectId,
      currentRepositoryMatches: Boolean(current && current.editor &&
        sameRepository(current.observation.snapshot.repository, requestedRepository) &&
        sameRepository(current.editor.read.snapshot.repository, requestedRepository)),
      currentAuthorScopeMatches: authorScopeRef.current === journalAuthorScope,
      selectedSceneId: current?.selectedSceneId ?? "",
      requestedSceneId: sceneId,
      editorSceneId: current?.editor?.read.scene.id,
      recoveryStatus: current?.recoveryStatus ?? "pending",
      editorRecoveryStatus: current?.editor?.recoveryStatus,
    });
    const isCurrentLoadContext = () => navigationRef.current === nav &&
      sceneLoadRef.current === sceneRequest && authorScopeRef.current === journalAuthorScope;
    try {
      const composedText = await editorFlushRef.current();
      const activeEditor = workRef.current?.editor;
      if (composedText !== null && activeEditor && composedText !== activeEditor.text) editText(composedText);
      recentResume.flush();
      await flushDraft();
    } catch (error) {
      if (isCurrentLoadContext()) setStatus({ message: messageOf(error), kind: "error" });
      return;
    }
    if (!isCurrentLoadContext()) return;
    updateWork((current) => current ? {
      ...current,
      selectedSceneId: sceneId,
      loadingScene: !canRetainRecoveredEditorDuringSceneLoad(sceneEditorLoadIdentity(current)),
    } : current);
    try {
      const { remote, effective } = await api.readSceneViews(projectId, sceneId, tree.snapshot);
      if (!isCurrentLoadContext()) return;
      if (snapshotKey(remote.snapshot) !== snapshotKey(tree.snapshot)) throw new Error("作品構成と原稿が異なるリモートスナップショットから返されました。再読み込みしてください。");
      if (!sameRemoteSnapshot(effective.snapshot, remote.snapshot)) throw new Error("チェックポイントとリモート原稿の基準が異なります。同期状態を確認してください。");
      const repository = preferredRepository ?? effective.snapshot.repository;
      const currentJournal = journalRef.current;
      const projectRecoveryStatus = workRef.current?.recoveryStatus ?? "pending";
      let recoveryStatus: EditorRecoveryStatus = !currentJournal
        ? recoveryStatusForJournalOpen(journalOpenErrorRef.current)
        : projectRecoveryStatus;
      let recoveryError = recoveryStatus === "pending"
        ? "ブラウザー回復記録を確認しています。確認が終わるまで編集を一時停止しています。"
        : recoveryStatus === "unavailable"
          ? journalOpenErrorRef.current || "回復記録の照合に失敗しました。記録を保持しています。"
          : "";
      let localEntries: JournalEntry[] = [];
      if (currentJournal) {
        try {
          localEntries = await currentJournal.getDocument(repository, effective.document.path, journalAuthorScope);
        } catch (error) {
          recoveryStatus = "unavailable";
          recoveryError = `ブラウザー回復記録を読めません。記録を保持しています。${messageOf(error)}`;
        }
      }
      if (!isCurrentLoadContext()) return;
      let publicationReceipts: Awaited<ReturnType<BrowserJournal["getPublicationReceipts"]>> = [];
      let cleanupError: unknown;
      if (currentJournal) {
        try {
          publicationReceipts = await currentJournal.getPublicationReceipts(repository, journalAuthorScope);
        } catch (error) {
          cleanupError = error;
          recoveryStatus = "unavailable";
          recoveryError = `公開確認記録を読めないため、回復状態を確認できません。記録を保持しています。${messageOf(error)}`;
        }
      }
      if (!isCurrentLoadContext()) return;
      if (cleanupError) {
        setStatus({ message: `公開確認記録を読めないため、回復記録を整理できませんでした。記録を保持しています。${messageOf(cleanupError)}`, kind: "error" });
      }
      if (currentJournal) {
        const receiptsToRetry = publicationReceipts.filter((receipt) =>
          localEntries.some((candidate) => isNonDraftEntryAcknowledgedByReceipt(candidate, receipt)));
        for (const receipt of receiptsToRetry) {
          if (!isCurrentLoadContext()) return;
          try {
            await currentJournal.acknowledge(repository, journalAuthorScope, receipt);
          } catch (error) {
            cleanupError ??= error;
            recoveryStatus = "unavailable";
            recoveryError = `確認済み操作の回復記録を整理できません。記録を保持しています。${messageOf(error)}`;
          }
          if (!isCurrentLoadContext()) return;
        }
        if (receiptsToRetry.length > 0) {
          try {
            localEntries = await currentJournal.getDocument(repository, effective.document.path, journalAuthorScope);
          } catch (error) {
            cleanupError ??= error;
            recoveryStatus = "unavailable";
            recoveryError = `確認済み操作の回復記録を再読込できません。記録を保持しています。${messageOf(error)}`;
          }
          if (!isCurrentLoadContext()) return;
          await refreshJournal(repository, nav);
          if (!isCurrentLoadContext()) return;
          const acknowledgedEntriesRemain = localEntries.some((candidate) =>
            receiptsToRetry.some((receipt) => isNonDraftEntryAcknowledgedByReceipt(candidate, receipt)));
          if (acknowledgedEntriesRemain) {
            const detail = cleanupError ? messageOf(cleanupError) : "確認済み操作の回復記録がまだ残っています。";
            setStatus({ message: `GitHub への保存は確認済みですが、ブラウザー回復記録を整理できませんでした。記録を保持しています。${detail}`, kind: "error" });
          }
        }
      }
      if (!isCurrentLoadContext()) return;
      let latest = localEntries.at(-1) ?? null;
      let text = effective.scene.text;
      let entry = latest;
      let conflict: SceneRead | null = null;
      if (!latest && currentJournal && recoveryStatus !== "unavailable") {
        const legacy = loadDraft(localStorageIfAvailable(), projectId, sceneId);
        if (legacy && legacy.text !== effective.scene.text) {
          const operation = buildOperation(effective, legacy.text, crypto.randomUUID(), 1);
          const migrated = makeEntry(repository, journalAuthorScope, sceneId, effective, legacy.text, effective.scene.text, operation, "draft");
          try {
            if (!await currentJournal.putLatestDraft(migrated)) throw new Error("A newer browser draft already exists.");
            clearDraft(localStorageIfAvailable(), projectId, sceneId);
            latest = migrated;
            if (legacy.revision !== effective.scene.revision) conflict = remote;
            setLegacyDrafts(readLegacyDrafts());
            generationRef.current = Math.max(generationRef.current, 1);
            void refreshJournal(repository, nav);
          } catch (error) {
            recoveryStatus = "unavailable";
            recoveryError = `古いブラウザー下書きを IndexedDB に移せませんでした。古い記録は残しました。${messageOf(error)}`;
            setGlobalError(recoveryError);
          }
        }
      }
      // A refresh can take longer than the draft debounce. Preserve edits made
      // while the pinned reads were in flight, even if IndexedDB has not seen
      // their newest generation yet.
      const inMemory = workRef.current;
      const inMemoryEditor = inMemory?.project.id === projectId && inMemory.selectedSceneId === sceneId &&
          inMemory.editor?.read.document.path === effective.document.path
        ? inMemory.editor
        : null;
      const inMemoryEntry = inMemoryEditor?.entry;
      const inMemoryEntryWasPublished = Boolean(inMemoryEditor && inMemoryEntry &&
        inMemoryEntry.state !== "draft" &&
        isUnchangedEntryConfirmedByReceipt(inMemoryEntry, inMemoryEditor.text, publicationReceipts));
      if (inMemoryEditor && inMemoryEntry && !inMemoryEntryWasPublished &&
          (!latest || inMemoryEntry.operation.generation > latest.operation.generation)) {
        latest = inMemoryEntry;
        entry = inMemoryEntry;
        text = inMemoryEditor.text;
      }
      if (latest) {
        if (latest.state === "draft" || latest.state === "checkpointing" || latest.state === "conflict") text = latest.text;
        const docPrecondition = latest.operation.reads.find((item) => item.path === effective.document.path)?.revision;
        const docWrite = latest.operation.writes.find((item) => item.path === effective.document.path)?.content;
        if (latest.state === "draft" && docPrecondition !== effective.document.revision) {
          const latestGeneration = latest.operation.generation;
          const priorCheckpoint = [...localEntries].reverse().find((candidate) =>
            candidate.operation.generation < latestGeneration &&
            (candidate.state === "checkpointing" || candidate.state === "checkpointed" || candidate.state === "publication_unknown") &&
            candidate.snapshot.remoteCommit === remote.snapshot.remoteCommit &&
            candidate.operation.writes.some((write) => write.path === effective.document.path && write.content === effective.document.content),
          );
          if (priorCheckpoint) {
            try {
              const rebasedGeneration = Math.max(generationRef.current, latestGeneration) + 1;
              generationRef.current = rebasedGeneration;
              const operation = buildOperation(effective, latest.text, latest.operation.id, rebasedGeneration);
              latest = makeEntry(repository, journalAuthorScope, sceneId, effective, latest.text, effective.scene.text, operation, "draft");
              if (!await journalRef.current?.putLatestDraft(latest)) throw new Error("A newer browser draft already exists.");
              entry = latest;
            } catch (error) {
              conflict = remote;
              recoveryStatus = "unavailable";
              recoveryError = `下書きをローカルチェックポイントの版に結び直せませんでした。元の記録は保持しています。${messageOf(error)}`;
              setGlobalError(recoveryError);
            }
          } else {
            conflict = remote;
          }
        }
        if ((latest.state === "checkpointed" || latest.state === "publication_unknown") && docWrite !== effective.document.content) {
          conflict = remote;
        }
        if (latest.state === "checkpointing" && docWrite !== effective.document.content) conflict = remote;
        if (latest.state === "conflict") conflict = remote;
      }
      if (!isCurrentLoadContext()) return;
      // A draft can arrive while the prior-checkpoint rebase is waiting for IndexedDB.
      // Re-read the live editor immediately before installation so that asynchronous
      // storage completion cannot replace a newer in-memory generation.
      const finalWork = workRef.current;
      const finalEditor = finalWork?.project.id === projectId && finalWork.selectedSceneId === sceneId &&
          finalWork.editor?.read.document.path === effective.document.path
        ? finalWork.editor
        : null;
      let baseText = latest?.baseText ?? effective.scene.text;
      let draftStored = Boolean(latest);
      let journalError = "";
      const finalEditorEntryWasPublished = Boolean(finalEditor?.entry &&
        finalEditor.entry.state !== "draft" &&
        isUnchangedEntryConfirmedByReceipt(finalEditor.entry, finalEditor.text, publicationReceipts));
      if (finalEditor?.entry && !finalEditorEntryWasPublished &&
          (!latest || finalEditor.entry.operation.generation > latest.operation.generation)) {
        latest = finalEditor.entry;
        entry = finalEditor.entry;
        text = finalEditor.text;
        baseText = finalEditor.baseText;
        draftStored = finalEditor.draftStored;
        journalError = finalEditor.journalError;
        const currentRevision = finalEditor.entry.operation.reads.find((item) => item.path === effective.document.path)?.revision;
        conflict = currentRevision !== effective.document.revision ||
            finalEditor.entry.operation.baseRemoteCommit !== remote.snapshot.remoteCommit
          ? remote
          : finalEditor.conflict;
      } else if (finalEditor?.entry && latest &&
          finalEditor.entry.operation.id === latest.operation.id &&
          finalEditor.entry.operation.generation === latest.operation.generation) {
        draftStored = finalEditor.draftStored;
        journalError = finalEditor.journalError;
      }
      if (!journalRef.current && journalOpenErrorRef.current) {
        recoveryStatus = recoveryStatusForJournalOpen(journalOpenErrorRef.current);
        recoveryError = journalOpenErrorRef.current;
      }
      const next: EditorSession = {
        read: effective,
        remote,
        text,
        baseText,
        entry: latest,
        conflict,
        draftStored,
        journalError: journalError || (recoveryStatus === "unavailable" ? recoveryError : ""),
        recoveryStatus,
      };
      generationRef.current = Math.max(generationRef.current, latest?.operation.generation ?? 0);
      updateWork((current) => current ? { ...current, selectedSceneId: sceneId, editor: next, loadingScene: false } : current);
      const loadedWork = workRef.current;
      if (loadedWork?.project.id === projectId && loadedWork.editor?.read.scene.id === sceneId) {
        updateApplicationLocation(resourceForWork(loadedWork));
      }
    } catch (error) {
      if (!isCurrentLoadContext()) return;
      let retainedCurrentEditor = false;
      updateWork((current) => {
        if (!current) return current;
        retainedCurrentEditor = isSameSceneEditorLoad(sceneEditorLoadIdentity(current));
        return { ...current, loadingScene: false, editor: retainedCurrentEditor ? current.editor : null };
      });
      setStatus({
        message: retainedCurrentEditor
          ? `シーンの更新を読み込めませんでした。表示中の編集内容は保持しています。${messageOf(error)}`
          : messageOf(error),
        kind: "error",
      });
    }
  }, [refreshJournal, recentResume.flush, updateWork]);

  const activateProject = useCallback(async (project: Project, persistSelection = true, scopeOverride?: string) => {
    const nav = ++navigationRef.current;
    setBusy("project");
    setProjectActionError(null);
    setStatus({ message: "リモートの状態を確認しています…", kind: "normal" });
    try {
      const composedText = await editorFlushRef.current();
      const activeEditor = workRef.current?.editor;
      if (composedText !== null && activeEditor && composedText !== activeEditor.text) editText(composedText);
      recentResume.flush();
      await flushDraft();
      if (navigationRef.current !== nav) return;
      updateWork(() => null);
      setGlobalError("");
      const details = await api.projectDetails(project.id);
      if (navigationRef.current !== nav) return;
      const activeProject = details.project;
      const observed = details.observation;
      const scope = scopeOverride ?? authorScopeRef.current;
      const tree = await api.readTree(activeProject.id, "remote", observed.snapshot);
      if (navigationRef.current !== nav) return;
      if (snapshotKey(tree.snapshot) !== snapshotKey(observed.snapshot)) throw new Error("作品構成が別のリモートスナップショットから返されました。");
      const next: WorkState = {
        project: activeProject,
        observation: observed,
        tree,
        selectedSceneId: "",
        editor: null,
        loadingScene: false,
        recoveryStatus: recoveryStatusForJournalOpen(journalOpenErrorRef.current),
      };
      const recoveryKey = recoveryKeyForNavigation(activeProject.id, observed.snapshot.repository, scope, nav);
      if (journalRef.current) recoveredProjectsRef.current.add(recoveryKey);
      workRef.current = next;
      setWork(next);
      setModules([]);
      setContributions([]);
      // Optional modules, proposals and recovery must not block opening a locally
      // available work. The navigation guard prevents an old load replacing new UI.
      void Promise.all([
        api.modules(activeProject.id).catch(() => []),
        api.contributions(activeProject.id).catch(() => []),
      ]).then(([nextModules, nextContributions]) => {
        if (navigationRef.current !== nav) return;
        setModules(nextModules);
        setContributions(nextContributions);
      });
      void reconcileProject(activeProject.id, observed.snapshot.repository, scope, nav).then((ready) => {
        if (!ready) recoveredProjectsRef.current.delete(recoveryKey);
      });
      void importRemoteProposals(activeProject.id, observed.snapshot.repository, scope, nav);
      if (persistSelection) {
        localStorageIfAvailable()?.setItem(ACTIVE_PROJECT_KEY, activeProject.id);
        updateApplicationLocation({ projectId: activeProject.id });
      }
      setProjects((current) => current.map((item) => item.id === activeProject.id ? activeProject : item));
      setStatus({
        message: observed.state === "fresh"
          ? `リモート ${observed.snapshot.remoteCommit.slice(0, 12)} · ${new Date(observed.observedAt).toLocaleTimeString("ja-JP")} に確認`
          : `ローカルSnapshot ${observed.snapshot.remoteCommit.slice(0, 12)} · リモート未確認`,
        kind: observed.state === "fresh" ? "success" : "normal",
      });
      // Refresh GitHub in the background; this never blocks the local tree.
      void refreshRef.current();
    } catch (error) {
      if (navigationRef.current === nav) setStatus({ message: messageOf(error), kind: "error" });
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }, [importRemoteProposals, recentResume.flush, reconcileProject, reloadJournalForWork, updateWork]);

  useEffect(() => {
    const onPopState = () => {
      const path = `${window.location.pathname}${window.location.search}`;
      const location = parseApplicationLocation(path);
      if (!location || location.mode !== mode) return;
      const target = location.resource;
      if (!target?.projectId) {
        stablePathRef.current = path;
        return;
      }
      const activeResource = resourceForWork(workRef.current);
      if (activeResource?.projectId === target.projectId && activeResource.sceneId === target.sceneId) {
        stablePathRef.current = path;
        return;
      }
      void (async () => {
        try {
          const composedText = await editorFlushRef.current();
          const currentEditor = workRef.current?.editor;
          if (composedText !== null && currentEditor && composedText !== currentEditor.text) editText(composedText);
          recentResume.flush();
          await flushDraft();
          let active = workRef.current;
          if (active?.project.id !== target.projectId) {
            const project = projects.find((item) => item.id === target.projectId);
            if (!project) throw new Error("移動先の作品は現在のアカウントで開けません。");
            await activateProject(project, false);
            active = workRef.current;
            if (active?.project.id !== target.projectId) throw new Error("移動先の作品を読み込めませんでした。");
          }
          if (target.sceneId) {
            const sceneLocation = active ? sceneTreeLocation(active.tree.tree, target.sceneId) : null;
            if (!active || !sceneLocation ||
                (target.volumeId && target.volumeId !== sceneLocation.volumeId) ||
                (target.chapterId && target.chapterId !== sceneLocation.chapterId)) {
              throw new Error("移動先のシーンが作品構成に見つからないか、URL の巻・章と一致しません。");
            }
            await loadScene(active.project.id, target.sceneId, active.tree, active.observation.snapshot.repository);
            if (workRef.current?.editor?.read.scene.id !== target.sceneId) throw new Error("移動先のシーンを読み込めませんでした。");
          } else if (active) {
            navigationRef.current++;
            sceneLoadRef.current++;
            updateWork((current) => current && current.project.id === target.projectId
              ? { ...current, selectedSceneId: "", editor: null, loadingScene: false }
              : current);
            setResumeRequest(null);
          }
          stablePathRef.current = path;
        } catch (error) {
          window.history.replaceState(window.history.state, "", stablePathRef.current);
          window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
          setStatus({ message: `移動する前に下書きを保存してください。${messageOf(error)}`, kind: "error" });
        }
      })();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [activateProject, loadScene, mode, projects, recentResume.flush, updateWork]);

  useEffect(() => {
    const current = workRef.current;
    if (!journal || !current) return;
    void importRemoteProposals(current.project.id, current.observation.snapshot.repository, authorScope, navigationRef.current);
  }, [authorScope, importRemoteProposals, journal, work?.project.id]);

  useEffect(() => {
    const current = workRef.current;
    if (!journal || !current) return;
    const nav = navigationRef.current;
    const key = recoveryKeyForNavigation(current.project.id, current.observation.snapshot.repository, authorScope, nav);
    if (recoveredProjectsRef.current.has(key)) return;
    recoveredProjectsRef.current.add(key);
    void reconcileProject(current.project.id, current.observation.snapshot.repository, authorScope, nav).then((ready) => {
      if (!ready) recoveredProjectsRef.current.delete(key);
    });
  }, [authorScope, journal, reconcileProject, work?.project.id]);

  useEffect(() => {
    const current = workRef.current;
    if (!journal || current?.recoveryStatus !== "ready" || !current.selectedSceneId || current.loadingScene ||
        current.editor?.recoveryStatus !== "pending") return;
    void loadScene(current.project.id, current.selectedSceneId, current.tree, current.observation.snapshot.repository);
  }, [journal, loadScene, work?.editor?.recoveryStatus, work?.loadingScene, work?.project.id, work?.recoveryStatus, work?.selectedSceneId]);

  const refreshRemote = useCallback(async () => {
    const current = workRef.current;
    if (!current || observationBusyRef.current || document.visibilityState === "hidden") return;
    observationBusyRef.current = true;
    const projectId = current.project.id;
    const nav = navigationRef.current;
    try {
      const observed = await api.observation(projectId);
      if (navigationRef.current !== nav || workRef.current?.project.id !== projectId) return;
      if (!sameRepository(workRef.current.observation.snapshot.repository, observed.snapshot.repository)) return;
      void importRemoteProposals(projectId, observed.snapshot.repository, authorScopeRef.current, nav);
      const latestBeforeRead = workRef.current;
      const changedRemote = Boolean(latestBeforeRead && latestBeforeRead.observation.snapshot.remoteCommit !== observed.snapshot.remoteCommit);
      const changedCheckpoint = Boolean(latestBeforeRead && latestBeforeRead.observation.checkpointHead !== observed.checkpointHead);
      const changedEditorSnapshot = Boolean(latestBeforeRead?.editor &&
        !sameRemoteSnapshot(latestBeforeRead.editor.remote.snapshot, observed.snapshot));
      if (changedRemote) {
        await reconcileProject(projectId, observed.snapshot.repository, authorScopeRef.current, nav);
        if (navigationRef.current !== nav || workRef.current?.project.id !== projectId) return;
      }
      const tree = changedRemote
        ? await api.readTree(projectId, "remote", observed.snapshot)
        : (latestBeforeRead?.tree ?? await api.readTree(projectId, "remote", observed.snapshot));
      if (navigationRef.current !== nav || snapshotKey(tree.snapshot) !== snapshotKey(observed.snapshot)) return;
      const latestBeforeUpdate = workRef.current;
      const changedTree = snapshotKey(latestBeforeUpdate?.tree.snapshot ?? current.tree.snapshot) !== snapshotKey(tree.snapshot);
      updateWork((latest) => {
        if (latest?.project.id !== projectId) return latest;
        const stableSnapshot = snapshotKey(latest.observation.snapshot) === snapshotKey(observed.snapshot)
          ? latest.observation.snapshot
          : observed.snapshot;
        const stableObservation = stableSnapshot === observed.snapshot ? observed : { ...observed, snapshot: stableSnapshot };
        const stableTree = snapshotKey(latest.tree.snapshot) === snapshotKey(tree.snapshot) ? latest.tree : tree;
        return { ...latest, observation: stableObservation, tree: stableTree };
      });
      setStatus({
        message: observed.state === "fresh"
          ? `リモート ${observed.snapshot.remoteCommit.slice(0, 12)} · ${new Date(observed.observedAt).toLocaleTimeString("ja-JP")} に確認`
          : `リモート確認状態: ${observed.state}`,
        kind: observed.state === "fresh" ? "normal" : "error",
      });
      const latest = workRef.current;
      if ((changedRemote || changedCheckpoint || changedTree || changedEditorSnapshot) && latest?.project.id === projectId && latest.selectedSceneId) {
        await flushDraft();
        await loadScene(projectId, latest.selectedSceneId, tree, observed.snapshot.repository);
      }
    } catch (error) {
      if (navigationRef.current === nav) setStatus({ message: `リモートの確認に失敗しました。${messageOf(error)}`, kind: "error" });
    } finally {
      observationBusyRef.current = false;
    }
  }, [importRemoteProposals, loadScene, recentResume.flush, reconcileProject, updateWork]);
  refreshRef.current = refreshRemote;

  const refreshForeground = useCallback(() => {
    const current = workRef.current;
    if (current && journalRef.current && (current.recoveryStatus === "unavailable" || current.editor?.recoveryStatus === "unavailable")) {
      const nav = navigationRef.current;
      const repository = current.observation.snapshot.repository;
      const recoveryKey = recoveryKeyForNavigation(current.project.id, repository, authorScopeRef.current, nav);
      recoveredProjectsRef.current.add(recoveryKey);
      updateWork((latest) => latest?.project.id === current.project.id && sameRepository(latest.observation.snapshot.repository, repository)
        ? {
          ...latest,
          recoveryStatus: "pending",
          editor: latest.editor ? { ...latest.editor, recoveryStatus: "pending", journalError: "" } : null,
        }
        : latest);
      void reconcileProject(current.project.id, repository, authorScopeRef.current, nav).then((ready) => {
        if (!ready) recoveredProjectsRef.current.delete(recoveryKey);
      });
    }
    // Proposal status and remote observation refresh independently of the editor.
    void refreshRef.current();
  }, [reconcileProject, updateWork]);

  useEffect(() => {
    if (!work) return;
    const timer = window.setInterval(refreshForeground, 15_000);
    const onForeground = () => {
      if (document.visibilityState === "visible") refreshForeground();
    };
    const onOnline = () => refreshForeground();
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("online", onOnline);
    };
  }, [refreshForeground, work?.project.id]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const editor = workRef.current?.editor;
      if (pendingDraftsRef.current.size > 0 || (editor && !editor.draftStored && editor.text !== editor.read.scene.text)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      for (const timer of draftTimersRef.current.values()) window.clearTimeout(timer);
      draftTimersRef.current.clear();
      for (const entry of pendingDraftsRef.current.values()) void persistDraft(entry);
    };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginError("");
    try {
      const result = await api.login(token);
      setToken("");
      const session = await api.session();
      setCanWrite(session.permissions ? session.permissions.includes("write") : true);
      const scope = session.authorScope || "owner";
      authorScopeRef.current = scope;
      setAuthorScope(scope);
      void refreshJournal();
      setAuthState("ready");
      const registered = await api.projects();
      setProjects(registered);
      if (registered[0]) await activateProject(registered[0], true, scope);
      else setStatus({ message: result.authenticated ? "ログインしました。作品リポジトリを登録してください。" : "ログインできませんでした。", kind: "normal" });
    } catch (error) {
      setLoginError(messageOf(error));
    }
  }

  async function signOut(): Promise<void> {
    try {
      recentResume.flush(true);
      await flushDraft();
      await api.logout();
      navigationRef.current++;
      updateWork(() => null);
      setAuthState("signed-out");
      setProjects([]);
    } catch (error) {
      setStatus({ message: `下書きを保存してからログアウトしてください。${messageOf(error)}`, kind: "error" });
    }
  }

  async function registerProject(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const nav = navigationRef.current;
    const form = new FormData(formElement);
    const url = String(form.get("url") ?? "").trim();
    setBusy("register");
    setGlobalError("");
    try {
      const project = await api.registerProject(url);
      if (navigationRef.current !== nav) return;
      formElement.reset();
      const nextProjects = await api.projects();
      if (navigationRef.current !== nav) return;
      setProjects(nextProjects);
      await activateProject(project);
    } catch (error) {
      if (navigationRef.current === nav) setGlobalError(messageOf(error));
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }

  function projectFailure(error: unknown): { code?: string; message: string } {
    return error instanceof ApiError
      ? { code: error.code, message: error.message }
      : { message: messageOf(error) };
  }

  async function reconstructActiveProject(): Promise<void> {
    const current = workRef.current;
    if (!current) return;
    const projectId = current.project.id;
    const repository = current.observation.snapshot.repository;
    const nav = navigationRef.current;
    if (!window.confirm(`「${projectLabel(current.project)}」のローカル作業領域を、リポジトリの現在の既定ブランチから再構築します。未保存のローカル変更や公開前のチェックポイントがある場合は Core が処理を拒否します。続けますか？`)) return;
    setProjectActionError(null);
    setBusy("reconstruct");
    try {
      await flushDraft();
      if (!isCurrentProject(nav, projectId, repository)) return;
      const { project } = await api.reconstructProject(projectId);
      setProjects((registered) => registered.map((item) => item.id === project.id ? project : item));
      if (isCurrentProject(nav, projectId, repository)) await activateProject(project, false);
    } catch (error) {
      if (navigationRef.current === nav && workRef.current?.project.id === projectId) {
        setProjectActionError({ projectId, ...projectFailure(error) });
      }
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }

  async function detachActiveProject(): Promise<void> {
    const current = workRef.current;
    if (!current) return;
    const projectId = current.project.id;
    const repository = current.observation.snapshot.repository;
    const nav = navigationRef.current;
    if (!window.confirm(`「${projectLabel(current.project)}」の登録とローカルクローンを解除します。GitHub 上のリポジトリは変更しません。下書きはブラウザーの回復記録に残します。続けますか？`)) return;
    setProjectActionError(null);
    setBusy("detach");
    try {
      await flushDraft();
      if (!isCurrentProject(nav, projectId, repository)) return;
      await api.detachProject(projectId);
      setProjects((registered) => registered.filter((item) => item.id !== projectId));
      if (isCurrentProject(nav, projectId, repository)) {
        const nextNavigation = ++navigationRef.current;
        updateWork(() => null);
        setModules([]);
        setContributions([]);
        setBusy("");
        localStorageIfAvailable()?.removeItem(ACTIVE_PROJECT_KEY);
        setStatus({ message: "ローカルの登録とクローンを解除しました。GitHub とブラウザーの回復記録は保持されています。", kind: "success" });
        await refreshJournal(undefined, nextNavigation);
      }
    } catch (error) {
      if (navigationRef.current === nav && workRef.current?.project.id === projectId) {
        setProjectActionError({ projectId, ...projectFailure(error) });
      }
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }

  function setStatusMessage(message: string, kind: "normal" | "error" | "success" = "normal"): void {
    setStatus({ message, kind });
  }

  async function persistDraft(entry: JournalEntry): Promise<boolean> {
    const navigation = navigationRef.current;
    const currentJournal = journalRef.current;
    if (!currentJournal) {
      updateWork((current) => navigationRef.current === navigation && current?.editor?.entry?.key === entry.key
        ? { ...current, editor: { ...current.editor, draftStored: false, journalError: "ブラウザー回復ストレージを利用できません。入力はこのタブにだけあります。" } }
        : current);
      return false;
    }
    const queued = draftQueueRef.current.then(async () => {
      const stored = await currentJournal.putLatestDraft(entry);
      if (!stored) throw new Error("新しい世代の回復記録があるため、この古い下書きは保存しませんでした。作品を再読み込みしてください。");
      const pendingKey = draftTimerKey(entry);
      const pending = pendingDraftsRef.current.get(pendingKey);
      if (pending?.operation.id === entry.operation.id && pending.operation.generation === entry.operation.generation) {
        pendingDraftsRef.current.delete(pendingKey);
      }
      await refreshJournal(entry.repository, navigation);
      updateWork((current) => navigationRef.current === navigation && current?.editor?.entry?.key === entry.key
        ? { ...current, editor: { ...current.editor, draftStored: true, journalError: "" } }
        : current);
      return true;
    }).catch((error) => {
      const errorText = messageOf(error);
      updateWork((current) => navigationRef.current === navigation && current?.editor?.entry?.key === entry.key
        ? { ...current, editor: { ...current.editor, draftStored: false, journalError: errorText } }
        : current);
      if (navigationRef.current === navigation) setStatus({ message: errorText, kind: "error" });
      return false;
    });
    draftQueueRef.current = queued.then(() => undefined);
    return queued;
  }

  async function persistScratchDraft(draft: ScratchDraftPayload, binding: ScratchDraftBinding): Promise<JournalEntry | null> {
    const current = workRef.current;
    const currentJournal = journalRef.current;
    if (!current || !current.editor || !currentJournal) throw new Error("作品またはブラウザー回復ストレージを利用できません。");
    const read = current.editor.read;
    if (current.editor.recoveryStatus !== "ready" || repositoryKey(read.snapshot.repository) !== binding.repositoryKey || snapshotKey(read.snapshot) !== snapshotKey(binding.snapshot) ||
        read.scene.id !== binding.sceneId || read.document.path !== binding.documentPath || current.selectedSceneId !== binding.sceneId || current.loadingScene) {
      throw new Error("スクラッチの読み込み中に表示中の原稿が変わりました。添付先を確認してもう一度保存してください。");
    }
    if (!draft.text.trim() && draft.attachments.length === 0) return null;
    const nav = navigationRef.current;
    const { operation, path } = buildScratchOperation(read, draft);
    const entry = makeEntry(read.snapshot.repository, authorScopeRef.current, read.scene.id, read, draft.text, "", operation, "draft", path);
    const stored = await currentJournal.putLatestDraft(entry);
    if (!stored) return null;
    await refreshJournal(read.snapshot.repository, nav);
    return entry;
  }

  function editText(nextText: string): void {
    const current = workRef.current;
    const editor = current?.editor;
    const currentJournal = journalRef.current;
    if (!current || !editor || !currentJournal || current.recoveryStatus !== "ready" || editor.recoveryStatus !== "ready" || current.loadingScene || current.selectedSceneId !== editor.read.scene.id) return;
    const prior = editor.entry;
    const id = prior?.state === "draft" ? prior.operation.id : crypto.randomUUID();
    const generation = Math.max(generationRef.current, prior?.operation.generation ?? 0) + 1;
    generationRef.current = generation;
    let entry: JournalEntry;
    try {
      const operation = buildOperation(editor.read, nextText, id, generation);
      entry = makeEntry(editor.read.snapshot.repository, authorScopeRef.current, editor.read.scene.id, editor.read, nextText, editor.read.scene.text, operation, "draft");
    } catch (error) {
      updateWork((latest) => latest?.editor ? { ...latest, editor: { ...latest.editor, text: nextText, draftStored: false, journalError: messageOf(error) } } : latest);
      return;
    }
    updateWork((latest) => latest?.editor ? {
      ...latest,
      editor: { ...latest.editor, text: nextText, entry, draftStored: false, journalError: "" },
    } : latest);
    const timerKey = draftTimerKey(entry);
    const pendingTimer = draftTimersRef.current.get(timerKey);
    if (pendingTimer) window.clearTimeout(pendingTimer);
    pendingDraftsRef.current.set(timerKey, entry);
    const timer = window.setTimeout(() => {
      if (draftTimersRef.current.get(timerKey) === timer) draftTimersRef.current.delete(timerKey);
      void persistDraft(entry);
    }, 350);
    draftTimersRef.current.set(timerKey, timer);
  }

  async function flushDraft(): Promise<JournalEntry | null> {
    await scratchFlushRef.current();
    const requireRecoverableEditorText = (editor: EditorSession): void => {
      if (!isEditorTextSafeToFlush(editor.text, editor.entry?.text ?? null, editor.read.scene.text, editor.recoveryStatus)) {
        throw new Error(editor.journalError || "現在の入力がブラウザー回復記録に含まれていないため、移動できません。");
      }
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const editor = workRef.current?.editor;
      if (!editor) return null;
      requireRecoverableEditorText(editor);
      if (!editor.entry || editor.entry.state !== "draft") return editor.entry ?? null;
      const entry = editor.entry;
      const timerKey = draftTimerKey(entry);
      const timer = draftTimersRef.current.get(timerKey);
      if (timer) window.clearTimeout(timer);
      draftTimersRef.current.delete(timerKey);
      await draftQueueRef.current;

      const currentEditor = workRef.current?.editor;
      if (currentEditor) requireRecoverableEditorText(currentEditor);
      const pending = pendingDraftsRef.current.get(timerKey);
      const target = pending && pending.operation.generation > entry.operation.generation ? pending : currentEditor?.entry ?? entry;
      if (currentEditor && target.text !== currentEditor.text) {
        throw new Error(currentEditor.journalError || "現在の入力とブラウザー回復記録が一致しないため、移動できません。");
      }
      if (target.state !== "draft") return target;
      const currentIsTarget = currentEditor?.entry?.operation.id === target.operation.id && currentEditor.entry.operation.generation === target.operation.generation;
      if (currentIsTarget && currentEditor.draftStored && !pendingDraftsRef.current.has(timerKey)) return target;

      const stored = await persistDraft(target);
      if (!stored) throw new Error(workRef.current?.editor?.journalError || "下書きをブラウザーに保存できませんでした。");
      const latest = workRef.current?.editor;
      if (latest) requireRecoverableEditorText(latest);
      if (latest?.entry?.state === "draft" && draftTimerKey(latest.entry) === timerKey &&
          (!latest.draftStored || pendingDraftsRef.current.has(timerKey))) continue;
      return latest?.entry ?? target;
    }
    throw new Error("下書きの入力が続いているため、移動前に保存できませんでした。入力を止めてもう一度お試しください。");
  }

  async function switchMode(): Promise<boolean> {
    const nextMode: UiMode = mode === "desktop" ? "mobile" : "desktop";
    try {
      const composedText = await editorFlushRef.current();
      const activeEditor = workRef.current?.editor;
      if (composedText !== null && activeEditor && composedText !== activeEditor.text) editText(composedText);
      recentResume.flush();
      await flushDraft();
      if (!rememberUiMode(nextMode)) throw new Error("画面の選択をこのブラウザーに保存できませんでした。");
      const resource = resourceForWork(workRef.current) ?? parseApplicationLocation(`${window.location.pathname}${window.location.search}`)?.resource ?? null;
      const currentPath = applicationPath(mode, resource, window.location.search);
      const nextPath = switchApplicationPath(currentPath, nextMode);
      window.location.assign(nextPath);
      return true;
    } catch (error) {
      setStatus({ message: `画面を切り替える前に下書きを保存してください。${messageOf(error)}`, kind: "error" });
      return false;
    }
  }

  async function checkpointEntry(
    projectId: string,
    entry: JournalEntry,
    onCheckpointing?: (entry: JournalEntry) => void,
    expectedNavigation?: number,
  ): Promise<JournalEntry> {
    const currentJournal = journalRef.current;
    if (!currentJournal) throw new Error("ブラウザー回復ストレージを開けません。");
    if (entry.authorScope !== authorScopeRef.current) throw new Error("別の作者スコープの記録はチェックポイントできません。");
    const operation = entry.operation;
    const proposalId = entry.proposalId ?? proposalIdFor(operation);
    const checkpointing = await currentJournal.updateState({
      ...entry,
      proposalId,
      authorizedAt: entry.authorizedAt ?? Date.now(),
    }, "checkpointing");
    if (checkpointing.state === "conflict") throw new Error("競合した回復記録はチェックポイントできません。");
    await refreshJournal(checkpointing.repository, expectedNavigation);
    onCheckpointing?.(checkpointing);
    const proposal = await api.propose(projectId, {
      id: proposalId,
      snapshot: checkpointing.snapshot,
      operations: [operation],
      source: "author",
    });
    await currentJournal.putProposal(checkpointing.repository, authorScopeRef.current, proposal);
    await currentJournal.updateState({ ...checkpointing, proposalId: proposal.id }, "checkpointing");
    await api.approve(projectId, { proposalId: proposal.id, operationIds: [operation.id], authorScope: authorScopeRef.current });
    const receipt = await api.checkpoint(projectId, operation);
    const saved = await currentJournal.updateState({ ...checkpointing, proposalId: proposal.id }, "checkpointed", receipt);
    await currentJournal.removeProposal(checkpointing.repository, authorScopeRef.current, proposal.id).catch(() => undefined);
    return saved;
  }

  async function reloadConflictSnapshot(
    nav: number,
    projectId: string,
    repository: RepositoryIdentity,
    sceneId: string,
    documentPath: string,
    operationId: string,
    generation: number,
  ): Promise<void> {
    const before = workRef.current;
    const beforeEditor = before?.editor;
    if (!isCurrentProject(nav, projectId, repository) || before?.selectedSceneId !== sceneId ||
        beforeEditor?.read.document.path !== documentPath) return;

    const observed = await api.observation(projectId);
    if (!isCurrentProject(nav, projectId, repository)) return;
    if (!sameRepository(observed.snapshot.repository, repository)) {
      throw new Error("登録済みリポジトリの識別情報が変わったため、競合の最新原稿を読み込めませんでした。");
    }
    const remoteChanged = before.observation.snapshot.remoteCommit !== observed.snapshot.remoteCommit;
    const checkpointChanged = before.observation.checkpointHead !== observed.checkpointHead;
    if (remoteChanged || checkpointChanged) {
      await reconcileProject(projectId, repository, authorScopeRef.current, nav);
      if (!isCurrentProject(nav, projectId, repository)) return;
    }
    const tree = await api.readTree(projectId, "remote", observed.snapshot);
    if (!isCurrentProject(nav, projectId, repository)) return;
    if (snapshotKey(tree.snapshot) !== snapshotKey(observed.snapshot)) {
      throw new Error("競合確認中に作品構成と原稿のリモート版が一致しませんでした。");
    }

    const latest = workRef.current;
    const editor = latest?.editor;
    if (latest?.selectedSceneId !== sceneId || editor?.read.document.path !== documentPath) return;
    const preservedEditor: EditorSession = { ...editor, conflict: null };
    updateWork((current) => current?.project.id === projectId && current.selectedSceneId === sceneId &&
        current.editor?.read.document.path === documentPath && sameRepository(current.observation.snapshot.repository, repository)
      ? {
        ...current,
        observation: observed,
        tree,
        loadingScene: true,
        editor: { ...current.editor, conflict: null },
      }
      : current);
    setStatus({ message: "現在のリモート版を取得し、保護された下書きと比較しています…", kind: "normal" });
    await loadScene(projectId, sceneId, tree, repository);
    if (!isCurrentProject(nav, projectId, repository)) return;
    const loaded = workRef.current;
    if (loaded?.selectedSceneId !== sceneId) return;
    if (!loaded.editor) {
      // A failed fresh read must not erase the author copy. Keep recovery visible but
      // with conflict controls unavailable until a canonical remote scene is loaded.
      updateWork((current) => current?.project.id === projectId && current.selectedSceneId === sceneId &&
          current.editor === null && sameRepository(current.observation.snapshot.repository, repository)
        ? { ...current, loadingScene: false, editor: preservedEditor }
        : current);
      return;
    }
    if (loaded.editor.entry?.operation.id === operationId && loaded.editor.entry.operation.generation === generation &&
        loaded.editor.text !== editor.text) {
      setStatus({ message: "リモート版を読み込みましたが、保護された操作本文が一致しません。ブラウザーの回復記録を保持しています。", kind: "error" });
      return;
    }
    await refreshJournal(repository, nav);
  }

  async function checkpointCurrent(): Promise<void> {
    const current = workRef.current;
    const editor = current?.editor;
    const currentJournal = journalRef.current;
    if (!current || current.recoveryStatus !== "ready" || current.loadingScene || current.selectedSceneId !== editor?.read.scene.id || !editor || editor.recoveryStatus !== "ready" || !currentJournal || !editor.entry || busy) return;
    const nav = navigationRef.current;
    const projectId = current.project.id;
    const repository = current.observation.snapshot.repository;
    const documentPath = editor.read.document.path;
    const sceneId = editor.read.scene.id;
    let submittedEntry = editor.entry;
    setBusy("checkpoint");
    try {
      await flushDraft();
      if (!isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) return;
      const latest = workRef.current?.editor;
      if (!latest?.entry || latest.conflict) throw new Error("競合を確認してからチェックポイントを作成してください。");
      const operation = latest.entry.operation;
      const checkpointingEntry = latest.entry;
      submittedEntry = checkpointingEntry;
      const saved = await checkpointEntry(projectId, checkpointingEntry, (checkpointing) => {
        if (!isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) return;
        updateWork((state) => state?.editor?.entry?.operation.id === operation.id && state.editor.entry.operation.generation === operation.generation
        ? { ...state, editor: { ...state.editor, entry: checkpointing } }
        : state);
      }, nav);
      if (!isCurrentProject(nav, projectId, repository)) return;
      updateWork((state) => state?.editor?.entry?.operation.id === operation.id && state.editor.entry.operation.generation === operation.generation
        ? { ...state, editor: { ...state.editor, entry: saved } }
        : state);
      await refreshJournal(saved.repository, nav);
      if (!isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) return;
      setStatus({ message: "ローカルチェックポイントを作成しました。GitHub へ保存するまでブラウザーの回復記録を保持します。", kind: "success" });
      await refreshRemote();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
        let conflictEntry: JournalEntry | null = null;
        try {
          conflictEntry = await currentJournal.updateState(submittedEntry, "conflict");
        } catch (storageError) {
          if (isCurrentProject(nav, projectId, repository)) {
            setStatus({ message: `チェックポイントが競合しましたが、競合状態を回復記録へ保存できませんでした。${messageOf(storageError)}`, kind: "error" });
          }
        }
        if (conflictEntry && isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) {
          updateWork((state) => state?.editor?.entry?.operation.id === submittedEntry.operation.id &&
              state.editor.entry.operation.generation === submittedEntry.operation.generation
            ? { ...state, editor: { ...state.editor, entry: conflictEntry!, text: conflictEntry!.text, conflict: null, draftStored: true } }
            : state);
        }
        if (conflictEntry && isCurrentProject(nav, projectId, repository)) {
          try {
            await reloadConflictSnapshot(nav, projectId, repository, sceneId, documentPath, submittedEntry.operation.id, submittedEntry.operation.generation);
          } catch (refreshError) {
            if (isCurrentProject(nav, projectId, repository)) {
              setStatus({ message: `チェックポイントは競合しました。最新のリモート原稿を確認できませんでした。下書きは回復記録に保持しています。${messageOf(refreshError)}`, kind: "error" });
            }
          }
        }
      }
      if (isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) setStatus({ message: messageOf(error), kind: "error" });
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }

  async function checkpointScratchEntry(entry: JournalEntry): Promise<void> {
    const current = workRef.current;
    const currentJournal = journalRef.current;
    if (!current || current.recoveryStatus !== "ready" || !currentJournal || current.editor?.recoveryStatus !== "ready" || current.loadingScene) throw new Error("作品またはブラウザー回復ストレージを利用できません。");
    if (busy) throw new Error("別の保存処理が進行中です。");
    const nav = navigationRef.current;
    const projectId = current.project.id;
    const repository = current.observation.snapshot.repository;
    setBusy("checkpoint");
    try {
      await scratchFlushRef.current();
      if (!isCurrentProject(nav, projectId, repository)) throw new Error("作品を切り替えたため、スクラッチの保存表示を更新できませんでした。");
      const candidates = await currentJournal.getDocument(entry.repository, entry.documentPath, authorScopeRef.current);
      const latest = [...candidates].reverse().find((candidate) => candidate.operation.id === entry.operation.id);
      if (!latest || latest.state !== "draft") throw new Error("このスクラッチは Draft 状態ではなくなりました。回復一覧を更新してください。");
      const saved = await checkpointEntry(projectId, latest, undefined, nav);
      if (!isCurrentProject(nav, projectId, repository)) return;
      await refreshJournal(saved.repository, nav);
      if (!isCurrentProject(nav, projectId, repository)) return;
      setStatus({ message: "スクラッチのローカルチェックポイントを作成しました。Save to GitHub で公開できます。", kind: "success" });
      await refreshRemote();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
        await currentJournal.updateState(entry, "conflict").catch(() => undefined);
      }
      await refreshJournal(entry.repository, nav);
      if (isCurrentProject(nav, projectId, repository)) setStatus({ message: messageOf(error), kind: "error" });
      throw error;
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }

  async function publishPending(): Promise<void> {
    const current = workRef.current;
    const currentJournal = journalRef.current;
    if (!current || !currentJournal || busy) return;
    const nav = navigationRef.current;
    const projectId = current.project.id;
    const initialRepository = current.observation.snapshot.repository;
    const syncEditorEntryState = (previous: JournalEntry, updated: JournalEntry): void => {
      updateWork((latest) => {
        const editor = latest?.editor;
        const entry = editor?.entry;
        if (!latest || !editor || !entry || entry.operation.id !== previous.operation.id ||
            entry.operation.generation !== previous.operation.generation || entry.authorScope !== previous.authorScope ||
            editor.read.document.path !== previous.documentPath || editor.read.scene.id !== previous.sceneId ||
            !sameRepository(latest.observation.snapshot.repository, previous.repository)) return latest;
        return { ...latest, editor: { ...editor, entry: updated } };
      });
    };
    setBusy("publish");
    try {
      await scratchFlushRef.current();
      if (!isCurrentProject(nav, projectId, initialRepository)) return;
      const observed = await api.observation(projectId);
      const repository = observed.snapshot.repository;
      if (!isCurrentProject(nav, projectId, initialRepository) || !sameRepository(repository, initialRepository)) return;
      await api.reconcile(projectId);
      if (!isCurrentProject(nav, projectId, initialRepository)) return;
      const proposalStatuses = await api.proposalStatuses(projectId);
      if (!isCurrentProject(nav, projectId, initialRepository)) return;
      const alreadyPublished = new Set(proposalStatuses.proposals.flatMap((item) => item.publishedOperationIds ?? []));
      const local = await currentJournal.getRepository(repository, authorScopeRef.current);
      const eligible = local.filter((entry) => (entry.state === "checkpointed" || entry.state === "publication_unknown") && !alreadyPublished.has(entry.operation.id));
      if (eligible.length === 0) throw new Error("GitHub へ保存するチェックポイントがありません。");
      const groups = new Map<string, JournalEntry[]>();
      for (const entry of eligible) {
        const batch = entry.publicationBatchId ?? "";
        const group = groups.get(batch) ?? [];
        group.push(entry);
        groups.set(batch, group);
      }
      for (const [existingBatch, group] of groups) {
        const batchId = existingBatch || crypto.randomUUID();
        for (const entry of group) {
          const pending = await currentJournal.updateState({ ...entry, publicationBatchId: batchId }, "publication_unknown");
          syncEditorEntryState(entry, pending);
        }
        const receipt = await api.publish(projectId, batchId);
        if (receipt.state === "confirmed") {
          await currentJournal.acknowledge(repository, authorScopeRef.current, receipt);
        } else if (receipt.state === "conflict") {
          for (const entry of group) {
            const conflict = await currentJournal.updateState({ ...entry, publicationBatchId: batchId }, "conflict");
            syncEditorEntryState(entry, conflict);
          }
          throw new Error("GitHub に別の更新がありました。チェックポイントは保持し、競合を確認してください。");
        } else {
          if (isCurrentProject(nav, projectId, repository)) setStatus({ message: "GitHub への保存結果を確認できませんでした。同じバッチ ID を保持して再確認します。", kind: "error" });
          await refreshJournal(repository, nav);
          return;
        }
      }
      await refreshJournal(repository, nav);
      if (!isCurrentProject(nav, projectId, repository)) return;
      await refreshRemote();
      if (isCurrentProject(nav, projectId, repository)) setStatus({ message: "GitHub への保存を確認しました。確認済みの操作だけ回復記録から削除しました。", kind: "success" });
    } catch (error) {
      if (isCurrentProject(nav, projectId, initialRepository)) setStatus({ message: messageOf(error), kind: "error" });
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }

  async function rebaseDraft(): Promise<void> {
    const current = workRef.current;
    const editor = current?.editor;
    if (!current || current.recoveryStatus !== "ready" || !editor || editor.recoveryStatus !== "ready" || current.loadingScene || !editor.conflict || !journalRef.current) return;
    if (editor.entry && editor.entry.state !== "draft") {
      setStatus({ message: "チェックポイント済みの競合は自動で結び直せません。比較を保ったまま Core の再調整結果を確認してください。", kind: "error" });
      return;
    }
    const nextBase = editor.conflict;
    const id = editor.entry?.operation.id ?? crypto.randomUUID();
    const generation = Math.max(generationRef.current, editor.entry?.operation.generation ?? 0) + 1;
    generationRef.current = generation;
    try {
      const operation = buildOperation(nextBase, editor.text, id, generation);
      const nextEntry = makeEntry(nextBase.snapshot.repository, authorScopeRef.current, nextBase.scene.id, nextBase, editor.text, nextBase.scene.text, operation, "draft");
      updateWork((state) => state?.editor ? {
        ...state,
        editor: { ...state.editor, read: nextBase, remote: nextBase, baseText: nextBase.scene.text, entry: nextEntry, conflict: null, draftStored: false },
      } : state);
      if (!await persistDraft(nextEntry)) throw new Error("比較した下書きが IndexedDB に保存できませんでした。");
      setStatus({ message: "比較した下書きを最新の原稿に結び直しました。", kind: "success" });
    } catch (error) {
      setStatus({ message: messageOf(error), kind: "error" });
    }
  }

  async function restoreRemote(): Promise<void> {
    const current = workRef.current;
    const editor = current?.editor;
    const currentJournal = journalRef.current;
    if (!current || current.recoveryStatus !== "ready" || !editor || editor.recoveryStatus !== "ready" || current.loadingScene || !editor.conflict || !currentJournal) return;
    if (editor.entry && editor.entry.state !== "draft") {
      setStatus({ message: "チェックポイント済みの操作はブラウザーから削除できません。", kind: "error" });
      return;
    }
    if (!window.confirm("未チェックポイントの下書きを削除して、現在の GitHub 版に戻しますか？")) return;
    const nav = navigationRef.current;
    const projectId = current.project.id;
    const repository = editor.read.snapshot.repository;
    const documentPath = editor.read.document.path;
    const sceneId = editor.read.scene.id;
    try {
      await currentJournal.removeDrafts(repository, documentPath, authorScopeRef.current);
      if (!isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) return;
      const remote = editor.conflict;
      updateWork((state) => state?.editor ? {
        ...state,
        editor: { ...state.editor, read: remote, remote, text: remote.scene.text, baseText: remote.scene.text, entry: null, conflict: null, draftStored: true, journalError: "" },
      } : state);
      await refreshJournal(repository, nav);
      if (isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) setStatus({ message: "保護対象外の下書きを削除して、GitHub 版に戻しました。", kind: "success" });
    } catch (error) {
      if (isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) setStatus({ message: messageOf(error), kind: "error" });
    }
  }

  async function mapLegacyDraft(record: LegacyDraftRecord): Promise<void> {
    const current = workRef.current;
    const editor = current?.editor;
    const currentJournal = journalRef.current;
    if (!current || current.recoveryStatus !== "ready" || !editor || editor.recoveryStatus !== "ready" || current.loadingScene || current.selectedSceneId !== editor.read.scene.id || !currentJournal) return;
    const accepted = window.confirm(
      `この古い記録を現在選択中の作品「${projectLabel(current.project)}」の「${editor.read.scene.title}」へ下書きとして移しますか？本文は Git に送信されません。`,
    );
    if (!accepted) return;
    const nav = navigationRef.current;
    const projectId = current.project.id;
    const repository = current.observation.snapshot.repository;
    const documentPath = editor.read.document.path;
    const sceneId = editor.read.scene.id;
    try {
      const prior = await currentJournal.getDocument(repository, documentPath, authorScopeRef.current);
      const existing = prior.at(-1);
      const id = existing?.state === "draft" ? existing.operation.id : crypto.randomUUID();
      const generation = Math.max(generationRef.current, existing?.operation.generation ?? 0) + 1;
      const operation = buildOperation(editor.read, record.text, id, generation);
      const entry = makeEntry(repository, authorScopeRef.current, sceneId, editor.read, record.text, editor.read.scene.text, operation, "draft");
      if (!await currentJournal.putLatestDraft(entry)) throw new Error("新しい回復記録があるため、この古い下書きは移しませんでした。");
      localStorageIfAvailable()?.removeItem(record.key);
      generationRef.current = generation;
      setLegacyDrafts(readLegacyDrafts());
      if (isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) updateWork((state) => state?.editor ? {
        ...state,
        editor: { ...state.editor, text: record.text, baseText: editor.read.scene.text, entry, conflict: null, draftStored: true, journalError: "" },
      } : state);
      await refreshJournal(repository, nav);
      if (isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) setStatus({ message: "古い下書きをこの作品の IndexedDB 回復記録へ移しました。Git への変更はありません。", kind: "success" });
    } catch (error) {
      if (isCurrentEditor(nav, projectId, repository, documentPath, sceneId)) setStatus({ message: `古い下書きを移せませんでした。元の記録は残しています。${messageOf(error)}`, kind: "error" });
    }
  }

  function exportLegacyDrafts(): void {
    const blob = new Blob([JSON.stringify(legacyDrafts, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "scriptorium-legacy-drafts.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  function requestPanel(id: string): void {
    setPanelRequest((previous) => ({ id, sequence: (previous?.sequence ?? 0) + 1 }));
  }

  function toggleHistory(): void {
    setHistoryOpen(true);
    requestPanel("history");
  }

  async function prepareLayoutChange(): Promise<boolean> {
    try {
      const composedText = await editorFlushRef.current();
      const current = workRef.current?.editor;
      if (composedText !== null && current && composedText !== current.text) editText(composedText);
      recentResume.flush();
      await flushDraft();
      return true;
    } catch (error) {
      setStatus({ message: `パネルを変更する前に下書きを保存してください。${messageOf(error)}`, kind: "error" });
      return false;
    }
  }

  function continueFrom(candidate: ReturnType<typeof mergeContinueCandidates>[number], reading = false): void {
    const current = workRef.current;
    if (!current || !sceneExistsInTree(current.tree.tree, candidate.sceneId)) return;
    const navigation = navigationRef.current;
    const targetRepositoryKey = repositoryKey(current.observation.snapshot.repository);
    const id = ++resumeRequestSequenceRef.current;
    setResumeRequest({
      id,
      repositoryKey: targetRepositoryKey,
      sceneId: candidate.sceneId,
      cursorSentenceIndex: candidate.sentenceOffset,
      scrollTop: candidate.scrollTop ?? 0,
      ...(reading && candidate.pageIndex !== null ? { pageIndex: candidate.pageIndex } : {}),
    });
    if (current.selectedSceneId === candidate.sceneId && current.editor?.read.scene.id === candidate.sceneId && !current.loadingScene) {
      requestEditorAfterExplicitLoad(current.project.id, candidate.sceneId, navigation, sceneLoadRef.current);
      return;
    }
    loadSceneForExplicitNavigation(current.project.id, candidate.sceneId, current.tree, current.observation.snapshot.repository, navigation);
  }

  function selectSceneFromOutline(sceneId: string): void {
    const current = workRef.current;
    if (!current) return;
    loadSceneForExplicitNavigation(current.project.id, sceneId, current.tree, current.observation.snapshot.repository, navigationRef.current);
  }

  function loadSceneForExplicitNavigation(
    projectId: string,
    sceneId: string,
    tree: TreeRead,
    repository: RepositoryIdentity,
    navigation: number,
  ): void {
    const sceneRequest = sceneLoadRef.current + 1;
    void loadScene(projectId, sceneId, tree, repository)
      .then(() => requestEditorAfterExplicitLoad(projectId, sceneId, navigation, sceneRequest));
  }

  function requestEditorAfterExplicitLoad(projectId: string, sceneId: string, navigation: number, sceneRequest: number): void {
    const current = workRef.current;
    if (navigationRef.current !== navigation || sceneLoadRef.current !== sceneRequest ||
        current?.project.id !== projectId || current.selectedSceneId !== sceneId) return;
    requestPanel("editor");
  }

  function completeResumeRequest(requestId: number): void {
    setResumeRequest((current) => current?.id === requestId ? null : current);
  }

  const currentRepoEntries = useMemo(() => work ? entries.filter((entry) => sameRepository(entry.repository, work.observation.snapshot.repository)) : [], [entries, work]);
  const currentRepoProposals = useMemo(() => work ? proposals.filter((proposal) => sameRepository(proposal.repository, work.observation.snapshot.repository)) : [], [proposals, work]);
  const renderedNavigation = navigationRef.current;
  const publishedOperationIds = useMemo(() => new Set(currentRepoProposals.flatMap((record) => record.status?.publishedOperationIds ?? [])), [currentRepoProposals]);
  const pendingCount = currentRepoEntries.filter((entry) => entry.state !== "draft" && !publishedOperationIds.has(entry.operation.id)).length;
  const recoverableEntries = useMemo(() => entries.filter((entry) => entry.state === "draft" || entry.state === "checkpointing" || entry.state === "checkpointed" || entry.state === "publication_unknown" || entry.state === "conflict"), [entries]);
  const tree = work?.tree.tree ?? null;
  const scene = work?.editor?.read.scene ?? null;
  const editor = work?.editor ?? null;
  const editorRecoveryStatus: EditorRecoveryStatus = work?.recoveryStatus === "unavailable" || editor?.recoveryStatus === "unavailable"
    ? "unavailable"
    : work?.recoveryStatus === "pending" || editor?.recoveryStatus === "pending"
      ? "pending"
      : "ready";
  const editorWritable = Boolean(editor && work && mayWriteEditor({
    hasWritePermission: canWrite,
    recoveryStatus: editorRecoveryStatus,
    loadingScene: work.loadingScene,
    selectedSceneId: work.selectedSceneId,
    editorSceneId: editor.read.scene.id,
  }));
  const canCheckpoint = Boolean(editorWritable && editor?.entry && (editor.entry.state === "draft" || editor.entry.state === "checkpointing") && editor.draftStored && !editor.conflict && editor.text !== editor.read.scene.text && !busy);
  const canResolveDraft = Boolean(editorWritable && editor?.conflict && (!editor.entry || editor.entry.state === "draft"));
  const canPublish = canWrite && pendingCount > 0 && currentRepoEntries.some((entry) => (entry.state === "checkpointed" || entry.state === "publication_unknown") && !publishedOperationIds.has(entry.operation.id)) && !busy;
  const continueCandidates = work && tree && recentResume.projectKey === JSON.stringify([authorScope, activeRepositoryKey, work.project.id])
    ? mergeContinueCandidates(recentResume.localWriting, recentResume.items, tree).slice(0, 2)
    : [];

  // A checkpoint overlay is part of every optional consumer's immutable context.
  const panelSnapshot = !work?.loadingScene && editor ? editor.read.snapshot : work?.tree.snapshot;
  const panelSnapshotKey = panelSnapshot ? snapshotKey(panelSnapshot) : "";
  const panelProjectId = work?.project.id ?? "";
  const enabledPanels = workspaceContributions(contributions, modules);
  const termAdornments = contributions.filter((item) => item.kind === "editor-adornment" &&
    item.contexts?.includes("editor") && modules.some((module) => module.id === item.module &&
      (module.availability === "active" || module.availability === "enabled-idle")));
  const termAdornmentKey = JSON.stringify(termAdornments.map((item) => [item.module, item.id, item.action]));
  const resolveTerms = useCallback(async (text: string, signal: AbortSignal): Promise<readonly EditorTermSpan[]> => {
    if (termAdornments.length === 0 || !panelSnapshot || signal.aborted) return [];
    const results = await Promise.allSettled(termAdornments.map((item) =>
      api.action(panelProjectId, item.action, { text }, signal, panelSnapshot)));
    const current = workRef.current;
    const currentSnapshot = !current?.loadingScene && current?.editor ? current.editor.read.snapshot : current?.tree.snapshot;
    if (signal.aborted || !current || current.project.id !== panelProjectId || !currentSnapshot ||
        snapshotKey(currentSnapshot) !== panelSnapshotKey) return [];
    return results.flatMap((outcome) => {
      if (outcome.status !== "fulfilled" || !outcome.value.ok || snapshotKey(outcome.value.snapshot) !== panelSnapshotKey) return [];
      const data = outcome.value.data as { spans?: EditorTermSpan[] };
      return Array.isArray(data?.spans) ? data.spans : [];
    });
  }, [panelProjectId, panelSnapshotKey, termAdornmentKey]);

  const navigateDocument = useCallback(async (documentPath: string): Promise<void> => {
    assertProjectPath(documentPath);
    const current = workRef.current;
    const currentSnapshot = !current?.loadingScene && current?.editor ? current.editor.read.snapshot : current?.tree.snapshot;
    if (!current || !panelSnapshot || current.project.id !== panelProjectId || !currentSnapshot ||
        snapshotKey(currentSnapshot) !== panelSnapshotKey) throw new Error("パネルのスナップショットが更新されています。");
    const nav = navigationRef.current;
    const result = await api.action(current.project.id, "core.document.resolve", { path: documentPath }, undefined, panelSnapshot);
    const latest = workRef.current;
    const latestSnapshot = !latest?.loadingScene && latest?.editor ? latest.editor.read.snapshot : latest?.tree.snapshot;
    if (!latest || latest.project.id !== panelProjectId || navigationRef.current !== nav || !latestSnapshot ||
        snapshotKey(latestSnapshot) !== panelSnapshotKey || snapshotKey(result.snapshot) !== panelSnapshotKey) return;
    if (!result.ok) throw new Error(result.error.message);
    const data = result.data as { sceneId: string | null; document?: { path: string; content: string; revision: string } | null };
    if (data.sceneId && sceneExistsInTree(latest.tree.tree, data.sceneId)) {
      await loadScene(latest.project.id, data.sceneId, latest.tree, latest.observation.snapshot.repository);
      requestPanel("editor");
    } else if (data.document?.path === documentPath && typeof data.document.content === "string") {
      setInspectedDocument({ ...data.document, snapshot: panelSnapshot });
      requestPanel("inspector");
    } else {
      setStatus({ message: "リンク先の文書はこのスナップショットでは利用できません。", kind: "normal" });
    }
  }, [loadScene, panelProjectId, panelSnapshotKey]);

  const onTermNavigate = useCallback((path: string) => {
    void navigateDocument(path).catch((error) => setStatus({ message: messageOf(error), kind: "error" }));
  }, [navigateDocument]);

  if (authState === "checking") return <main className="loading" role="status">Scriptorium を開いています…</main>;
  if (authState === "signed-out") {
    return (
      <main className="login-panel">
        <p className="eyebrow">Scriptorium · 執筆ワークスペース</p>
        {hostedMode ? <>
          <h1>Praetorium から開いてください</h1>
          <p>この Hosted ワークスペースへのアクセスは Praetorium が管理しています。</p>
          <button type="button" onClick={() => window.location.assign("/_platform/reauth")}>Praetorium でアクセスを更新</button>
        </> : <>
          <h1>ログイン</h1>
          <p>登録済みのアクセス資格情報で作品を開きます。</p>
          <form onSubmit={(event) => void signIn(event)}>
            <label htmlFor="auth-token">アクセストークン</label>
            <input id="auth-token" type="password" autoComplete="current-password" minLength={32} value={token} onChange={(event) => setToken(event.currentTarget.value)} required />
            <button type="submit">ログイン</button>
            {loginError && <p className="status" data-kind="error" role="alert">{loginError}</p>}
          </form>
        </>}
        {journalOpenError && <p className="status" data-kind="error" role="alert">{journalOpenError}</p>}
      </main>
    );
  }

  const header = (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Scriptorium ホーム">Scriptorium</a>
      <JobInbox canWrite={canWrite} />
      <ThemeControl mode={themeMode} onChange={onThemeChange} error={themeError} />
      <button type="button" className="quiet-button" onClick={() => void signOut()}>ログアウト</button>
    </header>
  );

  const library = (
    <aside className="sidebar" aria-label="作品と構成">
      {!hostedMode && <form onSubmit={(event) => void registerProject(event)} className="project-form">
        <h2>作品を追加</h2>
        <label htmlFor="repo-url">GitHub リポジトリ URL</label>
        <input id="repo-url" name="url" type="url" placeholder="https://github.com/owner/work" required />
        <button type="submit" disabled={busy === "register"}>{busy === "register" ? "登録中…" : "リポジトリを登録"}</button>
      </form>}
      <section className="project-list-section" aria-labelledby="projects-title">
        <h2 id="projects-title">作品</h2>
        <ul className="plain-list">
          {projects.map((project) => (
            <li key={project.id}>
              <button type="button" className="project-button" aria-current={work?.project.id === project.id ? "true" : "false"} onClick={() => void activateProject(project)}>
                {projectLabel(project)}
              </button>
            </li>
          ))}
          {projects.length === 0 && <li className="muted-list-item">登録された作品はありません</li>}
        </ul>
      </section>
      {work && !hostedMode && (
        <section className="project-management" aria-labelledby="project-management-title">
          <h2 id="project-management-title">選択中のリポジトリ</h2>
          <dl className="project-facts">
            <div><dt>URL</dt><dd><code>{work.project.url}</code></dd></div>
            <div><dt>リポジトリ ID</dt><dd><code>{work.observation.snapshot.repository.provider}:{work.observation.snapshot.repository.repositoryId}</code></dd></div>
            <div><dt>既定ブランチ</dt><dd><code>{work.observation.snapshot.repository.defaultBranch}</code></dd></div>
            <div><dt>登録ブランチ</dt><dd><code>{work.project.branch}</code></dd></div>
            <div><dt>確認したリモート</dt><dd><code>{work.observation.snapshot.remoteCommit.slice(0, 12)}</code></dd></div>
          </dl>
          <p className="project-management-help">再構築と解除はローカル作業領域だけに適用されます。未公開の変更がある場合は Core が拒否し、回復記録は保持します。</p>
          <div className="project-management-actions">
            <button type="button" className="compact-button" disabled={Boolean(busy)} onClick={() => void reconstructActiveProject()}>
              {busy === "reconstruct" ? "再構築中…" : "ローカルクローンを再構築"}
            </button>
            <button type="button" className="compact-button danger-button" disabled={Boolean(busy)} onClick={() => void detachActiveProject()}>
              {busy === "detach" ? "解除中…" : "作品の登録を解除"}
            </button>
          </div>
          {projectActionError?.projectId === work.project.id && (
            <p className="status" data-kind="error" data-code={projectActionError.code} role="alert">
              {projectActionError.message}{projectActionError.code ? ` (${projectActionError.code})` : ""}
            </p>
          )}
        </section>
      )}
      {work && tree && (
        <ContinuePanel
          candidates={continueCandidates}
          tree={tree}
          deviceType={recentResume.deviceType}
          error={recentResume.error}
          onContinue={(candidate) => continueFrom(candidate)}
          onRead={(candidate) => continueFrom(candidate, true)}
        />
      )}
      {tree && <TreeNav tree={tree} selectedSceneId={work?.selectedSceneId ?? ""} disabled={Boolean(busy)} onSelect={selectSceneFromOutline} />}
      {legacyDrafts.length > 0 && <LegacyRecoveryPanel drafts={legacyDrafts} selectedSceneId={work && !work.loadingScene && work.editor?.read.scene.id === work.selectedSceneId ? work.selectedSceneId : ""} onExport={exportLegacyDrafts} onMap={(draft) => void mapLegacyDraft(draft)} />}
      {!work && recoverableEntries.length > 0 && (
        <section className="recovery-panel" aria-labelledby="recovery-title">
          <h2 id="recovery-title">ブラウザーの回復記録</h2>
          <p>同じリポジトリを再登録すると、次の原稿を引き継げます。</p>
          <RecoveryList entries={recoverableEntries} />
        </section>
      )}
    </aside>
  );

  const statusSlot = (
    <div className="application-status">
      <div className="topbar-status" role="status" aria-live="polite" data-kind={status.kind}>{status.message || "作品を選択してください"}</div>
      {globalError && <p className="status" data-kind="error" role="alert">{globalError}</p>}
      {journalOpenError && <p className="status" data-kind="error" role="alert">{journalOpenError}</p>}
      {isolatedRecoveryCount > 0 && <p className="status" role="status">別の作者スコープまたは未割り当ての回復記録 {isolatedRecoveryCount} 件を保持しています。現在のセッションには復元しません。</p>}
      {work?.observation.state !== "fresh" && work && <p className="status" data-kind="error" role="alert">リモート確認状態: {work.observation.state}。最後に確認できた原稿を表示しています。</p>}
    </div>
  );

  const editorSlot = (
    <>
      {!work && (
        <section className="empty-state">
          <p className="eyebrow">読む・書く・育てる</p>
          <h1>Scriptorium</h1>
          <p>Git リポジトリを登録すると、原稿を確認しながら安全に書き進められます。</p>
          {recoverableEntries.length > 0 && <><h2>保存された回復記録</h2><RecoveryList entries={recoverableEntries} /></>}
        </section>
      )}
      {work && work.loadingScene && <p className="loading" role="status">スナップショットを読み込んでいます…</p>}
      {work && !scene && !work.loadingScene && <div className="empty-state"><h1>{tree?.title ?? projectLabel(work.project)}</h1><p>左側の作品構成からシーンを選んでください。</p></div>}
      {editor && scene && work && (
        <div data-recovery-status={editorRecoveryStatus} data-editor-writable={editorWritable ? "true" : "false"}>
        {editorRecoveryStatus === "pending" && <p className="status" role="status">ブラウザー回復記録を確認しています。確認が終わるまで編集を一時停止しています。</p>}
        <SceneEditor
          key={JSON.stringify([authorScope, repositoryKey(editor.read.snapshot.repository), editor.read.document.path, canWrite])}
          projectId={work.project.id}
          authorScope={authorScope}
          repositoryKey={repositoryKey(editor.read.snapshot.repository)}
          snapshot={editor.read.snapshot}
          historySnapshot={work.observation.snapshot}
          scene={scene}
          path={editor.read.document.path}
          breadcrumb={breadcrumbFor(tree, scene.id)}
          text={editor.text}
          readOnly={!editorWritable}
          onTextChange={editText}
          onCursorPositionChange={recentResume.onWritingPosition}
          onReadingPageChange={recentResume.onReadingPage}
          resumeRequest={resumeRequest}
          onResumeRequestApplied={completeResumeRequest}
          durability={editorDurability(editor)}
          draftStored={editor.draftStored}
          journalError={editor.journalError || journalOpenError}
          conflict={editor.conflict}
          canResolveDraft={canResolveDraft}
          onRebase={() => void rebaseDraft()}
          onRestoreRemote={() => void restoreRemote()}
          canCheckpoint={canCheckpoint}
          checkpointBusy={busy === "checkpoint"}
          onCheckpoint={() => void checkpointCurrent()}
          canPublish={canPublish}
          publishBusy={busy === "publish"}
          onPublish={() => void publishPending()}
          onHistory={() => void toggleHistory()}
          historyOpen={historyOpen}
          historyExternal
          resolveTerms={termAdornments.length > 0 && editorRecoveryStatus === "ready" ? resolveTerms : undefined}
          onTermNavigate={onTermNavigate}
          onRestoreHistoryBody={editText}
          scratchEntries={currentRepoEntries.filter((entry) => entry.documentPath.startsWith("meta/scratch/"))}
          onDraftScratch={persistScratchDraft}
          onCheckpointScratch={checkpointScratchEntry}
          registerScratchFlush={registerScratchFlush}
          registerNavigationFlush={registerNavigationFlush}
          scratchBusy={Boolean(busy)}
          pendingCount={pendingCount}
        />
        </div>
      )}
    </>
  );

  const toolsSlot = (
    <div className="shared-tools">
      {journal && currentRepoProposals.length > 0 && work && (
        <ProposalReview
          key={repositoryKey(work.observation.snapshot.repository)}
          projectId={work.project.id}
          repository={work.observation.snapshot.repository}
          authorScope={authorScope}
          journal={journal}
          proposals={currentRepoProposals}
          canWrite={canWrite}
          onChange={() => {
            if (isCurrentProject(renderedNavigation, work.project.id, work.observation.snapshot.repository)) {
              void importRemoteProposals(work.project.id, work.observation.snapshot.repository, authorScope, renderedNavigation);
            }
          }}
          onStatus={(message, kind) => {
            if (isCurrentProject(renderedNavigation, work.project.id, work.observation.snapshot.repository)) setStatusMessage(message, kind);
          }}
        />
      )}
      {currentRepoProposals.length === 0 && <p>確認待ちの提案はありません。</p>}
    </div>
  );

  const inspectorSlot = <section aria-label="文書と保存状態">
    {statusSlot}
    {editor && <dl className="project-facts">
      <div><dt>原稿</dt><dd><code>{editor.read.document.path}</code></dd></div>
      <div><dt>スナップショット</dt><dd><code>{editor.read.snapshot.overlayCommit ?? editor.read.snapshot.remoteCommit}</code></dd></div>
      <div><dt>ブラウザー回復</dt><dd>{editorRecoveryStatus}</dd></div>
    </dl>}
    {inspectedDocument && panelSnapshotKey === snapshotKey(inspectedDocument.snapshot) && <article>
      <h3>{inspectedDocument.path}</h3><pre className="workspace-document-source">{inspectedDocument.content}</pre>
    </article>}
    <RecoveryList entries={currentRepoEntries} />
  </section>;
  const panels = [
    { id: "editor", title: "Editor", render: () => editorSlot },
    { id: "outline", title: "Outline", render: () => library },
    { id: "inspector", title: "Inspector", render: () => inspectorSlot },
    { id: "history", title: "History", render: () => editor && scene && work
      ? <ManuscriptHistoryPanel projectId={work.project.id} manuscriptId={scene.id} sceneId={scene.id}
          snapshot={work.observation.snapshot} currentBody={editor.text}
          onRestore={(body) => { if (editorWritable) editText(body); }} onClose={() => { setHistoryOpen(false); requestPanel("editor"); }} />
      : <p>履歴を表示するシーンを選択してください。</p> },
    { id: "review", title: "Review", render: () => toolsSlot },
    ...enabledPanels.map((item) => ({ id: `module:${item.id}`, title: item.title, render: () => work && panelSnapshot
      ? <WorkspaceContribution item={item} contributions={contributions} modules={modules}
          projectId={work.project.id} authorScope={authorScope} snapshot={panelSnapshot}
          refresh={refreshContributionContext} journal={journal} onProposalStored={refreshProposals}
          readCurrentEditor={readCurrentEditor} navigateDocument={navigateDocument} /> : <p>作品を選択してください。</p> })),
  ];
  return <Shell mode={mode} header={header} library={library} editor={editorSlot} tools={toolsSlot} status={statusSlot}
    workspaceScope={authorScope} panels={panels} requestedPanel={panelRequest}
    statusHasError={status.kind === "error" || Boolean(globalError || journalOpenError)}
    beforeLayoutChange={prepareLayoutChange} onSwitchMode={switchMode} />;
}

function editorDurability(editor: EditorSession): "draft" | "checkpointing" | "checkpointed" | "publication_unknown" | "saved" {
  if (!editor.entry) return "saved";
  if (editor.entry.state === "draft" || editor.entry.state === "conflict") return "draft";
  return editor.entry.state;
}

function breadcrumbFor(tree: Tree | null, sceneId: string): string {
  if (!tree) return "";
  for (const volume of tree.volumes) {
    for (const chapter of volume.chapters) {
      const scene = chapter.scenes.find((item) => item.id === sceneId);
      if (scene) return `${volume.title} / ${chapter.title}`;
    }
  }
  return tree.title;
}

function ContinuePanel({
  candidates,
  tree,
  deviceType,
  error,
  onContinue,
  onRead,
}: {
  candidates: ContinueCandidate[];
  tree: Tree;
  deviceType: RecentActivityDeviceType;
  error: string;
  onContinue: (candidate: ContinueCandidate) => void;
  onRead: (candidate: ContinueCandidate) => void;
}) {
  return (
    <section className="continue-panel" aria-labelledby="continue-title">
      <h2 id="continue-title">続きから</h2>
      {error && <p className="continue-error" role="status">再開位置を同期できません: {error}</p>}
      {candidates.length === 0 ? <p className="muted-list-item">再開できるシーンがまだありません</p> : (
        <ul className="continue-list">
          {candidates.map((candidate, index) => {
            const handoff = candidate.source === "server"
              ? formatHandoffHint(candidate.deviceType, candidate.updatedAt, Date.now(), deviceType)
              : null;
            return (
              <li key={candidate.sceneId}>
                <strong>{sceneTitleInTree(tree, candidate.sceneId)}</strong>
                {handoff && <small>{handoff}</small>}
                <button type="button" className="quiet-button compact-button" onClick={() => onContinue(candidate)}>
                  {index === 0 ? "続きを書く" : "こちらを開く"}
                </button>
                {candidate.pageIndex !== null && (
                  <button type="button" className="quiet-button compact-button" onClick={() => onRead(candidate)}>
                    読書位置を開く
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TreeNav({ tree, selectedSceneId, disabled, onSelect }: { tree: Tree; selectedSceneId: string; disabled: boolean; onSelect: (id: string) => void }) {
  return (
    <nav className="tree" aria-label="作品構成">
      <h2>{tree.title}</h2>
      {tree.volumes.map((volume) => (
        <section className="tree-volume" key={volume.id}>
          <h3>{volume.title}</h3>
          {volume.chapters.map((chapter) => (
            <details key={chapter.id} open>
              <summary>{chapter.title}</summary>
              <ul className="scene-list">
                {chapter.scenes.map((scene) => (
                  <li key={scene.id}>
                    <button type="button" className="scene-button" aria-current={selectedSceneId === scene.id ? "true" : "false"} disabled={disabled} onClick={() => onSelect(scene.id)}>
                      {chapter.title}: {scene.title}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      ))}
    </nav>
  );
}

function RecoveryList({ entries }: { entries: JournalEntry[] }) {
  return (
    <ul className="recovery-list">
      {entries.map((entry) => (
        <li key={entry.key}>
          <strong>{entry.documentPath}</strong>
          <span>{entry.state} · {new Date(entry.updatedAt).toLocaleString("ja-JP")}</span>
          <small>{entry.repository.url} · {entry.repository.defaultBranch}</small>
        </li>
      ))}
    </ul>
  );
}

function LegacyRecoveryPanel({
  drafts,
  selectedSceneId,
  onExport,
  onMap,
}: {
  drafts: LegacyDraftRecord[];
  selectedSceneId: string;
  onExport: () => void;
  onMap: (draft: LegacyDraftRecord) => void;
}) {
  return (
    <section className="recovery-panel" aria-labelledby="legacy-recovery-title">
      <h2 id="legacy-recovery-title">旧ブラウザー下書き</h2>
      <p>プロジェクト ID に結び付いた古い下書きです。移行先が確認できるまで元の記録を残します。</p>
      <ul className="recovery-list">
        {drafts.map((draft) => (
          <li key={draft.key}>
            <strong>シーン {draft.sceneId}</strong>
            <span>{draft.text.length} 字 · {new Date(draft.savedAt).toLocaleString("ja-JP")}</span>
            {selectedSceneId && <button type="button" className="quiet-button" onClick={() => onMap(draft)}>選択中のシーンに下書きとして移す</button>}
          </li>
        ))}
      </ul>
      <button type="button" className="quiet-button" onClick={onExport}>回復 JSON をダウンロード</button>
    </section>
  );
}
