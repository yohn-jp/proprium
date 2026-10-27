import { lazy, Suspense, useLayoutEffect, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { BrowserLocalGit, BrowserLocalGitError } from "../git/index.js";
import { isGitHubWorkspaceIdentity, validateWorkspaceIdentity } from "../git/protocol.js";
import type { CommitReviewSnapshot, CommitSummary, FileRevision, LocalWorkspaceIdentity, StatusEntry, WorkspaceIdentity } from "../git/protocol.js";
import { createGitHubAccountSession, GitHubSyncError } from "../git/github-sync.js";
import type { GitHubAccount, GitHubDevicePrompt, GitHubRepository, GitHubAccountSession, GitHubSyncClient } from "../git/github-sync.js";
import { WorkspaceFileBrowser } from "./WorkspaceFileBrowser.js";
import { WorkspaceTransferPanel, downloadWorkspaceFile } from "./WorkspaceTransferPanel.js";
import type { WorkspaceFile } from "../git/index.js";
import { GitHubDeviceAuthorization, GitHubAuthorizationError } from "./GitHubDeviceAuthorization.js";
import { GitHubRepositoryPicker } from "./GitHubRepositoryPicker.js";
import { GatewayAccessLink } from "./GatewayAccessLink.js";
import { GitHistoryPanel } from "./GitHistoryPanel.js";
import { ChangedFilesReview } from "./ChangedFilesReview.js";
import { createHostPluginManager, PluginPanel } from "./PluginPanel.js";
import { LiveMcpPanel } from "./LiveMcpPanel.js";
import "./authoring/authoring-surface.css";
import { createBrowserAuthoringService, type BrowserAuthoringService } from "../authoring/service.js";
import { createAuthoringWorkspacePanels, validateAuthoringSurfaceRegistrations, type AuthoringSurfaceRegistration } from "./authoring/WorkspaceAuthoringPanels.js";
import { AuthoringReview } from "./authoring/AuthoringReview.js";
import { AuthoringAssets } from "./authoring/AuthoringAssets.js";
import { AuthoringCommandMenu } from "./authoring/AuthoringCommandMenu.js";
import { NarrativeNavigation } from "./authoring/NarrativeNavigation.js";
import { NarrativePortableResume } from "./authoring/NarrativePortableResume.js";
import { SemanticTaskControls } from "./authoring/SemanticTaskControls.js";
import { ResearchCandidateControls } from "../authoring/ResearchCandidateControls.js";
import { useProviderConsent } from "./use-provider-consent.js";
import { ProviderSettingsStore } from "../authoring/provider-settings.js";
import { ProviderSettingsPanel } from "../authoring/provider-settings-panel.js";
import { PairedPreferenceSettingsPanel, type PairedPreferenceSnapshot } from "../authoring/preference-settings-panel.js";
import { HostWritingResumeStore, savedBodySha256, writingResumeScope, type HostWritingResume, type WritingResumeSelection } from "./writing-resume.js";

import { DesktopShell } from "../../../shells/desktop/DesktopShell.js";
import { ThemeControl } from "../../../components/ThemeControl.js";
import { applyThemeMode, loadThemeMode, persistThemeMode } from "../../../theme.js";
import type { WorkspacePanel } from "../../../application/contracts.js";
import { StorageRecoveryDialog } from "./StorageRecoveryDialog.js";
import { RestoredEditor } from "./RestoredEditor.js";
import { rememberRecentDocument, resolveRecentDocument } from "./recent-document.js";
import { WorkspaceDraftRecovery } from "./WorkspaceDraftRecovery.js";
import { discoverWorkspaceDrafts, draftBaseMatches } from "./workspace-drafts.js";
import type { JournalEntry } from "../../../storage/journal.js";
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
interface WorkspaceAuthTarget {
  git: BrowserLocalGit;
  identity: WorkspaceIdentity;
  generation: string;
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
    return value.filter((item): item is RecentWorkspace => {
      if (!item || typeof item !== "object" || typeof item.title !== "string" || typeof item.lastOpened !== "number" || !item.identity) return false;
      try { validateWorkspaceIdentity(item.identity as WorkspaceIdentity); return true; }
      catch { return false; }
    });
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
function newLocalWorkspaceId(): string { return `local-${crypto.randomUUID().replaceAll("-", "")}`; }
function errorMessage(error: unknown): string {
  if (error instanceof BrowserLocalGitError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "The operation could not be completed.";
}
function asText(data: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return null; }
}

export function HostApp(): ReactElement {
  const navigate = useNavigate();
  const [pluginManager] = useState(createHostPluginManager);
  const [editorNode] = useState(() => document.createElement("div"));
  const [toolsNode] = useState(() => document.createElement("div"));
  const [recent, setRecent] = useState<RecentWorkspace[]>(readRecentWorkspaces);
  const [gatewayDraft, setGatewayDraft] = useState(readGateway);
  const [gatewaySettingsOpen, setGatewaySettingsOpen] = useState(() => !readGateway());
  const [session, setSession] = useState<GitHubAccountSession | null>(null);
  const [account, setAccount] = useState<GitHubAccount | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [authStage, setAuthStage] = useState<"waiting" | "repositories" | "verifying" | null>(null);
  const [devicePrompt, setDevicePrompt] = useState<GitHubDevicePrompt | null>(null);
  const [workspaceAuthOpen, setWorkspaceAuthOpen] = useState(false);
  const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false);
  const settingsDialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => { if (desktopSettingsOpen && settingsDialog.current && !settingsDialog.current.open) settingsDialog.current.showModal(); }, [desktopSettingsOpen]);
  const [busy, setBusy] = useState(false);
  const [fileMutationBusy, setFileMutationBusy] = useState(false);
  const setFileOperationBusy = useCallback((value: boolean) => { setFileMutationBusy(value); setBusy(value); }, []);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [mcpProposalCount, setMcpProposalCount] = useState(0);
  const [selectedRepository, setSelectedRepository] = useState<number | null>(null);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("無題のワークスペース");
  const [workspace, setWorkspace] = useState<RecentWorkspace | null>(null);
  const [workspaceGeneration, setWorkspaceGeneration] = useState("");
  const [git, setGit] = useState<BrowserLocalGit | null>(null);
  const [syncClient, setSyncClient] = useState<GitHubSyncClient | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [status, setStatus] = useState<{ head: string | null; entries: StatusEntry[]; localState: "draft" | "local-committed" }>({ head: null, entries: [], localState: "draft" });
  const [history, setHistory] = useState<CommitSummary[]>([]);
  const [currentFile, setCurrentFile] = useState<OpenFile | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [reviewedSnapshot, setReviewedSnapshot] = useState<{ key: string; snapshot: CommitReviewSnapshot | null }>({ key: "", snapshot: null });
  const [reviewRefresh, setReviewRefresh] = useState(0);
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
  const composingRef = useRef(false);
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const selectedNarrativeScene = useRef<{ id: string; path: string; metadataRevision: string; manuscriptRevision: string;
    generation: string; savedBytes: Uint8Array | null } | null>(null);
  const writingPosition = useRef<{ path: string; sentenceIndex: number | null; scrollTop: number; selection: WritingResumeSelection | null } | null>(null);
  const resumeTimer = useRef<number | undefined>(undefined);
  const resumeSequence = useRef(0);
  const [hostResume, setHostResume] = useState<(HostWritingResume & { requestId: number; generation: string;
    authorScope: string; savedBytes: Uint8Array | null }) | undefined>();
  const [navigationSelection, setNavigationSelection] = useState<{ requestId: string; start: number; end: number }>();
  const editorFlush = useRef<(() => Promise<string | null>) | null>(null);
  const workspaceAuthDialog = useRef<HTMLDialogElement | null>(null);
  const workspaceAuthTarget = useRef<WorkspaceAuthTarget | null>(null);
  const registerEditorFlush = useCallback((flush: (() => Promise<string | null>) | null) => { editorFlush.current = flush; }, []);
  useEffect(() => applyThemeMode(theme), [theme]);
  useEffect(() => { if (workspace && currentFile) rememberRecentDocument(workspace.identity, currentFile.path); }, [workspace, currentFile?.path]);
  useEffect(() => {
    const dialog = workspaceAuthDialog.current;
    if (!dialog) return;
    if (workspaceAuthOpen && !dialog.open) dialog.showModal();
    else if (!workspaceAuthOpen && dialog.open) dialog.close();
  }, [workspaceAuthOpen]);
  useEffect(() => {
    if (!workspace && mode === "mobile") {
      const search = new URLSearchParams(location.search);
      if (search.get("view") !== "library") { search.set("view", "library"); navigate({ search: search.toString() }, { replace: true }); }
    }
  }, [workspace, mode, navigate]);
  const gitRef = useRef<BrowserLocalGit | null>(null);
  const workspaceRef = useRef<RecentWorkspace | null>(workspace);
  const workspaceGenerationRef = useRef(workspaceGeneration);
  const sessionRef = useRef<GitHubAccountSession | null>(null);
  const authorizationRef = useRef<AbortController | null>(null);
  const currentFileRef = useRef<OpenFile | null>(currentFile);
  const livePluginInvoker = useRef<((args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | null>(null);
  currentFileRef.current = currentFile;
  useEffect(() => () => { void pluginManager.dispose(); }, [pluginManager]);
  workspaceRef.current = workspace;
  workspaceGenerationRef.current = workspaceGeneration;
  function loadLocalResume(): HostWritingResume | null {
    const selected = workspaceRef.current;
    if (!selected) return null;
    try { return new HostWritingResumeStore(localStorage).load(writingResumeScope(selected.identity, preferencesRef.current.email || "local")); }
    catch { return null; }
  }
  function currentSavedPosition() {
    const scene = selectedNarrativeScene.current, position = writingPosition.current, file = currentFileRef.current;
    if (!scene || !position || !file || file.dirty || composingRef.current || scene.path !== file.path ||
        scene.savedBytes !== file.data || position.path !== file.path || scene.generation !== workspaceGenerationRef.current) return null;
    return { scene_id: scene.id, manuscript_path: scene.path, manuscript_revision: scene.manuscriptRevision,
      sentence_index: position.sentenceIndex, scroll_top: position.scrollTop };
  }
  async function persistWritingPosition(): Promise<void> {
    const selected = selectedNarrativeScene.current, position = writingPosition.current;
    const file = currentFileRef.current, activeWorkspace = workspaceRef.current;
    const authorScope = preferencesRef.current.email || "local";
    if (!selected || !position || !file?.data || !activeWorkspace || file.dirty || composingRef.current ||
        selected.generation !== workspaceGenerationRef.current || selected.path !== file.path || position.path !== file.path) return;
    let bodyRevision: string;
    try { bodyRevision = selected.savedBytes === file.data ? selected.manuscriptRevision : await savedBodySha256(file.data); }
    catch { return; }
    if (currentFileRef.current !== file || selectedNarrativeScene.current !== selected || writingPosition.current !== position ||
        workspaceRef.current !== activeWorkspace || file.dirty || composingRef.current || authorScope !== (preferencesRef.current.email || "local")) return;
    selected.manuscriptRevision = bodyRevision; selected.savedBytes = file.data;
    try { new HostWritingResumeStore(localStorage).save(writingResumeScope(activeWorkspace.identity, authorScope), {
      position: { scene_id: selected.id, manuscript_path: selected.path, metadata_revision: selected.metadataRevision,
        manuscript_revision: bodyRevision, draft_generation: null, sentence_index: position.sentenceIndex, scroll_top: position.scrollTop }, selection: position.selection,
    }); } catch { /* Optional resume state cannot interrupt editor or journal persistence. */ }
  }
  function captureWritingPosition(path: string, sentenceIndex: number | null, scrollTop: number, selection: WritingResumeSelection | null): void {
    writingPosition.current = { path, sentenceIndex, scrollTop, selection };
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => { void persistWritingPosition(); }, 100);
  }
  useEffect(() => { void persistWritingPosition(); }, [currentFile?.dirty, currentFile?.data]);
  useEffect(() => {
    const flush = () => { void persistWritingPosition(); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); window.clearTimeout(resumeTimer.current); };
  }, []);
  const [authoring, setAuthoring] = useState<BrowserAuthoringService | null>(null);
  const providerConsent = useProviderConsent();
  const [providerSettings] = useState(()=>new ProviderSettingsStore());
  const [providerSettingsEpoch,setProviderSettingsEpoch] = useState(0);
  const [authoringRegistrations, setAuthoringRegistrations] = useState<AuthoringSurfaceRegistration[]>([]);
  const [authoringEpoch, setAuthoringEpoch] = useState(0);
  const refreshAuthoring = useCallback(() => setAuthoringEpoch(value => value + 1), []);
  useEffect(() => {
    if (!git || !workspace) { setAuthoring(null); setAuthoringRegistrations([]); return; }
    const service = createBrowserAuthoringService({ manager: pluginManager, git, workspace: workspace.identity,
      onProviderConsent: providerConsent.request,
      provider: providerSettings.brokerConfiguration(),
      actorId: () => preferencesRef.current.email || "local",
      generation: workspaceGeneration,
      measureAssetCapacity: async input => {
        const estimate = await navigator.storage?.estimate().catch(() => undefined);
        const available = estimate?.quota !== undefined && estimate.usage !== undefined
          ? Math.max(0, estimate.quota - estimate.usage) : null;
        // Dictionary processing uses the admitted tokenizer. Model execution needs
        // a separately measured runtime/device policy and cannot infer support here.
        const dictionary = input.role === "dictionary";
        const wasm = typeof WebAssembly !== "undefined" && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        return { device_supported: dictionary && wasm && typeof indexedDB !== "undefined" && available !== null,
          available_storage_bytes: available, memory_required_bytes: null,
          device_requirements: [dictionary ? "辞書はプラグインのローカルWASMで処理します。原稿は送信しません。" : "この端末でのモデル実行は未検証です。"],
          ...(!dictionary ? { reason: "対応するモデル実行環境の容量検証が完了していません。" }
            : available === null ? { reason: "ブラウザーの保存容量を測定できません。" } : {}) };
      },
      getEditorState: () => ({ path: currentFileRef.current?.path ?? null, dirty: currentFileRef.current?.dirty ?? false,
        draft_generation: null, composing: composingRef.current, resume_position: currentSavedPosition() }),
      onNavigate: async (target, _intent, expected) => {
        if (gitRef.current !== git || workspaceGenerationRef.current !== workspaceGeneration) throw new Error("snapshot_stale");
        if (currentFileRef.current?.dirty) throw new Error("dirty_draft: save the current document before navigation");
        if (target.path) {
          const initial = currentFileRef.current;
          const read = await git.read(target.path);
          await git.assertAuthoringSnapshot(expected.snapshot.id);
          if (gitRef.current !== git || workspaceGenerationRef.current !== workspaceGeneration) throw new Error("snapshot_stale");
          if (composingRef.current || currentFileRef.current !== initial || currentFileRef.current?.dirty) throw new Error("dirty_draft");
          if (read.data === null) throw new Error("file_not_found");
          const text = asText(read.data);
          const opened: OpenFile = { path: target.path, data: read.data, revision: read.revision, text, binary: text === null, dirty: false };
          currentFileRef.current = opened; setCurrentFile(opened);
          setNavigationSelection(target.span ? { requestId: crypto.randomUUID(), start: target.span.start, end: target.span.end } : undefined);
          setRequestedPanel(value => ({ id: "editor", sequence: value.sequence + 1 }));
        }
        if (target.panel_id) setRequestedPanel(value => ({ id: target.panel_id!, sequence: value.sequence + 1 }));
      }, onMutationBusy: setFileOperationBusy });
    setAuthoring(service);
    void service.recoverProposal().catch(error => setMessage({ tone: "error", text: errorMessage(error) }));
    return () => { void service.dispose(); };
  }, [git, workspaceGeneration, pluginManager, providerSettingsEpoch]);
  useEffect(() => {
    let cancelled = false;
    if (authoring) void authoring.listSurfaces().then(values => { if (!cancelled) setAuthoringRegistrations(validateAuthoringSurfaceRegistrations(values)); })
      .catch(error => { if (!cancelled) setMessage({ tone: "error", text: errorMessage(error) }); });
    return () => { cancelled = true; };
  }, [authoring, authoringEpoch]);
  const invokeAuthoring = async (event: Event, pluginId: string, actionId: string, input: Readonly<Record<string, import("./authoring/types.js").AuthoringJson>>, invocationSource?: { readonly surfaceId: string; readonly resume?: HostWritingResume }) => {
    if (!authoring) throw new Error("repository_unavailable");
    const savedResume = invocationSource?.resume ?? (invocationSource?.surfaceId === "proprium.narrative.continue-writing" ? loadLocalResume() : null);
    const authorScope = preferencesRef.current.email || "local";
    const output = await authoring.invokeUiWithArtifacts(event, pluginId, actionId, input, savedResume ? result=>{
      if(pluginId!=="proprium.narrative"||actionId!=="proprium.narrative.scene.open"||!result.ok)return;
      const value=result.value as {scene?:{id?:string;metadata_revision?:string};manuscript_path?:string;manuscript_revision?:string};
      const position=savedResume.position;
      if(authorScope!==(preferencesRef.current.email||"local")||value.scene?.id!==position.scene_id||value.scene.metadata_revision!==position.metadata_revision||value.manuscript_path!==position.manuscript_path||value.manuscript_revision!==position.manuscript_revision)throw new Error("snapshot_stale: 保存位置の原稿または構成が変更されています。");
    } : undefined);
    const result = output.action_result;
    if (pluginId === "proprium.narrative" && actionId === "proprium.narrative.scene.open" && result.ok && result.value && typeof result.value === "object") {
      const value = result.value as { scene?: { id?: string; metadata_revision?: string }; manuscript_path?: string; manuscript_revision?: string };
      const file = currentFileRef.current, currentWorkspace = workspaceRef.current;
      if (value.scene?.id && value.scene.metadata_revision && value.manuscript_revision && file && file.path === value.manuscript_path && !file.dirty &&
          currentWorkspace?.identity.localWorkspaceId === result.scope.workspace_id && currentWorkspace.identity.branch === result.scope.branch &&
          workspaceGenerationRef.current === result.scope.generation) {
        selectedNarrativeScene.current = { id: value.scene.id, path: file.path, metadataRevision: value.scene.metadata_revision,
          manuscriptRevision: value.manuscript_revision, generation: result.scope.generation, savedBytes: file.data };
        if (savedResume && authorScope === (preferencesRef.current.email || "local") && savedResume.position.scene_id === value.scene.id &&
            savedResume.position.manuscript_path === file.path && savedResume.position.manuscript_revision === value.manuscript_revision) {
          writingPosition.current = { path: file.path, sentenceIndex: savedResume.position.sentence_index,
            scrollTop: savedResume.position.scroll_top, selection: savedResume.selection };
          setHostResume({ ...savedResume, requestId: ++resumeSequence.current, generation: result.scope.generation,
            authorScope, savedBytes: file.data });
        }
      }
    }
    refreshAuthoring();
    const source = output.artifact;
    if (!source) return { action_result: output.action_result };
    return { action_result: output.action_result, artifact: {
      metadata: { filename: source.metadata.filename, media_type: source.metadata.media_type, bytes: source.metadata.total_bytes, sha256: source.metadata.sha256 },
      text_preview_available: source.metadata.media_type.startsWith("text/"),
      previewText: (maxChars: number) => source.previewText(maxChars),
      download: async (downloadEvent: Event) => { const blob = await source.readAll(downloadEvent); const url = URL.createObjectURL(blob);
        try { const link = document.createElement("a"); link.href = url; link.download = source.metadata.filename; link.click(); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 1000); } },
      print: async (printEvent: Event, preset: import("./authoring/types.js").AuthoringPrintPreset) => {
        const popup = window.open("", "_blank"); if (!popup) throw new Error("印刷ウィンドウを許可してください");
        try { const blob = await source.readAll(printEvent); const text = await blob.text();
          const pre = popup.document.createElement("pre"); pre.textContent = text;
          pre.style.whiteSpace = "pre-wrap"; pre.style.fontFamily = "serif";
          if (preset !== "web-novel") pre.style.writingMode = "vertical-rl";
          popup.document.body.replaceChildren(pre); popup.opener = null; popup.print();
        } catch (error) { popup.close(); throw error; }
      },
    } };
  };
  const readAuthoring = async (pluginId: string, actionId: string, input: Readonly<Record<string, import("./authoring/types.js").AuthoringJson>>, signal: AbortSignal) => {
    if (!authoring) throw new Error("repository_unavailable");
    if (pluginId === "proprium.narrative" && actionId === "proprium.narrative.scene.continue" && !Object.hasOwn(input,"resume_position")) {
      return authoring.invokeRead(pluginId, actionId, { resume_position: loadLocalResume()?.position ?? null }, signal);
    }
    return authoring.invokeRead(pluginId, actionId, input, signal);
  };
  const navigateAuthoring = async (event: Event, target: import("../authoring/service.js").AuthoringNavigationTarget, intent: "open" | "reveal") => {
    if (!authoring) throw new Error("repository_unavailable");
    await authoring.navigate(event, target, intent);
  };
  const activeWorkspaceId = workspace?.identity.localWorkspaceId ?? null;
  const selectedRepositoryEntry = repositories.find(item => item.id === selectedRepository) ?? null;
  const changedPaths = useMemo(() => new Set(status.entries.map(entry => entry.path)), [status.entries]);
  const reviewSnapshotKey = JSON.stringify([workspaceGeneration, reviewRefresh, status.head, files.map(file => [file.path, file.oid]), status.entries]);
  const commitReviewed = reviewedSnapshot.key === reviewSnapshotKey && reviewedSnapshot.snapshot !== null;
  const receiveCommitReview = useCallback((snapshot: CommitReviewSnapshot | null) => setReviewedSnapshot({ key: reviewSnapshotKey, snapshot }), [reviewSnapshotKey]);

  const refresh = useCallback(async (targetGit: BrowserLocalGit, targetWorkspace: RecentWorkspace): Promise<void> => {
    const next = await loadWorkspaceState(targetGit);
    if (gitRef.current !== targetGit || workspaceRef.current?.identity.localWorkspaceId !== targetWorkspace.identity.localWorkspaceId) return;
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
      const nextSync = attachedSession && isGitHubWorkspaceIdentity(entry.identity) ? nextGit.connectGitHubSession(attachedSession) : null;
      await nextGit.init();
      const nextState = await loadWorkspaceState(nextGit);
      const resumePath = resolveRecentDocument(entry.identity, nextState.files.map(file => file.path));
      const resumeRead = resumePath ? await nextGit.read(resumePath) : null;
      const resumeText = resumeRead?.data ? asText(resumeRead.data) : "";
      const resumed: OpenFile | null = resumePath && resumeRead ? { path: resumePath, data: resumeRead.data, revision: resumeRead.revision, text: resumeText, binary: resumeRead.data !== null && resumeText === null, dirty: false } : null;
      const liveFile = currentFileRef.current;
      if (liveFile?.dirty && (!discardConfirmed || liveFile.path !== initialFile?.path || liveFile.text !== initialFile?.text) &&
          !window.confirm("The editor changed while the workspace was loading. Discard the newer text and continue?")) {
        nextGit.close();
        return;
      }
      const previousGit = gitRef.current;
      const generation = crypto.randomUUID();
      gitRef.current = nextGit;
      workspaceRef.current = entry;
      workspaceGenerationRef.current = generation;
      setGit(nextGit);
      setSyncClient(nextSync);
      setWorkspace(entry);
      setWorkspaceGeneration(generation);
      setCurrentFile(resumed);
      if (resumed) setRequestedPanel(value => ({ id: "editor", sequence: value.sequence + 1 }));
      setStatus(nextState.status);
      setFiles(nextState.files);
      setHistory(nextState.history);
      setSyncState(nextState.status.entries.length || !nextState.status.head ? "local-draft" : "local-committed");
      setRecent(existing => rememberWorkspace(entry, existing));
      previousGit?.close();
      setMessage({ tone: "info", text: isGitHubWorkspaceIdentity(entry.identity)
        ? "この端末の作品を開きました。ファイルや履歴はGitHubへ公開するまで端末内に保存されます。"
        : "ローカル作品を開きました。文書と履歴はこのブラウザー内に保存されます。" });
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

  useEffect(() => () => { authorizationRef.current?.abort(); gitRef.current?.close(); sessionRef.current?.signOut(); }, []);

  function workspaceAuthTargetIsCurrent(target: WorkspaceAuthTarget): boolean {
    const active = workspaceRef.current;
    if (!active || !isGitHubWorkspaceIdentity(active.identity) || !isGitHubWorkspaceIdentity(target.identity)) return false;
    return gitRef.current === target.git && workspaceGenerationRef.current === target.generation && !!active &&
      active.identity.localWorkspaceId === target.identity.localWorkspaceId &&
      active.identity.origin === target.identity.origin &&
      active.identity.repositoryId === target.identity.repositoryId &&
      active.identity.owner === target.identity.owner &&
      active.identity.repository === target.identity.repository &&
      active.identity.branch === target.identity.branch;
  }

  function openWorkspaceGitHubAuth(): void {
    if (!workspace || !git || !isGitHubWorkspaceIdentity(workspace.identity)) return;
    workspaceAuthTarget.current = { git, identity: { ...workspace.identity }, generation: workspaceGeneration };
    setMessage(null);
    setWorkspaceAuthOpen(true);
  }

  async function connectGitHub(target?: WorkspaceAuthTarget): Promise<void> {
    const configuredGateway = gatewayDraft.trim();
    if (!configuredGateway) { setMessage({ tone: "error", text: "Enter the Proprium Gateway URL configured for this Host." }); return; }
    setBusy(true);
    setMessage(null);
    const controller = new AbortController();
    authorizationRef.current?.abort(); authorizationRef.current = controller;
    let accountSession: GitHubAccountSession | null = null;
    try {
      accountSession = createGitHubAccountSession(configuredGateway);
      const prompt = await accountSession.beginAuthorization();
      if (controller.signal.aborted || authorizationRef.current !== controller) {
        accountSession.signOut();
        return;
      }
      sessionRef.current?.signOut();
      sessionRef.current = accountSession;
      setSession(accountSession);
      setDevicePrompt(prompt); setAuthStage("waiting");
      if (!target) { setAccount(null); setRepositories([]); setSelectedRepository(null); setSelectedBranch(""); }
      setMessage({ tone: "info", text: `Enter code ${prompt.userCode} at GitHub, then return here. This page will finish sign-in automatically.` });
      const signedIn = await accountSession.completeAuthorization(controller.signal);
      if (controller.signal.aborted || authorizationRef.current !== controller) return;
      if (target) {
        if (!isGitHubWorkspaceIdentity(target.identity)) {
          throw new GitHubSyncError("repository_mismatch", "A local-only workspace has no GitHub repository to verify.");
        }
        if (!workspaceAuthTargetIsCurrent(target)) {
          throw new GitHubSyncError("authentication_required", "The active Workspace changed during GitHub sign-in. Local work was left untouched; reopen its GitHub connection.");
        }
        setAuthStage("verifying");
        const attachedClient = target.git.connectGitHubSession(accountSession);
        const confirmed = await attachedClient.remoteHead();
        if (controller.signal.aborted || authorizationRef.current !== controller) return;
        if (!workspaceAuthTargetIsCurrent(target)) {
          throw new GitHubSyncError("authentication_required", "The active Workspace changed while GitHub verified its repository. No connection was attached.");
        }
        if (confirmed.repositoryId !== target.identity.repositoryId || confirmed.branch !== target.identity.branch) {
          throw new GitHubSyncError("repository_mismatch", "GitHub did not confirm the immutable repository ID and branch for this Workspace.");
        }
        const available = await accountSession.repositories();
        if (controller.signal.aborted || authorizationRef.current !== controller) return;
        if (!workspaceAuthTargetIsCurrent(target)) {
          throw new GitHubSyncError("authentication_required", "The active Workspace changed while GitHub loaded the repository picker. No connection was attached.");
        }
        setSyncClient(attachedClient);
        setAccount(signedIn);
        setRepositories(available);
        setDevicePrompt(null);
        try { localStorage.setItem(GATEWAY_KEY, configuredGateway); } catch { /* Configuration can be entered again. */ }
        workspaceAuthTarget.current = null;
        setWorkspaceAuthOpen(false);
        setMessage({ tone: "success", text: `Connected this Workspace to GitHub as ${signedIn.login}. Fetch is available when you are ready; no remote changes were fetched or published.` });
        return;
      }
      setAuthStage("repositories");
      const available = await accountSession.repositories();
      if (controller.signal.aborted || authorizationRef.current !== controller) return;
      setAccount(signedIn);
      setRepositories(available);
      setDevicePrompt(null);
      try { localStorage.setItem(GATEWAY_KEY, configuredGateway); } catch { /* Configuration can be entered again. */ }
      setMessage({ tone: "success", text: `Connected to GitHub as ${signedIn.login}. Choose a repository to open.` });
    } catch (error) {
      accountSession?.signOut();
      if (authorizationRef.current !== controller) return;
      setDevicePrompt(null);
      setMessage({ tone: "error", text: errorMessage(error) });
      if (sessionRef.current === accountSession) sessionRef.current = null;
      setSession(null); setAccount(null); setRepositories([]);
      if (target && !workspaceAuthTargetIsCurrent(target)) {
        workspaceAuthTarget.current = null;
        setWorkspaceAuthOpen(false);
      }
    } finally { if (authorizationRef.current === controller) { authorizationRef.current = null; setAuthStage(null); setBusy(false); } }
  }

  function cancelGitHubAuthorization(): void {
    authorizationRef.current?.abort(); authorizationRef.current = null;
    sessionRef.current?.signOut(); sessionRef.current = null;
    workspaceAuthTarget.current = null;
    setSession(null); setAccount(null); setRepositories([]); setDevicePrompt(null); setAuthStage(null); setBusy(false);
    setMessage({ tone: "info", text: "GitHub sign-in canceled. Local workspaces remain available." });
  }

  function closeWorkspaceGitHubAuth(): void {
    cancelGitHubAuthorization();
    setWorkspaceAuthOpen(false);
  }

  async function createLocalWorkspace(): Promise<void> {
    const name = newWorkspaceName.trim();
    if (!name) { setMessage({ tone: "error", text: "Enter a name for this local workspace." }); return; }
    const identity: LocalWorkspaceIdentity = {
      provider: "local",
      name,
      branch: "main",
      localWorkspaceId: newLocalWorkspaceId(),
    };
    const entry: RecentWorkspace = { identity, title: name, lastOpened: Date.now() };
    await openLocalWorkspace(entry);
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
    const entry = recent.find(item => isGitHubWorkspaceIdentity(item.identity) && item.identity.repositoryId === identity.repositoryId && item.identity.branch === identity.branch)
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
      const generation = crypto.randomUUID();
      gitRef.current = nextGit;
      workspaceRef.current = entry;
      workspaceGenerationRef.current = generation;
      setGit(nextGit);
      setSyncClient(nextSync);
      setWorkspace(entry);
      setWorkspaceGeneration(generation);
      setCurrentFile(null);
      setStatus(initial.status);
      setFiles(initial.files);
      setHistory(initial.history);
      setSyncState(initial.status.entries.length || !initial.status.head ? "local-draft" : "local-committed");
      setRecent(existing => rememberWorkspace(entry, existing));
      previousGit?.close();
      setSyncState("syncing");
      setMessage({ tone: "info", text: "GitHubからWorkspaceを取得しています。初回はGit履歴とファイルをこのブラウザーへ取り込みます。" });
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
    await openLocalWorkspace(entry, isGitHubWorkspaceIdentity(entry.identity) ? session ?? undefined : undefined);
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
      if (gitRef.current !== git || workspaceRef.current?.identity.localWorkspaceId !== workspace.identity.localWorkspaceId) return;
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

  async function createFile(path: string): Promise<void> {
    if (!git || !workspace) return;
    const initialFile = currentFileRef.current;
    const discardConfirmed = Boolean(initialFile?.dirty && window.confirm("Discard unsaved editor text and create another file?"));
    if (initialFile?.dirty && !discardConfirmed) return;
    if (!path) { setMessage({ tone: "error", text: "Enter a repository-relative file path." }); return; }
    setBusy(true);
    try {
      const read = await git.read(path);
      if (gitRef.current !== git || workspaceRef.current?.identity.localWorkspaceId !== workspace.identity.localWorkspaceId) return;
      const liveFile = currentFileRef.current;
      if (liveFile?.dirty && (!discardConfirmed || liveFile.path !== initialFile?.path || liveFile.text !== initialFile?.text) &&
          !window.confirm("The editor changed while the new file was loading. Discard the newer text and continue?")) return;
      if (read.data !== null) throw new Error(`File already exists: ${path}`);
      setCurrentFile({ path, data: null, revision: read.revision, text: "", binary: false, dirty: true });
      setSyncState("editing");
      setRequestedPanel(value => ({ id: "editor", sequence: value.sequence + 1 }));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".cm-content")?.focus());
    } catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); }
    finally { setBusy(false); }
  }

  async function beforeFileMutation(): Promise<boolean> {
    const targetGit = git;
    try {
      const flushed = await editorFlush.current?.();
      const current = currentFileRef.current;
      return gitRef.current === targetGit && !current?.dirty && (flushed == null || !current || flushed === current.text);
    } catch { return false; }
  }

  async function openRecoveredDraft(entry: JournalEntry): Promise<void> {
    const targetGit = gitRef.current, targetWorkspace = workspaceRef.current;
    const targetGeneration = workspaceGenerationRef.current;
    if (!targetGit || !targetWorkspace || !(await beforeLayoutChange())) return;
    const initialFile = currentFileRef.current;
    if (initialFile?.dirty && !window.confirm("現在の入力は回復用に保護されています。選んだ下書きへ切り替えますか？")) return;
    setBusy(true); setMessage(null);
    try {
      if (!discoverWorkspaceDrafts([entry], targetWorkspace.identity, preferences.email || "local").length) throw new Error("この作品・作者の下書きではありません。");
      const current = await targetGit.read(entry.documentPath);
      if (!(await draftBaseMatches(entry, current.data))) throw new Error("元のファイルは下書きの記録後に変更されています。下書きは保持しています。現在の文書を確認してから回復してください。");
      if (gitRef.current !== targetGit || workspaceGenerationRef.current !== targetGeneration || currentFileRef.current !== initialFile) return;
      setCurrentFile({ path: entry.documentPath, data: current.data, revision: current.revision, text: entry.text, binary: false, dirty: true });
      setSyncState("editing");
      setRequestedPanel(value => ({ id: "editor", sequence: value.sequence + 1 }));
      setMessage({ tone: "info", text: "保護された下書きを開きました。ファイルへの保存はまだ行っていません。" });
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
      if (gitRef.current !== git || workspaceRef.current?.identity.localWorkspaceId !== workspace?.identity.localWorkspaceId) return;
      const latest = currentFileRef.current;
      if (latest?.path === savingFile.path && latest.dirty && latest.text !== savingFile.text) {
        setCurrentFile({ ...latest, data, revision, dirty: true });
      } else {
        setCurrentFile({ ...savingFile, data, revision, dirty: false });
      }
      await refresh(git, workspace!);
      if (currentFileRef.current?.dirty) setSyncState("editing");
      setMessage({ tone: "success", text: `${savingFile.path} saved to this browser's local Git worktree. It has not been sent to a remote.` });
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
    if (!commitReviewed) { setMessage({ tone: "error", text: "変更したファイルの内容を確認してからコミットしてください。" }); return; }
    if (!git || !workspace) return;
    if (currentFile?.dirty) { setMessage({ tone: "error", text: "Save the current editor text to the local worktree before committing." }); return; }
    if (!commitMessage.trim()) { setMessage({ tone: "error", text: "Enter a commit message." }); return; }
    if (!preferences.name.trim() || !preferences.email.includes("@")) { setMessage({ tone: "error", text: "Enter a Git author name and valid email address." }); return; }
    setBusy(true); setCheckpointBusy(true);
    try {
      const snapshot = reviewedSnapshot.snapshot;
      if (!snapshot) return;
      const committed = await git.commitReviewed(commitMessage, preferences, snapshot);
      setCommitMessage("");
      setSyncState("local-committed");
      await refresh(git, workspace);
      setMessage({ tone: "success", text: `Committed locally as ${committed.oid}. This commit is still only on this device.` });
    } catch (error) {
      if (error instanceof BrowserLocalGitError && error.code === "revision_conflict") {
        setReviewedSnapshot({ key: "", snapshot: null });
        setReviewRefresh(value => value + 1);
        await refresh(git, workspace).catch(() => undefined);
        setMessage({ tone: "error", text: "レビュー後に作品が変更されました。差分を読み込み直して、すべての変更をもう一度確認してください。" });
      } else setMessage({ tone: "error", text: errorMessage(error) });
    }
    finally { setBusy(false); setCheckpointBusy(false); }
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
    setBusy(true); setPublishBusy(true); setSyncState("syncing");
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
    finally { setBusy(false); setPublishBusy(false); }
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
      setSyncClient(null);
      sessionRef.current?.signOut(); sessionRef.current = null;
    }
    setMessage({ tone: "error", text });
  }

  function leaveWorkspace(): void {
    if (currentFile?.dirty && !window.confirm("This file has edits not saved to the local worktree. Leave and discard those edits?")) return;
    workspaceRef.current = null;
    workspaceGenerationRef.current = "";
    workspaceAuthTarget.current = null;
    setWorkspaceAuthOpen(false);
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
    setSession(null); setAccount(null); setRepositories([]); setDevicePrompt(null); setSyncClient(null);
    setMessage({ tone: "info", text: "Signed out. Local workspaces remain on this device." });
  };

  const registerLivePluginInvoker = useCallback((invoker: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | null): void => {
    livePluginInvoker.current = invoker;
  }, []);
  const executeLivePlugin = useCallback(async (args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    if (authoring && typeof args.pluginId === "string" && typeof args.operation === "string" && args.operation !== "run") {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (args.operation === "actions.list") {
        const input = args.input ?? {};
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "cursor" && key !== "limit")) throw new Error("invalid_input: action discovery accepts cursor and limit only");
        const { cursor, limit } = input as Record<string, unknown>;
        if ((cursor !== undefined && typeof cursor !== "string") || (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100))) throw new Error("invalid_input: invalid action discovery page");
        return authoring.actions(args.pluginId, "mcp", cursor as string | undefined, limit as number | undefined);
      }
      if (!args.input || typeof args.input !== "object" || Array.isArray(args.input)) throw new Error("invalid_input: typed action input must be an object");
      if (args.idempotency_key !== undefined && (typeof args.idempotency_key !== "string" || !args.idempotency_key || args.idempotency_key.length > 256)) throw new Error("invalid_input: invalid action envelope idempotency key");
      const result = await authoring.invokeMcp(args.pluginId, args.operation, args.input as Record<string, unknown>, "live-mcp", undefined, args.idempotency_key as string | undefined, signal);
      refreshAuthoring();
      return result;
    }
    const invoke = livePluginInvoker.current;
    if (!invoke) throw new Error("Open the Plugins panel and enable a WASM plugin before calling plugin_call.");
    return invoke(args, signal);
  }, [authoring, refreshAuthoring]);
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
  const researchScopeKey=JSON.stringify([workspaceGeneration,status.head,status.entries.map(entry=>[entry.path,entry.worktree,entry.stage]),preferences.email,
    authoringRegistrations.filter(row=>row.pluginId==="proprium.research").map(row=>[row.manifestDigest,row.status])]);
  const researchScopeRef=useRef(researchScopeKey);researchScopeRef.current=researchScopeKey;
  const selectedScene=selectedNarrativeScene.current;
  const sceneContext:Record<string,string>=selectedScene&&selectedScene.path===currentFile?.path&&selectedScene.generation===workspaceGeneration ? {
    scene_id:selectedScene.id,manuscript_path:selectedScene.path,metadata_revision:selectedScene.metadataRevision,manuscript_revision:selectedScene.manuscriptRevision,
  } : {};
  // Nonsecret identifiers only; never copy the editor or Draft into a plugin form.
  const contextualAuthoringRegistrations=authoringRegistrations.map(row=>row.pluginId==="proprium.speaker"||row.pluginId==="proprium.knowledge" ? {
    ...row,data:{...(row.data&&typeof row.data==="object"&&!Array.isArray(row.data)?row.data:{}),host_context:sceneContext},
  } : row);

  const revealPanel = (id: string): void => setRequestedPanel(value => ({ id, sequence: value.sequence + 1 }));
  const beforeLayoutChange = async (): Promise<boolean> => {
    try { await editorFlush.current?.(); return true; }
    catch (error) { setMessage({ tone: "error", text: errorMessage(error) }); return false; }
  };
  const recoverStorage = async (entry: RecentWorkspace): Promise<void> => {
    setBusy(true);
    setRecoveryTarget(entry);
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

  const recentCard = <section className="picker-card recent-card" aria-labelledby="recent-heading">
          <div className="card-heading"><div><p className="eyebrow">この端末</p><h2 id="recent-heading">最近開いた作品</h2></div><span className="card-icon">◷</span></div>
          <p className="field-help">このブラウザーに保存されます。GitHubの作品は、ファイルを読み込んだ後であればオフラインでも開けます。</p>
          {recent.length ? <ul className="recent-list">{recent.map(entry => <li key={entry.identity.localWorkspaceId}><button type="button" className="recent-workspace" disabled={busy} onClick={() => void selectRecent(entry)}><span><strong>{entry.title}</strong><small>{entry.identity.branch} · {isGitHubWorkspaceIdentity(entry.identity) ? "GitHub" : "ローカルのみ"} · {new Date(entry.lastOpened).toLocaleDateString()}に開きました</small></span><span aria-hidden="true">→</span></button></li>)}</ul> : <div className="empty-state"><span>◇</span><p>まだ作品を開いていません</p></div>}
        </section>;
  const picker = <section className="workspace-picker" aria-labelledby="picker-heading">
      <div className="welcome-copy"><p className="eyebrow">文書と履歴を手元に</p><h1 id="picker-heading">作品を作る・開く</h1><p>この端末で作品を作成して、すぐに編集を始められます。GitHubのリポジトリを開けば、リモートと同期できます。</p></div>
      <div className="picker-grid">
        <section className="picker-card local-start-card" aria-labelledby="local-start-heading">
          <div className="card-heading"><div><p className="eyebrow">ローカルの作品</p><h2 id="local-start-heading">この端末で書き始める</h2></div><span className="card-icon">✎</span></div>
          <p className="field-help">ログインなしで文書を作成し、この端末で編集できます。</p>
          <label htmlFor="new-workspace-name">作品名</label>
          <input id="new-workspace-name" value={newWorkspaceName} onChange={event => setNewWorkspaceName(event.target.value)} maxLength={120} autoComplete="off" />
          <button className="primary-button full-width" type="button" disabled={busy || !newWorkspaceName.trim()} onClick={() => void createLocalWorkspace()}>{busy ? "作成中…" : "ローカル作品を作成"}</button>
          <p className="field-help">端末内のファイルと履歴はブラウザーに保存されます。バックアップには書出しやGitHubへの公開を利用してください。</p>
        </section>
        <section className="picker-card" aria-labelledby="connect-heading">
          <div className="card-heading"><div><p className="eyebrow">GitHubの作品</p><h2 id="connect-heading">GitHub</h2></div><span className="card-icon">↗</span></div>
          {account ? <>
            <p className="signed-in">GitHubに接続中: <strong>{account.login}</strong><button type="button" className="text-button" onClick={signOut}>GitHubからログアウト</button></p>
            <GitHubRepositoryPicker session={session} repositories={repositories} selectedRepositoryId={selectedRepository} selectedBranch={selectedBranch}
              onRepositoryChange={repository => { setSelectedRepository(repository?.id ?? null); setSelectedBranch(""); }}
              onBranchChange={setSelectedBranch} onReconnect={() => void connectGitHub()} disabled={busy} idPrefix="workspace" />
            <button className="primary-button full-width" type="button" disabled={busy || !selectedRepositoryEntry || !selectedRepositoryEntry.permissions.pull || !selectedBranch.trim()} onClick={() => void openRemoteRepository()}>{busy ? "読込中…" : "作品を開く"}</button>
          </> : <>
            <details className="gateway-settings" open={gatewaySettingsOpen} onToggle={event => setGatewaySettingsOpen(event.currentTarget.open)}><summary>接続先設定</summary>
              <label htmlFor="github-gateway">Proprium Gateway URL</label>
              <input id="github-gateway" type="url" value={gatewayDraft} onChange={event => updateGateway(event.target.value)} placeholder="https://gateway.example.com" autoComplete="url" />
              <p className="field-help">通常は変更不要です。セルフホストのGatewayを利用する場合だけ変更してください。</p>
            </details>
            <p className="field-help">Cloudflare Accessで保護されたGatewayを使用する場合は、先にGatewayの認証画面を開いてログインしてください。完了後、この画面に戻ってGitHubへ接続します。</p>
      <GatewayAccessLink gatewayUrl={gatewayDraft} />
            {devicePrompt && <GitHubDeviceAuthorization prompt={devicePrompt} stage={authStage ?? "waiting"} onCancel={cancelGitHubAuthorization} onRetry={() => void connectGitHub()} retryDisabled={busy} />}
            {message?.tone === "error" && <GitHubAuthorizationError message={message.text} disabled={busy} onRetry={() => void connectGitHub()} />}
            <button className="primary-button full-width" type="button" disabled={busy} onClick={() => void connectGitHub()}>{busy ? "接続中…" : "GitHubに接続"}</button>
          </>}
        </section>
        {mode === "mobile" && recentCard}
      </div>
      <p className="locality-note"><span>●</span> 端末内の保存とGitHubへの公開は別の操作です。公開は選んだときだけ行います。</p>
    </section>;
  const library = workspace ? <div className="host-controls"><WorkspaceFileBrowser
            git={git!} files={files} selectedPath={currentFile?.path ?? null} pendingPath={currentFile?.data === null ? currentFile.path : undefined}
            changedPaths={changedPaths} busy={busy} canModify={!currentFile?.dirty} onBusyChange={setFileOperationBusy} beforeApply={beforeFileMutation}
            onSelect={path => { if (path === currentFile?.path) revealPanel("editor"); else void loadFile(path); }} onCreate={createFile}
            onMoved={async (from, to) => { const targetGit = git!, targetWorkspace = workspace, wasSelected = currentFileRef.current?.path === from; await refresh(targetGit, targetWorkspace); if (gitRef.current === targetGit && wasSelected) await loadFile(to); }}
            recovery={<WorkspaceDraftRecovery workspace={workspace.identity} authorScope={preferences.email || "local"} worktreePaths={files.map(file => file.path)} onOpenDraft={openRecoveredDraft} />}
            transfer={<WorkspaceTransferPanel git={git!} files={files} busy={busy} canImport={!currentFile?.dirty} onBusyChange={setBusy} onImportBusyChange={setFileOperationBusy} beforeApply={beforeFileMutation} onImported={async paths => { const targetGit = git!, targetWorkspace = workspace; await refresh(targetGit, targetWorkspace); if (gitRef.current === targetGit && paths[0]) await loadFile(paths[0]); if (gitRef.current === targetGit) setMessage({ tone: "info", text: `${paths.length}件をこの端末のファイルへ取り込みました。Gitコミット・GitHub公開は行っていません。` }); }} />}
          />
          <section className="sidebar-section sync-sidebar-section">
            <div className="section-title-row"><h2>{isGitHubWorkspaceIdentity(workspace.identity) ? "GitHub" : "リモート同期"}</h2><span className={`connection-indicator ${syncClient ? "connected" : "local-only"}`} aria-label={syncClient ? "Connected to GitHub" : "Local workspace only"}>{syncClient ? "GitHub接続済み" : "このブラウザーのみ"}</span></div>
            {syncClient ? <div className="sync-actions"><button type="button" onClick={() => void fetchRemote()} disabled={busy}>更新を確認</button><button type="button" onClick={() => void pullRemote()} disabled={busy}>変更を取得</button><button type="button" className="publish-button" onClick={() => void publishRemote()} disabled={busy || status.localState !== "local-committed"}>GitHubへ公開</button></div> : isGitHubWorkspaceIdentity(workspace.identity)
              ? <p className="sidebar-empty">ローカル編集はこのまま利用できます。GitHubには画面上部から接続できます。</p>
              : <p className="sidebar-empty">このWorkspaceはこのブラウザー内だけに保存されます。GitHub同期は設定されていません。</p>}
          </section>
</div> : mode === "desktop" ? <div className="host-controls">{recentCard}</div> : picker;
  const tools = <div className="host-controls">{authoring && <>
    {authoringRegistrations.some(row=>row.pluginId==="proprium.research"&&row.status==="ready") && <details><summary>文章から用語候補を抽出</summary><ResearchCandidateControls key={`research:${workspaceGeneration}`} scopeKey={researchScopeKey}
      invokeRead={async(expectedScope,actionId,input,signal)=>{if(expectedScope!==researchScopeRef.current)throw new Error("snapshot_stale");const result=await authoring.invokeRead("proprium.research",actionId,input,signal);if(expectedScope!==researchScopeRef.current)throw new Error("snapshot_stale");return result;}} /></details>}
    {authoringRegistrations.some(row=>row.pluginId==="proprium.narrative"&&row.status==="ready") && <NarrativePortableResume key={`portable:${workspaceGeneration}`} scopeKey={JSON.stringify([workspaceGeneration,status.head,status.entries.map(entry=>[entry.path,entry.worktree,entry.stage]),preferences.email,authoringRegistrations.filter(row=>row.pluginId==="proprium.narrative").map(row=>row.manifestDigest)])} localSceneId={loadLocalResume()?.position.scene_id}
      read={async(actionId,input,signal)=>{const result=await authoring.invokeRead("proprium.narrative",actionId,input,signal);if(!result.ok)throw new Error(`${result.error.code}: ${result.error.message}`);return result.value;}}
      open={async(event,position)=>{const result=await invokeAuthoring(event,"proprium.narrative","proprium.narrative.scene.open",{scene_id:position.scene_id},{surfaceId:"proprium.narrative.portable-resume",resume:{position,selection:null}});if(!result.action_result.ok)throw new Error(result.action_result.error.message);}} />}
    {authoringRegistrations.some(row=>row.pluginId==="proprium.semantic"&&row.status==="ready") && <SemanticTaskControls key={`semantic:${workspaceGeneration}`} scopeKey={JSON.stringify([workspaceGeneration,authoringRegistrations.filter(row=>row.pluginId==="proprium.semantic").map(row=>row.manifestDigest)])}
      invokeRead={(pluginId,actionId,input,signal)=>authoring.invokeRead(pluginId,actionId,input,signal)} invokeUi={(event,pluginId,actionId,input)=>authoring.invokeUi(event,pluginId,actionId,input)} />}
    <details><summary>外部プロバイダーの設定</summary><ProviderSettingsPanel store={providerSettings} onChanged={()=>setProviderSettingsEpoch(value=>value+1)} /></details>
    {authoringRegistrations.some(row=>row.pluginId==="proprium.paired-writing") && <details><summary>執筆支援の個人設定</summary><PairedPreferenceSettingsPanel key={`${workspaceGeneration}:${providerSettingsEpoch}:${preferences.email}`} scopeKey={authoring.localPreferenceScope()}
      load={async expectedScope=>{
        const local=await authoring.readLocalPreference(expectedScope,"proprium.paired-writing","model-settings",1);
        const result=await authoring.invokeRead("proprium.paired-writing","paired.workspace-settings.read",{});
        if(authoring.localPreferenceScope()!==expectedScope)throw new Error("snapshot_stale");
        if(!result.ok)throw new Error(result.error.message);
        const value=result.value as unknown as PairedPreferenceSnapshot;
        return {...value,local:local.found?local.value as Record<string,unknown>:{}};
      }} save={(event,expectedScope,value)=>authoring.writeLocalPreference(event,expectedScope,"proprium.paired-writing","model-settings",1,value)} onChanged={refreshAuthoring} /></details>}
    <AuthoringReview key={workspaceGeneration} service={authoring} epoch={authoringEpoch} onApplied={refreshAfterPlugin} /><AuthoringAssets key={`assets:${workspaceGeneration}`} manager={pluginManager} service={authoring} epoch={authoringEpoch} /></>}<AuthoringCommandMenu registrations={contextualAuthoringRegistrations} invoke={invokeAuthoring} read={readAuthoring} navigate={navigateAuthoring} />{git && workspace && <PluginPanel
            manager={pluginManager}
            workspaceId={activeWorkspaceId!}
            activationScope={{ workspace_id: workspace.identity.localWorkspaceId,
              repository_id: isGitHubWorkspaceIdentity(workspace.identity) ? workspace.identity.repositoryId : null,
              branch: workspace.identity.branch }}
            git={git}
            revisionKey={pluginRevisionKey}
            canApplyChanges={!currentFile?.dirty}
            hostBusy={busy}
            onBusyChange={setBusy}
            onWorkspaceChanged={refreshAfterPlugin}
            onRegisterLiveInvoker={registerLivePluginInvoker}
            onAuthoringSurfacesChanged={refreshAuthoring}
          />}
          {git && workspace && isGitHubWorkspaceIdentity(workspace.identity) && <LiveMcpPanel
            key={`${workspaceGeneration}:${gatewayDraft}`}
            repositories={recent}
            gatewayUrl={gatewayDraft}
            workspaceId={workspace.identity.localWorkspaceId}
            generation={workspaceGeneration}
            identity={workspace.identity}
            git={git}
            canApply={!currentFile?.dirty}
            onApplyBusyChange={setFileOperationBusy}
            beforeApply={beforeFileMutation}
            onWorkspaceChanged={refreshAfterPlugin}
            onExecutePlugin={executeLivePlugin}
            onPendingProposalsChange={setMcpProposalCount}
          />}
</div>;
  const inspector = <div className="host-controls"><button onClick={() => revealPanel("history")}>履歴</button><section className="commit-panel" aria-labelledby="commit-heading">
            <div className="dock-heading"><div><p className="eyebrow">LOCAL GIT</p><h2 id="commit-heading">保存する変更</h2></div><span className="count-badge">{status.entries.length}</span></div>
            <div className="change-summary" aria-live="polite">{status.entries.length ? `${status.entries.length}件のファイルに変更があります` : status.head ? `変更なし · ${status.head.slice(0, 10)}` : "まだGitにコミットしていません"}</div>
            {git && <ChangedFilesReview key={workspaceGeneration} git={git} head={status.head} refreshKey={reviewSnapshotKey} busy={busy} canCommit={!currentFile?.dirty} onReviewReady={receiveCommitReview} />}
            <label htmlFor="commit-message">変更の説明</label><input id="commit-message" value={commitMessage} onChange={event => setCommitMessage(event.target.value)} placeholder="今回の変更について" maxLength={100_000} />
            <div className="author-fields"><label>記録者名<input aria-label="Git author name" value={preferences.name} onChange={event => updatePreferences({ ...preferences, name: event.target.value })} placeholder="記録者名" /></label><label>記録者のメールアドレス<input aria-label="Git author email" type="email" value={preferences.email} onChange={event => updatePreferences({ ...preferences, email: event.target.value })} placeholder="name@example.com" /></label></div>
            <button type="button" className="primary-button commit-button" disabled={busy || !status.entries.length || !!currentFile?.dirty || !commitReviewed} onClick={() => void commitLocal()}>ローカルGitにコミット</button>
            <p className="local-commit-note">コミットはこの端末の履歴に記録されます。GitHubには公開されません。</p>
          </section>
</div>;
  const historyPanel = <div className="host-controls">{git && <GitHistoryPanel key={workspaceGeneration} git={git} history={history} busy={busy} canRestore={!currentFile?.dirty}
    onRefresh={() => { void git.log(40).then(setHistory).catch(error => setMessage({ tone: "error", text: errorMessage(error) })); }}
    onRestored={refreshAfterPlugin} onRestoreBusyChange={setFileOperationBusy} beforeRestore={beforeFileMutation} />}</div>;
  const hostFileActions = <div className="host-file-action-group" role="group" aria-label="Current file actions">
    <button type="button" disabled={busy || !currentFile?.dirty || currentFile?.binary} onClick={() => void saveDraft()}>端末に保存</button>
    <details className="host-document-menu"><summary>文書の操作</summary><div>
      <button type="button" disabled={busy || !currentFile} onClick={() => { if (currentFile) downloadWorkspaceFile(currentFile.path.split("/").at(-1) || "document.txt", currentFile.text !== null ? new TextEncoder().encode(currentFile.text) : currentFile.data ?? new Uint8Array()); }}>この文書を書き出す</button>
      <button type="button" className="destructive-action" disabled={busy} onClick={() => void deleteFile()}>文書を削除</button>
    </div></details>
  </div>;
  const editor = workspace && git && currentFile ? <section className="restored-editor">
    {authoring && selectedNarrativeScene.current?.path===currentFile.path && selectedNarrativeScene.current.generation===workspaceGeneration && authoringRegistrations.some(row=>row.pluginId==="proprium.narrative"&&row.status==="ready") && <NarrativeNavigation
      sceneId={selectedNarrativeScene.current.id} scopeKey={JSON.stringify([workspaceGeneration,status.head,status.entries.map(entry=>[entry.path,entry.worktree,entry.stage]),currentFile.dirty,authoringRegistrations.filter(row=>row.pluginId==="proprium.narrative").map(row=>row.manifestDigest)])}
      read={async(actionId,input,signal)=>{const result=await authoring.invokeRead("proprium.narrative",actionId,input,signal);if(!result.ok)throw new Error(`${result.error.code}: ${result.error.message}`);return result.value;}}
      open={async(event,sceneId,treeRevision)=>{const result=await invokeAuthoring(event,"proprium.narrative","proprium.narrative.scene.open",{scene_id:sceneId,expected_tree_revision:treeRevision});if(!result.action_result.ok)throw new Error(result.action_result.error.message);}} />}
    {currentFile.binary ? <>
      <strong aria-label="Current file">{currentFile.path}</strong>
      <p>Binary file · {currentFile.data?.byteLength ?? 0} bytes</p>
      {hostFileActions}
    </> : <RestoredEditor key={`${workspace.identity.localWorkspaceId}:${currentFile.path}`} workspace={workspace.identity} file={currentFile} onCompositionChange={value => { composingRef.current = value; }} hostNavigationSelection={navigationSelection} onHostNavigationSelectionApplied={() => setNavigationSelection(undefined)} onWritingPosition={captureWritingPosition} hostResume={hostResume?.generation === workspaceGeneration && hostResume.authorScope === (preferences.email || "local") && hostResume.savedBytes === currentFile.data && hostResume.position.manuscript_path === currentFile.path && !currentFile.dirty ? hostResume : undefined} onHostResumeApplied={(id, restored) => { setHostResume(current => current?.requestId === id ? undefined : current); if (!restored) setMessage({ tone: "error", text: "続き位置が現在の原稿と一致しないため、カーソルを移動しませんでした。" }); }} readOnly={fileMutationBusy} head={status.head} published={syncState === "published"} localCommitted={!!status.head && status.entries.length === 0} busy={busy} checkpointBusy={checkpointBusy} publishBusy={publishBusy} authorScope={preferences.email || "local"} author={preferences} git={git} hostFileActions={hostFileActions}
      onChange={text => { setCurrentFile(previous => previous ? { ...previous, text, dirty: true } : previous); setSyncState("editing"); }}
      onSave={() => void saveDraft()} onCommit={() => revealPanel("inspector")} onPublish={() => void publishRemote()} canPublish={!!syncClient && status.localState === "local-committed" && !currentFile.dirty}
      onHistory={() => revealPanel("history")} onRegisterFlush={registerEditorFlush} onScratchApplied={refreshAfterPlugin} />}
  </section> : workspace ? syncState === "syncing" ? <section className="host-controls" role="status"><h2>Workspaceを取得しています</h2><p>GitHubからGit履歴とファイルを読み込んでいます。完了後にファイル一覧を表示します。</p></section> : <p>文書を選ぶか、新しい文書を作成してください。</p> : mode === "desktop" ? picker : <p>作品ライブラリからWorkspaceを開いてください。</p>;
  const panels: WorkspacePanel[] = [
    ...createAuthoringWorkspacePanels(contextualAuthoringRegistrations, invokeAuthoring, readAuthoring, undefined, navigateAuthoring),
    { id: "editor", title: "原稿", render: () => <RetainedPanelSlot node={editorNode} /> },
    { id: "outline", title: "作品と構成", render: () => library },
    { id: "inspector", title: "文書と保存状態", render: () => inspector },
    { id: "history", title: "履歴", render: () => historyPanel },
    { id: "review", title: "レビューとツール", render: () => <RetainedPanelSlot node={toolsNode} /> },
  ];
  const settings = <section className="host-settings" aria-label="アプリケーション設定">
    <h2>表示と接続</h2>
    <label htmlFor="settings-theme">外観<select id="settings-theme" value={theme} onChange={event => {
      const value = event.currentTarget.value as typeof theme; setTheme(value);
      try { persistThemeMode(value); } catch { setMessage({ tone: "error", text: "外観設定を保存できませんでした。" }); }
    }}><option value="light">ライト</option><option value="dark">ダーク</option><option value="paper">紙</option></select></label>
    <fieldset disabled={busy}><legend>Gitの履歴に記録する作者</legend>
      <p>GitHubのログイン情報とは別です。コミットの作者名とメールアドレスとして使います。</p>
      <label htmlFor="settings-author-name">作者名<input id="settings-author-name" value={preferences.name} onChange={event => updatePreferences({ ...preferences, name: event.target.value })} /></label>
      <label htmlFor="settings-author-email">作者のメールアドレス<input id="settings-author-email" type="email" value={preferences.email} onChange={event => updatePreferences({ ...preferences, email: event.target.value })} /></label>
    </fieldset>
    <details><summary>GitHub・Gateway接続</summary>
      <p>{account ? `GitHub: ${account.login}` : "GitHubには接続していません。端末内の文書はログインなしで編集できます。"}</p>
      <label htmlFor="settings-gateway">Gateway URL<input id="settings-gateway" type="url" value={gatewayDraft} onChange={event => updateGateway(event.target.value)} disabled={busy} /></label>
      <GatewayAccessLink gatewayUrl={gatewayDraft} />
      <p>GatewayはGitHub接続とMCPに使います。端末内のファイル編集には必要ありません。</p>
    </details>
  </section>;
  const statusMessage = recoveryEntry ? null : message;
  const statusSurface = workspace || statusMessage ? <details className="application-status" data-attention={statusMessage?.tone === "error" || undefined}>
    <summary>
      <span className="save-state" role="status">{workspace ? saveStateLabel(syncState, status.head) : "端末内の作品"}</span>
      {statusMessage && <span className={`host-message message-${statusMessage.tone}`} role={statusMessage.tone === "error" ? "alert" : "status"}><span className="host-message-text">{statusMessage.text}</span></span>}
      {mcpProposalCount > 0 && <span className="pending-review-count">MCP提案 {mcpProposalCount}件</span>}
      <span className="host-status-disclosure">詳細</span>
    </summary>
    <div className="application-status-content">
      {mcpProposalCount > 0 && <button type="button" onClick={() => revealPanel("review")}>MCPの変更提案を確認（{mcpProposalCount}件）</button>}
      {statusMessage ? <><p>{statusMessage.text}</p><button type="button" aria-label="Dismiss message" onClick={() => setMessage(null)}>通知を閉じる</button></> : <p>{workspace ? saveStateLabel(syncState, status.head) : "Workspaceを開いてください。"}</p>}
    </div>
  </details> : null;
  const Shell = mode === "desktop" ? DesktopShell : MobileShell;
  return <main className="proprium-host restored-host" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy && !recoveryEntry) void saveDraft(); } }}>{providerConsent.view}<Suspense fallback={<p>ワークスペースを開いています…</p>}><Shell mode={mode} onNavigateHome={leaveWorkspace}
    header={<header className="topbar">{mode === "desktop" && <button type="button" className="quiet-button" onClick={() => { void beforeLayoutChange().then(ok => { if (ok) setDesktopSettingsOpen(true); }); }}>設定</button>}{workspace && <button className="quiet-button" onClick={leaveWorkspace}>作品一覧</button>}{workspace && !syncClient && isGitHubWorkspaceIdentity(workspace.identity) && <button type="button" className="quiet-button" aria-haspopup="dialog" aria-controls="workspace-github-auth" disabled={busy} onClick={openWorkspaceGitHubAuth}>GitHubに接続</button>}{account && <span className="host-account-label" aria-label="GitHub account">{account.login}</span>}<ThemeControl mode={theme} onChange={value => { setTheme(value); try { persistThemeMode(value); } catch { setMessage({ tone: "error", text: "外観設定を保存できませんでした。" }); } }} />{workspace && account && <button className="quiet-button" onClick={signOut}>GitHubからログアウト</button>}</header>}
    documentTitle={currentFile?.path ?? workspace?.title ?? "Proprium"} documentContext={workspace?.identity.branch}
    desktopDurability={syncState === "published" ? "saved" : checkpointBusy ? "checkpointing" : status.head && status.entries.length === 0 && !currentFile?.dirty ? "checkpointed" : "draft"}
    settings={settings} library={library} editor={workspace ? <RetainedPanelSlot node={editorNode} /> : editor} tools={<RetainedPanelSlot node={toolsNode} />} status={statusSurface} renderStatus={error => <>{statusSurface}{error && <p role="alert">{error}</p>}</>}
    onSwitchMode={async () => { if (!(await beforeLayoutChange())) return false; const next = mode === "desktop" ? "mobile" : "desktop"; setMode(next); try { localStorage.setItem("scriptorium:ui-mode", next); } catch { /* The active mode remains usable. */ } return true; }}
    workspaceScope={workspace?.identity.localWorkspaceId} panels={workspace ? panels : undefined} beforeLayoutChange={beforeLayoutChange} requestedPanel={requestedPanel} />
  </Suspense>{desktopSettingsOpen && mode === "desktop" && <dialog ref={settingsDialog} className="storage-recovery-dialog" aria-label="設定" onCancel={() => setDesktopSettingsOpen(false)}>{settings}<button type="button" onClick={() => setDesktopSettingsOpen(false)}>設定を閉じる</button></dialog>}{workspaceAuthOpen && <dialog ref={workspaceAuthDialog} id="workspace-github-auth" className="storage-recovery-dialog github-connection-dialog" aria-labelledby="workspace-github-auth-title" aria-describedby="workspace-github-auth-description" onCancel={event => { event.preventDefault(); closeWorkspaceGitHubAuth(); }}>
    <h2 id="workspace-github-auth-title">このWorkspaceをGitHubに接続</h2>
    <p id="workspace-github-auth-description">開いている原稿を保持したまま、Repositoryを確認して接続します。取得・公開は接続後に操作できます。</p>
    <details className="gateway-settings" open={gatewaySettingsOpen} onToggle={event => setGatewaySettingsOpen(event.currentTarget.open)}>
      <summary>接続先設定</summary>
      <label htmlFor="workspace-github-gateway">Proprium Gateway URL</label>
      <input id="workspace-github-gateway" type="url" value={gatewayDraft} onChange={event => updateGateway(event.target.value)} placeholder="https://gateway.example.com" autoComplete="url" />
      <p className="field-help">通常は変更不要です。Cloudflare Accessで保護されたGatewayは、先にログインしてください。</p>
      <GatewayAccessLink gatewayUrl={gatewayDraft} />
    </details>
    {devicePrompt && <GitHubDeviceAuthorization prompt={devicePrompt} stage={authStage ?? "waiting"} onCancel={closeWorkspaceGitHubAuth} onRetry={() => { const target = workspaceAuthTarget.current; if (target) void connectGitHub(target); }} retryDisabled={busy} />}
    {message?.tone === "error" && <GitHubAuthorizationError message={message.text} disabled={busy} onRetry={() => { const target = workspaceAuthTarget.current; if (target) void connectGitHub(target); }} />}
    <div className="storage-recovery-actions">
      <button type="button" className="quiet-button" onClick={closeWorkspaceGitHubAuth}>キャンセル</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => { const target = workspaceAuthTarget.current; if (target) void connectGitHub(target); }}>{busy ? "接続中…" : "GitHubに接続"}</button>
    </div>
  </dialog>}{recoveryEntry && <StorageRecoveryDialog key={`recovery:${recoveryEntry.identity.localWorkspaceId}`} title={recoveryEntry.title} busy={busy} error={message?.tone === "error" ? message.text : ""} onVerify={() => void recoverStorage(recoveryEntry)} />}{workspace && createPortal(tools, toolsNode, workspace.identity.localWorkspaceId)}{workspace && createPortal(editor, editorNode, `editor:${workspace.identity.localWorkspaceId}`)}</main>;

  function updatePreferences(value: { name: string; email: string }): void {
    setPreferences(value);
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value)); } catch { /* Optional local preference. */ }
  }
}

function saveStateLabel(state: SyncState, head: string | null): string {
  if (state === "editing") return "編集中・端末のファイル未保存";
  if (state === "syncing") return "GitHubと同期中";
  if (state === "published") return `GitHub公開済み · ${head?.slice(0, 8) ?? "confirmed"}`;
  if (state === "conflict") return "競合・端末内の変更を保持";
  if (state === "local-ahead") return `GitHub未公開のコミット · ${head?.slice(0, 8) ?? "unpublished"}`;
  if (state === "remote-unknown") return "GitHubの状態を確認できません";
  if (state === "offline") return "オフライン・端末内で作業中";
  if (state === "local-committed") return `端末のGitに記録済み · ${head?.slice(0, 8) ?? "unpublished"}`;
  return "端末の下書き";
}
