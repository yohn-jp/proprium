import type { WorkspaceIdentity } from "../git/protocol.js";
import { validateGitPath } from "../git/protocol.js";

const RECENT_DOCUMENTS_KEY = "proprium.host.recent-documents.v1";
const MAX_RECENT_DOCUMENTS = 40;

interface RecentDocumentRecord {
  workspaceKey: string;
  path: string;
  openedAt: number;
}

export interface RecentDocumentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): RecentDocumentStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

function workspaceKey(workspace: WorkspaceIdentity): string {
  return JSON.stringify([
    "name" in workspace ? "local" : "github",
    workspace.localWorkspaceId,
    workspace.branch,
  ]);
}

function readRecords(storage: RecentDocumentStorage): RecentDocumentRecord[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(RECENT_DOCUMENTS_KEY) ?? "null");
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is RecentDocumentRecord => {
      if (!record || typeof record !== "object") return false;
      const candidate = record as Partial<RecentDocumentRecord>;
      if (typeof candidate.workspaceKey !== "string" || typeof candidate.path !== "string" ||
          typeof candidate.openedAt !== "number" || !Number.isFinite(candidate.openedAt)) return false;
      try { validateGitPath(candidate.path); return true; }
      catch { return false; }
    });
  } catch { return []; }
}

/** Remember only the relative file path; drafts and file contents stay in the journal/Git stores. */
export function rememberRecentDocument(workspace: WorkspaceIdentity, path: string, storage = browserStorage()): void {
  if (!storage) return;
  try { validateGitPath(path); }
  catch { return; }
  const key = workspaceKey(workspace);
  const records = readRecords(storage).filter((record) => record.workspaceKey !== key);
  records.unshift({ workspaceKey: key, path, openedAt: Date.now() });
  try { storage.setItem(RECENT_DOCUMENTS_KEY, JSON.stringify(records.slice(0, MAX_RECENT_DOCUMENTS))); }
  catch { /* Resume convenience must never block editing or local Git. */ }
}

export function readRecentDocument(workspace: WorkspaceIdentity, storage = browserStorage()): string | null {
  if (!storage) return null;
  const key = workspaceKey(workspace);
  return readRecords(storage).find((record) => record.workspaceKey === key)?.path ?? null;
}

/** Resume only a file still present in the supplied worktree listing. */
export function resolveRecentDocument(
  workspace: WorkspaceIdentity,
  availablePaths: ReadonlySet<string> | readonly string[],
  storage = browserStorage(),
): string | null {
  const path = readRecentDocument(workspace, storage);
  if (!path) return null;
  const exists = Array.isArray(availablePaths)
    ? availablePaths.includes(path)
    : (availablePaths as ReadonlySet<string>).has(path);
  return exists ? path : null;
}
