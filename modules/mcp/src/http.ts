import { sessionLimits, clearIdleTimer, armIdleTimer, trackSessionStream, type SessionLifetime, type SessionLimits } from "./session-lifetime.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionDescriptor, ChangeOperation, ChangeProposal, ModuleActionContext, ProposalEvidence } from "@scriptorium/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HttpContribution } from "@scriptorium/contracts";
import { McpApiError, type McpActionClient } from "./api-client.js";
import { registerMcpTools } from "./tools.js";

export interface McpSession extends SessionLifetime {
  initialized: boolean;
  closePromise: Promise<void> | undefined;
  projectId: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  actionContext: AsyncLocalStorage<ModuleActionContext>;
  ready: Promise<void>;
  sessionId?: string;
}

function unavailableContext(): never {
  throw new Error("MCP action context is unavailable outside an authenticated request");
}

/** Bind each MCP message to the project/snapshot context supplied by its host HTTP request. */
function requestClient(storage: AsyncLocalStorage<ModuleActionContext>): McpActionClient {
  const current = () => storage.getStore() ?? unavailableContext();
  return {
    get projectId() {
      return storage.getStore()?.projectId;
    },
    listActions(): Promise<ActionDescriptor[]> {
      return current().listActions();
    },
    invoke(actionId: string, input: unknown, signal?: AbortSignal) {
      return current().invoke(actionId, input, signal);
    },
    propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string, signal?: AbortSignal): Promise<ChangeProposal> {
      return current().propose(operations, evidence, proposalId, signal);
    },
    forProject(projectId: string): McpActionClient {
      const context = current();
      if (context.projectId !== projectId) {
        throw new McpApiError(403, "PROJECT_SCOPE_MISMATCH", "The requested project does not match this MCP session");
      }
      return {
        projectId,
        listActions: () => context.listActions(),
        invoke: (actionId, input, signal) => context.invoke(actionId, input, signal),
        propose: (operations, evidence, proposalId, signal) => context.propose(operations, evidence, proposalId, signal),
        forProject(requestedId) {
          if (requestedId !== projectId) throw new McpApiError(403, "PROJECT_SCOPE_MISMATCH", "The requested project does not match this MCP session");
          return this;
        },
      };
    },
  };
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function isInitializationRequest(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body: unknown = await request.clone().json();
    return Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
  } catch {
    return false;
  }
}

const disposedRegistries = new WeakSet<Map<string, McpSession>>();

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
