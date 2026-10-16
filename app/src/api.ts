export interface Project {
  id: string;
  url: string;
  branch: string;
}

export interface Tree {
  title: string;
  volumes: Array<{
    id: string;
    title: string;
    chapters: Array<{
      id: string;
      title: string;
      scenes: Array<{ id: string; title: string }>;
    }>;
  }>;
}

export interface Scene {
  id: string;
  title: string;
  text: string;
  revision: string;
}

export interface Commit {
  hash: string;
  date: string;
  message: string;
}

export interface SyncStatus {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new ApiError(
      typeof details.error === "string" ? details.error : `Request failed (${response.status})`,
      response.status,
      typeof details.code === "string" ? details.code : "REQUEST_FAILED",
    );
  }
  return body as T;
}

export const api = {
  login: (token: string) => request<{ authenticated: true }>("/api/login", { method: "POST", body: JSON.stringify({ token }) }),
  session: () => request<{ authenticated: true }>("/api/session"),
  logout: () => request<{ authenticated: false }>("/api/logout", { method: "POST", body: "{}" }),
  projects: () => request<Project[]>("/api/projects"),
  registerProject: (url: string, branch?: string) => request<Project>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ url, ...(branch ? { branch } : {}) }),
  }),
  tree: (projectId: string) => request<Tree>(`/api/projects/${encodeURIComponent(projectId)}/tree`),
  scene: (projectId: string, sceneId: string) => request<Scene>(
    `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`,
  ),
  saveScene: (projectId: string, sceneId: string, text: string, revision: string) => request<Scene>(
    `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`,
    { method: "PUT", body: JSON.stringify({ text, revision }) },
  ),
  history: (projectId: string) => request<Commit[]>(`/api/projects/${encodeURIComponent(projectId)}/history`),
  status: (projectId: string) => request<SyncStatus>(`/api/projects/${encodeURIComponent(projectId)}/status`),
  sync: (projectId: string) => request<SyncStatus>(`/api/projects/${encodeURIComponent(projectId)}/sync`, { method: "POST", body: "{}" }),
};
