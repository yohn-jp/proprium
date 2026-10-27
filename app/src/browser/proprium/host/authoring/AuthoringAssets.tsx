import { useEffect, useRef, useState, type ReactElement } from "react";
import type { BrowserAuthoringService } from "../../authoring/service.js";
import type { AssetGroupPreview, AssetTransferProgress } from "../../authoring/assets.js";
import type { BrowserPluginManager } from "../../plugins/manager.js";

function bytes(value: number): string { return `${value.toLocaleString()} bytes (${(value / 1024 / 1024).toFixed(1)} MiB)`; }

/** Optional signed data transfers require their own explicit author capacity consent. */
export function AuthoringAssets({ manager, service, epoch }: {
  readonly manager: BrowserPluginManager;
  readonly service: BrowserAuthoringService;
  readonly epoch: number;
}): ReactElement | null {
  const [groups, setGroups] = useState<Array<{ pluginId: string; groupId: string; role: string }>>([]);
  const [preview, setPreview] = useState<AssetGroupPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<AssetTransferProgress | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let cancelled = false;
    void manager.installed().then(items => {
      if (!cancelled) setGroups(items.flatMap(item => item.manifest?.schema === "proprium.plugin/v2"
        ? item.manifest.asset_groups.map(group => ({ pluginId: item.id, groupId: group.id, role: group.role })) : []));
    }).catch(error => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, [manager, service, epoch]);
  useEffect(() => () => controller.current?.abort(), [service]);
  async function inspect(pluginId: string, groupId: string): Promise<void> {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setPreview(null); setConsent(false); setNotice(""); setProgress(null);
    try { const value = await service.inspectAssetGroup(pluginId, groupId, abort.signal); if (!abort.signal.aborted) setPreview(value); }
    catch (error) { if (!abort.signal.aborted) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  }
  function admit(event: Event): void {
    if (!preview || !consent || controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setNotice(""); setProgress(null);
    // Acquire the fresh UI gesture synchronously; no guest or MCP can initiate this transfer.
    const pending = service.admitAssetGroup(event, preview.plugin_id, preview.group_id, {
      accepted: true, manifest_sha256: preview.manifest_sha256,
      storage_bytes: preview.storage_required_bytes, transfer_bytes: preview.transfer_required_bytes,
    }, abort.signal, setProgress);
    void pending.then(() => {
      if (!abort.signal.aborted) { setNotice("署名・全チャンク・ファイルのダイジェストを検証して、このブラウザーに保存しました。"); setPreview(null); setConsent(false); }
    }, error => { if (!abort.signal.aborted) setNotice(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (controller.current === abort) { controller.current = null; setBusy(false); } });
  }
  if (!groups.length) return null;
  return <details className="authoring-assets"><summary>追加の辞書・モデルデータ</summary>
    <p>プラグインとは別に保存します。転送は開始ボタンを押すまで行いません。原稿を外部へ送信しません。</p>
    <ul>{groups.map(group => <li key={`${group.pluginId}:${group.groupId}`}><strong>{group.pluginId} / {group.groupId}</strong> · {group.role} <button type="button" disabled={busy} onClick={() => void inspect(group.pluginId, group.groupId)}>配布データと容量を確認</button></li>)}</ul>
    {preview && <section aria-label="追加データの容量確認">
      <h3>{preview.group_id} · {preview.version}</h3>
      <dl><dt>署名で固定されたmanifest SHA-256</dt><dd><code>{preview.manifest_sha256}</code></dd><dt>ライセンス</dt><dd>{preview.license}</dd><dt>データ合計</dt><dd>{bytes(preview.group_bytes)}</dd><dt>今回の転送</dt><dd>{bytes(preview.transfer_required_bytes)}</dd><dt>必要な保存容量</dt><dd>{bytes(preview.storage_required_bytes)}</dd><dt>測定した空き容量</dt><dd>{preview.capacity.available_storage_bytes === null ? "取得できません" : bytes(preview.capacity.available_storage_bytes)}</dd><dt>必要メモリー</dt><dd>{preview.capacity.memory_required_bytes === null ? "未測定" : bytes(preview.capacity.memory_required_bytes)}</dd></dl>
      {preview.capacity.device_requirements.map(requirement => <p key={requirement}>{requirement}</p>)}
      {!preview.capacity.device_supported && <p role="status">この環境では利用できません: {preview.capacity.reason || "対応する実行環境が確認されていません。"}</p>}
      <label><input type="checkbox" disabled={busy || !preview.capacity.device_supported} checked={consent} onChange={event => setConsent(event.target.checked)} />表示された転送量・保存容量を確認した</label>
      <button type="button" disabled={busy || !consent || !preview.capacity.device_supported} onClick={event => admit(event.nativeEvent)}>確認したデータの取得を開始</button>
    </section>}
    {busy && <button type="button" onClick={() => { controller.current?.abort(); controller.current = null; setBusy(false); setNotice("転送を中止しました。検証済みの保存済みデータは保持します。"); }}>中止</button>}
    {progress && <p role="status">{progress.phase === "transfer" ? "取得中" : "検証中"}: {bytes(progress.verified_bytes)} / {bytes(progress.total_bytes)}</p>}
    {notice && <p role="status">{notice}</p>}
  </details>;
}
