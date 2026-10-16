import type {
  ActionDescriptor,
  ActionResult,
  ChangeProposal,
  ProposalEvidence,
  RemoteObservation,
} from "@scriptorium/contracts";

export interface McpActionClient {
  readonly projectId?: string;
  /** Available on the standalone owner bearer transport; an in-process MCP session is project-bound. */
  listProjects?(): Promise<ProjectInfo[]>;
  listActions(): Promise<ActionDescriptor[]>;
  invoke(actionId: string, input: unknown): Promise<ActionResult>;
  propose(
    operations: ChangeProposal["operations"],
    evidence?: ProposalEvidence[],
    proposalId?: string,
  ): Promise<ChangeProposal>;
  forProject?(projectId: string): McpActionClient;
}

export interface ProjectInfo {
  id: string;
  url: string;
  branch: string;
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  projectId?: string;
  fetch?: typeof fetch;
}

export class McpApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message.slice(0, 512));
    this.name = "McpApiError";
  }
}

function statusCode(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return "INVALID_INPUT";
    case 401:
    case 403:
      return "UNAUTHORIZED";
    case 404:
      return "NOT_FOUND";
    case 409:
    case 412:
    case 428:
      return "STALE_PRECONDITION";
    case 423:
      return "PROJECT_WRITE_LOCKED";
    default:
      return "INTERNAL_ERROR";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bearer client used by the compiled stdio entry. It only calls the owner API. */
export class ApiClient implements McpActionClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ApiClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("MCP API URL must use HTTP or HTTPS");
    }
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
  }

  get projectId(): string | undefined {
    return this.options.projectId;
  }

  forProject(projectId: string): ApiClient {
    return new ApiClient({ ...this.options, projectId });
  }

  private projectPath(path: string): string {
    if (!this.options.projectId) {
      throw new McpApiError(400, "INVALID_PROJECT", "Set SCRIPTORIUM_PROJECT_ID or pass project_id");
    }
    return `/api/projects/${encodeURIComponent(this.options.projectId)}${path}`;
  }

  private async requestPath<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const hasBody = body !== undefined;
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const error = isRecord(payload) ? payload.error : undefined;
      const nestedCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      const code =
        (isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined) ??
        nestedCode ??
        statusCode(response.status);
      throw new McpApiError(
        response.status,
        code,
        typeof error === "string"
          ? error
          : isRecord(error) && typeof error.message === "string"
            ? error.message
            : `API request failed: ${method} ${path}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return this.requestPath(method, this.projectPath(path), body);
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const projects = await this.requestPath<unknown>("GET", "/api/projects");
    if (
      !Array.isArray(projects) ||
      projects.some(
        (project) =>
          !isRecord(project) ||
          typeof project.id !== "string" ||
          typeof project.url !== "string" ||
          typeof project.branch !== "string",
      )
    ) {
      throw new McpApiError(502, "INVALID_RESPONSE", "Project list response is invalid");
    }
    return projects as ProjectInfo[];
  }

  async listActions(): Promise<ActionDescriptor[]> {
    const result = await this.request<{ actions: ActionDescriptor[] }>(
      "GET",
      "/actions",
    );
    if (!Array.isArray(result.actions)) throw new McpApiError(502, "INVALID_RESPONSE", "Action catalog response is invalid");
    return result.actions;
  }

  async invoke(actionId: string, input: unknown): Promise<ActionResult> {
    return this.request<ActionResult>(
      "POST",
      `/actions/${encodeURIComponent(actionId)}`,
      { input },
    );
  }

  async propose(
    operations: ChangeProposal["operations"],
    evidence?: ProposalEvidence[],
    proposalId?: string,
  ): Promise<ChangeProposal> {
    const observation = await this.request<RemoteObservation>("GET", "/observation");
    return this.request<ChangeProposal>("POST", "/proposals", {
      ...(proposalId ? { id: proposalId } : {}),
      snapshot: observation.snapshot,
      operations,
      ...(evidence ? { evidence } : {}),
    });
  }
}

export function actionClientFromContext(context: {
  projectId: string;
  invoke(actionId: string, input: unknown): Promise<ActionResult>;
  listActions(): Promise<ActionDescriptor[]>;
  propose(
    operations: ChangeProposal["operations"],
    evidence?: ProposalEvidence[],
    proposalId?: string,
  ): Promise<ChangeProposal>;
}): McpActionClient {
  return {
    projectId: context.projectId,
    invoke: (actionId, input) => context.invoke(actionId, input),
    listActions: () => context.listActions(),
    propose: (operations, evidence, proposalId) => context.propose(operations, evidence, proposalId),
    forProject(projectId) {
      if (projectId !== context.projectId) {
        throw new McpApiError(403, "PROJECT_SCOPE_MISMATCH", "The requested project does not match this MCP session");
      }
      return this;
    },
  };
}
