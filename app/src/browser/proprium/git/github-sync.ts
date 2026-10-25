export type GitHubSyncErrorCode =
  | "authentication_required"
  | "authentication_expired"
  | "permission_denied"
  | "repository_mismatch"
  | "remote_conflict"
  | "remote_unknown"
  | "network_unavailable"
  | "git_error";

export class GitHubSyncError extends Error {
  constructor(readonly code: GitHubSyncErrorCode, message: string) {
    super(message);
    this.name = "GitHubSyncError";
  }
}

export interface GitHubRemoteHead {
  repositoryId: number;
  branch: string;
  head: string | null;
}

export interface GitHubFetchResult extends GitHubRemoteHead {
  localHead: string | null;
  importedCommits: number;
}

export type GitHubPullResult =
  | { state: "up-to-date"; head: string | null }
  | { state: "fast-forwarded"; previousHead: string | null; head: string }
  | { state: "conflict"; localHead: string | null; remoteHead: string | null };

export type GitHubPublishResult =
  | { state: "published"; head: string; remoteHead: string }
  | { state: "conflict"; expectedRemoteHead: string | null; remoteHead: string | null }
  | { state: "remote-unknown"; expectedRemoteHead: string | null; observedRemoteHead: string | null };

export type GitHubRemoteKind = "remote-head" | "remote-fetch" | "remote-pull" | "remote-publish";
export interface GitHubRemoteOperation {
  <T>(operation: GitHubRemoteKind, token: string, expected?: { head: string; remoteHead: string | null }): Promise<T>;
}

export interface GitHubSyncClient {
  signOut(): void;
  remoteHead(): Promise<GitHubRemoteHead>;
  fetch(): Promise<GitHubFetchResult>;
  pull(): Promise<GitHubPullResult>;
  publish(expectedHead: string, expectedRemoteHead: string | null): Promise<GitHubPublishResult>;
}

/** Holds a Host-supplied credential in memory; never persists or exposes it to plugins. */
export function createGitHubSyncClient(
  accessToken: string,
  operation: GitHubRemoteOperation,
): GitHubSyncClient {
  if (typeof accessToken !== "string" || accessToken.length < 1 || accessToken.length > 4096 || accessToken.trim() !== accessToken) {
    throw new GitHubSyncError("authentication_required", "Provide a valid in-memory GitHub credential before synchronizing.");
  }
  let token: string | null = accessToken;

  const remote = async <T>(kind: GitHubRemoteKind, expected?: { head: string; remoteHead: string | null }): Promise<T> => {
    const credential = token;
    if (!credential) throw new GitHubSyncError("authentication_required", "Sign in to GitHub before synchronizing this workspace.");
    try { return await operation<T>(kind, credential, expected); }
    catch (error) {
      if (error instanceof GitHubSyncError && error.code === "authentication_expired") token = null;
      throw error;
    }
  };

  return {
    signOut(): void { token = null; },
    remoteHead(): Promise<GitHubRemoteHead> { return remote("remote-head"); },
    fetch(): Promise<GitHubFetchResult> { return remote("remote-fetch"); },
    pull(): Promise<GitHubPullResult> { return remote("remote-pull"); },
    publish(expectedHead: string, expectedRemoteHead: string | null): Promise<GitHubPublishResult> {
      if (!/^[a-f0-9]{40}$/u.test(expectedHead) || (expectedRemoteHead !== null && !/^[a-f0-9]{40}$/u.test(expectedRemoteHead))) {
        return Promise.reject(new GitHubSyncError("git_error", "Publishing requires the verified local SHA and the observed remote SHA."));
      }
      return remote("remote-publish", { head: expectedHead, remoteHead: expectedRemoteHead });
    },
  };
}
