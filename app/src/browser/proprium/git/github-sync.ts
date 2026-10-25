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
  <T>(operation: GitHubRemoteKind, token: string, authRelayUrl: string, expected?: { head: string; remoteHead: string | null }): Promise<T>;
}

export interface GitHubSyncClient {
  beginAuthorization(): Promise<GitHubDevicePrompt>;
  completeAuthorization(signal?: AbortSignal): Promise<GitHubAccount>;
  signOut(): void;
  account(): GitHubAccount | null;
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

function networkError(): GitHubSyncError {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
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
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch { throw networkError(); }
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
  let authorization: { deviceCode: string; expiresAt: number; interval: number } | null = null;

  const requireToken = (): string => {
    if (!token) throw new GitHubSyncError("authentication_required", "Sign in to GitHub before synchronizing this workspace.");
    return token;
  };

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
    async beginAuthorization(): Promise<GitHubDevicePrompt> {
      token = null;
      account = null;
      authorization = null;
      const payload = object(await jsonRequest(fetcher, `${relayOrigin}/oauth/device/code`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
      }));
      const device = payload as unknown as DeviceCodeResponse;
      if (typeof device.device_code !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(device.device_code)
          || typeof device.user_code !== "string" || !/^[A-Z0-9-]{4,16}$/u.test(device.user_code)
          || device.verification_uri !== "https://github.com/login/device"
          || !Number.isSafeInteger(device.expires_in) || device.expires_in < 60 || device.expires_in > 1800
          || !Number.isSafeInteger(device.interval) || device.interval < 1 || device.interval > 60) {
        throw new GitHubSyncError("git_error", "GitHub returned an invalid device authorization response.");
      }
      const expiresAt = Date.now() + device.expires_in * 1000;
      authorization = { deviceCode: device.device_code, expiresAt, interval: device.interval };
      return { userCode: device.user_code, verificationUri: "https://github.com/login/device", expiresAt };
    },

    async completeAuthorization(signal?: AbortSignal): Promise<GitHubAccount> {
      const pending = authorization;
      if (!pending) throw new GitHubSyncError("authentication_required", "Start GitHub device authorization before completing sign-in.");
      try {
        while (Date.now() < pending.expiresAt) {
          await abortableDelay(pending.interval * 1000, signal);
          const raw = await jsonRequest(fetcher, `${relayOrigin}/oauth/token`, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ deviceCode: pending.deviceCode }),
          });
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
          if (!Number.isSafeInteger(profile.id) || typeof profile.login !== "string" || !profile.login) {
            throw new GitHubSyncError("git_error", "GitHub could not confirm the signed-in account.");
          }
          token = result.access_token;
          account = { id: profile.id as number, login: profile.login };
          authorization = null;
          return { ...account };
        }
      } catch (error) {
        authorization = null;
        throw error;
      }
      authorization = null;
      throw new GitHubSyncError("authentication_expired", "The GitHub device code expired. Start sign-in again.");
    },

    signOut(): void { token = null; account = null; authorization = null; },
    account(): GitHubAccount | null { return account ? { ...account } : null; },
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
