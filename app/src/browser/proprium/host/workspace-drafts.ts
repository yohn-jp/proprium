import { documentKey, repositoryKey, type JournalEntry } from "../../../storage/journal.js";
import type { RepositoryIdentity } from "@scriptorium/contracts";
import type { WorkspaceIdentity } from "../git/protocol.js";
import { isGitHubWorkspaceIdentity, validateGitPath } from "../git/protocol.js";

export function journalRepositoryForWorkspace(workspace: WorkspaceIdentity): RepositoryIdentity {
  if (!isGitHubWorkspaceIdentity(workspace)) {
    return {
      provider: "local",
      repositoryId: workspace.localWorkspaceId,
      defaultBranch: workspace.branch,
      ownerScope: workspace.localWorkspaceId,
      url: `local://${workspace.localWorkspaceId}`,
    };
  }
  return {
    provider: "github",
    repositoryId: String(workspace.repositoryId),
    defaultBranch: workspace.branch,
    ownerScope: workspace.localWorkspaceId,
    url: `${workspace.origin}/${workspace.owner}/${workspace.repository}`,
  };
}

export function workspaceBreadcrumb(workspace: WorkspaceIdentity): string {
  if (!isGitHubWorkspaceIdentity(workspace)) return `${workspace.name} / ${workspace.branch}`;
  return `${workspace.owner}/${workspace.repository} / ${workspace.branch}`;
}

/** Keep recovery records scoped to this exact browser workspace and author. */
export function discoverWorkspaceDrafts(
  entries: readonly JournalEntry[],
  workspace: WorkspaceIdentity,
  authorScope: string,
): JournalEntry[] {
  if (!authorScope) return [];
  const expectedRepository = journalRepositoryForWorkspace(workspace);
  const expectedRepositoryKey = repositoryKey(expectedRepository);
  return entries.filter((entry) => {
    try {
      validateGitPath(entry.documentPath);
      const documentWrite = entry.operation.writes.find((write) => write.path === entry.documentPath);
      const hasMatchingRead = entry.operation.reads.some((read) => read.path === entry.documentPath);
      return entry.version === 1 && entry.state === "draft" && entry.authorScope === authorScope &&
        entry.repositoryKey === expectedRepositoryKey && repositoryKey(entry.repository) === expectedRepositoryKey &&
        repositoryKey(entry.operation.repository) === expectedRepositoryKey &&
        entry.documentKey === documentKey(expectedRepository, entry.documentPath) &&
        entry.documentPath.length > 0 && !entry.documentPath.startsWith("meta/scratch/") &&
        entry.sceneId === entry.documentPath && documentWrite?.content === entry.text && hasMatchingRead &&
        Number.isFinite(entry.updatedAt) && Number.isSafeInteger(entry.operation.generation);
    } catch {
      return false;
    }
  }).sort((left, right) => right.updatedAt - left.updatedAt || left.documentPath.localeCompare(right.documentPath));
}

/**
 * Journal revisions are SHA-256 digests of the file bytes. A null revision means
 * the path was absent when the draft was protected, so it must still be absent.
 */
export async function draftBaseMatches(entry: JournalEntry, currentBytes: Uint8Array | null): Promise<boolean> {
  const read = entry.operation.reads.find((candidate) => candidate.path === entry.documentPath);
  if (!read) return false;
  if (read.revision === null) return currentBytes === null;
  if (!currentBytes) return false;
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(currentBytes));
  const currentRevision = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return currentRevision === read.revision;
}

export const WORKSPACE_DRAFTS_CHANGED_EVENT = "proprium:workspace-drafts-changed";

/** Notify an open workspace recovery list after a journal write; the event carries no draft content. */
export function notifyWorkspaceDraftsChanged(workspace: WorkspaceIdentity, authorScope: string): void {
  if (typeof window === "undefined") return;
  const detail = { repositoryKey: repositoryKey(journalRepositoryForWorkspace(workspace)), authorScope };
  window.dispatchEvent(new CustomEvent(WORKSPACE_DRAFTS_CHANGED_EVENT, { detail }));
}
