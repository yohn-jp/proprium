/** Shared by actual SDK sessions, with no timer or policy hidden in a transport mock. */
export interface SessionLifetime {
  activeRequests: number;
  lastUsedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  closing: boolean;
}
export interface SessionLimits { maxSessions?: number; idleTimeoutMs?: number; now?: () => number }
export function sessionLimits(input: SessionLimits) {
  const maxSessions = input.maxSessions ?? 100;
  const idleTimeoutMs = input.idleTimeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 2_147_483_647) {
    throw new TypeError("MCP session limits must be positive bounded integers");
  }
  return { maxSessions, idleTimeoutMs, now: input.now ?? Date.now };
}

export function clearIdleTimer(session: SessionLifetime): void {
  if (session.timer !== undefined) clearTimeout(session.timer);
  session.timer = undefined;
}

export function armIdleTimer(session: SessionLifetime, timeoutMs: number, now: () => number, close: () => Promise<void>): void {
  clearIdleTimer(session);
  if (session.closing || session.activeRequests > 0) return;
  session.timer = setTimeout(() => {
    session.timer = undefined;
    if (session.closing || session.activeRequests > 0) return;
    if (now() - session.lastUsedAt < timeoutMs) armIdleTimer(session, timeoutMs, now, close);
    else void close();
  }, Math.max(1, timeoutMs - (now() - session.lastUsedAt)));
  session.timer.unref?.();
}

/** A long-lived SDK SSE response remains active until its actual stream closes. */
export function trackSessionStream(response: Response, release: () => void): Response {
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { release(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) { release(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
