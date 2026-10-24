import assert from "node:assert/strict";
import { test } from "node:test";

test("ordinary API requests stop at document departure while keepalive cursor writes remain allowed", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const listeners = new Map<string, Array<{ listener: EventListenerOrEventListenerObject; capture: boolean }>>();
  const redirects: string[] = [];
  const fakeWindow = {
    location: { assign(url: string) { redirects.push(url); } },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      const entries = listeners.get(type) ?? [];
      entries.push({ listener, capture: typeof options === "boolean" ? options : options?.capture ?? false });
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry.listener !== listener));
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });

  try {
    const { api, DocumentDepartureError } = await import("./api.js");
    const requests: Array<{ input: string; keepalive: boolean }> = [];
    let holdInitialProject = false;
    let initialProjectStarted!: () => void;
    const initialAdmission = new Promise<void>((resolve) => { initialProjectStarted = resolve; });
    let releaseInitialProject!: (response: Response) => void;
    const initialProjectResponse = new Promise<Response>((resolve) => { releaseInitialProject = resolve; });
    let holdRefresh = false;
    let refreshStarted!: () => void;
    const refreshAdmission = new Promise<void>((resolve) => { refreshStarted = resolve; });
    let releaseRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
    let holdPendingRefresh = false;
    let pendingGrantFresh = false;
    let pendingRefreshStarted!: () => void;
    const pendingRefreshAdmission = new Promise<void>((resolve) => { pendingRefreshStarted = resolve; });
    let releasePendingRefresh!: (response: Response) => void;
    const pendingRefreshResponse = new Promise<Response>((resolve) => { releasePendingRefresh = resolve; });
    let holdStaleRefresh = false;
    let staleRefreshStarted!: () => void;
    const staleRefreshAdmission = new Promise<void>((resolve) => { staleRefreshStarted = resolve; });
    let releaseStaleRefresh!: (response: Response) => void;
    const staleRefreshResponse = new Promise<Response>((resolve) => { releaseStaleRefresh = resolve; });
    let finalRetryMode: "none" | "fallback" | "locks" = "none";
    let finalRetryAttempt = 0;
    let finalRetryAdmission = new Promise<void>(() => {});
    let releaseFinalRetry!: (response: Response) => void;
    let finalRetryResponse = new Promise<Response>(() => {});
    let signalFinalRetryStarted!: () => void;
    let rejectHeldProjectFetch = false;
    let rejectedProjectFetchStarted!: () => void;
    const rejectedProjectFetchAdmission = new Promise<void>((resolve) => { rejectedProjectFetchStarted = resolve; });
    let rejectProjectFetch!: (error: Error) => void;
    const rejectedProjectFetchResponse = new Promise<Response>((_resolve, reject) => { rejectProjectFetch = reject; });
    let holdProjectBody = false;
    let projectBodyStarted!: () => void;
    const projectBodyAdmission = new Promise<void>((resolve) => { projectBodyStarted = resolve; });
    let rejectProjectBody!: (error: Error) => void;
    const heldProjectBody = new Promise<unknown>((_resolve, reject) => { rejectProjectBody = reject; });
    let failProjectFetchWhileActive = false;
    let holdLogoutBody = false;
    let logoutBodyStarted!: () => void;
    const logoutBodyAdmission = new Promise<void>((resolve) => { logoutBodyStarted = resolve; });
    let rejectLogoutBody!: (error: Error) => void;
    const heldLogoutBody = new Promise<unknown>((_resolve, reject) => { rejectLogoutBody = reject; });
    let holdJobStreamFetch = false;
    let jobStreamFetchStarted!: () => void;
    const jobStreamFetchAdmission = new Promise<void>((resolve) => { jobStreamFetchStarted = resolve; });
    let rejectJobStreamFetch!: (error: Error) => void;
    const rejectedJobStreamFetch = new Promise<Response>((_resolve, reject) => { rejectJobStreamFetch = reject; });
    globalThis.fetch = async (input, init) => {
      requests.push({ input: String(input), keepalive: init?.keepalive === true });
      if (String(input) === "/api/version") {
        return Response.json({ name: "scriptorium", version: "0.1.0", hosted: true, profile: "hosted" });
      }
      if (String(input) === "/api/projects" && holdInitialProject) {
        initialProjectStarted();
        return initialProjectResponse;
      }
      if (String(input) === "/_platform/refresh" && holdRefresh) {
        refreshStarted();
        return refreshResponse;
      }
      if (String(input) === "/_platform/refresh" && holdPendingRefresh) {
        pendingRefreshStarted();
        return pendingRefreshResponse;
      }
      if (String(input) === "/_platform/refresh" && holdStaleRefresh) {
        staleRefreshStarted();
        return staleRefreshResponse;
      }
      if (String(input) === "/_platform/refresh" && finalRetryMode !== "none") {
        return Response.json({ refreshed: true });
      }
      if (String(input) === "/api/projects" && holdRefresh) {
        return Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
      }
      if (String(input) === "/api/projects" && holdPendingRefresh && !pendingGrantFresh) {
        return Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
      }
      if (String(input) === "/api/projects" && holdStaleRefresh) {
        return Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
      }
      if (String(input) === "/api/projects" && rejectHeldProjectFetch) {
        rejectedProjectFetchStarted();
        return rejectedProjectFetchResponse;
      }
      if (String(input) === "/api/projects" && holdProjectBody) {
        const response = Response.json([]);
        Object.defineProperty(response, "json", {
          value: () => {
            projectBodyStarted();
            return heldProjectBody;
          },
        });
        return response;
      }
      if (String(input) === "/_platform/logout" && holdLogoutBody) {
        const response = Response.json({ authenticated: false });
        Object.defineProperty(response, "json", {
          value: () => {
            logoutBodyStarted();
            return heldLogoutBody;
          },
        });
        return response;
      }
      if (String(input) === "/api/jobs/events" && holdJobStreamFetch) {
        jobStreamFetchStarted();
        return rejectedJobStreamFetch;
      }
      if (String(input) === "/api/projects" && failProjectFetchWhileActive) {
        throw new TypeError("The active network request failed.");
      }
      if (String(input) === "/api/projects" && finalRetryMode !== "none") {
        finalRetryAttempt += 1;
        const retryAttempt = finalRetryMode === "locks" ? 3 : 2;
        if (finalRetryAttempt === retryAttempt) {
          signalFinalRetryStarted();
          return finalRetryResponse;
        }
        return Response.json({ error: "Authentication required", code: "UNAUTHORIZED" }, { status: 401 });
      }
      if (String(input).endsWith("/recent-activity")) {
        return Response.json({ items: [{ sceneId: "scene-1", sentenceOffset: null, deviceType: "mobile", updatedAt: "2026-01-01T00:00:00.000Z" }] });
      }
      if (String(input) === "/api/projects") return Response.json([]);
      throw new Error(`Unexpected request: ${String(input)}`);
    };

    const dispatch = (type: string, event: Event) => {
      for (const { listener } of [...(listeners.get(type) ?? [])].sort((left, right) => Number(right.capture) - Number(left.capture))) {
        if (typeof listener === "function") listener.call(fakeWindow, event);
        else listener.handleEvent(event);
      }
    };
    const afterMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

    fakeWindow.addEventListener("beforeunload", (event) => event.preventDefault());
    const canceled = new Event("beforeunload", { cancelable: true });
    dispatch("beforeunload", canceled);
    await afterMicrotasks();
    assert.equal(canceled.defaultPrevented, true);
    assert.deepEqual(await api.projects(), []);
    assert.equal(requests.length, 1);

    await api.version();
    holdInitialProject = true;
    const initialProjectRequest = api.projects();
    await initialAdmission;
    dispatch("pageshow", new Event("pageshow"));
    releaseInitialProject(Response.json([]));
    assert.deepEqual(await initialProjectRequest, []);
    assert.equal(requests.filter((request) => request.input === "/api/projects").length, 2);
    holdInitialProject = false;

    holdRefresh = true;
    const refreshingRequest = api.projects();
    await refreshAdmission;
    listeners.set("beforeunload", (listeners.get("beforeunload") ?? []).filter((entry) => entry.capture));
    dispatch("beforeunload", new Event("beforeunload", { cancelable: true }));
    await afterMicrotasks();
    releaseRefresh(Response.json({ error: "Refresh grant expired", code: "UNAUTHORIZED" }, { status: 401 }));
    await assert.rejects(refreshingRequest, (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError");
    assert.deepEqual(redirects, []);
    assert.equal(requests.filter((request) => request.input === "/api/projects").length, 4);

    await assert.rejects(api.projects(), (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError");
    assert.equal(requests.filter((request) => request.input === "/api/projects").length, 4);

    holdRefresh = false;
    await api.putRecentActivity("project-1", { sceneId: "scene-1", sentenceOffset: null, deviceType: "mobile" }, { keepalive: true });
    assert.equal(requests.at(-1)?.keepalive, true);

    dispatch("pageshow", new Event("pageshow"));
    assert.deepEqual(await api.projects(), []);
    assert.equal(requests.filter((request) => request.input === "/api/projects").length, 5);

    dispatch("pagehide", new Event("pagehide"));
    await assert.rejects(api.projects(), (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError");
    assert.equal(requests.filter((request) => request.input === "/api/projects").length, 5);
    dispatch("pageshow", new Event("pageshow"));
    assert.deepEqual(await api.projects(), []);
    assert.equal(requests.filter((request) => request.input === "/api/projects").length, 6);

    holdRefresh = true;
    let lockQueued!: () => void;
    const lockQueuedSignal = new Promise<void>((resolve) => { lockQueued = resolve; });
    let runQueuedLock!: () => void;
    const fakeNavigator = {
      locks: {
        request(_name: string, callback: () => Promise<Response>): Promise<Response> {
          lockQueued();
          return new Promise<Response>((resolve, reject) => {
            runQueuedLock = () => { callback().then(resolve, reject); };
          });
        },
      },
    };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: fakeNavigator });
    const queuedRequest = api.projects();
    await lockQueuedSignal;
    dispatch("pagehide", new Event("pagehide"));
    dispatch("pageshow", new Event("pageshow"));
    runQueuedLock();
    await assert.rejects(queuedRequest, (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError");
    assert.equal(requests.filter((request) => request.input === "/api/projects").length, 7);

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: undefined } });
    holdRefresh = false;
    holdPendingRefresh = true;
    const refreshCountBeforeResume = requests.filter((request) => request.input === "/_platform/refresh").length;
    const departingCaller = api.projects();
    await pendingRefreshAdmission;
    dispatch("pagehide", new Event("pagehide"));
    dispatch("pageshow", new Event("pageshow"));
    const restoredCaller = api.projects();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.filter((request) => request.input === "/_platform/refresh").length, refreshCountBeforeResume + 1);
    pendingGrantFresh = true;
    releasePendingRefresh(Response.json({ refreshed: true }));
    await assert.rejects(departingCaller, (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError");
    assert.deepEqual(await restoredCaller, []);
    assert.equal(requests.filter((request) => request.input === "/_platform/refresh").length, refreshCountBeforeResume + 1);
    holdPendingRefresh = false;

    holdStaleRefresh = true;
    const staleCaller = api.projects();
    await staleRefreshAdmission;
    dispatch("pagehide", new Event("pagehide"));
    dispatch("pageshow", new Event("pageshow"));
    const refreshCountBeforeShared401 = requests.filter((request) => request.input === "/_platform/refresh").length;
    const restored401Callers = Promise.allSettled([api.projects(), api.projects()]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.filter((request) => request.input === "/_platform/refresh").length, refreshCountBeforeShared401);
    releaseStaleRefresh(Response.json({ error: "Refresh grant expired", code: "UNAUTHORIZED" }, { status: 401 }));
    await assert.rejects(staleCaller, (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError");
    const active401Results = await restored401Callers;
    assert.equal(active401Results.length, 2);
    assert.ok(active401Results.every((result) => result.status === "rejected" && result.reason instanceof Error &&
      "status" in result.reason && result.reason.status === 401));
    assert.deepEqual(redirects, ["/_platform/reauth"]);
    holdStaleRefresh = false;

    for (const mode of ["fallback", "locks"] as const) {
      finalRetryMode = mode;
      finalRetryAttempt = 0;
      finalRetryAdmission = new Promise<void>((resolve) => { signalFinalRetryStarted = resolve; });
      finalRetryResponse = new Promise<Response>((resolve) => { releaseFinalRetry = resolve; });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { locks: mode === "locks" ? { request: (_name: string, callback: () => Promise<Response>) => callback() } : undefined },
      });
      const refreshCountBeforeRetry = requests.filter((request) => request.input === "/_platform/refresh").length;
      const finalRetryCaller = api.projects();
      await finalRetryAdmission;
      dispatch("pagehide", new Event("pagehide"));
      dispatch("pageshow", new Event("pageshow"));
      releaseFinalRetry(Response.json([]));
      await assert.rejects(finalRetryCaller, (error: unknown) => error instanceof DocumentDepartureError && error.name === "AbortError");
      assert.equal(finalRetryAttempt, mode === "locks" ? 3 : 2);
      assert.equal(requests.filter((request) => request.input === "/_platform/refresh").length, refreshCountBeforeRetry + 1);
      finalRetryMode = "none";
    }

    rejectHeldProjectFetch = true;
    const rejectedFetchRequest = api.projects();
    await rejectedProjectFetchAdmission;
    dispatch("pagehide", new Event("pagehide"));
    dispatch("pageshow", new Event("pageshow"));
    rejectProjectFetch(new TypeError("The browser canceled the fetch."));
    await assert.rejects(rejectedFetchRequest, (error: unknown) => error instanceof DocumentDepartureError);
    rejectHeldProjectFetch = false;

    holdProjectBody = true;
    const rejectedBodyRequest = api.projects();
    await projectBodyAdmission;
    dispatch("pagehide", new Event("pagehide"));
    dispatch("pageshow", new Event("pageshow"));
    rejectProjectBody(new TypeError("The browser canceled response body consumption."));
    await assert.rejects(rejectedBodyRequest, (error: unknown) => error instanceof DocumentDepartureError);
    holdProjectBody = false;

    failProjectFetchWhileActive = true;
    await assert.rejects(api.projects(), (error: unknown) => error instanceof TypeError && error.message === "The active network request failed.");
    failProjectFetchWhileActive = false;

    holdLogoutBody = true;
    const logoutRequest = api.logout();
    await logoutBodyAdmission;
    dispatch("pagehide", new Event("pagehide"));
    dispatch("pageshow", new Event("pageshow"));
    rejectLogoutBody(new TypeError("The browser canceled logout response parsing."));
    await assert.rejects(logoutRequest, (error: unknown) => error instanceof DocumentDepartureError);
    holdLogoutBody = false;

    holdJobStreamFetch = true;
    const eventStreamRequest = api.jobEventStream(new AbortController().signal);
    await jobStreamFetchAdmission;
    dispatch("pagehide", new Event("pagehide"));
    dispatch("pageshow", new Event("pageshow"));
    rejectJobStreamFetch(new TypeError("The browser canceled the stream handshake."));
    await assert.rejects(eventStreamRequest, (error: unknown) => error instanceof DocumentDepartureError);
    holdJobStreamFetch = false;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
