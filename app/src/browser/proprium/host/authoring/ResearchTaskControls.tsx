import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionResult } from "../../authoring/types.js";

const PLUGIN = "proprium.research";
const START = "research.index.rebuild";
const STATUS = "research.task.status";
const CANCEL = "research.task.cancel";
const PHASES = new Set(["source_scan", "index_build", "cache_publish", "complete"]);
const STATES = new Set(["queued", "running", "paused", "cancelled", "failed", "complete"]);

export interface ResearchTaskProgress {
  readonly taskId: string;
  readonly state: string;
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
  readonly resumable: boolean;
}

export interface ResearchTaskControlsProps {
  readonly scopeKey: string;
  invokeRead(pluginId: string, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult>;
  invokeUi(event: Event, pluginId: string, actionId: string, input: Record<string, unknown>): Promise<ActionResult>;
  subscribe?(listener: (task: ResearchTaskProgress, snapshotId: string) => void): () => void;
}

export function parseResearchTaskProgress(value: unknown): ResearchTaskProgress[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { activeTasks?: unknown }).activeTasks)) {
    throw new Error("Research のタスク状態を読み取れませんでした。");
  }
  const rows = (value as { activeTasks: unknown[] }).activeTasks;
  if (rows.length > 1) throw new Error("Research のタスク状態を読み取れませんでした。");
  return rows.map(row => {
    if (!row || typeof row !== "object") throw new Error("Research のタスク状態を読み取れませんでした。");
    const item = row as Record<string, unknown>;
    if (typeof item.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.taskId) ||
        typeof item.state !== "string" || !STATES.has(item.state) || typeof item.phase !== "string" || !PHASES.has(item.phase) ||
        typeof item.resumable !== "boolean" || !Number.isSafeInteger(item.completed) || !Number.isSafeInteger(item.total) ||
        (item.completed as number) < 0 || (item.completed as number) > 5000 || (item.total as number) < 0 ||
        (item.total as number) > 5000 || ((item.total as number) === 0
          ? item.phase !== "source_scan" : (item.completed as number) > (item.total as number))) {
      throw new Error("Research のタスク状態を読み取れませんでした。");
    }
    return { taskId: item.taskId, state: item.state, phase: item.phase, completed: item.completed as number,
      total: item.total as number, resumable: item.resumable };
  });
}

/** Uses Host-issued durable task status and fresh-gesture start/cancel actions. */
export function ResearchTaskControls({ scopeKey, invokeRead, invokeUi, subscribe }: ResearchTaskControlsProps) {
  const [tasks, setTasks] = useState<ResearchTaskProgress[]>([]);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const serial = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const snapshotRef = useRef(snapshotId); snapshotRef.current = snapshotId;
  const readRef = useRef(invokeRead); readRef.current = invokeRead;
  const subscribeRef = useRef(subscribe); subscribeRef.current = subscribe;

  const refresh = useCallback(async () => {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const ticket = ++serial.current;
    setBusy(true); setMessage("");
    try {
      const result = await readRef.current(PLUGIN, STATUS, {}, active.signal);
      if (ticket !== serial.current || active.signal.aborted) return;
      if (!result.ok) throw new Error(result.error.message);
      setTasks(parseResearchTaskProgress(result.value));
      setSnapshotId(result.snapshot.id);
      setLoaded(true);
    } catch (error) {
      if (ticket === serial.current && !active.signal.aborted) setMessage(error instanceof Error ? error.message : "Research のタスク状態を読み取れませんでした。");
    } finally {
      if (ticket === serial.current) { controller.current = null; setBusy(false); }
    }
  }, []);

  useEffect(() => {
    serial.current++;
    controller.current?.abort(); controller.current = null;
    setTasks([]); setSnapshotId(null); setLoaded(false); setBusy(false); setMessage("");
    void refresh();
    return () => { serial.current++; controller.current?.abort(); controller.current = null; };
  }, [scopeKey, refresh]);

  useEffect(() => subscribeRef.current?.((task, updateSnapshotId) => {
    if (!snapshotRef.current || snapshotRef.current !== updateSnapshotId) return;
    controller.current?.abort(); controller.current = null;
    setTasks([task]); setLoaded(true); setBusy(false); setMessage("");
  }), [scopeKey]);

  async function start(event: Event, taskId: string = crypto.randomUUID()) {
    const ticket = ++serial.current;
    controller.current?.abort(); controller.current = null;
    setBusy(true); setMessage("");
    try {
      const result = await invokeUi(event, PLUGIN, START, { taskId });
      if (ticket !== serial.current) return;
      if (!result.ok) throw new Error(result.error.message);
      const value = result.value as Record<string, unknown>;
      if (!value || typeof value !== "object" || value.taskId !== taskId || typeof value.state !== "string" ||
          !(value.state === "running" || value.state === "complete") || typeof value.phase !== "string" || !PHASES.has(value.phase) ||
          !Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total) ||
          (value.completed as number) < 0 || (value.total as number) < (value.completed as number) || (value.total as number) > 5000) {
        throw new Error("Research の索引タスク開始結果を読み取れませんでした。");
      }
      setTasks([{ taskId, state: value.state, phase: value.phase, completed: value.completed as number,
        total: value.total as number, resumable: value.state === "running" }]);
      setSnapshotId(result.snapshot.id); setLoaded(true);
      setMessage(value.state === "complete" ? "このスナップショットの検索索引は既に最新です。" : "Research のローカル索引を構築しています。");
    } catch (error) {
      if (ticket === serial.current) setMessage(error instanceof Error ? error.message : "Research の索引タスクを開始できませんでした。");
    } finally { if (ticket === serial.current) setBusy(false); }
  }

  async function cancel(event: Event, taskId: string) {
    const ticket = ++serial.current;
    controller.current?.abort(); controller.current = null;
    setBusy(true); setMessage("");
    try {
      const result = await invokeUi(event, PLUGIN, CANCEL, { taskId });
      if (ticket !== serial.current) return;
      if (!result.ok) throw new Error(result.error.message);
      const value = result.value as Record<string, unknown>;
      if (!value || value.taskId !== taskId || typeof value.cancelled !== "boolean") throw new Error("Research のキャンセル結果を読み取れませんでした。");
      const cancelled = value.cancelled as boolean;
      setTasks(rows => rows.map(task => task.taskId === taskId ? { ...task, state: cancelled ? "cancelled" : task.state,
        resumable: cancelled || task.resumable } : task));
      setMessage(cancelled ? "索引の構築をキャンセルしました。" : "索引タスクは既に終了しています。");
    } catch (error) {
      if (ticket === serial.current) setMessage(error instanceof Error ? error.message : "Research のキャンセルに失敗しました。");
    } finally { if (ticket === serial.current) setBusy(false); }
  }

  const task = tasks[0];
  return <section aria-label="Research ローカル索引">
    <h3>Research ローカル索引</h3>
    <p>原稿と構成の索引をこの端末に構築します。進捗を確認して中断できます。同じページで再開すると保持中の作業位置を使い、ページ再読み込み後は同じ Git スナップショットから再計算します。</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? "確認中…" : "状態を更新"}</button>
    {loaded && (!task || task.state === "complete" || (["paused", "cancelled", "failed"].includes(task.state) && !task.resumable)) &&
      <button type="button" disabled={busy} onClick={event => void start(event.nativeEvent)}>{busy ? "開始しています…" : "索引を構築・再構築"}</button>}
    {loaded && !task && <p>現在実行中または再開可能なタスクはありません。</p>}
    {task && <div>
      <p role="status" aria-live="polite">{task.taskId}: {task.state} · {task.phase}{task.total === 0
        ? ` · ${task.completed} ページ走査済み` : ` (${task.completed}/${task.total})`}</p>
      {task.total > 0 && <progress value={task.completed} max={task.total} aria-label="Research 索引の進捗" />}
      {task.state === "running" && <button type="button" disabled={busy} onClick={event => void cancel(event.nativeEvent, task.taskId)}>キャンセル</button>}
      {["paused", "cancelled", "failed"].includes(task.state) && task.resumable &&
        <button type="button" disabled={busy} onClick={event => void start(event.nativeEvent, task.taskId)}>再開（再読み込み後は再計算）</button>}
      {["paused", "cancelled", "failed"].includes(task.state) && !task.resumable &&
        <p>元のスナップショットまたはプラグインが変わったため、このタスクは再開できません。新しい索引を開始してください。</p>}
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
