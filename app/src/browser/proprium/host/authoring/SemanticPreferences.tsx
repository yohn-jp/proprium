import { useEffect, useRef, useState, type ReactElement, type MouseEvent } from 'react';

export interface SemanticSettingsValue {
  preferences: { rerankerEnabled: boolean };
  legacyPreference: { present: boolean; valid: boolean; value?: boolean; sourceRevision?: string };
  models: readonly { id: string; role: 'embedding' | 'reranker'; status: string }[];
}
export interface SemanticPreferencesProps {
  /** Changes with the selected actor and workspace scope. */
  scopeKey: string;
  readLocal: (signal: AbortSignal) => Promise<{ found: boolean; value?: unknown }>;
  read: (signal: AbortSignal) => Promise<SemanticSettingsValue>;
  /** Must synchronously consume the trusted event and reject an obsolete scope. */
  save: (event: Event, expectedScope: string, value: { rerankerEnabled: boolean }) => Promise<void>;
}

export function SemanticPreferences({ scopeKey, readLocal, read, save }: SemanticPreferencesProps): ReactElement {
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const readRef = useRef(read); readRef.current = read;
  const readLocalRef = useRef(readLocal); readLocalRef.current = readLocal;
  const serial = useRef(0);
  const inspection = useRef<AbortController | null>(null);
  const loadedScope = useRef<string | null>(null);
  const [settings, setSettings] = useState<SemanticSettingsValue | null>(null);
  const [localReady, setLocalReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  useEffect(() => {
    inspection.current?.abort(); inspection.current = null;
    const id = ++serial.current; const controller = new AbortController();
    loadedScope.current = null; setSettings(null); setLocalReady(false); setEnabled(false); setDismissed(false); setMessage(''); setBusy(true);
    void readLocalRef.current(controller.signal).then(value => {
      if (controller.signal.aborted || serial.current !== id || currentScope.current !== scopeKey) return;
      const stored = value?.found && value.value && typeof value.value === 'object' && !Array.isArray(value.value) ? value.value as Record<string, unknown> : null;
      loadedScope.current = scopeKey; setEnabled(typeof stored?.rerankerEnabled === 'boolean' ? stored.rerankerEnabled : false); setLocalReady(true);
      if (value?.found && typeof stored?.rerankerEnabled !== 'boolean') setMessage('保存済み設定の形式が不正なため、無効として表示しています。');
    }).catch(error => { if (!controller.signal.aborted && serial.current === id && currentScope.current === scopeKey) setMessage(error instanceof Error ? error.message : '設定を読み取れません。'); })
      .finally(() => { if (!controller.signal.aborted && serial.current === id && currentScope.current === scopeKey) setBusy(false); });
    return () => { controller.abort(); inspection.current?.abort(); inspection.current = null; serial.current++; };
  }, [scopeKey]);
  const inspect = () => {
    if (!localReady || busy || loadedScope.current !== scopeKey) return;
    const id = ++serial.current; const controller = new AbortController(); inspection.current = controller; setBusy(true); setMessage('');
    void readRef.current(controller.signal).then(value => {
      if (serial.current !== id || currentScope.current !== scopeKey) return;
      if (!value || typeof value.preferences?.rerankerEnabled !== 'boolean' || typeof value.legacyPreference?.present !== 'boolean' || typeof value.legacyPreference?.valid !== 'boolean' || !Array.isArray(value.models)) throw new Error('Semantic 設定を読み取れません。');
      setSettings(value); setDismissed(false);
    }).catch(error => { if (serial.current === id && currentScope.current === scopeKey) setMessage(error instanceof Error ? error.message : '旧設定を確認できません。'); })
      .finally(() => { if (serial.current === id && currentScope.current === scopeKey) { inspection.current = null; setBusy(false); } });
  };
  const persist = (event: MouseEvent<HTMLButtonElement>, next: boolean) => {
    if (!localReady || busy || currentScope.current !== scopeKey || loadedScope.current !== scopeKey) return;
    const id = ++serial.current; setBusy(true); setMessage('');
    let pending: Promise<void>;
    try { pending = save(event.nativeEvent, scopeKey, { rerankerEnabled: next }); }
    catch (error) { setBusy(false); setMessage(error instanceof Error ? error.message : '設定を保存できません。'); return; }
    void pending.then(() => {
      if (serial.current !== id || currentScope.current !== scopeKey) return;
      setEnabled(next); setSettings(previous => previous ? { ...previous, preferences: { rerankerEnabled: next } } : previous); setMessage('このブラウザーの設定を保存しました。');
    }).catch(error => { if (serial.current === id && currentScope.current === scopeKey) setMessage(error instanceof Error ? error.message : '設定を保存できません。'); })
      .finally(() => { if (serial.current === id && currentScope.current === scopeKey) setBusy(false); });
  };
  const reranker = settings?.models.find(model => model.role === 'reranker');
  return <section aria-label="Semantic 設定">
    <h3>Semantic 設定</h3>
    <p>設定はこのブラウザーの利用者プロファイルに保存されます。設定の変更ではモデルの取得や外部送信は行いません。</p>
    {localReady && loadedScope.current === scopeKey && <>
      <label><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />再順位付けを有効にする</label>
      <button type="button" disabled={busy} onClick={event => persist(event, enabled)}>設定を保存</button>
      <p>再順位付けモデル: {reranker ? `${reranker.id}（${reranker.status}）` : '利用可能なモデル情報なし'}</p>
      {enabled && (!reranker || reranker.status !== 'ready') && <p>設定を有効にしてもモデルは現在利用できません。モデルの準備には別途明示的な操作が必要です。</p>}
      <button type="button" disabled={busy} onClick={inspect}>以前の設定を確認</button>
      {settings?.legacyPreference.present && !dismissed && <div>
        {settings.legacyPreference.valid && typeof settings.legacyPreference.value === 'boolean' ? <><p>旧設定: 再順位付け {settings.legacyPreference.value ? '有効' : '無効'}。採用するとこのブラウザーに保存します。</p><button type="button" disabled={busy} onClick={event => persist(event, settings.legacyPreference.value!)}>旧設定を採用して保存</button></> : <p>旧設定を読み取れません。形式が不正か、対応していないバージョンです。</p>}
        <button type="button" disabled={busy} onClick={() => setDismissed(true)}>表示を閉じる</button>
        <p>旧設定ファイルは変更されません。</p>
      </div>}
    </>}
    {busy && <p role="status">処理中…</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
