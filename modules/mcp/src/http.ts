import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionDescriptor, ChangeOperation, ChangeProposal, ModuleActionContext, ProposalEvidence } from "@scriptorium/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HttpContribution } from "@scriptorium/contracts";
import type { McpActionClient } from "./api-client.js";
import { registerMcpTools } from "./tools.js";

interface McpSession {
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
    invoke(actionId: string, input: unknown) {
      return current().invoke(actionId, input);
    },
    propose(operations: ChangeOperation[], evidence?: ProposalEvidence[], proposalId?: string): Promise<ChangeProposal> {
      return current().propose(operations, evidence, proposalId);
    },
    forProject(projectId: string): McpActionClient {
      const context = current();
      if (context.projectId !== projectId) {
        throw new Error("The requested project does not match this MCP session");
      }
      return {
        projectId,
        listActions: () => context.listActions(),
        invoke: (actionId, input) => context.invoke(actionId, input),
        propose: (operations, evidence, proposalId) => context.propose(operations, evidence, proposalId),
        forProject(requestedId) {
          if (requestedId !== projectId) throw new Error("The requested project does not match this MCP session");
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

/** Build a stateful SDK Streamable HTTP session using only Web Standard Request/Response APIs. */
function createSession(projectId: string, sessions: Map<string, McpSession>): McpSession {
  const actionContext = new AsyncLocalStorage<ModuleActionContext>();
  const server = new McpServer({ name: "scriptorium-mcp", version: "0.1.0" });
  registerMcpTools(server, requestClient(actionContext));

  let session: McpSession;
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => globalThis.crypto.randomUUID(),
    onsessioninitialized(sessionId) {
      session.sessionId = sessionId;
      sessions.set(sessionId, session);
    },
    onsessionclosed(sessionId) {
      const existing = sessions.get(sessionId);
      if (existing) sessions.delete(sessionId);
    },
  });
  session = { projectId, server, transport, actionContext, ready: Promise.resolve() };
  session.ready = server.connect(transport);
  return session;
}

/** Owner-only MCP transport contribution; all effects go through the host action/proposal context. */
export function createMcpHttpContribution(sessions: Map<string, McpSession>): HttpContribution {
  return {
    id: "streamable",
    path: "streamable",
    methods: ["GET", "POST", "DELETE"],
    access: "owner",
    effect: "propose",
    async handle(request, context) {
      const sessionId = request.headers.get("mcp-session-id");
      let session: McpSession | undefined;

      if (!sessionId) {
        if (request.method === "GET") return errorResponse(405, "Open an MCP session before opening an event stream");
        if (request.method === "DELETE") return errorResponse(404, "MCP session not found");
        if (!(await isInitializationRequest(request))) {
          return errorResponse(400, "An MCP session ID is required; initialize a session first");
        }
        session = createSession(context.projectId, sessions);
      } else {
        session = sessions.get(sessionId);
        if (!session) return errorResponse(404, "MCP session not found");
        if (session.projectId !== context.projectId) {
          return errorResponse(404, "MCP session not found for this project");
        }
      }

      await session.ready;
      return session.actionContext.run(context, () => session!.transport.handleRequest(request));
    },
  };
}

export async function closeMcpSessions(sessions: Map<string, McpSession>): Promise<void> {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map((session) => session.server.close().catch(() => undefined)));
}
