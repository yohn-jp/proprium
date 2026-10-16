const active = new Map();
let shuttingDown = false;

function respond(message) {
  if (typeof process.send !== "function") return;
  process.send(message, () => {
    if (message.id) active.delete(message.id);
    if (shuttingDown && active.size === 0 && process.connected) process.disconnect();
  });
}

process.send?.({ type: "ready" });
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "shutdown") {
    shuttingDown = true;
    if (active.size === 0 && process.connected) process.disconnect();
    return;
  }
  if (message.type === "cancel" && typeof message.id === "string") {
    const running = active.get(message.id);
    if (running) {
      clearTimeout(running.timer);
      const request = running.request;
      respond({ type: "error", id: request.id, snapshot: request.snapshot,
      error: { code: "job_cancelled", message: "cancelled in worker service", retryable: false } });
    }
    return;
  }
  if (message.type !== "job" || !message.request || typeof message.request.id !== "string") return;
  const request = message.request;
  const running = { request, timer: undefined };
  active.set(request.id, running);
  if (request.task === "hold") {
    running.timer = setTimeout(() => {
      respond({ type: "result", result: {
        id: request.id,
        snapshot: request.snapshot,
        model: request.model,
        modelVersion: request.modelVersion,
        moduleVersion: request.moduleVersion,
        output: { pid: process.pid, task: request.task, input: request.input },
      } });
    }, 30_000);
    return;
  }
  const output = { pid: process.pid, task: request.task, input: request.input };
  respond({ type: "result", result: {
    id: request.id,
    snapshot: request.snapshot,
    model: request.model,
    modelVersion: request.modelVersion,
    moduleVersion: request.moduleVersion,
    output,
  } });
});
