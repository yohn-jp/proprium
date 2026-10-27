import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { BrowserPluginManager } from "../plugins/index.js";
import { decodeRegistryBytes } from "../plugins/registry.js";
import type { InstalledPlugin, PluginInstallPreview, RegistryCatalogEntry } from "../plugins/manager.js";
import type { PluginCapability, PluginTranscript, RuntimeSnapshot } from "../plugin-runtime/protocol.js";
import type { BrowserLocalGit } from "../git/index.js";

const HOST_CAPABILITIES: readonly PluginCapability[] = [
  "workspace.snapshot.read", "workspace.change.propose", "workspace.ui.contribute",
];
const AUTHORING_HOST_CAPABILITIES = new Set([
  "workspace.identity.read", "workspace.file.read", "workspace.change.propose", "workspace.change.timestamp",
  "workspace.plugin.invoke", "workspace.derived.cache", "workspace.asset.read", "plugin.preferences.read",
  "workspace.ui.contribute", "workspace.change.stage", "workspace.change.list", "workspace.change.status",
  "workspace.change.observations", "workspace.change.inspect", "workspace.change.content.read",
  "workspace.capabilities.query", "artifact.create", "artifact.append", "artifact.seal", "artifact.discard",
]);
const MAX_SNAPSHOT_FILES = 256;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
type InstallIntent = "install" | "update";

interface PluginPanelProps {
  manager: BrowserPluginManager;
  workspaceId: string;
  git: BrowserLocalGit;
  revisionKey: string;
  canApplyChanges: boolean;
  hostBusy: boolean;
  onBusyChange(value: boolean): void;
  onWorkspaceChanged(): Promise<void>;
  onRegisterLiveInvoker(invoker: ((args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | null): void;
  onAuthoringSurfacesChanged?(): void;
}
interface SnapshotState { value: RuntimeSnapshot; inputRevisionKey: string; }

function registryConfig(): { url: string; publicKey: Uint8Array; artifactOrigins: string[] } | null {
  const url = import.meta.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL?.trim();
  const encodedKey = import.meta.env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY?.trim();
  const artifactOrigins = (import.meta.env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean);
  if (!url || !encodedKey || !artifactOrigins.length) return null;
  try {
    const publicKey = decodeRegistryBytes(encodedKey, 32, "registry public key");
    return { url, publicKey, artifactOrigins };
  } catch { return null; }
}

/** Shared by HostApp's authoring service and the normal PluginPanel lifecycle. */
export function createHostPluginManager(): BrowserPluginManager {
  const config = registryConfig();
  return new BrowserPluginManager({
    registries: config ? [{ url: config.url, publicKey: config.publicKey, artifactOrigins: config.artifactOrigins }] : [],
  });
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function takeSnapshot(git: BrowserLocalGit, workspaceId: string): Promise<RuntimeSnapshot> {
  const entries = await git.listFiles();
  if (entries.length > MAX_SNAPSHOT_FILES) throw new Error(`Plugin snapshots are limited to ${MAX_SNAPSHOT_FILES} files; this repository has ${entries.length}.`);
  let bytes = 0;
  const files: RuntimeSnapshot["files"][number][] = [];
  for (const entry of entries) {
    const read = await git.read(entry.path);
    if (!read.data) continue;
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(read.data); }
    catch { continue; }
    bytes += new TextEncoder().encode(content).byteLength;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("The UTF-8 workspace snapshot exceeds the 2 MiB plugin limit.");
    if (!read.revision.oid) throw new Error(`The Host could not confirm a revision for ${entry.path}.`);
    files.push(Object.freeze({ path: entry.path, revision: read.revision.oid, content }));
  }
  const revision = JSON.stringify(files.map(file => [file.path, file.revision]));
  return Object.freeze({ id: `${workspaceId}:${crypto.randomUUID()}`, revision, files: Object.freeze(files) });
}

function needsWorkspaceSnapshot(plugin: InstalledPlugin): boolean {
  return plugin.capabilities.includes("workspace.snapshot.read") || plugin.capabilities.includes("workspace.change.propose");
}

function emptySnapshot(workspaceId: string): RuntimeSnapshot {
  return Object.freeze({
    id: `${workspaceId}:${crypto.randomUUID()}`,
    revision: crypto.randomUUID(),
    files: Object.freeze([]),
  });
}

function snapshotForPlugin(plugin: InstalledPlugin, git: BrowserLocalGit, workspaceId: string): Promise<RuntimeSnapshot> {
  return needsWorkspaceSnapshot(plugin) ? takeSnapshot(git, workspaceId) : Promise.resolve(emptySnapshot(workspaceId));
}

export function PluginPanel({ manager, workspaceId, git, revisionKey, canApplyChanges, hostBusy, onBusyChange, onWorkspaceChanged, onRegisterLiveInvoker, onAuthoringSurfacesChanged }: PluginPanelProps): ReactElement {
  const config = useMemo(registryConfig, []);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [registryCatalog, setRegistryCatalog] = useState<readonly RegistryCatalogEntry[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [installPlan, setInstallPlan] = useState<PluginInstallPreview | null>(null);
  const [planIntent, setPlanIntent] = useState<InstallIntent | null>(null);
  const [grants, setGrants] = useState<Record<string, PluginCapability[]>>({});
  const [requests, setRequests] = useState<Record<string, string>>({});
  const [transcripts, setTranscripts] = useState<Record<string, PluginTranscript>>({});
  const [pendingSnapshot, setPendingSnapshot] = useState<Record<string, SnapshotState>>({});
  const [ownBusy, setOwnBusy] = useState(false);
  const busy = ownBusy || hostBusy;
  const [notice, setNotice] = useState("");
  const currentRevisionKey = useRef(revisionKey);
  const currentSnapshots = useRef(new Map<string, SnapshotState>());
  currentRevisionKey.current = revisionKey;

  useEffect(() => {
    onRegisterLiveInvoker(async (args, signal) => {
      if (typeof args.pluginId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(args.pluginId) || args.operation !== "run") {
        throw new Error("plugin_call requires an installed pluginId and operation 'run'.");
      }
      if ((await manager.installed()).find(item => item.id === args.pluginId)?.actions.length) throw new Error("invalid_input: authoring plugins require a qualified typed action");
      const input = typeof args.input === "string" ? args.input : isPlainRecord(args.input) && typeof args.input.request === "string" ? args.input.request : "";
      if (!input || input.length > 256 * 1024) throw new Error("plugin_call input must contain a request up to 256 KiB.");
      const plugin = (await manager.installed()).find(item => item.id === args.pluginId && (item.state === "active" || item.state === "enabled-idle"));
      if (!plugin) throw new Error("Enable the plugin and grant its capabilities in the Browser Host before calling it.");
      const inputRevisionKey = currentRevisionKey.current;
      const snapshot = await snapshotForPlugin(plugin, git, workspaceId);
      if (signal.aborted) throw new DOMException("Plugin execution was canceled", "AbortError");
      const snapshotState = { value: snapshot, inputRevisionKey };
      const transcript = await manager.invoke({
        pluginId: plugin.id, request: input, snapshot,
        signal,
        isSnapshotCurrent: (snapshotId, revision) => currentRevisionKey.current === inputRevisionKey && snapshot.id === snapshotId && snapshot.revision === revision,
      });
      if (currentRevisionKey.current !== inputRevisionKey) throw new Error("The workspace changed while the plugin ran; its result was discarded.");
      currentSnapshots.current.set(plugin.id, snapshotState);
      setPendingSnapshot(current => ({ ...current, [plugin.id]: snapshotState }));
      setTranscripts(current => ({ ...current, [plugin.id]: transcript }));
      return { pluginId: plugin.id, value: transcript.value, proposals: transcript.proposals };
    });
    return () => onRegisterLiveInvoker(null);
  }, [manager, workspaceId, git, onRegisterLiveInvoker]);

  async function refreshPlugins(): Promise<void> {
    setPlugins(await manager.installed());
    onAuthoringSurfacesChanged?.();
  }
  const lastWorkspaceId = useRef(workspaceId);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (lastWorkspaceId.current !== workspaceId) {
          for (const plugin of await manager.installed()) if (plugin.state === "active" || plugin.state === "enabled-idle") await manager.disable(plugin.id, plugin.version);
          lastWorkspaceId.current = workspaceId;
          setTranscripts({});
          setPendingSnapshot({});
          setGrants({});
          setRequests({});
          currentSnapshots.current.clear();
        }
        const installed = await manager.installed();
        if (!cancelled) {
          setPlugins(installed);
          onAuthoringSurfacesChanged?.();
        }
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "Installed plugin metadata could not be verified.");
      }
    })();
    return () => { cancelled = true; };
  }, [manager, workspaceId, onAuthoringSurfacesChanged]);
  async function loadRegistryCatalog(): Promise<void> {
    if (!config) return;
    setRegistryCatalog([]);
    setCatalogLoaded(false);
    setCatalogLoading(true);
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      setRegistryCatalog(await manager.registryCatalog());
      setCatalogLoaded(true);
      setNotice("署名検証済みのレジストリ情報を表示しています。プレビューを確認するまでプラグイン本体はダウンロードされません。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "信頼済みプラグインカタログを検証できませんでした。"); }
    finally { setCatalogLoading(false); setOwnBusy(false); onBusyChange(false); }
  }

  async function previewInstall(entry: RegistryCatalogEntry): Promise<void> {
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      const preview = await manager.previewInstall({ registryUrl: entry.registryUrl, pluginId: entry.id, version: entry.version });
      setInstallPlan(preview);
      setPlanIntent("install");
      setNotice("署名済みの配布物、要求権限、依存関係、転送サイズを確認してください。まだダウンロードは始まりません。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "プラグインのプレビューに失敗しました。"); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  async function confirmInstallPlan(): Promise<void> {
    if (!installPlan || !planIntent) return;
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      if (planIntent === "install") {
        await manager.installFromRegistry(installPlan);
        setNotice("署名とダイジェストを検証し、無効状態でインストールしました。実行には権限の確認と明示的な有効化が必要です。");
      } else {
        await manager.update(installPlan);
        setNotice(`バージョン ${installPlan.version} を確認して固定しました。更新版を使うには有効化してください。`);
      }
      setInstallPlan(null); setPlanIntent(null);
      await refreshPlugins();
    } catch (error) {
      setInstallPlan(null); setPlanIntent(null);
      setNotice(error instanceof Error ? error.message : "インストールに失敗しました。未検証のプラグインは実行されていません。");
    } finally { setOwnBusy(false); onBusyChange(false); }
  }

  function cancelPlan(): void { setInstallPlan(null); setPlanIntent(null); }

  async function enable(plugin: InstalledPlugin): Promise<void> {
    const grantKey = `${workspaceId}:${plugin.id}@${plugin.version}`;
    const selected = grants[grantKey] ?? [];
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      await manager.enable({ pluginId: plugin.id, version: plugin.version, workspaceId, grants: selected, hostAllowed: plugin.capabilities.filter(value => plugin.actions.length ? AUTHORING_HOST_CAPABILITIES.has(value) : HOST_CAPABILITIES.includes(value as PluginCapability)) });
      await refreshPlugins();
      setNotice(`${plugin.id}@${plugin.version} is enabled with these grants. No Worker starts until you choose Run.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Plugin could not be enabled."); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  async function invoke(plugin: InstalledPlugin, request: string): Promise<void> {
    if (currentRevisionKey.current !== revisionKey) { setNotice("ワークスペースが変更されました。プラグインのスナップショットを更新して再実行してください。"); return; }
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      const snapshot = await snapshotForPlugin(plugin, git, workspaceId);
      const selected: SnapshotState = { value: snapshot, inputRevisionKey: revisionKey };
      currentSnapshots.current.set(plugin.id, selected);
      const transcript = await manager.invoke({
        pluginId: plugin.id,
        request,
        snapshot,
        isSnapshotCurrent: (snapshotId, revision) => {
          const current = currentSnapshots.current.get(plugin.id);
          return current === selected && currentRevisionKey.current === selected.inputRevisionKey &&
            current.value.id === snapshotId && current.value.revision === revision;
        },
      });
      const after = needsWorkspaceSnapshot(plugin) ? await takeSnapshot(git, workspaceId) : null;
      if ((after && after.revision !== snapshot.revision) || currentRevisionKey.current !== revisionKey) {
        throw new Error("The workspace changed while the plugin was running. Its result was discarded; run it again on the current snapshot.");
      }
      setTranscripts(current => ({ ...current, [plugin.id]: transcript }));
      setPendingSnapshot(current => ({ ...current, [plugin.id]: selected }));
      await refreshPlugins();
      setNotice(transcript.proposals.length ? `Plugin returned ${transcript.proposals.length} change proposal(s) for Host review.` : "Plugin run completed. No workspace changes were applied.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Plugin execution failed."); await refreshPlugins().catch(() => undefined); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  async function applyProposals(plugin: InstalledPlugin): Promise<void> {
    const transcript = transcripts[plugin.id];
    const snapshotState = pendingSnapshot[plugin.id];
    if (!transcript || !snapshotState || !canApplyChanges) { setNotice("Save editor text before reviewing plugin changes."); return; }
    const current = currentSnapshots.current.get(plugin.id);
    if (current !== snapshotState || currentRevisionKey.current !== snapshotState.inputRevisionKey) { setNotice("This proposal is based on an older workspace snapshot. Run the plugin again before applying it."); return; }
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      const readSet = new Map<string, { path: string; revision: { oid: string | null } }>();
      const changes = new Map<string, { path: string; content: Uint8Array; expectedRevision: { oid: string | null } }>();
      for (const proposal of transcript.proposals) {
        for (const read of proposal.readSet) {
          const revision = { oid: read.revision ?? null };
          const existing = readSet.get(read.path);
          if (existing && existing.revision.oid !== revision.oid) throw new Error(`Plugin returned conflicting read revisions for ${read.path}. Nothing was applied.`);
          readSet.set(read.path, { path: read.path, revision });
        }
        for (const change of proposal.changes) {
          if (changes.has(change.path)) throw new Error(`Multiple proposals changed ${change.path}. Review them separately before applying.`);
          const expectedRevision = { oid: change.expectedRevision ?? null };
          changes.set(change.path, { path: change.path, content: new TextEncoder().encode(change.content), expectedRevision });
          const existing = readSet.get(change.path);
          if (existing && existing.revision.oid !== expectedRevision.oid) throw new Error(`Proposal read and write revisions disagree for ${change.path}. Nothing was applied.`);
          readSet.set(change.path, { path: change.path, revision: expectedRevision });
        }
      }
      if (current !== snapshotState || currentRevisionKey.current !== snapshotState.inputRevisionKey) throw new Error("The workspace changed while you were reviewing this proposal. No changes were applied.");
      await git.applyChanges([...changes.values()], [...readSet.values()]);
      currentSnapshots.current.delete(plugin.id);
      setPendingSnapshot(current => { const next = { ...current }; delete next[plugin.id]; return next; });
      await onWorkspaceChanged();
      setNotice(`Applied ${changes.size} proposed file change(s) to the local worktree. Commit and publish are still separate Host actions.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The Host could not apply the proposal."); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  async function disable(plugin: InstalledPlugin): Promise<void> {
    setOwnBusy(true); onBusyChange(true);
    try { await manager.disable(plugin.id, plugin.version); setTranscripts(current => { const next = { ...current }; delete next[plugin.id]; return next; }); await refreshPlugins(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Plugin could not be stopped."); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  async function uninstall(plugin: InstalledPlugin): Promise<void> {
    if (!window.confirm(`Uninstall ${plugin.id}@${plugin.version}? User repository files will not be changed.`)) return;
    setOwnBusy(true); onBusyChange(true);
    try { await manager.uninstall(plugin.id, plugin.version); await refreshPlugins(); setNotice(`Uninstalled ${plugin.id}@${plugin.version}.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Plugin could not be removed."); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  async function update(plugin: InstalledPlugin): Promise<void> {
    const nextVersion = window.prompt(`Install and pin a verified version of ${plugin.id}.`, "");
    if (!nextVersion) return;
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      const preview = await manager.previewUpdate({ registryUrl: plugin.registryUrl, pluginId: plugin.id, version: nextVersion.trim() });
      setInstallPlan(preview); setPlanIntent("update");
      setNotice("Review the signed update package, permissions, dependencies and download size before transfer.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Plugin update preview failed; the installed version remains pinned."); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  async function rollback(plugin: InstalledPlugin): Promise<void> {
    setOwnBusy(true); onBusyChange(true); setNotice("");
    try {
      await manager.rollback(plugin.id);
      await refreshPlugins();
      setNotice(`${plugin.id} was rolled back to its retained verified version. Enable it when ready.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "No verified plugin version is available for rollback."); }
    finally { setOwnBusy(false); onBusyChange(false); }
  }

  return <details className="plugin-manager-panel">
    <summary>Plugins <span className="count-badge">{plugins.length}</span></summary>
    <div className="plugin-panel-content">
      <p className="plugin-panel-copy">プラグインは署名を検証してから利用できます。インストールしても無効状態のままで、権限を確認して有効化した後に実行できます。</p>
      <p className="plugin-panel-copy"><code>proprium.compute-sum</code> は配布と実行の確認用サンプルです。計算機能のみで、小説執筆プラグインではありません。</p>
      {!config ? <p className="plugin-panel-warning" role="status">このHostビルドには信頼済みプラグインレジストリが設定されていません。</p> : <section className="plugin-registry-catalog" aria-labelledby="plugin-registry-heading">
        <h3 id="plugin-registry-heading">プラグインカタログ</h3>
        <p id="plugin-registry-help">Hostに固定された公開鍵でレジストリ署名を検証します。一覧には署名対象のID、バージョン、依存関係を表示します。このv1のカタログに機能説明は含まれないため、IDだけで機能を推測せず、提供元の説明も確認してください。</p>
        <p>一覧の表示だけではプラグイン本体を取得しません。まず検証済みの詳細プレビューを開き、権限と転送量を確認してからダウンロードします。</p>
        <button type="button" onClick={() => void loadRegistryCatalog()} disabled={busy} aria-describedby="plugin-registry-help">{catalogLoaded ? "カタログを再読み込み" : "信頼済みカタログを表示"}</button>
        {catalogLoading && <p role="status">レジストリ署名を検証しています…</p>}
        {catalogLoaded && !registryCatalog.length && <p className="plugin-empty">信頼済みレジストリに利用可能なプラグインはありません。</p>}
        {registryCatalog.length > 0 && <ul className="registry-plugin-list">{registryCatalog.map(entry => <li key={`${entry.registryUrl}:${entry.id}@${entry.version}`}>
          <article className="registry-plugin-card">
            <h4><code>{entry.id}</code></h4>
            <p>バージョン <code>{entry.version}</code> · レジストリ <code>{entry.registryId}@{entry.registryVersion}</code></p>
            {entry.dependencies.length > 0 && <p>依存関係: {entry.dependencies.map(dependency => `${dependency.id} ${dependency.range}`).join("、")}</p>}
            <button type="button" onClick={() => void previewInstall(entry)} disabled={busy} aria-label={`${entry.id} ${entry.version} の署名済みプレビューを確認`}>署名を確認してプレビュー</button>
          </article>
        </li>)}</ul>}
      </section>}
      {installPlan && <section className="plugin-install-preview" aria-labelledby="plugin-preview-heading">
        <div className="plugin-preview-heading"><h3 id="plugin-preview-heading">{planIntent === "update" ? "更新プレビュー" : "インストールプレビュー"}</h3><button type="button" onClick={cancelPlan} disabled={busy}>閉じる</button></div>
        <dl><dt>プラグイン</dt><dd><code>{installPlan.pluginId}@{installPlan.version}</code></dd><dt>ダウンロード合計</dt><dd>{formatBytes(installPlan.downloadBytes)}</dd><dt>プレビュー有効期限</dt><dd><time dateTime={new Date(installPlan.expiresAt).toISOString()}>{new Date(installPlan.expiresAt).toLocaleTimeString()}</time></dd></dl>
        <ul>{installPlan.packages.map(item => <li key={`${item.id}@${item.version}`}><article><strong>{item.id}@{item.version}</strong><span>{formatBytes(item.downloadBytes)}</span><small>要求する権限: {item.capabilities.join(", ") || "なし"}</small>{item.dependencies.length > 0 && <small>依存関係: {item.dependencies.map(dependency => `${dependency.id}@${dependency.version}`).join(", ")}</small>}</article></li>)}</ul>
        <button type="button" className="plugin-confirm-install" disabled={busy} onClick={() => void confirmInstallPlan()}>{planIntent === "update" ? "ダウンロードして更新版を固定" : "ダウンロードして無効状態でインストール"}</button>
      </section>}
      {notice && <p className="plugin-notice" role="status" aria-live="polite">{notice}</p>}
      {!plugins.length ? <div className="plugin-empty-state"><p className="plugin-empty">検証済みのインストール済みプラグインはありません。</p><p>プラグインがなくても、ワークスペースの編集とGit操作は利用できます。</p></div> : <ul className="installed-plugins">{plugins.map(plugin => {
        const pluginKey = `${plugin.id}@${plugin.version}`;
        const inputId = `plugin-input-${plugin.id}-${plugin.version}`;
        const inputHelpId = `${inputId}-help`;
        const isComputeSumSample = plugin.id === "proprium.compute-sum";
        const request = requests[pluginKey] ?? (isComputeSumSample ? '{"left":20,"right":22}' : "");
        const canRun = !plugin.actions.length && (plugin.state === "active" || plugin.state === "enabled-idle");
        return <li key={pluginKey}>
          <div className="plugin-card-head"><div><strong>{plugin.id}</strong><small>v{plugin.version} · {plugin.state === "active" ? "active" : plugin.state === "enabled-idle" ? "enabled, idle" : plugin.state === "revoked" ? "publisher revoked" : "installed, disabled"}</small></div><code>{plugin.activeVersion ? `pinned ${plugin.activeVersion}` : "not pinned"}</code></div>
          <fieldset disabled={busy || plugin.state !== "installed"}>
            <legend>Requested capabilities</legend>
            {plugin.capabilities.length === 0 && <p>要求する権限はありません。</p>}
            {plugin.capabilities.map(value => {
              const grantKey = `${workspaceId}:${plugin.id}@${plugin.version}`;
              const selected = grants[grantKey] ?? [];
              return <label key={value} className="capability-choice"><input type="checkbox" checked={selected.includes(value as PluginCapability)} onChange={event => setGrants(current => ({ ...current, [grantKey]: event.target.checked ? [...selected, value as PluginCapability] : selected.filter(item => item !== value) }))} /> <span>{value}</span></label>;
            })}
          </fieldset>
          <div className="plugin-actions">{plugin.state === "active" ? <>{!plugin.actions.length && <button type="button" onClick={() => void invoke(plugin, request)} disabled={busy}>Run</button>}<button type="button" onClick={() => void disable(plugin)} disabled={busy}>Stop</button></> : plugin.state === "enabled-idle" ? <>{!plugin.actions.length && <button type="button" onClick={() => void invoke(plugin, request)} disabled={busy}>Run</button>}<button type="button" onClick={() => void disable(plugin)} disabled={busy}>Disable</button></> : <button type="button" onClick={() => void enable(plugin)} disabled={busy || plugin.state === "revoked"}>{plugin.state === "revoked" ? "Revoked" : "Enable"}</button>}<button type="button" onClick={() => void update(plugin)} disabled={busy}>Update version</button>{plugin.activeVersion && <button type="button" onClick={() => void rollback(plugin)} disabled={busy}>Rollback</button>}<button type="button" className="plugin-remove" onClick={() => void uninstall(plugin)} disabled={busy}>Uninstall</button></div>
          {canRun && <label className="plugin-request" htmlFor={inputId}><span>プラグイン入力（テキスト）</span><small id={inputHelpId}>Hostは内容を1本の文字列として渡します。現在のABIは入力スキーマを定義せず、この画面も形式を検証しません。各プラグインの説明に従って入力してください。</small>{isComputeSumSample && <small id={`${inputId}-sample`}>計算サンプルは left と right の2つの有限な数値だけを含むJSONを受け取ります。例: <code>{'{"left":20,"right":22}'}</code></small>}<textarea id={inputId} aria-describedby={`${inputHelpId}${isComputeSumSample ? ` ${inputId}-sample` : ""}`} value={request} onChange={event => setRequests(current => ({ ...current, [pluginKey]: event.target.value }))} maxLength={256 * 1024} placeholder={isComputeSumSample ? '{"left":20,"right":22}' : "プラグインの指定形式を入力"} /></label>}
          {plugin.dependencies.length > 0 && <p className="plugin-metadata">Dependencies: {plugin.dependencies.map(item => `${item.id}@${item.version}`).join(", ")}</p>}
          {plugin.contributions.length > 0 && <section className="plugin-contributions" aria-label="Host-rendered plugin contributions"><strong>Plugin surfaces</strong>{plugin.contributions.map(item => <article key={`${item.kind}:${item.id}`}><small>{item.kind}</small><span>{item.title}</span></article>)}</section>}
          {transcripts[plugin.id]?.value && <pre className="plugin-output" aria-label={`${plugin.id} output`}>{transcripts[plugin.id]!.value}</pre>}
          {transcripts[plugin.id]?.proposals.length ? <div className="plugin-proposals"><strong>Proposed changes</strong>{transcripts[plugin.id]!.proposals.flatMap((proposal, index) => proposal.changes.map(change => <article key={`${plugin.id}:${index}:${change.path}`}><span>{change.path}</span><pre>{change.content.slice(0, 1200)}{change.content.length > 1200 ? "…" : ""}</pre></article>))}<button type="button" onClick={() => void applyProposals(plugin)} disabled={busy || !canApplyChanges}>Review and apply to local worktree</button></div> : null}
        </li>;
      })}</ul>}
    </div>
  </details>;
}
