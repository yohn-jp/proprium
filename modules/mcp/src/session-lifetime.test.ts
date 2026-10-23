import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionLimits, armIdleTimer, clearIdleTimer, trackSessionStream, type SessionLifetime } from "./session-lifetime.js";

test("MCP idle expiry does not close an active request and releases its timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const session: SessionLifetime = { activeRequests: 1, lastUsedAt: 0, closing: false, timer: undefined };
  let closes = 0;
  const close = async () => { closes++; session.closing = true; };
  armIdleTimer(session, 100, Date.now, close);
  t.mock.timers.tick(200);
  assert.equal(closes, 0);
  session.activeRequests = 0;
  session.lastUsedAt = Date.now();
  armIdleTimer(session, 100, Date.now, close);
  t.mock.timers.tick(99);
  assert.equal(closes, 0);
  t.mock.timers.tick(1);
  assert.equal(closes, 1);
  clearIdleTimer(session);
  assert.equal(session.timer, undefined);
});

test("MCP tracks SSE activity until response cancellation", async () => {
  let released = 0;
  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { canceled++; } });
  const response = trackSessionStream(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }), () => released++);
  assert.equal(released, 0);
  await response.body!.cancel();
  assert.equal(released, 1);
  assert.equal(canceled, 1);
});

test("MCP session configuration rejects unbounded and zero limits", () => {
  for (const maxSessions of [0, -1, Infinity, NaN, 1.5]) assert.throws(() => sessionLimits({ maxSessions }));
  for (const idleTimeoutMs of [0, -1, Infinity, 2_147_483_648]) assert.throws(() => sessionLimits({ idleTimeoutMs }));
});
