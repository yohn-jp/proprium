import { lazy, Suspense, useLayoutEffect, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { BrowserLocalGit, BrowserLocalGitError } from "../git/index.js";
import type { CommitSummary, FileRevision, StatusEntry, WorkspaceIdentity } from "../git/protocol.js";
import { createGitHubAccountSession } from "../git/github-sync.js";
import type { GitHubAccount, GitHubDevicePrompt, GitHubRepository, GitHubAccountSession, GitHubSyncClient } from "../git/github-sync.js";
import { PluginPanel } from "./PluginPanel.js";
import { LiveMcpPanel } from "./LiveMcpPanel.js";

import { DesktopShell } from "../../../shells/desktop/DesktopShell.js";
import { ThemeControl } from "../../../components/ThemeControl.js";
import { applyThemeMode, loadThemeMode, persistThemeMode } from "../../../theme.js";
import type { WorkspacePanel } from "../../../application/contracts.js";
import { RestoredEditor } from "./RestoredEditor.js";
const MobileShell = lazy(() => import("../../../shells/mobile/MobileShell.js").then(module => ({ default: module.MobileShell })));

function RetainedPanelSlot({ node }: { node: HTMLElement }): ReactElement {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { slot.current?.append(node); return () => { node.remove(); }; }, [node]);
  return <div ref={slot} />;
}

interface RecentWorkspace {
  identity: WorkspaceIdentity;
  title: string;
  lastOpened: number;
}
declare global {
  interface Window { propriumHostOpenLocalWorkspace?: (entry: RecentWorkspace) => Promise<void>; }
}
interface OpenFile {
  path: string;
  data: Uint8Array | null;
  revision: FileRevision;
  text: string | null;
  binary: boolean;
  dirty: boolean;
}
type SyncState = "editing" | "local-draft" | "local-committed" | "local-ahead" | "published" | "syncing" | "offline" | "conflict" | "remote-unknown";
interface OperationMessage { tone: "info" | "error" | "success"; text: string; }

const RECENTS_KEY = "proprium.host.recent-workspaces.v1";
const PREFERENCES_KEY = "proprium.host.preferences.v1";
const GATEWAY_KEY = "proprium.host.gateway-url.v1";
const DEFAULT_GATEWAY = import.meta.env.VITE_PROPRIUM_GATEWAY_URL ?? "";

function readRecentWorkspaces(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is RecentWorkspace => !!item && typeof item === "object" &&
      typeof item.title === "string" && typeof item.lastOpened === "number" && item.identity &&
      typeof item.identity.localWorkspaceId === "string");
  } catch { return []; }
}
function persistRecents(value: RecentWorkspace[]): void {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(value.slice(0, 20))); }
  catch { /* Workspace metadata is convenience only; Git storage remains in LightningFS. */ }
}
function readGateway(): string { try { return localStorage.getItem(GATEWAY_KEY) || DEFAULT_GATEWAY; } catch { return DEFAULT_GATEWAY; } }
function persistGateway(value: string): void {
  try {
    const url = new URL(value);
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((!loopback && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
    localStorage.setItem(GATEWAY_KEY, url.origin);
  } catch { /* Do not persist incomplete or credential-bearing URLs. */ }
}
function readPreferences(): { name: string; email: string } {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "null") as unknown;
    if (value && typeof value === "object" && "name" in value && "email" in value && typeof value.name === "string" && typeof value.email === "string") {
      return { name: value.name, email: value.email };
    }
  } catch { /* Use defaults. */ }
  return { name: "", email: "" };
}
async function loadWorkspaceState(targetGit: BrowserLocalGit): Promise<{
  status: { head: string | null; entries: StatusEntry[]; localState: "draft" | "local-committed" };
  files: Array<{ path: string; type: "blob"; oid: string; bytes: number }>;
  history: CommitSummary[];
}> {
  const [status, files, history] = await Promise.all([targetGit.status(), targetGit.listFiles(), targetGit.log(40)]);
  return { status, files, history };
}
function rememberWorkspace(entry: RecentWorkspace, current: RecentWorkspace[]): RecentWorkspace[] {
  const next = [{ ...entry, lastOpened: Date.now() }, ...current.filter(item => item.identity.localWorkspaceId !== entry.identity.localWorkspaceId)];
  persistRecents(next);
  return next;
}
function localWorkspaceId(repositoryId: number, branch: string): string {
  const key = `${repositoryId}:${branch}`;
  let digest = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) digest = Math.imul(digest ^ key.charCodeAt(index), 0x01000193);
  return `gh${(digest >>> 0).toString(16).padStart(8, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
function errorMessage(error: unknown): string {
  if (error instanceof BrowserLocalGitError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "The operation could not be completed.";
}
function asText(data: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return null; }
}
function fileIcon(path: string): string { return path.includes("/") ? "↳" : "▤"; }

export function HostApp(): ReactElement {
  const navigate = useNavigate();
  const [editorNode] = useState(() => document.createElement("div"));
  const [toolsNode] = useState(() => document.createElement("div"));
  const [recent, setRecent] = useState<RecentWorkspace[]>(readRecentWorkspaces);
  const [gatewayDraft, setGatewayDraft] = useState(readGateway);
  const [session, setSession] = useState<GitHubAccountSession | null>(null);
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [devicePrompt, setDevicePrompt] = useState<GitHubDevicePrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedRepository, setSelectedRepository] = useState<number | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [workspace, setWorkspace] = useState<RecentWorkspace | null>(null);
  const [workspaceGeneration, setWorkspaceGeneration] = useState("");
  const [git, setGit] = useState<BrowserLocalGit | null>(null);
  const [syncClient, setSyncClient] = useState<GitHubSyncClient | null>(null);
  const [files, setFiles] = useState<Array<{ path: string; type: "blob" | "tree"; oid: string; bytes: number }>>([]);
  const [status, setStatus] = useState<{ head: string | null; entries: StatusEntry[]; localState: "draft" | "local-committed" }>({ head: null, entries: [], localState: "draft" });
  const [history, setHistory] = useState<CommitSummary[]>([]);
  const [currentFile, setCurrentFile] = useState<OpenFile | null>(null);
  const [newPath, setNewPath] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [preferences, setPreferences] = useState(readPreferences);
  const [syncState, setSyncState] = useState<SyncState>("local-draft");
  const [message, setMessage] = useState<OperationMessage | null>(null);
  const [mode, setMode] = useState<"desktop" | "mobile">(() => {
    if (location.pathname.startsWith("/mobile")) return "mobile";
    if (location.pathname.startsWith("/desktop")) return "desktop";
    try { const saved = localStorage.getItem("scriptorium:ui-mode"); if (saved === "desktop" || saved === "mobile") return saved; } catch { /* Use device default. */ }
    return window.matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop";
  });
  const [theme, setTheme] = useState(loadThemeMode);
  const [requestedPanel, setRequestedPanel] = useState({ id: "editor", sequence: 0 });
  const [recoveryTarget, setRecoveryTarget] = useState<RecentWorkspace | null>(null);
  const editorFlush = useRef<(() => Promise<string | null>) | null>(null);
  const registerEditorFlush = useCallback((flush: (() => Promise<string | null>) | null) => { editorFlush.current = flush; }, []);
  useEffect(() => applyThemeMode(theme), [theme]);
  useEffect(() => {
    if (!workspace && mode === "mobile") {
      const search = new URLSearchParams(location.search);
      if (search.get("view") !== "library") { search.set("view", "library"); navigate({ search: search.toString() }, { replace: true }); }
    }
  }, [workspace, mode, navigate]);
  const gitRef = useRef<BrowserLocalGit | null>(null);
  const sessionRef = useRef<GitHubAccountSession | null>(null);
  const currentFileRef = useRef<OpenFile | null>(currentFile);
  const livePluginInvoker = useRef<((args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | null>(null);
  currentFileRef.current = currentFile;
  const activeWorkspaceId = workspace?.identity.localWorkspaceId ?? null;
  const selectedRepositoryEntry = repositories.find(item => item.id === selectedRepository) ?? null;
  const changedPaths = useMemo(() => new Set(status.entries.map(entry => entry.path)), [status.entries]);

  const refresh = useCallback(async (targetGit: BrowserLocalGit, targetWorkspace: RecentWorkspace): Promise<void> => {
    const next = await loadWorkspaceState(targetGit);
    setStatus(next.status);
    setFiles(next.files);
    setHistory(next.history);
    const liveFile = currentFileRef.current;
    setSyncState(liveFile?.dirty ? "editing" : next.status.entries.length || !next.status.head ? "local-draft" : "local-committed");
    if (liveFile && !liveFile.dirty && !next.files.some(file => file.path === liveFile.path) && liveFile.data !== null) setCurrentFile(null);
    setRecent(existing => rememberWorkspace(targetWorkspace, existing));
  }, [currentFile]);

  const openLocalWorkspace = useCallback(async (entry: RecentWorkspace, attachedSession?: GitHubAccountSession): Promise<void> => {
    const initialFile = currentFileRef.current;
    const discardConfirmed = Boolean(initialFile?.dirty && window.confirm("This file has edits that are not saved to the local workspace. Leave it and discard those edits?"));
    if (initialFile?.dirty && !discardConfirmed) return;
    setBusy(true);
    setMessage(null);
    let nextGit: BrowserLocalGit | null = null;
    try {
      nextGit = new BrowserLocalGit(entry.identity);
      const nextSync = attachedSession ? nextGit.connectGitHubSession(attachedSession) : null;
      await nextGit.init();
      const nextState = await loadWorkspaceState(nextGit);
      const liveFile = currentFileRef.current;
      if (liveFile?.dirty && (!discardConfirmed || liveFile.path !== initialFile?.path || liveFile.text !== initialFile?.text) &&
          !window.confirm("The editor changed while the workspace was loading. Discard the newer text and continue?")) {
        nextGit.close();
        return;
      }
      const previousGit = gitRef.current;
      gitRef.current = nextGit;
      setGit(nextGit);
      setSyncClient(nextSync);
      setWorkspace(entry);
      setWorkspaceGeneration(crypto.randomUUID());
      setCurrentFile(null);
      setStatus(nextState.status);
      setFiles(nextState.files);
      setHistory(nextState.history);
      setSyncState(nextState.status.entries.length || !nextState.status.head ? "local-draft" : "local-committed");
      setRecent(existing => rememberWorkspace(entry, existing));
      previousGit?.close();
      setMessage({ tone: "info", text: "Workspace opened on this device. Local drafts and commits remain in this browser until published to GitHub." });
    } catch (error) {
      if (error instanceof BrowserLocalGitError && error.code === "storage_unknown") setRecoveryTarget(entry);
      if (gitRef.current !== nextGit) nextGit?.close();
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally { setBusy(false); }
  }, [currentFile]);

  useEffect(() => {
    if (import.meta.env.VITE_PROPRIUM_E2E !== "true") return;
    window.propriumHostOpenLocalWorkspace = openLocalWorkspace;
    return () => { window.propriumHostOpenLocalWorkspace = undefined; };
  }, [openLocalWorkspace]);

  useEffect(() => () => { gitRef.current?.close(); sessionRef.current?.signOut(); }, []);

  async function connectGitHub(): Promise<void> {
    const configuredGateway = gatewayDraft.trim();
    if (!configuredGateway) { setMessage({ tone: "error", text: "Enter the Proprium Gateway URL configured for this Host." }); return; }
    setBusy(true);
    setMessage(null);
    let accountSession: GitHubAccountSession | null = null;
    try {
      accountSession = createGitHubAccountSession(configuredGateway);
      const verificationWindow = window.open("https://github.com/login/device", "_blank", "noopener,noreferrer");
      const prompt = await accountSession.beginAuthorization();
      sessionRef.current?.signOut();
      sessionRef.current = accountSession;
      setSession(accountSession);
      setDevicePrompt(prompt);
      setMessage({ tone: "info", text: `Enter code ${prompt.userCode} at GitHub, then return here. This page will finish sign-in automatically.` });
      if (!verificationWindow) setMessage({ tone: "info", text: `Enter code ${prompt.userCode} at ${prompt.verificationUri}, then return here. This page will finish sign-in automatically.` });
      const signedIn = await accountSession.completeAuthorization();
      setAccount(signedIn);
      const available = await accountSession.repositories();
      setRepositories(available);
      setDevicePrompt(null);
      try { localStorage.setItem(GATEWAY_KEY, configuredGateway); } catch { /* Configuration can be entered again. */ }
      setMessage({ tone: "success", text: `Connected to GitHub as ${signedIn.login}. Choose a repository to open.` });
    } catch (error) {
      setDevicePrompt(null);
      setMessage({ tone: "error", text: errorMessage(error) });
      accountSession?.signOut();
      if (sessionRef.current === accountSession) sessionRef.current = null;
      setSession(null);
    } finally { setBusy(false); }
  }

  async function openRemoteRepository(): Promise<void> {
    if (!session || !selectedRepositoryEntry) return;
    const initialFile = currentFileRef.current;
    const discardConfirmed = Boolean(initialFile?.dirty && window.confirm("This file has edits that are not saved to the local worktree. Leave it and discard those edits?"));
    if (initialFile?.dirty && !discardConfirmed) return;
    const branch = selectedBranch.trim() || selectedRepositoryEntry.defaultBranch;
    const identity: WorkspaceIdentity = {
      origin: "https://github.com",
      repositoryId: selectedRepositoryEntry.id,
      owner: selectedRepositoryEntry.owner,
      repository: selectedRepositoryEntry.name,
      branch,
      localWorkspaceId: localWorkspaceId(selectedRepositoryEntry.id, branch),
    };
    const entry = recent.find(item => item.identity.repositoryId === identity.repositoryId && item.identity.branch === identity.branch)
      ?? { identity, title: `${selectedRepositoryEntry.fullName} · ${branch}`, lastOpened: Date.now() };
    setBusy(true);
    setMessage(null);
    let nextGit: BrowserLocalGit | null = null;
    try {
      nextGit = new BrowserLocalGit(entry.identity);
      await nextGit.init();
      const nextSync = nextGit.connectGitHubSession(session);
      const initial = await loadWorkspaceState(nextGit);
      const liveFile = currentFileRef.current;
      if (liveFile?.dirty && (!discardConfirmed || liveFile.path !== initialFile?.path || liveFile.text !== initialFile?.text) &&
          !window.confirm("The editor changed while the repository was loading. Discard the newer text and continue?")) {
        nextGit.close();
        return;
      }
      const previousGit = gitRef.current;
      gitRef.current = nextGit;
      setGit(nextGit);
      setSyncClient(nextSync);
      setWorkspace(entry);
      setWorkspaceGeneration(crypto.randomUUID());
      setCurrentFile(null);
      setStatus(initial.status);
      setFiles(initial.files);
      setHistory(initial.history);
      setSyncState(initial.status.entries.length || !initial.status.head ? "local-draft" : "local-committed");
      setRecent(existing => rememberWorkspace(entry, existing));
      previousGit?.close();
      const pulled = await nextSync.pull();
      await refresh(nextGit, entry);
      if (pulled.state === "conflict") {
        setSyncState("conflict");
        setMessage({ tone: "error", text: `The local branch and GitHub branch diverged. Local ${pulled.localHead ?? "(empty)"}; GitHub ${pulled.remoteHead ?? "(empty)"}. Local files were preserved.` });
      } else if (pulled.state === "local-ahead") {
        setSyncState("local-ahead");
        setMessage({ tone: "info", text: `Opened ${entry.title}. Local commits through ${pulled.head} are waiting to be published; GitHub is at ${pulled.remoteHead ?? "no published commit"}. Local history and files were preserved.` });
      } else {
        setMessage({ tone: "success", text: pulled.state === "fast-forwarded" ? `Opened ${entry.title} at GitHub commit ${pulled.head}.` : `Opened ${entry.title}; local branch matches GitHub.` });
      }
    } catch (error) {
      const text = errorMessage(error);
      setSyncState(text.includes("network_unavailable") ? "offline" : text.includes("remote_unknown") ? "remote-unknown" : "local-draft");
      setMessage({ tone: "error", text });
      if (error instanceof BrowserLocalGitError && error.code === "storage_unknown") setRecoveryTarget(entry);
      if (gitRef.current !== nextGit) nextGit?.close();
    } finally { setBusy(false); }
  }

  async function selectRecent(entry: RecentWorkspace): Promise<void> {
    await openLocalWorkspace(entry);
  }

  async function refreshAfterPlugin(): Promise<void> {
    const targetGit = git;
    const targetWorkspace = workspace;
    if (!targetGit || !targetWorkspace) return;
    const initialFile = currentFileRef.current;
    await refresh(targetGit, targetWorkspace);
    if (!initialFile || initialFile.dirty || gitRef.current !== targetGit) return;
    const fileBeforeRead = currentFileRef.current;
    if (!fileBeforeRead || fileBeforeRead.path !== initialFile.path || fileBeforeRead.dirty) return;
    const read = await targetGit.read(fileBeforeRead.path);
    const latestFile = currentFileRef.current;
    if (gitRef.current !== targetGit || latestFile?.path !== fileBeforeRead.path || latestFile.dirty ||
        latestFile.text !== fileBeforeRead.text || latestFile.revision.oid !== fileBeforeRead.revision.oid) return;
    const data = read.data;
    const text = data === null ? "" : asText(data);
    const updatedFile: OpenFile = { ...latestFile, data, revision: read.revision, text, binary: data !== null && text === null, dirty: false };
    currentFileRef.current = updatedFile;
    setCurrentFile(updatedFile);
  }

  async function loadFile(path: string): Promise<void> {
    if (!git || !workspace) return;
    const initialFile = currentFileRef.current;
    const discardConfirmed = Boolean(initialFile?.dirty && window.confirm("Discard unsaved editor text and open another file?"));
    if (initialFile?.dirty && !discardConfirmed) return;
    setBusy(true);
    setMessage(null);
    try {
      const read = await git.read(path);
      const liveFile = currentFileRef.current;
      if (liveFile?.dirty && (!discardConfirmed || liveFile.path !== initialFile?.path || liveFile.text !== initialFile?.text) &&
          !window.confirm("The editor changed while the file was loading. Discard the newer text and continue?")) return;
      const data = read.data;
      const text = data === null ? "" : asText(data);
      const entry: OpenFile = { path, data, revision: read.revision, text, binary: data !== null && text === null, dirty: false };
      setCurrentFile(entry);
      setRequestedPanel(value => ({ id: "editor", sequence: value.sequence + 1 }));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".cm-content")?.focus());
    } catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function createFile(): Promise<void> {
    if (!git || !workspace) return;
    const initialFile = currentFileRef.current;
    const discardConfirmed = Boolean(initialFile?.dirty && window.confirm("Discard unsaved editor text and create another file?"));
    if (initialFile?.dirty && !discardConfirmed) return;
    const path = newPath.trim();
    if (!path) { setMessage({ tone: "error", text: "Enter a repository-relative file path." }); return; }
    setBusy(true);
    try {
      const read = await git.read(path);
      const liveFile = currentFileRef.current;
      if (liveFile?.dirty && (!discardConfirmed || liveFile.path !== initialFile?.path || liveFile.text !== initialFile?.text) &&
          !window.confirm("The editor changed while the new file was loading. Discard the newer text and continue?")) return;
      if (read.data !== null) throw new Error(`File already exists: ${path}`);
      setCurrentFile({ path, data: null, revision: read.revision, text: "", binary: false, dirty: true });
      setSyncState("editing");
      setRequestedPanel(value => ({ id: "editor", sequence: value.sequence + 1 }));
      setNewPath("");
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".cm-content")?.focus());
    } catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function saveDraft(): Promise<void> {
    if (!git || !currentFile || currentFile.binary || currentFile.text === null) return;
    const savingFile = currentFile;
    setBusy(true);
    try {
      if (savingFile.text === null) return;
      const data = new TextEncoder().encode(savingFile.text);
      const revision = await git.write(savingFile.path, data, savingFile.revision);
      const latest = currentFileRef.current;
      if (latest?.path === savingFile.path && latest.dirty && latest.text !== savingFile.text) {
        setCurrentFile({ ...latest, data, revision, dirty: true });
      } else {
        setCurrentFile({ ...savingFile, data, revision, dirty: false });
      }
      await refresh(git, workspace!);
      if (currentFileRef.current?.dirty) setSyncState("editing");
      setMessage({ tone: "success", text: `${savingFile.path} saved to this browser's local Git worktree. It is not published to GitHub.` });
    } catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function deleteFile(): Promise<void> {
    const targetGit = git;
    const targetWorkspace = workspace;
    const deletingFile = currentFileRef.current;
    if (!targetGit || !targetWorkspace || !deletingFile || !window.confirm(deletingFile.dirty ? `Delete ${deletingFile.path} from the local worktree and discard its unsaved editor text?` : `Delete ${deletingFile.path} from the local worktree?`)) return;
    setBusy(true);
    try {
      await targetGit.delete(deletingFile.path, deletingFile.revision);
      const stillInWorkspace = gitRef.current === targetGit;
      const latestFile = currentFileRef.current;
      const sameFileStillOpen = stillInWorkspace && latestFile?.path === deletingFile.path;
      const preserveNewerText = sameFileStillOpen && latestFile.dirty && (!deletingFile.dirty || latestFile.text !== deletingFile.text);
      if (sameFileStillOpen && preserveNewerText) {
        const preservedDraft: OpenFile = { ...latestFile, data: null, revision: { oid: null }, dirty: true };
        currentFileRef.current = preservedDraft;
        setCurrentFile(preservedDraft);
        setSyncState("editing");
      } else if (sameFileStillOpen) {
        currentFileRef.current = null;
        setCurrentFile(null);
      }
      if (stillInWorkspace) await refresh(targetGit, targetWorkspace);
      const workspacePrefix = stillInWorkspace ? "" : `${targetWorkspace.title} · `;
      const editorNotice = preserveNewerText ? " Newer editor text is preserved as an unsaved draft; save it to recreate the file." : "";
      setMessage({ tone: "info", text: `${workspacePrefix}${deletingFile.path} is deleted in the local worktree.${editorNotice} Commit and publish to share the deletion.` });
    } catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function commitLocal(): Promise<void> {
    if (!git || !workspace) return;
    if (currentFile?.dirty) { setMessage({ tone: "error", text: "Save the current editor text to the local worktree before committing." }); return; }
    if (!commitMessage.trim()) { setMessage({ tone: "error", text: "Enter a commit message." }); return; }
    if (!preferences.name.trim() || !preferences.email.includes("@")) { setMessage({ tone: "error", text: "Enter a Git author name and valid email address." }); return; }
    setBusy(true);
    try {
      const before = await git.status();
      if (!before.entries.length) { setMessage({ tone: "info", text: "There are no local changes to commit." }); return; }
      const staged = await git.add(before.entries.map(entry => entry.path), before.head);
      const committed = await git.commit(commitMessage, preferences, staged.head);
      setCommitMessage("");
      setSyncState("local-committed");
      await refresh(git, workspace);
      setMessage({ tone: "success", text: `Committed locally as ${committed.oid}. This commit is still only on this device.` });
    } catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function fetchRemote(): Promise<void> {
    if (!git || !syncClient) { setMessage({ tone: "error", text: "Connect to GitHub to fetch this repository." }); return; }
    if (currentFile?.dirty) { setMessage({ tone: "error", text: "Save the current editor text before fetching remote changes." }); return; }
    setBusy(true); setSyncState("syncing");
    try {
      const result = await syncClient.fetch();
      await refresh(git, workspace!);
      setMessage({ tone: "success", text: `Fetched ${result.importedCommits} commit(s). The working tree was not changed.` });
    } catch (error) { applySyncError(error); }
    finally { setBusy(false); }
  }

  async function pullRemote(): Promise<void> {
    if (!git || !syncClient) { setMessage({ tone: "error", text: "Connect to GitHub to pull this repository." }); return; }
    if (currentFile?.dirty) { setMessage({ tone: "error", text: "Save the current editor text before pulling remote changes." }); return; }
    setBusy(true); setSyncState("syncing");
    try {
      const result = await syncClient.pull();
      if (result.state === "conflict") {
        setSyncState("conflict");
        setMessage({ tone: "error", text: `GitHub and this device have diverged. Local ${result.localHead ?? "(empty)"}; remote ${result.remoteHead ?? "(empty)"}. Nothing was overwritten. Commit, inspect history, or choose another workspace before resolving.` });
      } else if (result.state === "local-ahead") {
        setSyncState("local-ahead");
        setMessage({ tone: "info", text: `Local commits through ${result.head} are waiting to be published. GitHub is at ${result.remoteHead ?? "no published commit"}; local history and editor contents were preserved.` });
      } else {
        setSyncState("local-committed");
        setMessage({ tone: "success", text: result.state === "fast-forwarded" ? `Updated to GitHub commit ${result.head}.` : "This workspace already matches GitHub." });
      }
      await refresh(git, workspace!);
      if (result.state === "conflict") setSyncState("conflict");
      else if (result.state === "local-ahead") setSyncState("local-ahead");
      else {
        const liveFile = currentFileRef.current;
        if (liveFile?.dirty) {
          setMessage({ tone: "info", text: "The pull completed, and the editor has newer unsaved text. It was left untouched; save it and reopen the file to load the updated branch." });
        } else if (liveFile) {
          const read = await git.read(liveFile.path);
          if (currentFileRef.current?.dirty) {
            setMessage({ tone: "info", text: "The editor changed while GitHub updates loaded. Its unsaved text was left untouched." });
          } else if (currentFileRef.current?.path === liveFile.path) {
            if (read.data === null) setCurrentFile(null);
            else {
              const text = asText(read.data);
              setCurrentFile({ path: liveFile.path, data: read.data, revision: read.revision, text, binary: text === null, dirty: false });
            }
          }
        }
      }
    } catch (error) { applySyncError(error); }
    finally { setBusy(false); }
  }

  async function publishRemote(): Promise<void> {
    if (!git || !syncClient) { setMessage({ tone: "error", text: "Connect to GitHub to publish this repository." }); return; }
    if (currentFile?.dirty) { setMessage({ tone: "error", text: "Save the current editor text before publishing." }); return; }
    setBusy(true); setSyncState("syncing");
    try {
      const local = await git.status();
      if (!local.head || local.entries.length) throw new Error("Commit all local worktree changes before publishing.");
      const remote = await syncClient.remoteHead();
      const result = await syncClient.publish(local.head, remote.head);
      if (result.state === "published") {
        if (result.head === local.head && result.remoteHead === local.head) {
          setSyncState(currentFileRef.current?.dirty ? "editing" : "published");
          setMessage({ tone: "success", text: `Published commit ${local.head} to GitHub and confirmed the remote branch SHA.` });
        } else {
          setSyncState("remote-unknown");
          setMessage({ tone: "error", text: `GitHub returned a publication receipt for ${result.remoteHead}, but this Host requested ${local.head}. Check the remote branch before retrying.` });
        }
      } else if (result.state === "conflict") {
        setSyncState("conflict");
        setMessage({ tone: "error", text: `GitHub changed before publication. Expected ${result.expectedRemoteHead ?? "(empty)"}; found ${result.remoteHead ?? "(empty)"}. Fetch and pull or inspect the history before retrying.` });
      } else if (result.state === "remote-unknown") {
        setSyncState("remote-unknown");
        setMessage({ tone: "error", text: `GitHub could not confirm publication. Expected ${local.head}; observed ${result.observedRemoteHead ?? "(unknown)"}. Check the remote branch before retrying.` });
      }
    } catch (error) { applySyncError(error); }
    finally { setBusy(false); }
  }

  function applySyncError(error: unknown): void {
    const text = errorMessage(error);
    if (text.includes("network_unavailable")) setSyncState("offline");
    else if (text.includes("remote_unknown")) setSyncState("remote-unknown");
    else if (text.includes("remote_conflict")) setSyncState("conflict");
    else setSyncState("local-committed");
    if (text.includes("authentication_expired")) {
      setAccount(null);
      setRepositories([]);
      setSession(null);
      sessionRef.current = null;
    }
    setMessage({ tone: "error", text });
  }

  function leaveWorkspace(): void {
    if (currentFile?.dirty && !window.confirm("This file has edits not saved to the local worktree. Leave and discard those edits?")) return;
    gitRef.current?.close();
    gitRef.current = null;
    setWorkspace(null);
    setWorkspaceGeneration("");
    setGit(null);
    setSyncClient(null);
    setCurrentFile(null);
    setMessage(null);
  }

  const signOut = (): void => {
    session?.signOut();
    sessionRef.current = null;
    setSession(null); setAccount(null); setRepositories([]); setDevicePrompt(null);
    setMessage({ tone: "info", text: "Signed out. Local workspaces remain on this device." });
  };

  const registerLivePluginInvoker = useCallback((invoker: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | null): void => {
    livePluginInvoker.current = invoker;
  }, []);
  const executeLivePlugin = useCallback(async (args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const invoke = livePluginInvoker.current;
    if (!invoke) throw new Error("Open the Plugins panel and enable a WASM plugin before calling plugin_call.");
    return invoke(args, signal);
  }, []);
  const updateGateway = useCallback((value: string): void => {
    setGatewayDraft(value);
    persistGateway(value);
  }, []);

  const pluginRevisionKey = JSON.stringify([
    workspace?.identity.localWorkspaceId,
    status.head,
    status.entries.map(entry => [entry.path, entry.head, entry.worktree, entry.stage]),
    currentFile?.dirty ?? false,
    currentFile?.dirty ? currentFile.text : null,
  ]);

  const revealPanel = (id: string): void => setRequestedPanel(value => ({ id, sequence: value.sequence + 1 }));
  const beforeLayoutChange = async (): Promise<boolean> => {
    try { await editorFlush.current?.(); return true; }
    catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); return false; }
  };
  const recoverStorage = async (entry: RecentWorkspace): Promise<void> => {
    setBusy(true);
    const active = workspace?.identity.localWorkspaceId === entry.identity.localWorkspaceId ? gitRef.current : null;
    const candidate = active ?? new BrowserLocalGit(entry.identity);
    try {
      await candidate.verifyStorage(); setRecoveryTarget(null);
      if (active) {
        await refresh(active, entry);
        setMessage({ tone: "success", text: "ブラウザー内Gitの整合性を確認しました。原稿と保存データを保持しています。" });
      } else {
        candidate.close(); await openLocalWorkspace(entry, session ?? undefined);
      }
    } catch (error) { if (!active) candidate.close(); setMessage({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  };
  const recoveryEntry = recoveryTarget ?? (message?.text.startsWith("storage_unknown:") ? workspace : null);
  const recovery = recoveryEntry && <section role="alert"><h2>ブラウザー内Gitの整合性確認</h2><p>前回の操作結果が未確定です。保存データを削除せず、Gitオブジェクトと作業状態を検証します。</p><button disabled={busy} onClick={() => void recoverStorage(recoveryEntry)}>保存データの整合性を確認</button></section>;
  const picker = <section className="workspace-picker" aria-labelledby="picker-heading">
      <div className="welcome-copy"><p className="eyebrow">A workspace that stays yours</p><h1 id="picker-heading">Open a GitHub workspace</h1><p>Open a repository in this browser, edit files offline, commit locally, and publish when you are ready.</p></div>
      <div className="picker-grid">
        <section className="picker-card" aria-labelledby="connect-heading">
          <div className="card-heading"><div><p className="eyebrow">REMOTE WORKSPACE</p><h2 id="connect-heading">GitHub</h2></div><span className="card-icon">↗</span></div>
          {account ? <>
            <p className="signed-in">Connected as <strong>{account.login}</strong><button type="button" className="text-button" onClick={signOut}>Sign out</button></p>
            <label htmlFor="repository-picker">Repository</label>
            <select id="repository-picker" value={selectedRepository ?? ""} onChange={event => {
              const id = Number(event.target.value) || null;
              setSelectedRepository(id);
              setSelectedBranch(repositories.find(item => item.id === id)?.defaultBranch ?? "");
            }}>
              <option value="">Choose a repository</option>
              {repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.fullName}{repository.private ? " · private" : ""}</option>)}
            </select>
            {selectedRepositoryEntry && <><label htmlFor="workspace-branch">Branch</label><input id="workspace-branch" value={selectedBranch} onChange={event => setSelectedBranch(event.target.value)} placeholder={selectedRepositoryEntry.defaultBranch} autoComplete="off" /><p className="repository-branch">Default: <code>{selectedRepositoryEntry.defaultBranch}</code></p></>}
            <button className="primary-button full-width" type="button" disabled={busy || !selectedRepositoryEntry || !selectedRepositoryEntry.permissions.pull || !selectedBranch.trim()} onClick={() => void openRemoteRepository()}>{busy ? "Opening…" : "Open workspace"}</button>
          </> : <>
            <label htmlFor="github-gateway">Proprium Gateway URL</label>
            <input id="github-gateway" type="url" value={gatewayDraft} onChange={event => updateGateway(event.target.value)} placeholder="https://gateway.example.com" autoComplete="url" />
            <p className="field-help">The Gateway handles GitHub device authorization and restricted Git transport. Browser GitHub REST calls remain direct. It does not store repository files or local Git data.</p>
            {devicePrompt && <div className="device-prompt"><span>Enter this code on GitHub</span><strong>{devicePrompt.userCode}</strong><a href={devicePrompt.verificationUri} target="_blank" rel="noreferrer">Open GitHub device sign-in</a><span className="field-help">Waiting for authorization…</span></div>}
            <button className="primary-button full-width" type="button" disabled={busy} onClick={() => void connectGitHub()}>{busy ? "Connecting…" : "Connect GitHub"}</button>
          </>}
        </section>
        <section className="picker-card recent-card" aria-labelledby="recent-heading">
          <div className="card-heading"><div><p className="eyebrow">THIS DEVICE</p><h2 id="recent-heading">Recent workspaces</h2></div><span className="card-icon">◷</span></div>
          <p className="field-help">Available offline after they have been opened in this browser. Local changes remain vulnerable to browser storage loss until GitHub confirms publication.</p>
          {recent.length ? <ul className="recent-list">{recent.map(entry => <li key={entry.identity.localWorkspaceId}><button type="button" className="recent-workspace" disabled={busy} onClick={() => void selectRecent(entry)}><span><strong>{entry.title}</strong><small>{entry.identity.branch} · opened {new Date(entry.lastOpened).toLocaleDateString()}</small></span><span aria-hidden="true">→</span></button></li>)}</ul> : <div className="empty-state"><span>◇</span><p>No local workspaces yet</p></div>}
        </section>
      </div>
      <p className="locality-note"><span>●</span> Editing and Git run in this browser. GitHub is the shared source of truth; local commits are not published automatically.</p>
    </section>;
  const library = workspace ? <div className="host-controls"><section className="sidebar-section">
            <div className="section-title-row"><h2>Files</h2><span className="count-badge">{files.filter(file => file.type === "blob").length}</span></div>
            <form className="new-file-form" onSubmit={event => { event.preventDefault(); void createFile(); }}>
              <label className="sr-only" htmlFor="new-file-path">New file path</label><input id="new-file-path" value={newPath} onChange={event => setNewPath(event.target.value)} placeholder="New file path" maxLength={1024} />
              <button type="submit" aria-label="Create new file" title="Create new file" disabled={busy}>+</button>
            </form>
            {files.length ? <ul className="file-list" aria-label="Repository files">{files.filter(file => file.type === "blob").map(file => <li key={file.path}><button type="button" aria-current={currentFile?.path === file.path ? "page" : undefined} className={`file-row ${currentFile?.path === file.path ? "file-selected" : ""}`} onClick={() => void loadFile(file.path)}><span className="file-icon" aria-hidden="true">{fileIcon(file.path)}</span><span className="file-path">{file.path}</span>{changedPaths.has(file.path) && <span className="change-dot" aria-label="Local change" />}</button></li>)}</ul> : <p className="sidebar-empty">This repository has no files yet.</p>}
          </section>
          <section className="sidebar-section sync-sidebar-section">
            <div className="section-title-row"><h2>GitHub</h2><span className={`connection-indicator ${syncClient ? "connected" : "local-only"}`} aria-label={syncClient ? "Connected to GitHub" : "Local workspace only"} /></div>
            {syncClient ? <div className="sync-actions"><button type="button" onClick={() => void fetchRemote()} disabled={busy}>Fetch</button><button type="button" onClick={() => void pullRemote()} disabled={busy}>Pull</button><button type="button" className="publish-button" onClick={() => void publishRemote()} disabled={busy || status.localState !== "local-committed"}>Publish</button></div> : <p className="sidebar-empty">Sign in to enable remote sync. Local editing remains available offline.</p>}
          </section>
</div> : picker;
  const tools = <div className="host-controls">{git && workspace && <PluginPanel
            workspaceId={activeWorkspaceId!}
            git={git}
            revisionKey={pluginRevisionKey}
            canApplyChanges={!currentFile?.dirty}
            hostBusy={busy}
            onBusyChange={setBusy}
            onWorkspaceChanged={refreshAfterPlugin}
            onRegisterLiveInvoker={registerLivePluginInvoker}
          />}
          {git && workspace && <LiveMcpPanel
            gatewayUrl={gatewayDraft}
            onGatewayUrlChange={updateGateway}
            workspaceId={workspace.identity.localWorkspaceId}
            generation={workspaceGeneration}
            identity={workspace.identity}
            git={git}
            canApply={!currentFile?.dirty}
            onWorkspaceChanged={refreshAfterPlugin}
            onExecutePlugin={executeLivePlugin}
          />}
</div>;
  const inspector = <div className="host-controls"><button onClick={() => revealPanel("history")}>History</button>{recovery}<section className="commit-panel" aria-labelledby="commit-heading">
            <div className="dock-heading"><div><p className="eyebrow">LOCAL GIT</p><h2 id="commit-heading">Changes</h2></div><span className="count-badge">{status.entries.length}</span></div>
            <div className="change-summary" aria-live="polite">{status.entries.length ? `${status.entries.length} changed file${status.entries.length === 1 ? "" : "s"}` : status.head ? `Clean at ${status.head.slice(0, 10)}` : "No local commit yet"}</div>
            <label htmlFor="commit-message">Commit message</label><input id="commit-message" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} placeholder="Describe your changes" maxLength={100_000} />
            <div className="author-fields"><label>Git author name<input aria-label="Git author name" value={preferences.name} onChange={event => updatePreferences({ ...preferences, name: event.target.value })} placeholder="Name" /></label><label>Git author email<input aria-label="Git author email" type="email" value={preferences.email} onChange={event => updatePreferences({ ...preferences, email: event.target.value })} placeholder="name@example.com" /></label></div>
            <button type="button" className="primary-button commit-button" disabled={busy || !status.entries.length || !!currentFile?.dirty} onClick={() => void commitLocal()}>Commit locally</button>
            <p className="local-commit-note">A local commit stays on this device until you explicitly publish it.</p>
          </section>
</div>;
  const historyPanel = <div className="host-controls"><section className="history-panel" aria-labelledby="history-heading">
            <div className="dock-heading"><div><p className="eyebrow">REPOSITORY</p><h2 id="history-heading">History</h2></div><button type="button" className="text-button" disabled={busy} onClick={() => git && void git.log(40).then(setHistory).catch(error => setMessage({ tone: "error", text: errorMessage(error) }))}>Refresh</button></div>
            {history.length ? <ol className="history-list">{history.map(commit => <li key={commit.oid}><span className="commit-rail" aria-hidden="true" /><div><strong>{commit.message.split("\n")[0]}</strong><code>{commit.oid.slice(0, 10)}</code><small>{commit.author.name} · {new Date(commit.timestamp * 1000).toLocaleString()}</small></div></li>)}</ol> : <p className="sidebar-empty">No commits in this local workspace.</p>}
          </section>
</div>;
  const editor = workspace && git && currentFile ? <section className="restored-editor">
    <div className="host-file-actions"><strong aria-label="Current file">{currentFile.path}</strong><button disabled={busy || !currentFile.dirty || currentFile.binary} onClick={() => void saveDraft()}>Save draft</button><button disabled={busy} onClick={() => void deleteFile()}>Delete file</button></div>
    {currentFile.binary ? <p>Binary file · {currentFile.data?.byteLength ?? 0} bytes</p> : <RestoredEditor key={`${workspace.identity.localWorkspaceId}:${currentFile.path}`} workspace={workspace.identity} file={currentFile} head={status.head} published={syncState === "published"} localCommitted={!!status.head && status.entries.length === 0} busy={busy} authorScope={preferences.email || "local"} author={preferences} git={git}
      onChange={text => { setCurrentFile(previous => previous ? { ...previous, text, dirty: true } : previous); setSyncState("editing"); }}
      onSave={() => void saveDraft()} onCommit={() => revealPanel("inspector")} onPublish={() => void publishRemote()} canPublish={!!syncClient && status.localState === "local-committed" && !currentFile.dirty}
      onHistory={() => revealPanel("history")} onRegisterFlush={registerEditorFlush} onScratchApplied={refreshAfterPlugin} />}
  </section> : workspace ? <p>Choose a file to edit</p> : <p>作品ライブラリからWorkspaceを開いてください。</p>;
  const panels: WorkspacePanel[] = [
    { id: "editor", title: "原稿", render: () => <RetainedPanelSlot node={editorNode} /> },
    { id: "outline", title: "作品と構成", render: () => library },
    { id: "inspector", title: "文書と保存状態", render: () => inspector },
    { id: "history", title: "履歴", render: () => historyPanel },
    { id: "review", title: "レビューとツール", render: () => <RetainedPanelSlot node={toolsNode} /> },
  ];
  const statusSurface = <>{recovery}{message && <div className={`host-message message-${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}<button aria-label="Dismiss message" onClick={() => setMessage(null)}>×</button></div>}<span className="save-state" role="status">{workspace ? saveStateLabel(syncState, status.head) : "Browser workspace"}</span></>;
  const Shell = mode === "desktop" ? DesktopShell : MobileShell;
  return <main className="proprium-host restored-host" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy) void saveDraft(); } }}><Suspense fallback={<p>ワークスペースを開いています…</p>}><Shell mode={mode}
    header={<header className="topbar">{workspace && <button onClick={leaveWorkspace}>Workspaces</button>}<span>{workspace?.title ?? "Proprium"}</span><ThemeControl mode={theme} onChange={value => { setTheme(value); try { persistThemeMode(value); } catch { setMessage({ tone: "error", text: "外観設定を保存できませんでした。" }); } }} />{workspace && account && <button onClick={signOut}>Sign out</button>}</header>}
    documentTitle={currentFile?.path ?? workspace?.title ?? "Proprium"} documentContext={workspace?.identity.branch}
    desktopDurability={syncState === "published" ? "saved" : busy ? "checkpointing" : status.head && status.entries.length === 0 && !currentFile?.dirty ? "checkpointed" : "draft"}
    library={library} editor={workspace ? <RetainedPanelSlot node={editorNode} /> : editor} tools={<RetainedPanelSlot node={toolsNode} />} status={statusSurface} renderStatus={error => <>{statusSurface}{error && <p role="alert">{error}</p>}</>}
    onSwitchMode={async () => { if (!(await beforeLayoutChange())) return false; const next = mode === "desktop" ? "mobile" : "desktop"; setMode(next); try { localStorage.setItem("scriptorium:ui-mode", next); } catch { /* The active mode remains usable. */ } return true; }}
    workspaceScope={workspace?.identity.localWorkspaceId} panels={workspace ? panels : undefined} beforeLayoutChange={beforeLayoutChange} requestedPanel={requestedPanel} />
  </Suspense>{workspace && createPortal(tools, toolsNode, workspace.identity.localWorkspaceId)}{workspace && createPortal(editor, editorNode, `editor:${workspace.identity.localWorkspaceId}`)}</main>;

  function updatePreferences(value: { name: string; email: string }): void {
    setPreferences(value);
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); } catch { /* Optional local preference. */ }
  }
}

function saveStateLabel(state: SyncState, head: string | null): string {
  if (state === "editing") return "Unsaved editor text";
  if (state === "syncing") return "Syncing with GitHub";
  if (state === "published") return `Published · ${head?.slice(0, 8) ?? "confirmed"}`;
  if (state === "conflict") return "Conflict · local work preserved";
  if (state === "local-ahead") return `Local commits await Publish · ${head?.slice(0, 8) ?? "unpublished"}`;
  if (state === "remote-unknown") return "Remote state unknown";
  if (state === "offline") return "Offline · local only";
  if (state === "local-committed") return `Committed locally · ${head?.slice(0, 8) ?? "unpublished"}`;
  return "Draft on this device";
}
