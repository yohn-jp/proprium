import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type InboxItem, type JobEvent, type PublicJob } from "../api";

type StreamState = "connected" | "reconnecting" | "unavailable";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ja-JP");
  } catch {
    return iso;
  }
}

function statusLabel(status: PublicJob["status"]): string {
  switch (status) {
    case "queued": return "待機中";
    case "running": return "実行中";
    case "done": return "完了";
    case "error": return "失敗";
  }
}

function parseJobEvent(payload: string): JobEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  if ((event.type !== "job-status" && event.type !== "job-progress") ||
      typeof event.jobId !== "string" || typeof event.jobType !== "string" ||
      (event.status !== "queued" && event.status !== "running" && event.status !== "done" && event.status !== "error") ||
      (event.progress !== null && (typeof event.progress !== "number" || !Number.isFinite(event.progress) || event.progress < 0 || event.progress > 1)) ||
      typeof event.at !== "string" || (event.error !== undefined && typeof event.error !== "string")) return null;
  return event as JobEvent;
}

function mergeJobLists(current: PublicJob[], incoming: PublicJob[]): PublicJob[] {
  const latestById = new Map(current.map((job) => [job.id, job]));
  return incoming.map((job) => {
    const latest = latestById.get(job.id);
    if (!latest) return job;
    const latestTime = Date.parse(latest.updatedAt);
    const incomingTime = Date.parse(job.updatedAt);
    return Number.isFinite(latestTime) && Number.isFinite(incomingTime) && latestTime > incomingTime
      ? latest
      : job;
  });
}

function JobResult({ result }: { result: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const formatted = expanded ? formatResult(result) : null;
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>結果を表示</summary>
      {expanded ? (
        <pre style={{ maxHeight: "24rem", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {formatted ?? ""}
        </pre>
      ) : null}
    </details>
  );
}

function formatResult(result: unknown): string {
  try {
    return typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

function JobRecord({ job }: { job: PublicJob }) {
  const hasProgress = typeof job.progress === "number";
  return (
    <li>
      <strong>{job.type}</strong>
      <span className={`durability-badge${job.status === "error" ? "" : " is-current"}`}>
        {statusLabel(job.status)}
      </span>
      <small>{formatWhen(job.updatedAt)}</small>
      {job.status === "running" || job.status === "queued" ? (
        hasProgress ? (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <progress max={1} value={job.progress!} aria-label={`${job.type} の進行状況`} />
            <span>{Math.round(job.progress! * 100)}%</span>
          </div>
        ) : <span className="eyebrow">進行状況はありません</span>
      ) : null}
      {job.error ? <p className="status" data-kind="error" role="alert">{job.error}</p> : null}
      {job.errorCode ? (
        <p className="eyebrow">
          <code>{job.errorCode}</code>{job.retryable ? " · 再試行できます" : ""}
        </p>
      ) : null}
      {job.result !== null ? <JobResult result={job.result} /> : null}
    </li>
  );
}

async function readJobEventStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal, onEvent: (event: JobEvent) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const event = parseJobEvent(line.slice(5).trimStart());
          if (event) onEvent(event);
        }
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > 1_000_000) buffer = "";
    }
  } finally {
    reader.releaseLock();
  }
}

/** Owner-only job completion inbox and bounded host job history. */
export function JobInbox() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>("reconnecting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [busyInboxAction, setBusyInboxAction] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mountedRef = useRef(false);
  const jobsRef = useRef<PublicJob[]>([]);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  const unknownJobIdsRef = useRef(new Set<string>());

  const replaceJobs = useCallback((next: PublicJob[]) => {
    const merged = mergeJobLists(jobsRef.current, next);
    jobsRef.current = merged;
    setJobs(merged);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlightRef.current && !refreshControllerRef.current?.signal.aborted) {
      refreshQueuedRef.current = true;
      return refreshInFlightRef.current;
    }

    const controller = new AbortController();
    refreshControllerRef.current = controller;
    setLoading(true);
    const task = Promise.all([api.jobs(controller.signal), api.inbox(false, controller.signal)])
      .then(([nextJobs, inbox]) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        replaceJobs(nextJobs);
        setItems(inbox.items);
        setUnreadCount(inbox.unreadCount);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (mountedRef.current && !controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (refreshControllerRef.current === controller) {
          refreshControllerRef.current = null;
          refreshInFlightRef.current = null;
          if (mountedRef.current) setLoading(false);
          if (refreshQueuedRef.current && mountedRef.current) {
            refreshQueuedRef.current = false;
            queueMicrotask(() => void refresh());
          }
        }
      });
    refreshInFlightRef.current = task;
    return task;
  }, [replaceJobs]);

  const onJobEvent = useCallback((event: JobEvent) => {
    const current = jobsRef.current;
    const existing = current.find((job) => job.id === event.jobId);
    if (!existing) {
      if (!unknownJobIdsRef.current.has(event.jobId)) {
        unknownJobIdsRef.current.add(event.jobId);
        if (unknownJobIdsRef.current.size > 500) {
          const oldest = unknownJobIdsRef.current.values().next().value;
          if (oldest) unknownJobIdsRef.current.delete(oldest);
        }
        void refresh();
      }
      return;
    }

    const next = current.map((job) => job.id === event.jobId ? {
      ...job,
      status: event.status,
      progress: event.progress,
      error: event.error ?? job.error,
      updatedAt: event.at,
      ...(event.status === "done" || event.status === "error" ? { finishedAt: job.finishedAt ?? event.at } : {}),
    } : job);
    jobsRef.current = next;
    setJobs(next);
    if (event.type === "job-status" && (event.status === "done" || event.status === "error")) void refresh();
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      refreshControllerRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let retryTimer: number | undefined;
    let activeController: AbortController | null = null;

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = Math.min(30_000, 1_000 * (2 ** Math.min(attempts, 5)));
      attempts += 1;
      retryTimer = window.setTimeout(() => void connect(), delay);
    };

    const connect = async () => {
      if (cancelled) return;
      const controller = new AbortController();
      activeController = controller;
      try {
        const response = await api.jobEventStream(controller.signal);
        if (cancelled) return;
        const connectedAt = Date.now();
        setStreamState("connected");
        setStreamError(null);
        void refresh();
        await readJobEventStream(response.body!, controller.signal, onJobEvent);
        if (!cancelled && !controller.signal.aborted) {
          if (Date.now() - connectedAt >= 10_000) attempts = 0;
          setStreamState("reconnecting");
          scheduleReconnect();
        }
      } catch (reason) {
        if (cancelled || controller.signal.aborted) return;
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) {
          setStreamState("unavailable");
          setStreamError(reason.message);
          return;
        }
        setStreamState("reconnecting");
        setStreamError(errorMessage(reason));
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      activeController?.abort();
    };
  }, [onJobEvent, refresh]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const markRead = async (itemId: string) => {
    setBusyInboxAction(itemId);
    try {
      await api.markInboxRead(itemId);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyInboxAction(null);
    }
  };

  const markAllRead = async () => {
    setBusyInboxAction("all");
    try {
      await api.markAllInboxRead();
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyInboxAction(null);
    }
  };

  return (
    <>
      <button
        type="button"
        className="quiet-button compact-button"
        onClick={() => {
          setOpen(true);
          void refresh();
        }}
        title="受信箱"
        aria-label={unreadCount > 0 ? `受信箱（未読 ${unreadCount}）` : "受信箱"}
      >
        受信箱{unreadCount > 0 ? <span className="durability-badge is-current" style={{ marginLeft: "0.35rem" }}>{unreadCount}</span> : null}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="job-inbox-title"
        onClose={() => setOpen(false)}
        style={{
          width: "min(54rem, calc(100vw - 2rem))",
          maxHeight: "min(84vh, 52rem)",
          margin: "auto",
          padding: "1rem",
          overflow: "auto",
          border: "1px solid var(--line)",
          borderRadius: "0.6rem",
          color: "var(--ink)",
          background: "var(--paper)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
          <h2 id="job-inbox-title" style={{ margin: 0 }}>受信箱とジョブ履歴</h2>
          <button type="button" className="quiet-button compact-button" onClick={() => void refresh()} disabled={loading}>
            更新
          </button>
        </div>
        <p className="eyebrow" role="status" aria-live="polite">
          {streamState === "connected" ? "進行状況をリアルタイムで受信しています。" :
            streamState === "reconnecting" ? "進行状況の接続を再試行しています。" : "進行状況の接続を利用できません。"}
        </p>
        {streamError ? <p className="status" data-kind="error">{streamError}</p> : null}
        {error ? <p className="status" data-kind="error" role="alert">{error}</p> : null}

        <section className="recovery-panel" aria-labelledby="job-history-title">
          <h3 id="job-history-title">ジョブ履歴</h3>
          {loading && jobs.length === 0 ? <p className="loading" role="status">読み込み中…</p> :
            jobs.length === 0 ? <p className="muted-list-item">ジョブはまだありません。</p> : (
              <ul className="recovery-list">
                {jobs.map((job) => <JobRecord key={job.id} job={job} />)}
              </ul>
            )}
        </section>

        <section className="recovery-panel" aria-labelledby="job-notifications-title">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem" }}>
            <h3 id="job-notifications-title">通知</h3>
            <span className="eyebrow">未読 {unreadCount} 件</span>
          </div>
          {items.length === 0 ? <p className="muted-list-item">通知はまだありません。</p> : (
            <ul className="recovery-list">
              {items.map((item) => (
                <li key={item.id} style={item.read ? { opacity: 0.72 } : undefined}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
                    <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      <strong>{item.title}</strong>{" "}
                      <span className={`durability-badge${item.status === "error" ? "" : " is-current"}`}>
                        {item.status === "error" ? "失敗" : "完了"}
                      </span>{" "}
                      {!item.read ? <span className="durability-badge">未読</span> : null}
                      <p style={{ margin: "0.35rem 0", whiteSpace: "pre-wrap" }}>{item.body}</p>
                      <small>{formatWhen(item.createdAt)}</small>
                    </div>
                    {!item.read ? (
                      <button
                        type="button"
                        className="quiet-button compact-button"
                        onClick={() => void markRead(item.id)}
                        disabled={busyInboxAction !== null}
                      >
                        既読
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginTop: "1rem" }}>
          <button type="button" className="quiet-button compact-button" onClick={() => void markAllRead()} disabled={unreadCount === 0 || busyInboxAction !== null}>
            すべて既読
          </button>
          <button type="button" className="compact-button" onClick={() => dialogRef.current?.close()}>
            閉じる
          </button>
        </div>
      </dialog>
    </>
  );
}
