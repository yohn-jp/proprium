import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  assertChangeOperation,
  assertProjectPath,
  snapshotKey,
  type ChangeOperation,
  type ChangeProposal,
  type ModuleStatus,
  type RemoteObservation,
  type RepositoryIdentity,
  type SnapshotId,
  type UiContribution,
} from "@scriptorium/contracts";
import { ApiError, api, type Commit, type Project, type SceneRead, type Tree, type TreeRead } from "./api";
import { ContributionHost } from "./contributions/ContributionHost";
import { ProposalReview } from "./contributions/ProposalReview";
import { SceneEditor } from "./editor/SceneEditor";
import { replaceDocumentBody } from "./editor/ruby";
import { clearDraft, loadDraft } from "./drafts";
import {
  BrowserJournal,
  documentKey,
  journalEntryKey,
  repositoryKey,
  requestPersistentStorage,
  type JournalEntry,
  type JournalProposal,
} from "./storage/journal";

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
}

interface WorkState {
  project: Project;
  observation: RemoteObservation;
  tree: TreeRead;
  selectedSceneId: string;
  editor: EditorSession | null;
  loadingScene: boolean;
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
    message: `Write scene: ${read.scene.title.replace(/[\r\n]+/gu, " ").slice(0, 120)}`,
  };
  assertChangeOperation(operation);
  return operation;
}

function proposalIdFor(operation: ChangeOperation): string {
  return `author-${operation.id}-${operation.generation}`;
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
): JournalEntry {
  const key = documentKey(repository, read.document.path);
  const entry: JournalEntry = {
    version: 1,
    key: "",
    repositoryKey: repositoryKey(repository),
    documentKey: key,
    authorScope,
    repository,
    documentPath: read.document.path,
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

export function App() {
  const [authState, setAuthState] = useState<"checking" | "signed-out" | "ready">("checking");
  const [authorScope, setAuthorScope] = useState("owner");
  const authorScopeRef = useRef("owner");
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [journal, setJournal] = useState<BrowserJournal | null>(null);
  const [journalOpenError, setJournalOpenError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [work, setWork] = useState<WorkState | null>(null);
  const [status, setStatus] = useState<{ message: string; kind: "normal" | "error" | "success" }>({ message: "", kind: "normal" });
  const [globalError, setGlobalError] = useState("");
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [proposals, setProposals] = useState<JournalProposal[]>([]);
  const [isolatedRecoveryCount, setIsolatedRecoveryCount] = useState(0);
  const [legacyDrafts, setLegacyDrafts] = useState<LegacyDraftRecord[]>([]);
  const [modules, setModules] = useState<ModuleStatus[]>([]);
  const [contributions, setContributions] = useState<UiContribution[]>([]);
  const [history, setHistory] = useState<Commit[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const navigationRef = useRef(0);
  const workRef = useRef<WorkState | null>(null);
  const journalRef = useRef<BrowserJournal | null>(null);
  const draftQueueRef = useRef<Promise<void>>(Promise.resolve());
  const draftTimersRef = useRef(new Map<string, number>());
  const pendingDraftsRef = useRef(new Map<string, JournalEntry>());
  const generationRef = useRef(0);
  const observationBusyRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const sceneLoadRef = useRef(0);
  const recoveredProjectsRef = useRef(new Set<string>());

  const updateWork = useCallback((updater: (current: WorkState | null) => WorkState | null) => {
    const next = updater(workRef.current);
    workRef.current = next;
    setWork(next);
  }, []);

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
        ? allProposals.filter((record) => record.authorScope === authorScopeRef.current && sameRepository(record.repository, repository))
        : allProposals.filter((record) => record.authorScope === authorScopeRef.current);
      setProposals(visibleProposals);
    } catch (error) {
      if (expectedNavigation === undefined || navigationRef.current === expectedNavigation) setGlobalError(messageOf(error));
    }
  }, []);

  const refreshContributionContext = useCallback(() => refreshRef.current(), []);
  const refreshProposals = useCallback(() => {
    const repository = workRef.current?.observation.snapshot.repository;
    if (repository) void refreshJournal(repository);
  }, [refreshJournal]);

  useEffect(() => {
    let cancelled = false;
    void BrowserJournal.open().then(async (opened) => {
      if (cancelled) {
        opened.close();
        return;
      }
      journalRef.current = opened;
      setJournal(opened);
      setLegacyDrafts(readLegacyDrafts());
      await requestPersistentStorage();
      await refreshJournal();
    }).catch((error) => {
      if (!cancelled) setJournalOpenError(messageOf(error));
    });
    void api.session().then(async (session) => {
      if (cancelled) return;
      const scope = session.authorScope || "owner";
      authorScopeRef.current = scope;
      setAuthorScope(scope);
      void refreshJournal();
      setAuthState("ready");
      try {
        const registered = await api.projects();
        if (cancelled) return;
        setProjects(registered);
        const stored = localStorageIfAvailable()?.getItem(ACTIVE_PROJECT_KEY) ?? null;
        const next = registered.find((project) => project.id === stored) ?? registered[0];
        if (next) await activateProject(next, false, scope);
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

  const reconcileProject = useCallback(async (projectId: string, repository: RepositoryIdentity, author: string, expectedNavigation?: number) => {
    const currentJournal = journalRef.current;
    if (!currentJournal) return;
    const persisted = await currentJournal.getRepository(repository, author);
    if (expectedNavigation !== undefined && navigationRef.current !== expectedNavigation) return;
    for (const entry of persisted) {
      if (expectedNavigation !== undefined && navigationRef.current !== expectedNavigation) return;
      if (entry.state !== "checkpointing" && entry.state !== "checkpointed") continue;
      try {
        await replayAuthorizedEntry(projectId, entry, author);
      } catch (error) {
        const conflict = error instanceof ApiError && (error.status === 409 || error.status === 412);
        if (conflict) await currentJournal.updateState(entry, "conflict").catch(() => undefined);
        else if (entry.state === "checkpointed") {
          // The server's acknowledgement stays in the browser journal until recovery can be retried.
        }
      }
    }
    try {
      const reconciled = await api.reconcile(projectId);
      if (expectedNavigation !== undefined && navigationRef.current !== expectedNavigation) return;
      for (const result of reconciled.operations) {
        const match = persisted.find((entry) => entry.operation.id === result.operationId);
        if (!match) continue;
        if (result.state === "conflict") await currentJournal.updateState(match, "conflict");
        else if (result.receipt && (result.state === "replayed" || result.state === "unchanged")) {
          await currentJournal.updateState(match, "checkpointed", result.receipt);
        }
      }
    } catch {
      // Observation and editor reads remain available; reconciliation failures stay visible at their next operation.
    }
    await reloadJournalForWork(repository, expectedNavigation);
  }, [reloadJournalForWork, replayAuthorizedEntry]);

  const loadScene = useCallback(async (projectId: string, sceneId: string, tree: TreeRead, preferredRepository?: RepositoryIdentity) => {
    const sceneRequest = ++sceneLoadRef.current;
    const nav = navigationRef.current;
    try {
      await flushDraft();
    } catch (error) {
      if (navigationRef.current === nav && sceneLoadRef.current === sceneRequest) setStatus({ message: messageOf(error), kind: "error" });
      return;
    }
    if (navigationRef.current !== nav || sceneLoadRef.current !== sceneRequest) return;
    updateWork((current) => current ? { ...current, selectedSceneId: sceneId, loadingScene: true } : current);
    try {
      const remote = await api.readScene(projectId, sceneId, "remote", tree.snapshot);
      if (navigationRef.current !== nav || sceneLoadRef.current !== sceneRequest) return;
      if (snapshotKey(remote.snapshot) !== snapshotKey(tree.snapshot)) throw new Error("作品構成と原稿が異なるリモートスナップショットから返されました。再読み込みしてください。");
      const effective = await api.readScene(projectId, sceneId, "checkpoint");
      if (navigationRef.current !== nav || sceneLoadRef.current !== sceneRequest) return;
      if (!sameRemoteSnapshot(effective.snapshot, remote.snapshot)) throw new Error("チェックポイントとリモート原稿の基準が異なります。同期状態を確認してください。");
      const repository = preferredRepository ?? effective.snapshot.repository;
      const localEntries = await journalRef.current?.getDocument(repository, effective.document.path, authorScopeRef.current) ?? [];
      if (navigationRef.current !== nav || sceneLoadRef.current !== sceneRequest) return;
      let latest = localEntries.at(-1) ?? null;
      let text = effective.scene.text;
      let entry = latest;
      let conflict: SceneRead | null = null;
      if (!latest && journalRef.current) {
        const legacy = loadDraft(localStorageIfAvailable(), projectId, sceneId);
        if (legacy && legacy.text !== effective.scene.text) {
          const operation = buildOperation(effective, legacy.text, crypto.randomUUID(), 1);
          const migrated = makeEntry(repository, authorScopeRef.current, sceneId, effective, legacy.text, effective.scene.text, operation, "draft");
          try {
            if (!await journalRef.current.putLatestDraft(migrated)) throw new Error("A newer browser draft already exists.");
            clearDraft(localStorageIfAvailable(), projectId, sceneId);
            latest = migrated;
            if (legacy.revision !== effective.scene.revision) conflict = remote;
            setLegacyDrafts(readLegacyDrafts());
            generationRef.current = Math.max(generationRef.current, 1);
            void refreshJournal(repository);
          } catch (error) {
            setGlobalError(`古いブラウザー下書きを IndexedDB に移せませんでした。古い記録は残しました。${messageOf(error)}`);
          }
        }
      }
      if (latest) {
        text = latest.text;
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
              const operation = buildOperation(effective, latest.text, latest.operation.id, latest.operation.generation);
              latest = makeEntry(repository, authorScopeRef.current, sceneId, effective, latest.text, effective.scene.text, operation, "draft");
              if (!await journalRef.current?.putLatestDraft(latest)) throw new Error("A newer browser draft already exists.");
              entry = latest;
            } catch (error) {
              conflict = remote;
              setGlobalError(`下書きをローカルチェックポイントの版に結び直せませんでした。元の記録は保持しています。${messageOf(error)}`);
            }
          } else {
            conflict = remote;
          }
        }
        if ((latest.state === "checkpointed" || latest.state === "publication_unknown") && docWrite !== effective.document.content) {
          conflict = remote;
        }
        if (latest.state === "conflict") conflict = remote;
      }
      if (navigationRef.current !== nav || sceneLoadRef.current !== sceneRequest) return;
      const next: EditorSession = {
        read: effective,
        remote,
        text,
        baseText: latest?.baseText ?? effective.scene.text,
        entry: latest,
        conflict,
        draftStored: Boolean(latest),
        journalError: "",
      };
      generationRef.current = Math.max(generationRef.current, latest?.operation.generation ?? 0);
      updateWork((current) => current ? { ...current, selectedSceneId: sceneId, editor: next, loadingScene: false } : current);
    } catch (error) {
      if (navigationRef.current !== nav || sceneLoadRef.current !== sceneRequest) return;
      updateWork((current) => current ? { ...current, loadingScene: false, editor: null } : current);
      setStatus({ message: messageOf(error), kind: "error" });
    }
  }, [refreshJournal, updateWork]);

  const activateProject = useCallback(async (project: Project, persistSelection = true, scopeOverride?: string) => {
    const nav = ++navigationRef.current;
    setBusy("project");
    setStatus({ message: "リモートの状態を確認しています…", kind: "normal" });
    try {
      await flushDraft();
      if (navigationRef.current !== nav) return;
      updateWork(() => null);
      setGlobalError("");
      const observed = await api.observation(project.id);
      if (navigationRef.current !== nav) return;
      const scope = scopeOverride ?? authorScopeRef.current;
      await reconcileProject(project.id, observed.snapshot.repository, scope, nav);
      if (navigationRef.current !== nav) return;
      if (journalRef.current) recoveredProjectsRef.current.add(`${project.id}:${repositoryKey(observed.snapshot.repository)}`);
      const tree = await api.readTree(project.id, "remote", observed.snapshot);
      if (navigationRef.current !== nav) return;
      if (snapshotKey(tree.snapshot) !== snapshotKey(observed.snapshot)) throw new Error("作品構成が別のリモートスナップショットから返されました。");
      const next: WorkState = { project, observation: observed, tree, selectedSceneId: "", editor: null, loadingScene: false };
      const [nextModules, nextContributions] = await Promise.all([
        api.modules(project.id).catch(() => []),
        api.contributions(project.id).catch(() => []),
      ]);
      if (navigationRef.current !== nav) return;
      workRef.current = next;
      setWork(next);
      setModules(nextModules);
      setContributions(nextContributions);
      await reloadJournalForWork(observed.snapshot.repository, nav);
      if (navigationRef.current !== nav) return;
      if (persistSelection) localStorageIfAvailable()?.setItem(ACTIVE_PROJECT_KEY, project.id);
      setProjects((current) => current.map((item) => item.id === project.id ? project : item));
      setStatus({
        message: `リモート ${observed.snapshot.remoteCommit.slice(0, 12)} · ${new Date(observed.observedAt).toLocaleTimeString("ja-JP")} に確認`,
        kind: observed.state === "fresh" ? "success" : "error",
      });
    } catch (error) {
      if (navigationRef.current === nav) setStatus({ message: messageOf(error), kind: "error" });
    } finally {
      if (navigationRef.current === nav) setBusy("");
    }
  }, [reconcileProject, reloadJournalForWork, updateWork]);

  useEffect(() => {
    const current = workRef.current;
    if (!journal || !current) return;
    const key = `${current.project.id}:${repositoryKey(current.observation.snapshot.repository)}`;
    if (recoveredProjectsRef.current.has(key)) return;
    recoveredProjectsRef.current.add(key);
    void reconcileProject(current.project.id, current.observation.snapshot.repository, authorScope);
  }, [authorScope, journal, reconcileProject, work?.project.id]);

  const refreshRemote = useCallback(async () => {
    const current = workRef.current;
    if (!current || observationBusyRef.current || document.visibilityState === "hidden") return;
    observationBusyRef.current = true;
    const projectId = current.project.id;
    const nav = navigationRef.current;
    try {
      const observed = await api.observation(projectId);
      if (navigationRef.current !== nav || workRef.current?.project.id !== projectId) return;
      const latestBeforeRead = workRef.current;
      const changedRemote = Boolean(latestBeforeRead && latestBeforeRead.observation.snapshot.remoteCommit !== observed.snapshot.remoteCommit);
      const changedCheckpoint = Boolean(latestBeforeRead && latestBeforeRead.observation.checkpointHead !== observed.checkpointHead);
      if (changedRemote) {
      await reconcileProject(projectId, observed.snapshot.repository, authorScope, nav);
        if (navigationRef.current !== nav || workRef.current?.project.id !== projectId) return;
      }
      const tree = await api.readTree(projectId, "remote", observed.snapshot);
      if (navigationRef.current !== nav || snapshotKey(tree.snapshot) !== snapshotKey(observed.snapshot)) return;
      const latestBeforeUpdate = workRef.current;
      const changedTree = snapshotKey(latestBeforeUpdate?.tree.snapshot ?? current.tree.snapshot) !== snapshotKey(tree.snapshot);
      updateWork((latest) => latest?.project.id === projectId ? { ...latest, observation: observed, tree } : latest);
      setStatus({
        message: observed.state === "fresh"
          ? `リモート ${observed.snapshot.remoteCommit.slice(0, 12)} · ${new Date(observed.observedAt).toLocaleTimeString("ja-JP")} に確認`
          : `リモート確認状態: ${observed.state}`,
        kind: observed.state === "fresh" ? "normal" : "error",
      });
      const latest = workRef.current;
      if ((changedRemote || changedCheckpoint || changedTree) && latest?.project.id === projectId && latest.selectedSceneId) {
        await flushDraft();
        await loadScene(projectId, latest.selectedSceneId, tree, observed.snapshot.repository);
      }
    } catch (error) {
      if (navigationRef.current === nav) setStatus({ message: `リモートの確認に失敗しました。${messageOf(error)}`, kind: "error" });
    } finally {
      observationBusyRef.current = false;
    }
  }, [authorScope, loadScene, reconcileProject, updateWork]);
  refreshRef.current = refreshRemote;

  useEffect(() => {
    if (!work) return;
    const timer = window.setInterval(() => void refreshRef.current(), 15_000);
    const onForeground = () => {
      if (document.visibilityState === "visible") void refreshRef.current();
    };
    const onOnline = () => void refreshRef.current();
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("online", onOnline);
    };
  }, [work?.project.id]);

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
    const form = new FormData(event.currentTarget);
    const url = String(form.get("url") ?? "").trim();
    const branch = String(form.get("branch") ?? "").trim();
    setBusy("register");
    setGlobalError("");
    try {
      const project = await api.registerProject(url, branch || undefined);
      const nextProjects = await api.projects();
      setProjects(nextProjects);
      await activateProject(project);
      event.currentTarget.reset();
    } catch (error) {
      setGlobalError(messageOf(error));
    } finally {
      setBusy("");
    }
  }

  function setStatusMessage(message: string, kind: "normal" | "error" | "success" = "normal"): void {
    setStatus({ message, kind });
  }

  async function persistDraft(entry: JournalEntry): Promise<boolean> {
    const navigation = navigationRef.current;
    const currentJournal = journalRef.current;
    if (!currentJournal) {
      updateWork((current) => current?.editor?.entry?.operation.id === entry.operation.id && current.editor.entry.operation.generation === entry.operation.generation
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
      await refreshJournal(workRef.current?.observation.snapshot.repository, navigation);
      updateWork((current) => current?.editor?.entry?.operation.id === entry.operation.id && current.editor.entry.operation.generation === entry.operation.generation
        ? { ...current, editor: { ...current.editor, draftStored: true, journalError: "" } }
        : current);
      return true;
    }).catch((error) => {
      const errorText = messageOf(error);
      updateWork((current) => current?.editor?.entry?.operation.id === entry.operation.id && current.editor.entry.operation.generation === entry.operation.generation
        ? { ...current, editor: { ...current.editor, draftStored: false, journalError: errorText } }
        : current);
      if (navigationRef.current === navigation) setStatus({ message: errorText, kind: "error" });
      return false;
    });
    draftQueueRef.current = queued.then(() => undefined);
    return queued;
  }

  function editText(nextText: string): void {
    const current = workRef.current;
    const editor = current?.editor;
    const currentJournal = journalRef.current;
    if (!current || !editor || !currentJournal) {
      if (current && editor) {
        updateWork((latest) => latest?.editor ? { ...latest, editor: { ...latest.editor, text: nextText, draftStored: false, journalError: "ブラウザー回復ストレージを利用できません。" } } : latest);
      }
      return;
    }
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
    for (let attempt = 0; attempt < 8; attempt++) {
      const editor = workRef.current?.editor;
      if (!editor?.entry || editor.entry.state !== "draft") return editor?.entry ?? null;
      const entry = editor.entry;
      const timerKey = draftTimerKey(entry);
      const timer = draftTimersRef.current.get(timerKey);
      if (timer) window.clearTimeout(timer);
      draftTimersRef.current.delete(timerKey);
      await draftQueueRef.current;

      const currentEditor = workRef.current?.editor;
      const pending = pendingDraftsRef.current.get(timerKey);
      const target = pending && pending.operation.generation > entry.operation.generation ? pending : currentEditor?.entry ?? entry;
      if (target.state !== "draft") return target;
      const currentIsTarget = currentEditor?.entry?.operation.id === target.operation.id && currentEditor.entry.operation.generation === target.operation.generation;
      if (currentIsTarget && currentEditor.draftStored && !pendingDraftsRef.current.has(timerKey)) return target;

      const stored = await persistDraft(target);
      if (!stored) throw new Error(workRef.current?.editor?.journalError || "下書きをブラウザーに保存できませんでした。");
      const latest = workRef.current?.editor;
      if (latest?.entry?.state === "draft" && draftTimerKey(latest.entry) === timerKey &&
          (!latest.draftStored || pendingDraftsRef.current.has(timerKey))) continue;
      return latest?.entry ?? target;
    }
    throw new Error("下書きの入力が続いているため、移動前に保存できませんでした。入力を止めてもう一度お試しください。");
  }

  async function checkpointCurrent(): Promise<void> {
    const current = workRef.current;
    const editor = current?.editor;
    const currentJournal = journalRef.current;
    if (!current || !editor || !currentJournal || !editor.entry || busy) return;
    setBusy("checkpoint");
    try {
      await flushDraft();
      const latest = workRef.current?.editor;
      if (!latest?.entry || latest.conflict) throw new Error("競合を確認してからチェックポイントを作成してください。");
      const operation = latest.entry.operation;
      const proposalId = latest.entry.proposalId ?? proposalIdFor(operation);
      const checkpointing = await currentJournal.updateState({
        ...latest.entry,
        proposalId,
        authorizedAt: Date.now(),
      }, "checkpointing");
      updateWork((state) => state?.editor?.entry?.operation.generation === operation.generation
        ? { ...state, editor: { ...state.editor, entry: checkpointing } }
        : state);
      const proposal = await api.propose(current.project.id, {
        id: proposalId,
        snapshot: checkpointing.snapshot,
        operations: [operation],
        source: "author",
      });
      await currentJournal.putProposal(checkpointing.repository, authorScopeRef.current, proposal);
      await currentJournal.updateState({ ...checkpointing, proposalId: proposal.id }, "checkpointing");
      await api.approve(current.project.id, { proposalId: proposal.id, operationIds: [operation.id], authorScope });
      const receipt = await api.checkpoint(current.project.id, operation);
      const saved = await currentJournal.updateState({ ...checkpointing, proposalId: proposal.id }, "checkpointed", receipt);
      await currentJournal.removeProposal(checkpointing.repository, authorScopeRef.current, proposal.id).catch(() => undefined);
      updateWork((state) => state?.editor?.entry?.operation.id === operation.id && state.editor.entry.operation.generation === operation.generation
        ? { ...state, editor: { ...state.editor, entry: saved } }
        : state);
      await refreshJournal(checkpointing.repository);
      setStatus({ message: "ローカルチェックポイントを作成しました。GitHub へ保存するまでブラウザーの回復記録を保持します。", kind: "success" });
      await refreshRemote();
    } catch (error) {
      const currentEditor = workRef.current?.editor;
      if (currentEditor?.entry && currentEditor.entry.state === "checkpointing" && (error instanceof ApiError && (error.status === 409 || error.status === 412))) {
        await currentJournal.updateState(currentEditor.entry, "conflict").catch(() => undefined);
        updateWork((state) => state?.editor ? { ...state, editor: { ...state.editor, conflict: state.editor.remote } } : state);
      }
      setStatus({ message: messageOf(error), kind: "error" });
    } finally {
      setBusy("");
    }
  }

  async function publishPending(): Promise<void> {
    const current = workRef.current;
    const currentJournal = journalRef.current;
    if (!current || !currentJournal || busy) return;
    setBusy("publish");
    try {
      const observed = await api.observation(current.project.id);
      await api.reconcile(current.project.id);
      const repository = observed.snapshot.repository;
      const local = await currentJournal.getRepository(repository, authorScopeRef.current);
      const eligible = local.filter((entry) => entry.state === "checkpointed" || entry.state === "publication_unknown");
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
        for (const entry of group) await currentJournal.updateState({ ...entry, publicationBatchId: batchId }, "publication_unknown");
        const receipt = await api.publish(current.project.id, batchId);
        if (receipt.state === "confirmed") {
          await currentJournal.acknowledge(repository, authorScopeRef.current, receipt);
        } else if (receipt.state === "conflict") {
          for (const entry of group) await currentJournal.updateState(entry, "conflict");
          throw new Error("GitHub に別の更新がありました。チェックポイントは保持し、競合を確認してください。");
        } else {
          setStatus({ message: "GitHub への保存結果を確認できませんでした。同じバッチ ID を保持して再確認します。", kind: "error" });
          await refreshJournal(repository);
          return;
        }
      }
      await refreshJournal(repository);
      await refreshRemote();
      setStatus({ message: "GitHub への保存を確認しました。確認済みの操作だけ回復記録から削除しました。", kind: "success" });
    } catch (error) {
      setStatus({ message: messageOf(error), kind: "error" });
    } finally {
      setBusy("");
    }
  }

  async function rebaseDraft(): Promise<void> {
    const current = workRef.current;
    const editor = current?.editor;
    if (!current || !editor || !editor.conflict || !journalRef.current) return;
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
    if (!current || !editor || !editor.conflict || !currentJournal) return;
    if (editor.entry && editor.entry.state !== "draft") {
      setStatus({ message: "チェックポイント済みの操作はブラウザーから削除できません。", kind: "error" });
      return;
    }
    if (!window.confirm("未チェックポイントの下書きを削除して、現在の GitHub 版に戻しますか？")) return;
    try {
      await currentJournal.removeDrafts(editor.read.snapshot.repository, editor.read.document.path, authorScopeRef.current);
      const remote = editor.conflict;
      updateWork((state) => state?.editor ? {
        ...state,
        editor: { ...state.editor, read: remote, remote, text: remote.scene.text, baseText: remote.scene.text, entry: null, conflict: null, draftStored: true, journalError: "" },
      } : state);
      await refreshJournal(editor.read.snapshot.repository);
      setStatus({ message: "保護対象外の下書きを削除して、GitHub 版に戻しました。", kind: "success" });
    } catch (error) {
      setStatus({ message: messageOf(error), kind: "error" });
    }
  }

  async function mapLegacyDraft(record: LegacyDraftRecord): Promise<void> {
    const current = workRef.current;
    const editor = current?.editor;
    const currentJournal = journalRef.current;
    if (!current || !editor || current.loadingScene || current.selectedSceneId !== editor.read.scene.id || !currentJournal) return;
    const accepted = window.confirm(
      `この古い記録を現在選択中の作品「${projectLabel(current.project)}」の「${editor.read.scene.title}」へ下書きとして移しますか？本文は Git に送信されません。`,
    );
    if (!accepted) return;
    try {
      const prior = await currentJournal.getDocument(current.observation.snapshot.repository, editor.read.document.path, authorScopeRef.current);
      const existing = prior.at(-1);
      const id = existing?.state === "draft" ? existing.operation.id : crypto.randomUUID();
      const generation = Math.max(generationRef.current, existing?.operation.generation ?? 0) + 1;
      const operation = buildOperation(editor.read, record.text, id, generation);
      const entry = makeEntry(current.observation.snapshot.repository, authorScopeRef.current, editor.read.scene.id, editor.read, record.text, editor.read.scene.text, operation, "draft");
      if (!await currentJournal.putLatestDraft(entry)) throw new Error("新しい回復記録があるため、この古い下書きは移しませんでした。");
      localStorageIfAvailable()?.removeItem(record.key);
      generationRef.current = generation;
      setLegacyDrafts(readLegacyDrafts());
      updateWork((state) => state?.editor ? {
        ...state,
        editor: { ...state.editor, text: record.text, baseText: editor.read.scene.text, entry, conflict: null, draftStored: true, journalError: "" },
      } : state);
      await refreshJournal(current.observation.snapshot.repository);
      setStatus({ message: "古い下書きをこの作品の IndexedDB 回復記録へ移しました。Git への変更はありません。", kind: "success" });
    } catch (error) {
      setStatus({ message: `古い下書きを移せませんでした。元の記録は残しています。${messageOf(error)}`, kind: "error" });
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

  async function toggleHistory(): Promise<void> {
    const current = workRef.current;
    if (!current) return;
    if (!historyOpen) {
      try {
        setHistory(await api.history(current.project.id));
      } catch (error) {
        setStatus({ message: messageOf(error), kind: "error" });
      }
    }
    setHistoryOpen((open) => !open);
  }

  const currentRepoEntries = useMemo(() => work ? entries.filter((entry) => sameRepository(entry.repository, work.observation.snapshot.repository)) : [], [entries, work]);
  const pendingCount = currentRepoEntries.filter((entry) => entry.state !== "draft").length;
  const recoverableEntries = useMemo(() => entries.filter((entry) => entry.state === "draft" || entry.state === "checkpointing" || entry.state === "checkpointed" || entry.state === "publication_unknown" || entry.state === "conflict"), [entries]);
  const tree = work?.tree.tree ?? null;
  const scene = work?.editor?.read.scene ?? null;
  const editor = work?.editor ?? null;
  const canCheckpoint = Boolean(editor?.entry && (editor.entry.state === "draft" || editor.entry.state === "checkpointing") && editor.draftStored && !editor.conflict && editor.text !== editor.read.scene.text && !busy);
  const canResolveDraft = Boolean(editor?.conflict && (!editor.entry || editor.entry.state === "draft"));
  const canPublish = pendingCount > 0 && currentRepoEntries.some((entry) => entry.state === "checkpointed" || entry.state === "publication_unknown") && !busy;

  if (authState === "checking") return <main className="loading" role="status">Scriptorium を開いています…</main>;
  if (authState === "signed-out") {
    return (
      <main className="login-panel">
        <p className="eyebrow">Scriptorium · 執筆ワークスペース</p>
        <h1>ログイン</h1>
        <p>登録済みのアクセス資格情報で作品を開きます。</p>
        <form onSubmit={(event) => void signIn(event)}>
          <label htmlFor="auth-token">アクセストークン</label>
          <input id="auth-token" type="password" autoComplete="current-password" minLength={32} value={token} onChange={(event) => setToken(event.currentTarget.value)} required />
          <button type="submit">ログイン</button>
          {loginError && <p className="status" data-kind="error" role="alert">{loginError}</p>}
        </form>
        {journalOpenError && <p className="status" data-kind="error" role="alert">{journalOpenError}</p>}
      </main>
    );
  }

  return (
    <div className="workspace">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Scriptorium ホーム">Scriptorium</a>
        <div className="topbar-status" role="status" aria-live="polite" data-kind={status.kind}>{status.message || "作品を選択してください"}</div>
        <button type="button" className="quiet-button" onClick={() => void signOut()}>ログアウト</button>
      </header>
      <div className="workspace-grid">
        <aside className="sidebar" aria-label="作品と構成">
          <form onSubmit={(event) => void registerProject(event)} className="project-form">
            <h2>作品を追加</h2>
            <label htmlFor="repo-url">GitHub リポジトリ URL</label>
            <input id="repo-url" name="url" type="url" placeholder="https://github.com/owner/work" required />
            <label htmlFor="repo-branch">ブランチ（任意）</label>
            <input id="repo-branch" name="branch" type="text" autoComplete="off" />
            <button type="submit" disabled={busy === "register"}>{busy === "register" ? "登録中…" : "リポジトリを登録"}</button>
          </form>
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
          {tree && <TreeNav tree={tree} selectedSceneId={work?.selectedSceneId ?? ""} disabled={Boolean(busy)} onSelect={(sceneId) => work && void loadScene(work.project.id, sceneId, work.tree, work.observation.snapshot.repository)} />}
          {legacyDrafts.length > 0 && <LegacyRecoveryPanel drafts={legacyDrafts} selectedSceneId={work && !work.loadingScene && work.editor?.read.scene.id === work.selectedSceneId ? work.selectedSceneId : ""} onExport={exportLegacyDrafts} onMap={(draft) => void mapLegacyDraft(draft)} />}
          {!work && recoverableEntries.length > 0 && (
            <section className="recovery-panel" aria-labelledby="recovery-title">
              <h2 id="recovery-title">ブラウザーの回復記録</h2>
              <p>同じリポジトリを再登録すると、次の原稿を引き継げます。</p>
              <RecoveryList entries={recoverableEntries} />
            </section>
          )}
        </aside>

        <main className="writing-area" aria-label="執筆">
          {globalError && <p className="status" data-kind="error" role="alert">{globalError}</p>}
          {journalOpenError && <p className="status" data-kind="error" role="alert">{journalOpenError}</p>}
          {isolatedRecoveryCount > 0 && <p className="status" role="status">別の作者スコープまたは未割り当ての回復記録 {isolatedRecoveryCount} 件を保持しています。現在のセッションには復元しません。</p>}
          {journal && proposals.length > 0 && work && (
            <ProposalReview
              projectId={work.project.id}
              repository={work.observation.snapshot.repository}
              authorScope={authorScope}
              journal={journal}
              proposals={proposals}
              onChange={() => void refreshJournal(work.observation.snapshot.repository)}
              onStatus={setStatusMessage}
            />
          )}
          {!work && (
            <section className="empty-state">
              <p className="eyebrow">読む・書く・育てる</p>
              <h1>Scriptorium</h1>
              <p>Git リポジトリを登録すると、原稿を確認しながら安全に書き進められます。</p>
              {recoverableEntries.length > 0 && <><h2>保存された回復記録</h2><RecoveryList entries={recoverableEntries} /></>}
            </section>
          )}
          {work && (
            <>
              {globalError && <p className="status" data-kind="error" role="alert">{globalError}</p>}
              {work.observation.state !== "fresh" && <p className="status" data-kind="error" role="alert">リモート確認状態: {work.observation.state}。最後に確認できた原稿を表示しています。</p>}
              {work.loadingScene && <p className="loading" role="status">スナップショットを読み込んでいます…</p>}
              {!scene && !work.loadingScene && <div className="empty-state"><h1>{tree?.title ?? projectLabel(work.project)}</h1><p>左側の作品構成からシーンを選んでください。</p></div>}
              {editor && scene && (
                <>
                  <SceneEditor
                    key={JSON.stringify([repositoryKey(editor.read.snapshot.repository), editor.read.document.path])}
                    projectId={work.project.id}
                    scene={scene}
                    path={editor.read.document.path}
                    breadcrumb={breadcrumbFor(tree, scene.id)}
                    text={editor.text}
                    onTextChange={editText}
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
                    journal={journal}
                    repository={work.observation.snapshot.repository}
                    onJournalError={(message) => setStatus({ message, kind: "error" })}
                    pendingCount={pendingCount}
                  />
                  {historyOpen && <HistoryPanel commits={history} />}
                    <ContributionHost projectId={work.project.id} authorScope={authorScope} slot="editor" contributions={contributions} modules={modules} snapshot={work.tree.snapshot} refresh={refreshContributionContext} journal={journal} onProposalStored={refreshProposals} />
                  <div className="contribution-dock">
                    {(["dock", "inspection", "review", "settings"] as const).map((slot) => (
                      <ContributionHost key={slot} projectId={work.project.id} authorScope={authorScope} slot={slot} contributions={contributions} modules={modules} snapshot={work.tree.snapshot} refresh={refreshContributionContext} journal={journal} onProposalStored={refreshProposals} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
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

function HistoryPanel({ commits }: { commits: Commit[] }) {
  return (
    <section className="history-panel" aria-labelledby="history-title">
      <h2 id="history-title">Git 履歴</h2>
      {commits.length ? <ol>{commits.map((commit) => <li key={commit.hash}><strong>{commit.message}</strong><span>{commit.hash.slice(0, 12)} · {new Date(commit.date).toLocaleString("ja-JP")}</span></li>)}</ol> : <p>履歴はありません。</p>}
    </section>
  );
}
