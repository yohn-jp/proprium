from pathlib import Path
import sys


def replace(path, old, new):
    file = Path(path)
    source = file.read_text()
    if source.count(old) != 1:
        raise RuntimeError(f'{path}: expected exactly one original fragment')
    file.write_text(source.replace(old, new))


if sys.argv[1] == 'tests':
    file = Path('packages/api/src/server.test.ts')
    file.write_text(file.read_text() + r'''

for (const status of [502, 503] as const) {
  for (const phase of ["read", "write"] as const) {
    it(`audit Hosted ${phase} dependency HTTP ${status} is not authentication denial`, async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "scriptorium-auth-outage-"));
      const normal = hostedTestPolicy();
      const policy: HostedAuthorizationPolicy = {
        ...normal,
        async authenticate(token, permission = "read") {
          if (permission === phase) throw Object.assign(new Error("private upstream detail"), { status });
          return normal.authenticate(token, permission);
        },
      };
      const apiServer = await startHostedApi(makeStore(), directory, policy, undefined, undefined, resolve(directory, "history"));
      try {
        const response = await fetch(`${apiServer.base}${phase === "read" ? "/api/session" : "/api/inbox/read-all"}`, {
          method: phase === "read" ? "GET" : "POST", headers: { Authorization: "Bearer write-grant" },
        });
        assert.equal(response.status, status);
        assert.equal(response.headers.has("www-authenticate"), false);
        const body = await response.json() as { code: string; error: string };
        assert.equal(body.code, "AUTHORIZATION_UNAVAILABLE");
        assert.ok(!body.error.includes("private"));
      } finally {
        await apiServer.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
''')
    file = Path('modules/mcp/src/http.test.ts')
    file.write_text(file.read_text() + r'''

test("audit MCP capacity reserves concurrent initialization and bounds abandoned sessions", async () => {
  const sessions = new Map();
  const contribution = createMcpHttpContribution(sessions, { maxSessions: 1, idleTimeoutMs: 60_000 });
  const host = actionContext([]);
  const initialize = (id: number) => new Request("http://scriptorium.test/streamable", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "limits", version: "1" } } }),
  });
  try {
    const responses = await Promise.all([contribution.handle(initialize(1), host), contribution.handle(initialize(2), host)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 503]);
    await Promise.all(responses.map(r => r.text()));
    assert.equal(sessions.size, 1);
    const denied = await contribution.handle(initialize(3), host);
    assert.equal(denied.status, 503);
    await denied.text();
  } finally { await closeMcpSessions(sessions); }
  assert.equal(sessions.size, 0);
});

test("audit MCP expires idle SDK sessions and cannot allocate after disposal", async () => {
  let now = 0;
  const sessions = new Map();
  const contribution = createMcpHttpContribution(sessions, { maxSessions: 1, idleTimeoutMs: 100, now: () => now });
  const host = actionContext([]);
  const initialize = () => new Request("http://scriptorium.test/streamable", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "expiry", version: "1" } } }),
  });
  try {
    const first = await contribution.handle(initialize(), host);
    assert.equal(first.status, 200);
    const oldId = first.headers.get("mcp-session-id");
    assert.ok(oldId);
    await first.text();
    now = 101;
    const old = await contribution.handle(new Request("http://scriptorium.test/streamable", { headers: { "mcp-session-id": oldId, Accept: "text/event-stream" } }), host);
    assert.equal(old.status, 404);
    await old.text();
    assert.equal(sessions.size, 0);
    const next = await contribution.handle(initialize(), host);
    assert.equal(next.status, 200);
    await next.text();
  } finally { await closeMcpSessions(sessions); }
  const stopped = await contribution.handle(initialize(), host);
  assert.equal(stopped.status, 503);
  await stopped.text();
});
''')
    sys.exit(0)

if sys.argv[1] != 'apply':
    raise RuntimeError('unknown phase')

replace('packages/api/src/server.ts', 'import { randomBytes, timingSafeEqual } from "node:crypto";',
        'import { authorizationFailure } from "./authorization-error.js";\nimport { randomBytes, timingSafeEqual } from "node:crypto";')
replace('packages/api/src/server.ts', '''        const candidate = error as { status?: unknown };
        const status = candidate?.status === 403 ? 403 : 401;
        if (routePath.endsWith("/modules/mcp/streamable")) {''', '''        const failure = authorizationFailure(error, "read");
        if (failure.status === 401 && routePath.endsWith("/modules/mcp/streamable")) {''')
replace('packages/api/src/server.ts', '''        fail(response, status, status === 403 ? "FORBIDDEN" : "UNAUTHORIZED", "Hosted repository access is invalid or expired");''', '''        fail(response, failure.status, failure.code, failure.message);''')
replace('packages/api/src/server.ts', '''        catch { throw httpFailure(403, "WRITE_PERMISSION_REQUIRED", "Current repository write permission is required"); }''', '''        catch (error) {
          const failure = authorizationFailure(error, "write");
          throw httpFailure(failure.status, failure.code, failure.message);
        }''')

api = Path('app/src/api.ts')
s = api.read_text()
start = s.index('export class ApiError extends Error {')
end = s.index('let hostedMode:', start)
s = s[:start] + s[end:]
s = 'import { ApiError } from "./api-error";\nexport { ApiError } from "./api-error";\nimport { responseContracts as dto, readApiResponse, decodeResponse, type ResponseGuard } from "./api-response";\n' + s
start = s.index('async function request<T>(')
end = s.index('async function requestEventStream(', start)
s = s[:start] + '''async function request<T>(guard: ResponseGuard<T>, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return readApiResponse(await fetchWithHostedRefresh(path, { ...init, headers }), guard);
}

''' + s[end:]
contracts = {
    'RuntimeVersion': 'version', '{ authenticated: true }': 'loggedIn', 'Session': 'session', '{ authenticated: false }': 'loggedOut',
    'PublicJob[]': 'jobs', 'PublicJob': 'job', 'InboxListResponse': 'inbox', '{ item: InboxItem }': 'inboxItem', '{ marked: number }': 'marked',
    'Project[]': 'projects', 'ProjectDetails': 'projectDetails', 'Project': 'project', '{ project: Project }': 'projectEnvelope', 'void': 'empty',
    'Tree': 'tree', 'TreeRead': 'treeRead', 'Scene': 'scene', 'SceneRead': 'sceneRead', '{ remote: SceneRead; effective: SceneRead }': 'sceneViews',
    'SnapshotRead': 'snapshotRead', 'Commit[]': 'history', 'ManuscriptSnapshotList': 'manuscriptList', 'ManuscriptSnapshotRead': 'manuscriptRead',
    'SyncStatus': 'sync', 'RemoteObservation': 'observation', 'RecentActivityResponse': 'recentActivity', '{ proposals: ProposalStatus[] }': 'proposals',
    'ChangeProposal': 'proposal', 'CheckpointReceipt': 'checkpoint', 'ReconcileResult': 'reconcile', 'PublishReceipt': 'publish',
    'ModuleStatus[]': 'modules', 'UiContribution[]': 'contributions', 'ActionResult': 'action',
}
for name, guard in contracts.items():
    token = f'request<{name}>('
    if token not in s:
        raise RuntimeError('missing API endpoint contract ' + name)
    s = s.replace(token, f'request(dto.{guard}, ')
s = s.replace('return (body ?? { authenticated: false }) as { authenticated: false };', 'return decodeResponse(body, dto.loggedOut);')
s = s.replace('{ signal }', '{ ...(signal ? { signal } : {}) }')
s = s.replace('      signal,', '      ...(signal ? { signal } : {}),')
s = s.replace(' }), signal },', ' }), ...(signal ? { signal } : {}) },')
api.write_text(s)
replace('app/src/api.test.ts', 'Response.json({ hosted: true })', 'Response.json({ name: "scriptorium", version: "0.1.0", hosted: true, profile: "hosted" })')
replace('app/src/api.test.ts', 'return Response.json({ remote: { snapshot }, effective: { snapshot } });', '''const read = { snapshot, scene: { id: "scene-1", title: "One", text: "text", revision: "revision" }, document: { path: "a.md", content: "text", revision: null }, metadata: { path: "a.yaml", content: "id: scene-1", revision: null } };
    return Response.json({ remote: read, effective: read });''')

replace('modules/mcp/src/index.ts', 'import { closeMcpSessions, createMcpHttpContribution } from "./http.js";', 'import { closeMcpSessions, createMcpHttpContribution, type McpSession } from "./http.js";')
replace('modules/mcp/src/index.ts', 'const sessions = new Map();', 'const sessions = new Map<string, McpSession>();')
http = Path('modules/mcp/src/http.ts')
s = http.read_text()
s = 'import { sessionLimits, clearIdleTimer, armIdleTimer, trackSessionStream, type SessionLifetime, type SessionLimits } from "./session-lifetime.js";\n' + s
s = s.replace('interface McpSession {', 'export interface McpSession extends SessionLifetime {\n  initialized: boolean;\n  closePromise: Promise<void> | undefined;')
start = s.index('/** Build a stateful SDK Streamable HTTP session')
s = s[:start] + r'''const disposedRegistries = new WeakSet<Map<string, McpSession>>();

function closeSession(session: McpSession, sessions: Map<string, McpSession>): Promise<void> {
  if (session.closePromise) return session.closePromise;
  session.closing = true;
  clearIdleTimer(session);
  if (session.sessionId && sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
  session.closePromise = session.ready.catch(() => undefined).then(() => session.server.close()).catch(() => undefined);
  return session.closePromise;
}

function createSession(projectId: string, sessions: Map<string, McpSession>, now: number): McpSession {
  const actionContext = new AsyncLocalStorage<ModuleActionContext>();
  const server = new McpServer({ name: "scriptorium-mcp", version: "0.1.0" });
  registerMcpTools(server, requestClient(actionContext));
  const sessionId = globalThis.crypto.randomUUID();
  let session: McpSession;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized() { session.initialized = true; },
    onsessionclosed() {
      session.closing = true;
      clearIdleTimer(session);
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    },
  });
  session = { projectId, server, transport, actionContext, sessionId, ready: Promise.resolve(),
    initialized: false, closing: false, activeRequests: 0, lastUsedAt: now, timer: undefined, closePromise: undefined };
  sessions.set(sessionId, session);
  session.ready = server.connect(transport);
  return session;
}

/** Owner-only MCP; bounded sessions never grant author mutation authority. */
export function createMcpHttpContribution(sessions: Map<string, McpSession>, options: SessionLimits = {}): HttpContribution {
  const { maxSessions, idleTimeoutMs, now } = sessionLimits(options);
  let pendingInitializations = 0;
  return {
    id: "streamable", path: "streamable", methods: ["GET", "POST", "DELETE"], access: "owner", effect: "propose",
    async handle(request, context) {
      if (disposedRegistries.has(sessions)) return errorResponse(503, "MCP module is stopping");
      for (const existing of sessions.values()) {
        if (existing.activeRequests === 0 && now() - existing.lastUsedAt >= idleTimeoutMs) await closeSession(existing, sessions);
      }
      const sessionId = request.headers.get("mcp-session-id");
      let session: McpSession;
      if (!sessionId) {
        if (request.method === "GET") return errorResponse(405, "Open an MCP session before opening an event stream");
        if (request.method === "DELETE") return errorResponse(404, "MCP session not found");
        if (sessions.size + pendingInitializations >= maxSessions) return errorResponse(503, "MCP session capacity reached");
        pendingInitializations++;
        try {
          if (!(await isInitializationRequest(request))) return errorResponse(400, "An MCP session ID is required; initialize a session first");
          if (disposedRegistries.has(sessions)) return errorResponse(503, "MCP module is stopping");
          session = createSession(context.projectId, sessions, now());
        } finally { pendingInitializations--; }
      } else {
        const existing = sessions.get(sessionId);
        if (!existing || !existing.initialized || existing.closing || existing.projectId !== context.projectId) return errorResponse(404, "MCP session not found for this project");
        session = existing;
      }
      session.activeRequests++;
      clearIdleTimer(session);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        session.activeRequests--;
        session.lastUsedAt = now();
        armIdleTimer(session, idleTimeoutMs, now, () => closeSession(session, sessions));
      };
      try {
        await session.ready;
        if (session.closing || disposedRegistries.has(sessions)) {
          release();
          await closeSession(session, sessions);
          return errorResponse(503, "MCP module is stopping");
        }
        const response = await session.actionContext.run(context, () => session.transport.handleRequest(request));
        if (!session.initialized) { release(); await closeSession(session, sessions); return response; }
        return trackSessionStream(response, release);
      } catch (error) {
        release();
        if (!session.initialized) await closeSession(session, sessions);
        throw error;
      }
    },
  };
}

export async function closeMcpSessions(sessions: Map<string, McpSession>): Promise<void> {
  disposedRegistries.add(sessions);
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map(session => closeSession(session, sessions)));
}
'''
http.write_text(s)

replace('Dockerfile', 'RUN pnpm build\n', 'RUN pnpm build:workspace\n')

for path in ['packages/core/src/index.test.ts', 'packages/core/src/transactions.test.ts']:
    file = Path(path)
    source = file.read_text()
    target = 'execFile("git", args,'
    if source.count(target) != 1:
        raise RuntimeError('expected one Git fixture helper in ' + path)
    source = source.replace(target, 'execFile("git", ["-c", "user.name=Test Writer", "-c", "user.email=writer@example.test", ...args],')
    file.write_text(source)

for filename in ['AGENTS.md', 'CONTRIBUTING.md']:
    file = Path(filename)
    source = file.read_text()
    if filename == 'AGENTS.md':
        old = 'Never run or synchronize GitHub Actions, CI workflows, or organization templates for this initial Core recovery.'
    else:
        old = 'Do not add, synchronize, or run CI/GitHub Actions or organization templates as part of the initial recovery.'
    if old not in source:
        raise RuntimeError('initial-recovery instruction changed')
    source = source.replace(old, 'Issue #29 authorizes repository verification CI and exact-source release gates after initial Core recovery. Verification never publishes or deploys. Only the gated release workflow may publish; do not synchronize organization templates or change production resources.')
    file.write_text(source)
print('Applied bounded audit edits; no main or production changes.')
