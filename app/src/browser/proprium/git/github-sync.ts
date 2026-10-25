export type GitHubSyncErrorCode =
  | "authentication_required"
  | "authentication_expired"
  | "permission_denied"
  | "repository_mismatch"
  | "remote_conflict"
  | "remote_unknown"
  | "rest_unsupported"
  | "network_unavailable"
  | "git_error";

export class GitHubSyncError extends Error {
  constructor(readonly code: GitHubSyncErrorCode, message: string) {
    super(message);
    this.name = "GitHubSyncError";
  }
}

export interface GitHubDevicePrompt {
  userCode: string;
  verificationUri: "https://github.com/login/device";
  expiresAt: number;
}

export interface GitHubAccount {
  id: number;
  login: string;
}

export interface GitHubRepository {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  permissions: { pull: boolean; push: boolean };
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
  | { state: "local-ahead"; head: string; remoteHead: string | null }
  | { state: "fast-forwarded"; previousHead: string | null; head: string }
  | { state: "conflict"; localHead: string | null; remoteHead: string | null };

export type GitHubPublishResult =
  | { state: "published"; head: string; remoteHead: string }
  | { state: "conflict"; expectedRemoteHead: string | null; remoteHead: string | null }
  | { state: "remote-unknown"; expectedRemoteHead: string | null; observedRemoteHead: string | null };

export type GitHubRemoteKind = "remote-head" | "remote-fetch" | "remote-pull" | "remote-publish";
export interface GitHubRemoteOperation {
  <T>(operation: GitHubRemoteKind, token: string, authRelayUrl: string, expected?: { head: string; remoteHead: string | null }): Promise<T>;
}

export interface GitHubAccountSession {
  beginAuthorization(): Promise<GitHubDevicePrompt>;
  completeAuthorization(signal?: AbortSignal): Promise<GitHubAccount>;
  signOut(): void;
  account(): GitHubAccount | null;
  repositories(): Promise<GitHubRepository[]>;
  connect(operation: GitHubRemoteOperation): GitHubSyncClient;
}

export interface GitHubSyncClient extends Omit<GitHubAccountSession, "connect"> {
  connect(operation: GitHubRemoteOperation): GitHubSyncClient;
  remoteHead(): Promise<GitHubRemoteHead>;
  fetch(): Promise<GitHubFetchResult>;
  pull(): Promise<GitHubPullResult>;
  publish(expectedHead: string, expectedRemoteHead: string | null): Promise<GitHubPublishResult>;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface AccessTokenResponse {
  access_token?: string;
  token_type?: string;
  error?: string;
  interval?: number;
}

function networkError(target: "GitHub" | "Gateway" = "GitHub"): GitHubSyncError {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (target === "Gateway") return new GitHubSyncError("network_unavailable", offline
    ? "The Gateway is unavailable while this device is offline. Local editing remains available."
    : "The browser could not reach the configured Gateway. Check its URL and availability. If Cloudflare Access is enabled, check Gateway sign-in and CORS preflight settings. Local editing remains available.");
  return new GitHubSyncError("network_unavailable", offline
    ? "GitHub is unavailable while this device is offline. Local changes remain on this device."
    : "The browser could not reach GitHub. Check connectivity and GitHub CORS availability, then retry.");
}

function responseError(status: number, payload: unknown, fallback: string): GitHubSyncError {
  const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
    ? payload.error
    : "";
  if (status === 401 || message === "bad_verification_code" || message === "expired_token" || message === "incorrect_device_code") {
    return new GitHubSyncError("authentication_expired", "GitHub authorization expired or was revoked. Sign in again.");
  }
  if (status === 403 || message === "access_denied") {
    return new GitHubSyncError("permission_denied", "GitHub denied this operation. Check repository access and the granted permissions.");
  }
  return new GitHubSyncError("git_error", fallback);
}

async function jsonRequest(fetcher: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      cache: "no-store",
      credentials: init.credentials ?? "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch { throw networkError(new URL(url).origin === "https://api.github.com" ? "GitHub" : "Gateway"); }
  let body: unknown;
  try { body = await response.json(); }
  catch { body = null; }
  if (!response.ok) throw responseError(response.status, body, "GitHub returned an invalid authentication response.");
  return body;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubSyncError("git_error", "GitHub returned an incomplete response.");
  }
  return value as Record<string, unknown>;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Authorization cancelled.", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Authorization cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Keeps the access token in this Host-owned closure; no token is persisted or returned to callers. */
export function createGitHubSyncClient(
  authRelayUrl: string,
  operation: GitHubRemoteOperation,
  fetcher: typeof fetch = fetch,
): GitHubSyncClient {
  return createGitHubAccountSession(authRelayUrl, fetcher).connect(operation);
}

/** Account and repository picker session, reusable when a workspace-specific Git client is opened. */
export function createGitHubAccountSession(
  authRelayUrl: string,
  fetcher: typeof fetch = fetch,
): GitHubAccountSession {
  let relay: URL;
  try { relay = new URL(authRelayUrl); }
  catch { throw new TypeError("A configured GitHub OAuth relay URL is required."); }
  const loopback = relay.protocol === "http:" && ["localhost", "127.0.0.1"].includes(relay.hostname);
  if ((!loopback && relay.protocol !== "https:") || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/") {
    throw new TypeError("The GitHub OAuth relay must be a trusted HTTPS origin (or loopback during local development).");
  }
  const relayOrigin = relay.origin;
  let token: string | null = null;
  let account: GitHubAccount | null = null;
  let authGeneration = 0;
  let authorization: { deviceCode: string; expiresAt: number; interval: number; generation: number; completing: boolean } | null = null;

  const requireToken = (): string => {
    if (!token) throw new GitHubSyncError("authentication_required", "Sign in to GitHub before synchronizing this workspace.");
    return token;
  };

  const repositories = async (): Promise<GitHubRepository[]> => {
    const credential = requireToken();
    const result: GitHubRepository[] = [];
    try {
      for (let page = 1; page <= 100; page += 1) {
        let response: Response;
        try {
          response = await fetcher(`https://api.github.com/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=updated&per_page=100&page=${page}`, {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${credential}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
          });
        } catch { throw networkError(); }
        let payload: unknown;
        try { payload = await response.json(); }
        catch { throw new GitHubSyncError("git_error", "GitHub returned an invalid repository list."); }
        if (!response.ok) throw responseError(response.status, payload, "GitHub could not list repositories for this account.");
        if (!Array.isArray(payload) || payload.length > 100) throw new GitHubSyncError("git_error", "GitHub returned an invalid repository list.");
        for (const raw of payload) {
          const repository = object(raw);
          const owner = repository.owner && typeof repository.owner === "object" && !Array.isArray(repository.owner)
            ? (repository.owner as Record<string, unknown>).login : undefined;
          const permissions = repository.permissions && typeof repository.permissions === "object" && !Array.isArray(repository.permissions)
            ? repository.permissions as Record<string, unknown> : {};
          if (!Number.isSafeInteger(repository.id) || (repository.id as number) <= 0 ||
              typeof owner !== "string" || !/^[A-Za-z0-9-]+$/u.test(owner) ||
              typeof repository.name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(repository.name) ||
              typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== `${owner}/${repository.name}`.toLowerCase() ||
              typeof repository.default_branch !== "string" || !/^[A-Za-z0-9._/-]+$/u.test(repository.default_branch) ||
              repository.default_branch.startsWith("/") || repository.default_branch.endsWith("/") ||
              repository.default_branch.includes("..") || repository.default_branch.includes("//") ||
              typeof repository.private !== "boolean") {
            throw new GitHubSyncError("git_error", "GitHub returned malformed repository metadata.");
          }
          result.push({
            id: repository.id as number,
            fullName: repository.full_name,
            owner,
            name: repository.name,
            defaultBranch: repository.default_branch,
            private: repository.private,
            permissions: { pull: permissions.pull === true, push: permissions.push === true },
          });
        }
        if (payload.length < 100) return result;
      }
      throw new GitHubSyncError("git_error", "This account has more repositories than the browser picker can safely load at once.");
    } catch (error) {
      if (error instanceof GitHubSyncError && error.code === "authentication_expired") {
        token = null;
        account = null;
      }
      throw error;
    }
  };

  const accountClient: Omit<GitHubAccountSession, "connect"> = {
    async beginAuthorization(): Promise<GitHubDevicePrompt> {
      const generation = ++authGeneration;
      token = null;
      account = null;
      authorization = null;
      const payload = object(await jsonRequest(fetcher, `${relayOrigin}/oauth/device/code`, {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
      }));
      if (generation !== authGeneration) throw new GitHubSyncError("authentication_required", "GitHub sign-in was canceled or replaced.");
      const device = payload as unknown as DeviceCodeResponse;
      if (typeof device.device_code !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(device.device_code)
          || typeof device.user_code !== "string" || !/^[A-Z0-9-]{4,16}$/u.test(device.user_code)
          || device.verification_uri !== "https://github.com/login/device"
          || !Number.isSafeInteger(device.expires_in) || device.expires_in < 60 || device.expires_in > 1800
          || !Number.isSafeInteger(device.interval) || device.interval < 1 || device.interval > 60) {
        throw new GitHubSyncError("git_error", "GitHub returned an invalid device authorization response.");
      }
      const expiresAt = Date.now() + device.expires_in * 1000;
      authorization = { deviceCode: device.device_code, expiresAt, interval: device.interval, generation, completing: false };
      return { userCode: device.user_code, verificationUri: "https://github.com/login/device", expiresAt };
    },

    async completeAuthorization(signal?: AbortSignal): Promise<GitHubAccount> {
      const pending = authorization;
      if (!pending || pending.generation !== authGeneration) throw new GitHubSyncError("authentication_required", "Start GitHub device authorization before completing sign-in.");
      if (pending.completing) throw new GitHubSyncError("git_error", "GitHub device authorization is already being completed.");
      pending.completing = true;
      try {
        while (Date.now() < pending.expiresAt) {
          await abortableDelay(pending.interval * 1000, signal);
          if (authorization !== pending || authGeneration !== pending.generation) {
            throw new GitHubSyncError("authentication_required", "GitHub sign-in was canceled or replaced.");
          }
          const raw = await jsonRequest(fetcher, `${relayOrigin}/oauth/token`, {
            method: "POST",
            credentials: "include",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ deviceCode: pending.deviceCode }),
          });
          if (authorization !== pending || authGeneration !== pending.generation) {
            throw new GitHubSyncError("authentication_required", "GitHub sign-in was canceled or replaced.");
          }
          const result = object(raw) as AccessTokenResponse;
          if (result.error === "authorization_pending") continue;
          if (result.error === "slow_down") {
            const responseInterval = result.interval;
            pending.interval = Number.isSafeInteger(responseInterval) && responseInterval! > pending.interval
              ? responseInterval!
              : pending.interval + 5;
            continue;
          }
          if (result.error) throw responseError(result.error === "access_denied" ? 403 : 401, result, "GitHub device authorization failed.");
          if (typeof result.access_token !== "string" || result.access_token.length < 1 || result.access_token.length > 4096
              || result.token_type?.toLowerCase() !== "bearer") {
            throw new GitHubSyncError("git_error", "GitHub returned an incomplete access token response.");
          }
          const profile = object(await jsonRequest(fetcher, "https://api.github.com/user", {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${result.access_token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }));
          if (authorization !== pending || authGeneration !== pending.generation) {
            throw new GitHubSyncError("authentication_required", "GitHub sign-in was canceled or replaced.");
          }
          if (!Number.isSafeInteger(profile.id) || typeof profile.login !== "string" || !profile.login) {
            throw new GitHubSyncError("git_error", "GitHub could not confirm the signed-in account.");
          }
          token = result.access_token;
          account = { id: profile.id as number, login: profile.login };
          authorization = null;
          return { ...account };
        }
      } catch (error) {
        if (authorization === pending && authGeneration === pending.generation) authorization = null;
        throw error;
      }
      if (authorization === pending && authGeneration === pending.generation) authorization = null;
      throw new GitHubSyncError("authentication_expired", "The GitHub device code expired. Start sign-in again.");
    },

    signOut(): void { authGeneration += 1; token = null; account = null; authorization = null; },
    account(): GitHubAccount | null { return account ? { ...account } : null; },
    repositories,
  };

  const connect = (operation: GitHubRemoteOperation): GitHubSyncClient => {
    const remote = async <T>(kind: GitHubRemoteKind, expected?: { head: string; remoteHead: string | null }): Promise<T> => {
      const credential = requireToken();
      try { return await operation<T>(kind, credential, relayOrigin, expected); }
      catch (error) {
        if (error instanceof GitHubSyncError && error.code === "authentication_expired") {
          token = null;
          account = null;
        }
        throw error;
      }
    };
    return {
      ...accountClient,
      connect,
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
  };
  return { ...accountClient, connect };
}
