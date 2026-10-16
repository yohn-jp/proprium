function send(message, done) {
  if (typeof process.send === "function") process.send(message, done);
  else done?.();
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "job") {
    const request = message.request;
    if (request.task === "hold") {
      const timer = setInterval(() => {}, 1000);
      send({ type: "ready" });
      process.on("message", (control) => {
        if (control?.type !== "cancel" || control.id !== request.id) return;
        clearInterval(timer);
        send({ type: "error", id: request.id, snapshot: request.snapshot,
          error: { code: "job_cancelled", message: "cancelled in worker", retryable: false } }, () => process.disconnect());
      });
      return;
    }
    const output = request.task === "large"
      ? "x".repeat(request.input.size)
      : {
          echo: request.input,
          pid: process.pid,
          cwd: process.cwd(),
          credentials: {
            github: process.env.GITHUB_TOKEN ?? null,
            openai: process.env.OPENAI_API_KEY ?? null,
            injected: process.env.UNDECLARED_SECRET ?? null,
            home: process.env.HOME ?? null,
            nodeOptions: process.env.NODE_OPTIONS ?? null,
          },
        };
    const result = {
      id: request.id,
      snapshot: request.snapshot,
      model: request.model,
      modelVersion: request.modelVersion === "wrong" ? "other" : request.modelVersion,
      moduleVersion: request.moduleVersion,
      output,
    };
    send({ type: "result", result }, () => process.disconnect());
  }
});
