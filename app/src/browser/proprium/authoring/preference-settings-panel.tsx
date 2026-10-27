import { useEffect, useRef, useState, type ReactElement } from 'react';

/** These values are non-secret aliases already validated by the Host preference authority. */
export interface PairedPreferenceSnapshot {
  readonly local: Readonly<Record<string, unknown>>;
  readonly workspace: { readonly settings: { readonly defaultPresetId: string; readonly featurePresetIds: Readonly<Record<string, string>> } };
  readonly effective: {
    readonly defaultPresetId: string;
    readonly presets: readonly { readonly id: string; readonly label: string; readonly model: string }[];
    readonly featurePresetIds: Readonly<Record<string, string>>;
  };
}
export interface PairedPreferenceSettingsPanelProps {
  /** Opaque key changes whenever the selected Host actor or workspace scope changes. */
  readonly scopeKey: string;
  readonly load: (expectedScope: string) => Promise<PairedPreferenceSnapshot>;
  /** Must synchronously consume the native trusted event and reject a stale expectedScope. */
  readonly save: (event: Event, expectedScope: string, value: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly onChanged?: () => void;
}
const FEATURES = [
  ['dialogue-sketch-turn','台詞の生成'], ['dialogue-sketch','会話案'], ['zukan-proposal','設定の提案'],
  ['scene-summary','シーンの要約'], ['chapter-summary','章の要約'], ['rewrite','書き換え'], ['synonym-suggest','類義語'],
  ['speaker-attribution-llm','話者の推定'], ['continuation-options','続きの候補'], ['contradiction-check','矛盾の確認'],
  ['state-event-draft','状態イベント'], ['first-read-reaction','初読の反応'], ['setting-qa','設定への質問'],
] as const;
type Snapshot = PairedPreferenceSnapshot;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function inspect(value: Snapshot): Snapshot {
  if (!value || !object(value.local) || !object(value.workspace) || !object(value.workspace.settings) || typeof value.workspace.settings.defaultPresetId !== 'string' || !object(value.workspace.settings.featurePresetIds) || !object(value.effective) || !Array.isArray(value.effective.presets) || value.effective.presets.length < 1 || value.effective.presets.length > 32 ||
      !object(value.effective.featurePresetIds) || typeof value.effective.defaultPresetId !== 'string') throw new Error('設定を読み取れません。');
  const ids = new Set<string>();
  for (const p of value.effective.presets) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 64 || ids.has(p.id) || typeof p.label !== 'string' || p.label.length > 128 || typeof p.model !== 'string' || p.model.length > 512) throw new Error('プリセットの形式が不正です。');
    ids.add(p.id);
  }
  if (!ids.has(value.effective.defaultPresetId) || Object.values(value.effective.featurePresetIds).some(id => typeof id !== 'string' || !ids.has(id))) throw new Error('プリセットの参照が不正です。');
  if (value.local.defaultPresetId !== undefined && (typeof value.local.defaultPresetId !== 'string' || !ids.has(value.local.defaultPresetId))) throw new Error('このブラウザーの設定が不正です。');
  if (value.local.featurePresetIds !== undefined && (!object(value.local.featurePresetIds) || Object.values(value.local.featurePresetIds).some(id => typeof id !== 'string' || !ids.has(id)))) throw new Error('このブラウザーの機能別設定が不正です。');
  return value;
}
/** Build only the local override; untouched recognized settings stay present. */
export function buildPairedPreferenceOverride(snapshot: Snapshot, defaultId: string, featureIds: Readonly<Record<string, string>>): Record<string, unknown> {
  inspect(snapshot);
  const valid = new Set(snapshot.effective.presets.map(p => p.id));
  if (defaultId && !valid.has(defaultId)) throw new Error('プリセットを選択してください。');
  const prior = object(snapshot.local.featurePresetIds) ? snapshot.local.featurePresetIds : {};
  const features: Record<string, unknown> = { ...prior };
  for (const [feature] of FEATURES) {
    const choice = featureIds[feature] ?? '';
    if (choice && !valid.has(choice)) throw new Error('機能別プリセットを選択してください。');
    if (choice) features[feature] = choice; else delete features[feature];
  }
  const next: Record<string, unknown> = { ...snapshot.local };
  if (defaultId) next.defaultPresetId = defaultId; else delete next.defaultPresetId;
  if (Object.keys(features).length) next.featurePresetIds = features; else delete next.featurePresetIds;
  return next;
}

/** Host-only form; the caller owns scope binding, validation and gesture authority. */
export function PairedPreferenceSettingsPanel({ scopeKey, load, save, onChanged }: PairedPreferenceSettingsPanelProps): ReactElement {
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const loadRef = useRef(load); loadRef.current = load;
  const sequence = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [defaultId, setDefaultId] = useState('');
  const [featureIds, setFeatureIds] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const serial = ++sequence.current; let live = true;
    setSnapshot(null); setDefaultId(''); setFeatureIds({}); setMessage(''); setBusy(true);
    void loadRef.current(scopeKey).then(value => {
      if (!live || sequence.current !== serial || currentScope.current !== scopeKey) return;
      const next = inspect(value); setSnapshot(next);
      setDefaultId(typeof next.local.defaultPresetId === 'string' ? next.local.defaultPresetId : '');
      const choices: Record<string,string> = {};
      if (object(next.local.featurePresetIds)) for (const [feature] of FEATURES) if (typeof next.local.featurePresetIds[feature] === 'string') choices[feature] = next.local.featurePresetIds[feature] as string;
      setFeatureIds(choices);
    }).catch(error => { if (live && sequence.current === serial && currentScope.current === scopeKey) setMessage(error instanceof Error ? error.message : '設定を読み取れません。'); })
      .finally(() => { if (live && sequence.current === serial && currentScope.current === scopeKey) setBusy(false); });
    return () => { live = false; sequence.current++; };
  }, [scopeKey]);
  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!snapshot || busy || currentScope.current !== scopeKey) return;
    let value: Record<string, unknown>;
    try { value = buildPairedPreferenceOverride(snapshot, defaultId, featureIds); }
    catch (error) { setMessage(error instanceof Error ? error.message : '設定を保存できません。'); return; }
    const serial = sequence.current;
    setBusy(true); setMessage('');
    // Invoke immediately while the browser's trusted submit gesture is fresh.
    let pending: Promise<void>;
    try { pending = save(event.nativeEvent, scopeKey, value); }
    catch (error) { setBusy(false); setMessage(error instanceof Error ? error.message : '設定を保存できません。'); return; }
    void pending.then(() => {
      if (sequence.current !== serial || currentScope.current !== scopeKey) return;
      setSnapshot(previous => previous ? { ...previous, local: value } : previous); setMessage('このブラウザーの設定を保存しました。'); onChanged?.();
    }).catch(error => { if (sequence.current === serial && currentScope.current === scopeKey) setMessage(error instanceof Error ? error.message : '設定を保存できません。'); })
      .finally(() => { if (sequence.current === serial && currentScope.current === scopeKey) setBusy(false); });
  }
  const options = snapshot?.effective.presets ?? [];
  const modelFor = (id: string) => options.find(p => p.id === id)?.model || '環境の既定';
  return <section aria-labelledby="paired-local-preference-title">
    <h3 id="paired-local-preference-title">このブラウザーのモデル設定</h3>
    <p>ワークスペースの共有設定より優先します。モデルへの接続や送信の許可は別に確認します。</p>
    {message && <p role="status" aria-live="polite">{message}</p>}
    {!snapshot && !message && <p role="status">設定を読み込んでいます…</p>}
    {snapshot && <form onSubmit={submit}>
      <label>既定のプリセット <select value={defaultId} onChange={event => setDefaultId(event.target.value)} disabled={busy}>
        <option value="">ワークスペースの設定を使う ({snapshot.workspace.settings.defaultPresetId})</option>
        {options.map(p => <option key={p.id} value={p.id}>{p.label} — {p.model || '環境の既定'}</option>)}
      </select></label>
      <p>選択中のモデル: {modelFor(defaultId || snapshot.workspace.settings.defaultPresetId)}</p>
      <fieldset disabled={busy}><legend>機能別のプリセット</legend>
        {FEATURES.map(([id,label]) => <label key={id}>{label} <select value={featureIds[id] ?? ''} onChange={event => setFeatureIds(current => ({...current,[id]:event.target.value}))}>
          <option value="">ワークスペースの設定を使う ({snapshot.workspace.settings.featurePresetIds[id] || snapshot.workspace.settings.defaultPresetId})</option>
          {options.map(p => <option key={p.id} value={p.id}>{p.label} — {p.model || '環境の既定'}</option>)}
        </select></label>)}
      </fieldset>
      <button type="submit" disabled={busy}>このブラウザーに保存</button>
    </form>}
  </section>;
}
