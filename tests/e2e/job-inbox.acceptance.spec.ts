import { expect, test, type Page, type Route } from "@playwright/test";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const now = "2026-10-17T00:00:00.000Z";

function fixtureJob(overrides: Record<string, unknown>) {
  return {
    id: "job-running-1",
    type: "speaker-evaluation",
    status: "running",
    progress: 0.1,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    ...overrides,
  };
}

async function assertOwnerCookie(route: Route): Promise<void> {
  const headers = await route.request().allHeaders();
  expect(headers.cookie).toContain("scriptorium_session=");
}

async function emitJobEvent(page: Page, event: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (payload) => {
    const testWindow = window as Window & { __emitJobInboxEvent?: (event: object) => void };
    if (!testWindow.__emitJobInboxEvent) throw new Error("The inbox test event stream is not connected");
    testWindow.__emitJobInboxEvent(payload);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }, event);
}

test("authenticated inbox preserves owner job history and updates it from SSE", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  const jobs = [
    fixtureJob({ id: "job-running-1" }),
    fixtureJob({
      id: "job-done-1",
      type: "assistant.summary",
      status: "done",
      progress: 1,
      result: { summary: "Synthetic completed result" },
      updatedAt: "2026-10-17T00:01:00.000Z",
      finishedAt: "2026-10-17T00:01:00.000Z",
    }),
    fixtureJob({
      id: "job-error-1",
      type: "speaker-training",
      status: "error",
      progress: null,
      error: "Synthetic worker failure",
      errorCode: "worker_unavailable",
      retryable: false,
      updatedAt: "2026-10-17T00:02:00.000Z",
      finishedAt: "2026-10-17T00:02:00.000Z",
    }),
  ];
  let inboxItems = [
    {
      id: "inbox-done-1",
      kind: "job-complete",
      jobId: "job-done-1",
      jobType: "assistant.summary",
      title: "要約の生成が完了しました",
      body: "Synthetic completion message",
      status: "done",
      read: false,
      userId: null,
      projectKey: "fixture-repository",
      createdAt: "2026-10-17T00:01:00.000Z",
    },
    {
      id: "inbox-error-1",
      kind: "job-complete",
      jobId: "job-error-1",
      jobType: "speaker-training",
      title: "学習に失敗しました",
      body: "Synthetic failure message",
      status: "error",
      read: false,
      userId: null,
      projectKey: "fixture-repository",
      createdAt: "2026-10-17T00:02:00.000Z",
    },
  ];
  const apiRequestsBeforeLogin: string[] = [];
  let gateNextJobsRead = false;
  let terminalEventSent = false;
  let releaseQueuedRead: (() => void) | null = null;
  let reportQueuedReadStarted: (() => void) | null = null;
  const queuedReadGate = new Promise<void>((resolve) => { releaseQueuedRead = resolve; });
  const queuedReadStarted = new Promise<void>((resolve) => { reportQueuedReadStarted = resolve; });

  const raceQueuedJob = fixtureJob({
    id: "job-race-1",
    type: "speaker-evaluation-race",
    status: "queued",
    progress: 0,
  });
  const raceCompletedJob = fixtureJob({
    id: "job-race-1",
    type: "speaker-evaluation-race",
    status: "done",
    progress: 1,
    result: { summary: "Completed after queued snapshot" },
    updatedAt: "2026-10-17T00:03:00.000Z",
    finishedAt: "2026-10-17T00:03:00.000Z",
  });
  const raceCompletionItem = {
    id: "inbox-race-1",
    kind: "job-complete",
    jobId: "job-race-1",
    jobType: "speaker-evaluation-race",
    title: "評価が完了しました",
    body: "Completion after queued snapshot",
    status: "done",
    read: false,
    userId: null,
    projectKey: "fixture-repository",
    createdAt: "2026-10-17T00:03:00.000Z",
  };

  await page.addInitScript(() => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const eventStream = new ReadableStream<Uint8Array>({
      start(nextController) { controller = nextController; },
      cancel() { controller = null; },
    });
    const testWindow = window as Window & { __emitJobInboxEvent?: (event: object) => void };
    testWindow.__emitJobInboxEvent = (event) => {
      if (!controller) throw new Error("The inbox event stream is not readable");
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = input instanceof Request ? input.url : String(input);
      if (new URL(inputUrl, window.location.href).pathname !== "/api/jobs/events") return originalFetch(input, init);
      const response = await originalFetch(input, init);
      if (!response.ok) return response;
      await response.body?.cancel().catch(() => undefined);
      init?.signal?.addEventListener("abort", () => {
        try { controller?.close(); } catch { /* The stream may already be closed. */ }
      }, { once: true });
      return new Response(eventStream, { status: response.status, headers: response.headers });
    };
  });

  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/jobs" || path === "/api/jobs/events" || path.startsWith("/api/inbox")) {
      apiRequestsBeforeLogin.push(path);
    }
  });

  await page.route((url) => {
    const path = new URL(url).pathname;
    return path === "/api/jobs" || path === "/api/jobs/events" || path.startsWith("/api/jobs/");
  }, async (route) => {
    await assertOwnerCookie(route);
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/jobs/events") {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      return;
    }
    if (path === "/api/jobs" && route.request().method() === "GET") {
      if (gateNextJobsRead) {
        gateNextJobsRead = false;
        reportQueuedReadStarted?.();
        await queuedReadGate;
        await route.fulfill({ json: [...jobs, raceQueuedJob] });
        return;
      }
      await route.fulfill({ json: terminalEventSent ? [...jobs, raceCompletedJob] : jobs });
      return;
    }
    const jobId = path.match(/^\/api\/jobs\/([^/]+)$/u)?.[1];
    const job = jobs.find((candidate) => candidate.id === jobId);
    await route.fulfill(job ? { json: job } : { status: 404, json: { error: "Job was not found" } });
  });

  await page.route("**/api/inbox**", async (route) => {
    await assertOwnerCookie(route);
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET") {
      const unreadOnly = new URL(route.request().url()).searchParams.get("unread") === "1";
      if (terminalEventSent && !inboxItems.some((item) => item.id === raceCompletionItem.id)) inboxItems.push(raceCompletionItem);
      const items = inboxItems.filter((item) => !unreadOnly || !item.read);
      await route.fulfill({ json: { items, unreadCount: inboxItems.filter((item) => !item.read).length } });
      return;
    }
    if (path === "/api/inbox/read-all") {
      const marked = inboxItems.filter((item) => !item.read).length;
      inboxItems = inboxItems.map((item) => ({ ...item, read: true }));
      await route.fulfill({ json: { marked } });
      return;
    }
    const itemId = path.match(/^\/api\/inbox\/([^/]+)\/read$/u)?.[1];
    const item = inboxItems.find((candidate) => candidate.id === itemId);
    if (!item) {
      await route.fulfill({ status: 404, json: { error: "Inbox item was not found" } });
      return;
    }
    inboxItems = inboxItems.map((candidate) => candidate.id === itemId ? { ...candidate, read: true } : candidate);
    await route.fulfill({ json: { item: inboxItems.find((candidate) => candidate.id === itemId) } });
  });

  await page.goto("/");
  await expect(page.getByLabel("アクセストークン")).toBeVisible();
  expect(apiRequestsBeforeLogin).toEqual([]);
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();

  const inboxButton = page.getByRole("button", { name: /受信箱/u });
  await expect(inboxButton).toContainText("2");
  await inboxButton.click();

  const dialog = page.getByRole("dialog", { name: "受信箱とジョブ履歴" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "更新" })).toBeEnabled();
  await emitJobEvent(page, {
    type: "job-progress",
    jobId: "job-running-1",
    jobType: "speaker-evaluation",
    status: "running",
    progress: 0.37,
    at: "2026-10-17T00:00:30.000Z",
  });
  const runningJob = dialog.getByRole("listitem").filter({ hasText: "speaker-evaluation" });
  await expect(runningJob.getByRole("progressbar")).toHaveAttribute("value", "0.37");
  await expect(runningJob).toContainText("37%");
  const completedJob = dialog.getByRole("listitem").filter({ hasText: "assistant.summary" });
  await completedJob.getByText("結果を表示").click();
  await expect(completedJob).toContainText("Synthetic completed result");
  const failedJob = dialog.getByRole("listitem").filter({ hasText: "speaker-training" });
  await expect(failedJob).toContainText("Synthetic worker failure");
  await expect(failedJob).toContainText("worker_unavailable");

  const notifications = dialog.getByRole("region", { name: "通知" });
  await expect(notifications).toContainText("Synthetic completion message");
  await expect(notifications).toContainText("Synthetic failure message");

  gateNextJobsRead = true;
  await emitJobEvent(page, {
    type: "job-status",
    jobId: "job-race-1",
    jobType: "speaker-evaluation-race",
    status: "queued",
    progress: 0,
    at: "2026-10-17T00:02:30.000Z",
  });
  await queuedReadStarted;
  terminalEventSent = true;
  await emitJobEvent(page, {
    type: "job-status",
    jobId: "job-race-1",
    jobType: "speaker-evaluation-race",
    status: "done",
    progress: 1,
    at: "2026-10-17T00:03:00.000Z",
  });
  inboxItems.push(raceCompletionItem);
  releaseQueuedRead?.();
  const racedJob = dialog.getByRole("listitem").filter({ hasText: "speaker-evaluation-race" });
  await expect(racedJob).toContainText("完了");
  await expect(notifications).toContainText("Completion after queued snapshot");
  await expect(inboxButton).toContainText("3");

  await notifications.getByRole("button", { name: "既読" }).first().click();
  await expect(notifications).toContainText("未読 2 件");
  await dialog.getByRole("button", { name: "すべて既読" }).click();
  await expect(notifications).toContainText("未読 0 件");
  await expect(inboxButton).not.toContainText("2");
});
