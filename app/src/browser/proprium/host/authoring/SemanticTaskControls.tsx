import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../../authoring/types.js';

const PLUGIN = 'proprium.semantic';
export type SemanticTaskProfile = 'embedding' | 'reranker';
const TASK_PROFILES = {
  embedding: {
    status: 'proprium.semantic.task.status', cancel: 'proprium.semantic.task.cancel', start: 'proprium.semantic.index.rebuild',
    phases: new Set(['source_scan', 'model_loading', 'embedding', 'cache_validation', 'cache_publish', 'query_embedding', 'vector_scan', 'reranking', 'term_embedding', 'mention_scan', 'candidate_scoring', 'complete']),
    label: 'Semantic タスク', heading: 'Semantic タスク',
    startLabel: 'インデックスを構築・検索モデルを準備', startMessage: 'Semantic タスクを開始しました。',
  },
  reranker: {
    status: 'proprium.semantic.reranker.task.status', cancel: 'proprium.semantic.reranker.task.cancel', start: 'proprium.semantic.reranker.prepare',
    phases: new Set(['inspect_graph', 'load_tensors', 'load_tokenizer', 'compile', 'complete']),
    label: 'BGE 再順位付けモデルの準備', heading: 'BGE 再順位付けモデル',
    startLabel: 'BGE モデルをこの端末で準備', startMessage: 'BGE 再順位付けモデルの準備を開始しました。',
  },
} as const;
const PHASE_LABELS: Readonly<Record<string, string>> = {
  inspect_graph: 'モデル構造を検証', load_tensors: 'モデルの重みを読み込み', load_tokenizer: 'トークナイザーを読み込み',
  compile: 'モデルを準備', complete: '完了',
};
const STATES = new Set(['queued', 'running', 'paused', 'cancelled', 'failed', 'complete']);
export interface SemanticTask { taskId: string; state: string; phase: string; completed: number; total: number; resumable: boolean }
export interface SemanticTaskControlsProps {
  /** BGE preparation is a separate, explicit task and asset grant from E5 indexing. */
  profile?: SemanticTaskProfile;
  /** Changes on workspace, branch or plugin activation change. */
  scopeKey: string;
  invokeRead(pluginId: string, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult>;
  invokeUi(event: Event, pluginId: string, actionId: string, input: Record<string, unknown>): Promise<ActionResult>;
  subscribe?(listener: (task: SemanticTask, snapshotId: string) => void): () => void;
}
export function parseSemanticTasks(value: unknown, profile: SemanticTaskProfile = 'embedding'): SemanticTask[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { activeTasks?: unknown }).activeTasks)) throw new Error('タスク状態を読み取れませんでした。');
  const rows = (value as { activeTasks: unknown[] }).activeTasks;
  if (rows.length > 1) throw new Error('タスク状態を読み取れませんでした。');
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('タスク状態を読み取れませんでした。');
    const item = row as Record<string, unknown>;
    if (typeof item.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.taskId) || typeof item.state !== 'string' || !STATES.has(item.state) ||
        typeof item.phase !== 'string' || !TASK_PROFILES[profile].phases.has(item.phase) || typeof item.resumable !== 'boolean' ||
        !Number.isSafeInteger(item.completed) || !Number.isSafeInteger(item.total) || (item.completed as number) < 0 || (item.completed as number) > (item.total as number)) throw new Error('タスク状態を読み取れませんでした。');
    return { taskId: item.taskId, state: item.state, phase: item.phase, completed: item.completed as number, total: item.total as number, resumable: item.resumable };
  });
}

/** Host-owned status/cancel path remains responsive while the plugin is executing bounded slices. */
export function SemanticTaskControls({ profile = 'embedding', scopeKey, invokeRead, invokeUi, subscribe }: SemanticTaskControlsProps) {
  const config = TASK_PROFILES[profile];
  const [tasks, setTasks] = useState<SemanticTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState('');
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [rerankerEnabled, setRerankerEnabled] = useState(false);
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const invokeReadRef = useRef(invokeRead); invokeReadRef.current = invokeRead;
  const subscribeRef = useRef(subscribe); subscribeRef.current = subscribe;
  const snapshotIdRef = useRef<string | null>(snapshotId); snapshotIdRef.current = snapshotId;
  useEffect(() => {
    generation.current++;
    read.current?.abort(); read.current = null;
    setTasks([]); setLoaded(false); setReading(false); setCancelling(null); setStarting(false); setMessage(''); setSnapshotId(null);
    return () => { generation.current++; read.current?.abort(); read.current = null; };
  }, [scopeKey]);
  const refresh = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    const ticket = ++generation.current;
    setReading(true); setMessage('');
    try {
      const result = await invokeReadRef.current(PLUGIN, config.status, {}, controller.signal);
      if (ticket !== generation.current || controller.signal.aborted) return;
      if (!result.ok) throw new Error(result.error.message);
      if (profile === 'reranker') {
        const settings = await invokeReadRef.current(PLUGIN, 'proprium.semantic.settings.read', {}, controller.signal);
        if (ticket !== generation.current || controller.signal.aborted) return;
        const value = settings.ok && settings.value && typeof settings.value === 'object'
          ? (settings.value as { preferences?: { rerankerEnabled?: unknown } }).preferences?.rerankerEnabled : undefined;
        if (!settings.ok || typeof value !== 'boolean') throw new Error(settings.ok ? 'Semantic の再順位付け設定を確認できません。' : settings.error.message);
        setRerankerEnabled(value);
      }
      setSnapshotId(result.snapshot.id);
      setTasks(parseSemanticTasks(result.value, profile)); setLoaded(true);
    } catch (error) {
      if (ticket === generation.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'タスク状態を読み取れませんでした。');
    } finally { if (ticket === generation.current) { read.current = null; setReading(false); } }
  }, [config.status, profile]);
  useEffect(() => { void refresh(); }, [scopeKey, refresh]);
  useEffect(() => {
    return subscribeRef.current?.((task, updateSnapshotId) => {
      if (!config.phases.has(task.phase)) return;
      if (!snapshotIdRef.current || updateSnapshotId !== snapshotIdRef.current) return;
      read.current?.abort(); read.current = null; setReading(false);
      setTasks([task]); setLoaded(true); setMessage('');
    });
  }, [scopeKey, config.phases]);
  async function start(event: Event) {
    if (starting || cancelling !== null || tasks.some(task => task.state === 'running')) return;
    const ticket = ++generation.current;
    setStarting(true); setMessage('');
    try {
      const taskId = crypto.randomUUID();
      const result = await invokeUi(event, PLUGIN, config.start, { taskId });
      if (ticket !== generation.current) return;
      if (!result.ok) throw new Error(result.error.message);
      const value = result.value as Record<string, unknown>;
      if (!value || typeof value !== 'object' || value.taskId !== taskId || !['running', 'complete'].includes(String(value.state)) ||
          typeof value.phase !== 'string' || !config.phases.has(value.phase) ||
          !Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total) ||
          (value.completed as number) < 0 || (value.total as number) < (value.completed as number)) {
        throw new Error('Semantic の開始結果を読み取れませんでした。');
      }
      setTasks([{ taskId, state: String(value.state), phase: value.phase,
        completed: value.completed as number, total: value.total as number, resumable: value.state === 'running' }]);
      setSnapshotId(result.snapshot.id);
      setLoaded(true);
      setMessage(value.phase === 'model_loading' ? '検索モデルを準備しています。' : config.startMessage);
    } catch (error) { if (ticket === generation.current) setMessage(error instanceof Error ? error.message : 'タスクを開始できませんでした。'); }
    finally { if (ticket === generation.current) setStarting(false); }
  }
  async function cancel(event: Event, taskId: string) {
    read.current?.abort(); read.current = null;
    const ticket = ++generation.current;
    setReading(false); setCancelling(taskId); setMessage('');
    try {
      const result = await invokeUi(event, PLUGIN, config.cancel, { taskId });
      if (ticket !== generation.current) return;
      if (!result.ok) throw new Error(result.error.message);
      const value = result.value as { taskId?: unknown; cancelled?: unknown };
      if (!value || value.taskId !== taskId || typeof value.cancelled !== 'boolean') throw new Error('キャンセル結果を読み取れませんでした。');
      const cancelled = value.cancelled;
      setTasks(previous => previous.map(task => task.taskId === taskId
        ? { ...task, state: cancelled ? 'cancelled' : task.state, resumable: cancelled || task.resumable }
        : task));
      setMessage(cancelled ? 'タスクをキャンセルしました。' : 'タスクは既に終了しています。');
    } catch (error) { if (ticket === generation.current) setMessage(error instanceof Error ? error.message : 'キャンセルできませんでした。'); }
    finally { if (ticket === generation.current) setCancelling(null); }
  }
  async function resume(event: Event, taskId: string) {
    const ticket = ++generation.current;
    setCancelling(taskId); setMessage('');
    try {
      const result = await invokeUi(event, PLUGIN, config.start, { taskId });
      if (ticket !== generation.current) return;
      if (!result.ok) throw new Error(result.error.message);
      const value = result.value as { taskId?: unknown; state?: unknown };
      if (!value || value.taskId !== taskId || !['running', 'complete'].includes(String(value.state))) throw new Error('再開結果を読み取れませんでした。');
      setMessage(value.state === 'complete' ? 'このスナップショットの索引は既に完成しています。' : 'Semantic タスクを再開しました。');
      setTasks(previous => previous.map(task => task.taskId === taskId
        ? { ...task, state: String(value.state), resumable: value.state === 'running' } : task));
    } catch (error) { if (ticket === generation.current) setMessage(error instanceof Error ? error.message : 'タスクを再開できませんでした。'); }
    finally { if (ticket === generation.current) setCancelling(null); }
  }
  const active = tasks.some(task => task.state === 'running' || (['paused', 'cancelled', 'failed'].includes(task.state) && task.resumable));
  const previousPreparationCompleted = profile === 'reranker' && tasks.some(task => task.state === 'complete');
  const rerankerStartLabel = previousPreparationCompleted ? 'BGE モデルをこの実行環境で確認・再準備' : config.startLabel;
  return <section aria-label={config.label}>
    <h3>{config.heading}</h3>
    {profile === 'reranker' && <>
      <p>BGE v2-m3 は、Semantic検索の E5 と別に導入して準備する大型モデルです。必要な容量は 2,288,661,281 バイト（約2.29 GB）です。データはこのブラウザーで処理します。</p>
      <p>先に Semantic のローカル設定で再順位付けを有効にして保存し、このモデル専用の取得を承認してください。E5 の許可では BGE を取得しません。ページを再読み込みした場合は、保存済みアセットを使ってモデルを再準備できます。</p>
    </>}
    <button type="button" disabled={reading || cancelling !== null || starting} onClick={() => void refresh()}>{reading ? '確認中…' : '状態を更新'}</button>
    {loaded && !active &&
      <button type="button" disabled={reading || starting || cancelling !== null || (profile === 'reranker' && !rerankerEnabled)} onClick={event => void start(event.nativeEvent)}>
        {starting ? '開始しています…' : rerankerStartLabel}
      </button>}
    {loaded && profile === 'reranker' && !rerankerEnabled && <p>Semantic 設定で再順位付けを有効にして保存すると準備できます。</p>}
    {loaded && profile === 'reranker' && previousPreparationCompleted && <p>前回の準備記録は完了しています。ページ再読み込み後は、このボタンでブラウザー内のモデルを再準備します。</p>}
    {loaded && tasks.length === 0 && <p>実行中のタスクはありません。</p>}
    {tasks.map(task => <div key={task.taskId}>
      <p role="status" aria-live="polite">{task.taskId}: {task.state} · {PHASE_LABELS[task.phase] ?? task.phase} ({task.completed}/{task.total})</p>
      {task.total > 0 && <progress value={task.completed} max={task.total} aria-label={`${task.taskId} の進捗`} />}
      {task.state === 'running' && <button type="button" disabled={cancelling !== null} onClick={event => void cancel(event.nativeEvent, task.taskId)}>キャンセル</button>}
      {['paused', 'cancelled', 'failed'].includes(task.state) && task.resumable && <button type="button" disabled={cancelling !== null} onClick={event => void resume(event.nativeEvent, task.taskId)}>再開</button>}
      {['paused', 'cancelled', 'failed'].includes(task.state) && !task.resumable && <p>このタスクは現在のスナップショットまたはプラグインでは再開できません。</p>}
    </div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
