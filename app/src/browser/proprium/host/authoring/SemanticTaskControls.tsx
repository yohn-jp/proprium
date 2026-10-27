import React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../../authoring/types.js';

const PLUGIN = 'proprium.semantic';
const STATUS = 'proprium.semantic.task.status';
const CANCEL = 'proprium.semantic.task.cancel';
const PHASES = new Set(['source_scan', 'embedding', 'cache_validation', 'cache_publish', 'query_embedding', 'vector_scan', 'reranking', 'term_embedding', 'mention_scan', 'candidate_scoring', 'complete']);
export interface SemanticTask { taskId: string; phase: string; completed: number; total: number }
export interface SemanticTaskControlsProps {
  /** Changes on workspace, branch or plugin activation change. */
  scopeKey: string;
  invokeRead(pluginId: string, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult>;
  invokeUi(event: Event, pluginId: string, actionId: string, input: Record<string, unknown>): Promise<ActionResult>;
}
export function parseSemanticTasks(value: unknown): SemanticTask[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { activeTasks?: unknown }).activeTasks)) throw new Error('タスク状態を読み取れませんでした。');
  const rows = (value as { activeTasks: unknown[] }).activeTasks;
  if (rows.length > 1) throw new Error('タスク状態を読み取れませんでした。');
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('タスク状態を読み取れませんでした。');
    const item = row as Record<string, unknown>;
    if (typeof item.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.taskId) || typeof item.phase !== 'string' || !PHASES.has(item.phase) ||
        !Number.isSafeInteger(item.completed) || !Number.isSafeInteger(item.total) || (item.completed as number) < 0 || (item.completed as number) > (item.total as number)) throw new Error('タスク状態を読み取れませんでした。');
    return { taskId: item.taskId, phase: item.phase, completed: item.completed as number, total: item.total as number };
  });
}

/** Independent of the plugin panel's busy state; only explicit refresh performs a read. */
export function SemanticTaskControls({ scopeKey, invokeRead, invokeUi }: SemanticTaskControlsProps) {
  const [tasks, setTasks] = useState<SemanticTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current++;
    read.current?.abort(); read.current = null;
    setTasks([]); setLoaded(false); setReading(false); setCancelling(null); setMessage('');
    return () => { generation.current++; read.current?.abort(); read.current = null; };
  }, [scopeKey]);
  async function refresh() {
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    const ticket = ++generation.current;
    setReading(true); setMessage('');
    try {
      const result = await invokeRead(PLUGIN, STATUS, {}, controller.signal);
      if (ticket !== generation.current || controller.signal.aborted) return;
      if (!result.ok) throw new Error(result.error.message);
      setTasks(parseSemanticTasks(result.value)); setLoaded(true);
    } catch (error) {
      if (ticket === generation.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'タスク状態を読み取れませんでした。');
    } finally { if (ticket === generation.current) { read.current = null; setReading(false); } }
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
      setTasks(previous => previous.filter(task => task.taskId !== taskId));
      setMessage(value.cancelled ? 'タスクをキャンセルしました。' : 'タスクは既に終了しています。');
    } catch (error) { if (ticket === generation.current) setMessage(error instanceof Error ? error.message : 'キャンセルできませんでした。'); }
    finally { if (ticket === generation.current) setCancelling(null); }
  }
  return <section aria-label="Semantic タスク">
    <h3>Semantic タスク</h3>
    <button type="button" disabled={reading || cancelling !== null} onClick={() => void refresh()}>{reading ? '確認中…' : '状態を更新'}</button>
    {loaded && tasks.length === 0 && <p>実行中のタスクはありません。</p>}
    {tasks.map(task => <div key={task.taskId}>
      <p>{task.taskId}: {task.phase} ({task.completed}/{task.total})</p>
      {task.total > 0 && <progress value={task.completed} max={task.total} aria-label={`${task.taskId} の進捗`} />}
      <button type="button" disabled={cancelling !== null} onClick={event => void cancel(event.nativeEvent, task.taskId)}>キャンセル</button>
    </div>)}
    {message && <p role="status">{message}</p>}
  </section>;
}
