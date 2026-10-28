import React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../../authoring/types.js';

const PLUGIN = 'proprium.semantic';
const STATUS = 'proprium.semantic.task.status';
const CANCEL = 'proprium.semantic.task.cancel';
const REBUILD = 'proprium.semantic.index.rebuild';
const PHASES = new Set(['source_scan', 'model_loading', 'embedding', 'cache_validation', 'cache_publish', 'query_embedding', 'vector_scan', 'reranking', 'term_embedding', 'mention_scan', 'candidate_scoring', 'complete']);
const STATES = new Set(['queued', 'running', 'paused', 'cancelled', 'failed', 'complete']);
export interface SemanticTask { taskId: string; state: string; phase: string; completed: number; total: number; resumable: boolean }
export interface SemanticTaskControlsProps {
  /** Changes on workspace, branch or plugin activation change. */
  scopeKey: string;
  invokeRead(pluginId: string, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult>;
  invokeUi(event: Event, pluginId: string, actionId: string, input: Record<string, unknown>): Promise<ActionResult>;
  subscribe?(listener: (task: SemanticTask, snapshotId: string) => void): () => void;
}
export function parseSemanticTasks(value: unknown): SemanticTask[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { activeTasks?: unknown }).activeTasks)) throw new Error('タスク状態を読み取れませんでした。');
  const rows = (value as { activeTasks: unknown[] }).activeTasks;
  if (rows.length > 1) throw new Error('タスク状態を読み取れませんでした。');
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('タスク状態を読み取れませんでした。');
    const item = row as Record<string, unknown>;
    if (typeof item.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.taskId) || typeof item.state !== 'string' || !STATES.has(item.state) ||
        typeof item.phase !== 'string' || !PHASES.has(item.phase) || typeof item.resumable !== 'boolean' ||
        !Number.isSafeInteger(item.completed) || !Number.isSafeInteger(item.total) || (item.completed as number) < 0 || (item.completed as number) > (item.total as number)) throw new Error('タスク状態を読み取れませんでした。');
    return { taskId: item.taskId, state: item.state, phase: item.phase, completed: item.completed as number, total: item.total as number, resumable: item.resumable };
  });
}

/** Host-owned status/cancel path remains responsive while the plugin is executing bounded slices. */
export function SemanticTaskControls({ scopeKey, invokeRead, invokeUi, subscribe }: SemanticTaskControlsProps) {
  const [tasks, setTasks] = useState<SemanticTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState('');
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
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
      const result = await invokeReadRef.current(PLUGIN, STATUS, {}, controller.signal);
      if (ticket !== generation.current || controller.signal.aborted) return;
      if (!result.ok) throw new Error(result.error.message);
      setSnapshotId(result.snapshot.id);
      setTasks(parseSemanticTasks(result.value)); setLoaded(true);
    } catch (error) {
      if (ticket === generation.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'タスク状態を読み取れませんでした。');
    } finally { if (ticket === generation.current) { read.current = null; setReading(false); } }
  }, []);
  useEffect(() => { void refresh(); }, [scopeKey, refresh]);
  useEffect(() => {
    return subscribeRef.current?.((task, updateSnapshotId) => {
      if (!snapshotIdRef.current || updateSnapshotId !== snapshotIdRef.current) return;
      read.current?.abort(); read.current = null; setReading(false);
      setTasks([task]); setLoaded(true); setMessage('');
    });
  }, [scopeKey]);
  async function start(event: Event) {
    if (starting || cancelling !== null || tasks.some(task => task.state === 'running')) return;
    const ticket = ++generation.current;
    setStarting(true); setMessage('');
    try {
      const taskId = crypto.randomUUID();
      const result = await invokeUi(event, PLUGIN, REBUILD, { taskId });
      if (ticket !== generation.current) return;
      if (!result.ok) throw new Error(result.error.message);
      const value = result.value as Record<string, unknown>;
      if (!value || typeof value !== 'object' || value.taskId !== taskId || !['running', 'complete'].includes(String(value.state)) ||
          typeof value.phase !== 'string' || !PHASES.has(value.phase) ||
          !Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total) ||
          (value.completed as number) < 0 || (value.total as number) < (value.completed as number)) {
        throw new Error('Semantic の開始結果を読み取れませんでした。');
      }
      setTasks([{ taskId, state: String(value.state), phase: value.phase,
        completed: value.completed as number, total: value.total as number, resumable: value.state === 'running' }]);
      setSnapshotId(result.snapshot.id);
      setLoaded(true);
      setMessage(value.phase === 'model_loading' ? '検索モデルを準備しています。' : 'Semantic タスクを開始しました。');
    } catch (error) { if (ticket === generation.current) setMessage(error instanceof Error ? error.message : 'Semantic タスクを開始できませんでした。'); }
    finally { if (ticket === generation.current) setStarting(false); }
  }
  async function cancel(event: Event, taskId: string) {
    read.current?.abort(); read.current = null;
    const ticket = ++generation.current;
    setReading(false); setCancelling(taskId); setMessage('');
    try {
      const result = await invokeUi(event, PLUGIN, CANCEL, { taskId });
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
      const result = await invokeUi(event, PLUGIN, REBUILD, { taskId });
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
  return <section aria-label="Semantic タスク">
    <h3>Semantic タスク</h3>
    <button type="button" disabled={reading || cancelling !== null || starting} onClick={() => void refresh()}>{reading ? '確認中…' : '状態を更新'}</button>
    {loaded && !tasks.some(task => task.state === 'running' || (['paused', 'cancelled', 'failed'].includes(task.state) && task.resumable)) &&
      <button type="button" disabled={reading || starting || cancelling !== null} onClick={event => void start(event.nativeEvent)}>
        {starting ? '開始しています…' : 'インデックスを構築・検索モデルを準備'}
      </button>}
    {loaded && tasks.length === 0 && <p>実行中のタスクはありません。</p>}
    {tasks.map(task => <div key={task.taskId}>
      <p role="status" aria-live="polite">{task.taskId}: {task.state} · {task.phase} ({task.completed}/{task.total})</p>
      {task.total > 0 && <progress value={task.completed} max={task.total} aria-label={`${task.taskId} の進捗`} />}
      {task.state === 'running' && <button type="button" disabled={cancelling !== null} onClick={event => void cancel(event.nativeEvent, task.taskId)}>キャンセル</button>}
      {['paused', 'cancelled', 'failed'].includes(task.state) && task.resumable && <button type="button" disabled={cancelling !== null} onClick={event => void resume(event.nativeEvent, task.taskId)}>再開</button>}
      {['paused', 'cancelled', 'failed'].includes(task.state) && !task.resumable && <p>このタスクは現在のスナップショットまたはプラグインでは再開できません。</p>}
    </div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
