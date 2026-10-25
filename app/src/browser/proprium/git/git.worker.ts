/// <reference lib="webworker" />
import { Buffer } from "buffer";
import LightningFS from "@isomorphic-git/lightning-fs";
import * as git from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import type { HttpClient } from "isomorphic-git";
import type { CommitObject, TreeObject } from "isomorphic-git";
import type { LocalGitErrorCode, LocalGitRequest, LocalGitResponse, StatusEntry, WorkspaceIdentity } from "./protocol.js";
import {
  MAX_WORKSPACE_CHANGE_BYTES,
  MAX_WORKSPACE_CHANGE_COUNT,
  MAX_WORKSPACE_READ_BYTES,
  MAX_WORKSPACE_READ_SET_COUNT,
  validateGitPath,
  validateWorkspaceIdentity,
} from "./protocol.js";

const scope = self as DedicatedWorkerGlobalScope;
globalThis.Buffer = Buffer;
const storage = new LightningFS("proprium-git-v1");
const fs = storage.promises;
const flush = (): Promise<void> => (fs as unknown as { flush(): Promise<void> }).flush();
const dataRoot = "/proprium";
const uncertainWorkspaces = new Set<string>();
const knownHeads = new Map<string, string | null>();
const failure = (code: LocalGitErrorCode, message: string): never => { throw Object.assign(new Error(message), { propriumCode: code }); };

class GitHubApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function apiMessage(code: number): string {
  if (code === 401) return "GitHub authorization expired or was revoked. Sign in again.";
  if (code === 403) return "GitHub denied this operation. Check repository access and the granted permissions.";
  if (code === 404) return "The GitHub repository, branch, or Git object was not found or is not accessible.";
  if (code === 409) return "GitHub reported a remote reference conflict. Fetch the latest branch before retrying.";
  return `GitHub returned HTTP ${code} for a Git synchronization request.`;
}

async function githubApi<T>(workspace: WorkspaceIdentity, token: string, path: string, init: RequestInit = {}, missing: false | "null" = false): Promise<T> {
  if (!token || token.length > 4096) failure("authentication_required", "Sign in to GitHub before synchronizing this workspace.");
  let response: Response | null = null;
  try {
    response = await fetch(`https://api.github.com/repos/${encodeURIComponent(workspace.owner)}/${encodeURIComponent(workspace.repository)}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    const offline = scope.navigator.onLine === false;
    return failure("network_unavailable", offline
      ? "GitHub is unavailable while this device is offline. Local changes remain on this device."
      : "The browser could not reach GitHub. Check connectivity and GitHub CORS availability, then retry.");
  }
  if (!response) return failure("network_unavailable", "The browser could not reach GitHub.");
  if (response.status === 404 && missing === "null") return null as T;
  if (!response.ok) {
    const code = response.status === 401 ? "authentication_expired"
      : response.status === 403 ? "permission_denied"
        : response.status === 409 ? "remote_conflict" : "git_error";
    throw Object.assign(new GitHubApiError(response.status, apiMessage(response.status)), { propriumCode: code });
  }
  try { return await response.json() as T; }
  catch { return failure("remote_unknown", "GitHub returned a successful response that could not be read safely."); }
}

interface GitHubRepository { id: number; full_name: string; owner: { login: string }; permissions?: { pull?: boolean; push?: boolean }; }
interface GitHubRef { ref: string; object: { sha: string; type: string }; }
interface GitHubTreeEntry { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; }
interface GitHubTree { sha: string; truncated: boolean; tree: GitHubTreeEntry[]; }
interface GitHubPerson { name: string; email: string; date: string; }
interface GitHubCommit {
  sha: string;
  commit: { tree: { sha: string }; message: string; author: GitHubPerson; committer: GitHubPerson; verification?: { signature?: string | null } };
  parents: Array<{ sha: string }>;
}

async function verifyRemoteRepository(workspace: WorkspaceIdentity, token: string, write: boolean): Promise<GitHubRepository> {
  const repository = await githubApi<GitHubRepository | null>(workspace, token, "");
  if (!repository || repository.id !== workspace.repositoryId || typeof repository.owner?.login !== "string" || repository.owner.login.toLowerCase() !== workspace.owner.toLowerCase()
      || repository.full_name?.toLowerCase() !== `${workspace.owner}/${workspace.repository}`.toLowerCase()) {
    return failure("repository_mismatch", "The authenticated GitHub repository does not match this local workspace identity.");
  }
  if (repository.permissions?.pull !== true || (write && repository.permissions?.push !== true)) {
    return failure("permission_denied", write
      ? "This GitHub account does not have write access to the selected repository."
      : "This GitHub account does not have read access to the selected repository.");
  }
  return repository;
}

function branchRef(workspace: WorkspaceIdentity): string {
  return `/git/ref/heads/${workspace.branch.split("/").map(encodeURIComponent).join("/")}`;
}

async function readRemoteHead(workspace: WorkspaceIdentity, token: string): Promise<string | null> {
  const ref = await githubApi<GitHubRef | null>(workspace, token, branchRef(workspace), {}, "null");
  if (!ref) return null;
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(ref.ref) || ref.ref !== `refs/heads/${workspace.branch}`
      || ref.object?.type !== "commit" || !/^[a-f0-9]{40}$/u.test(ref.object.sha)) {
    return failure("remote_unknown", "GitHub returned a malformed branch reference.");
  }
  return ref.object.sha;
}

async function localCommitExists(dir: string, oid: string): Promise<boolean> {
  try { await git.readCommit({ fs, dir, oid }); return true; }
  catch { return false; }
}

interface HydrationState {
  commits: Map<string, GitHubCommit>;
  trees: Set<string>;
  blobs: Set<string>;
  imported: Set<string>;
  objects: number;
}

const MAX_REMOTE_COMMITS = 2_000;
const MAX_REMOTE_OBJECTS = 20_000;
const MAX_REMOTE_BLOB_BYTES = 50 * 1024 * 1024;

function createHydrationState(): HydrationState {
  return { commits: new Map(), trees: new Set(), blobs: new Set(), imported: new Set(), objects: 0 };
}

async function hydrateTree(workspace: WorkspaceIdentity, token: string, dir: string, oid: string, state: HydrationState): Promise<void> {
  if (state.trees.has(oid)) return;
  state.trees.add(oid);
  if (++state.objects > MAX_REMOTE_OBJECTS) failure("git_error", "This repository exceeds the Browser Git import object limit.");
  const tree = await githubApi<GitHubTree | null>(workspace, token, `/git/trees/${oid}`);
  if (!tree || tree.sha !== oid || !Array.isArray(tree.tree)) {
    return failure("git_error", "GitHub returned an invalid Git tree; no remote ref was applied locally.");
  }
  if (tree.truncated) {
    return failure("rest_unsupported", "GitHub REST returned a truncated tree; retry with the scoped Git transport.");
  }
  const entries: TreeObject = [];
  for (const entry of tree.tree) {
    if (!entry || typeof entry.path !== "string" || entry.path.includes("/") || !/^[a-f0-9]{40}$/u.test(entry.sha)
        || !/^(?:100644|100755|120000|040000|160000)$/u.test(entry.mode)) {
      return failure("git_error", "GitHub returned an invalid Git tree entry.");
    }
    if (entry.type === "tree" && entry.mode === "040000") {
      await hydrateTree(workspace, token, dir, entry.sha, state);
    } else if (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) {
      if (!state.blobs.has(entry.sha)) {
        if (++state.objects > MAX_REMOTE_OBJECTS) failure("git_error", "This repository exceeds the Browser Git import object limit.");
        const blob = await githubApi<{ sha: string; encoding: string; content: string; size: number } | null>(workspace, token, `/git/blobs/${entry.sha}`);
        if (!blob || blob.sha !== entry.sha || !Number.isSafeInteger(blob.size) || blob.size < 0) {
          return failure("git_error", "GitHub returned an invalid Git blob.");
        }
        if (blob.encoding !== "base64" || blob.size > MAX_REMOTE_BLOB_BYTES) {
          return failure("rest_unsupported", "GitHub REST cannot represent this blob safely; retry with the scoped Git transport.");
        }
        let bytes: Uint8Array;
        try {
          const binary = atob(blob.content.replace(/\s+/gu, ""));
          bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        } catch { return failure("git_error", "GitHub returned a malformed base64 Git blob."); }
        if (bytes.byteLength !== blob.size) {
          failure("git_error", "GitHub returned a Git blob whose decoded size did not match its metadata.");
        }
        if (await git.writeBlob({ fs, dir, blob: bytes }) !== entry.sha) {
          failure("rest_unsupported", "GitHub REST did not preserve the original blob SHA; retry with the scoped Git transport.");
        }
        state.blobs.add(entry.sha);
      }
    } else {
      failure("rest_unsupported", "GitHub REST cannot import this Git tree mode; retry with the scoped Git transport.");
    }
    entries.push({ mode: entry.mode, path: entry.path, oid: entry.sha, type: entry.type });
  }
  if (await git.writeTree({ fs, dir, tree: entries }) !== oid) {
    failure("rest_unsupported", "GitHub REST did not preserve the original tree SHA; retry with the scoped Git transport.");
  }
}

function gitDate(person: GitHubPerson): { name: string; email: string; timestamp: number; timezoneOffset: number } {
  if (!person || typeof person.name !== "string" || typeof person.email !== "string" || typeof person.date !== "string") {
    return failure("git_error", "GitHub returned incomplete Git commit identity metadata.");
  }
  const match = /(Z|([+-])(\d{2}):(\d{2}))$/u.exec(person.date);
  const timestamp = Date.parse(person.date);
  if (!match || !Number.isFinite(timestamp)) return failure("git_error", "GitHub returned an unsupported Git commit date.");
  const minutes = Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  const offset = match[1] === "Z" ? 0 : minutes === 0 ? (match[2] === "-" ? -0 : 0) : minutes * (match[2] === "+" ? -1 : 1);
  return { name: person.name, email: person.email, timestamp: Math.floor(timestamp / 1000), timezoneOffset: offset };
}

async function hydrateCommit(workspace: WorkspaceIdentity, token: string, dir: string, oid: string, state: HydrationState, visiting = new Set<string>()): Promise<void> {
  if (state.imported.has(oid) || await localCommitExists(dir, oid)) return;
  if (visiting.has(oid)) failure("git_error", "GitHub returned a cyclic commit graph.");
  if (state.commits.size >= MAX_REMOTE_COMMITS) failure("git_error", "This repository exceeds the Browser Git history import limit.");
  visiting.add(oid);
  let remote = state.commits.get(oid);
  if (!remote) {
    const fetched = await githubApi<GitHubCommit | null>(workspace, token, `/commits/${oid}`);
    if (!fetched || fetched.sha !== oid || !/^[a-f0-9]{40}$/u.test(fetched.commit?.tree?.sha)
        || !Array.isArray(fetched.parents) || fetched.parents.some(parent => !/^[a-f0-9]{40}$/u.test(parent.sha))) {
      return failure("git_error", "GitHub returned an invalid Git commit object.");
    }
    remote = fetched;
    state.commits.set(oid, remote);
  }
  for (const parent of remote.parents) await hydrateCommit(workspace, token, dir, parent.sha, state, visiting);
  await hydrateTree(workspace, token, dir, remote.commit.tree.sha, state);
  const commit: CommitObject = {
    tree: remote.commit.tree.sha,
    parent: remote.parents.map(parent => parent.sha),
    author: gitDate(remote.commit.author),
    committer: gitDate(remote.commit.committer),
    message: remote.commit.message,
    ...(remote.commit.verification?.signature ? { gpgsig: remote.commit.verification.signature } : {}),
  };
  const written = await git.writeCommit({ fs, dir, commit });
  if (written !== oid) {
    failure("rest_unsupported", `GitHub REST could not preserve the original commit SHA (expected ${oid}, computed ${written}); retry with the scoped Git transport.`);
  }
  state.imported.add(oid);
  state.objects += 1;
  visiting.delete(oid);
}

async function hydrateRemoteHead(workspace: WorkspaceIdentity, token: string, dir: string, head: string | null, state = createHydrationState()): Promise<HydrationState> {
  if (head) await hydrateCommit(workspace, token, dir, head, state);
  return state;
}

function isRestUnsupported(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "propriumCode" in error && error.propriumCode === "rest_unsupported");
}

function smartHttpClient(workspace: WorkspaceIdentity, token: string, relayUrl: string): HttpClient {
  let relay: URL;
  try { relay = new URL(relayUrl); }
  catch { return failure("git_error", "A configured GitHub relay origin is required for Git transport."); }
  const loopback = relay.protocol === "http:" && ["localhost", "127.0.0.1"].includes(relay.hostname);
  if ((!loopback && relay.protocol !== "https:") || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/") {
    return failure("git_error", "The GitHub relay must be a trusted HTTPS origin (or loopback during local development).");
  }
  const githubRepositoryPath = `/${workspace.owner}/${workspace.repository}.git`;
  const relayRepositoryPath = `/git/${workspace.owner}/${workspace.repository}.git`;
  return {
    request: async (request) => {
      let source: URL;
      try { source = new URL(request.url); }
      catch { return failure("git_error", "Git requested an invalid transport URL."); }
      const prefix = `${githubRepositoryPath}/`;
      if (source.origin !== "https://github.com" || source.username || source.password || source.hash || !source.pathname.startsWith(prefix)) {
        return failure("git_error", "Git transport requested a URL outside the selected GitHub repository.");
      }
      const endpoint = source.pathname.slice(prefix.length);
      const isAdvertisement = endpoint === "info/refs";
      const service = source.searchParams.get("service");
      const method = request.method ?? "GET";
      const validAdvertisement = isAdvertisement && [...source.searchParams.keys()].length === 1
        && (service === "git-upload-pack" || service === "git-receive-pack") && method === "GET";
      const validPack = !source.search && ((endpoint === "git-upload-pack" && method === "POST")
        || (endpoint === "git-receive-pack" && method === "POST"));
      if (!validAdvertisement && !validPack) return failure("git_error", "Git transport requested an unsupported GitHub endpoint.");
      const destination = new URL(`${relayRepositoryPath}/${endpoint}${source.search}`, relay.origin);
      const headers = { ...(request.headers ?? {}) };
      for (const name of Object.keys(headers)) if (name.toLowerCase() === "authorization" || name.toLowerCase() === "x-proprium-repository-id") delete headers[name];
      headers.Authorization = `Bearer ${token}`;
      headers["X-Proprium-Repository-Id"] = String(workspace.repositoryId);
      let response;
      try {
        response = await webHttp.request({
          ...request,
          url: destination.toString(),
          headers,
          fetchOptions: {
            ...request.fetchOptions,
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
          },
        });
      } catch {
        return failure("network_unavailable", scope.navigator.onLine === false
          ? "GitHub Smart HTTP is unavailable while this device is offline. Local Git data remains on this device."
          : "The browser could not reach the configured GitHub Git relay.");
      }
      if (response.statusCode === 401) failure("authentication_expired", "GitHub authorization expired or was revoked. Sign in again.");
      if (response.statusCode === 403) failure("permission_denied", "GitHub denied this Git transport request. Check repository access.");
      if (response.statusCode === 404) failure("repository_mismatch", "The configured relay could not access the selected GitHub repository.");
      if (response.statusCode === 409 || response.statusCode === 422) failure("remote_conflict", "GitHub rejected the Git ref update because the remote branch changed or is protected.");
      return { ...response, url: request.url };
    },
  };
}

async function countMissingRemoteCommits(workspace: WorkspaceIdentity, token: string, dir: string, head: string): Promise<number> {
  const pending = [head];
  const seen = new Set<string>();
  let missing = 0;
  while (pending.length) {
    const oid = pending.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (seen.size > MAX_REMOTE_COMMITS) failure("git_error", "This repository exceeds the Browser Git history import limit.");
    if (await localCommitExists(dir, oid)) continue;
    const commit = await githubApi<GitHubCommit>(workspace, token, `/commits/${oid}`);
    if (!commit || commit.sha !== oid || !Array.isArray(commit.parents)
        || commit.parents.some(parent => !/^[a-f0-9]{40}$/u.test(parent.sha))) {
      failure("git_error", "GitHub returned invalid commit ancestry while preparing Git transport.");
    }
    missing += 1;
    pending.push(...commit.parents.map(parent => parent.sha));
  }
  return missing;
}

async function fetchViaSmartHttp(workspace: WorkspaceIdentity, token: string, relayUrl: string, dir: string, expectedHead: string): Promise<void> {
  const url = `https://github.com/${workspace.owner}/${workspace.repository}.git`;
  let result: Awaited<ReturnType<typeof git.fetch>>;
  try {
    result = await git.fetch({
      fs, dir, url, http: smartHttpClient(workspace, token, relayUrl),
      ref: workspace.branch, remoteRef: workspace.branch, singleBranch: true, tags: false,
    });
  } catch (error) {
    if (error && typeof error === "object" && "propriumCode" in error) throw error;
    failure("git_error", "GitHub Smart HTTP could not import the advertised Git objects.");
  }
  if (!result!.fetchHead || result!.fetchHead !== expectedHead) {
    failure("remote_unknown", "The GitHub branch changed during Smart HTTP fetch; the local branch was not updated.");
  }
}

async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  const pending = [descendant];
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const { commit } = await git.readCommit({ fs, dir, oid });
    pending.push(...commit.parent);
  }
  return false;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  return btoa(binary);
}

function isoGitDate(person: CommitObject["author"]): string {
  const east = -person.timezoneOffset;
  const local = new Date((person.timestamp + east * 60) * 1000);
  const sign = east < 0 || Object.is(person.timezoneOffset, -0) ? "-" : "+";
  const absolute = Math.abs(east);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}T${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}:${String(local.getUTCSeconds()).padStart(2, "0")}${offset}`;
}

interface UploadedTreeEntry { path: string; mode: string; type: "blob" | "tree" | "commit"; sha: string; }

async function uploadTree(workspace: WorkspaceIdentity, token: string, dir: string, oid: string, uploadedTrees: Set<string>, uploadedBlobs: Set<string>, uploadedObjects: number): Promise<number> {
  if (uploadedTrees.has(oid)) return uploadedObjects;
  uploadedTrees.add(oid);
  const { tree } = await git.readTree({ fs, dir, oid });
  const entries: UploadedTreeEntry[] = [];
  for (const entry of tree) {
    if (entry.type === "tree") {
      uploadedObjects = await uploadTree(workspace, token, dir, entry.oid, uploadedTrees, uploadedBlobs, uploadedObjects);
    } else if (entry.type === "blob") {
      if (!uploadedBlobs.has(entry.oid)) {
        const { blob } = await git.readBlob({ fs, dir, oid: entry.oid });
        if (blob.byteLength > MAX_REMOTE_BLOB_BYTES) failure("git_error", "This Git blob exceeds the Browser Git publish size limit.");
        const response = await githubApi<{ sha: string }>(workspace, token, "/git/blobs", { method: "POST", body: JSON.stringify({ content: encodeBase64(blob), encoding: "base64" }) });
        if (response?.sha !== entry.oid) failure("rest_unsupported", "GitHub REST did not preserve a local blob SHA; retry with the scoped Git transport.");
        uploadedBlobs.add(entry.oid);
        if (++uploadedObjects > MAX_REMOTE_OBJECTS) failure("git_error", "This local history exceeds the Browser Git publish object limit.");
      }
    } else {
      failure("rest_unsupported", "GitHub REST cannot publish this Git tree mode; retry with the scoped Git transport.");
    }
    entries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.oid });
  }
  const created = await githubApi<{ sha: string }>(workspace, token, "/git/trees", { method: "POST", body: JSON.stringify({ tree: entries }) });
  if (created?.sha !== oid) failure("rest_unsupported", "GitHub REST did not preserve a local tree SHA; retry with the scoped Git transport.");
  if (++uploadedObjects > MAX_REMOTE_OBJECTS) failure("git_error", "This local history exceeds the Browser Git publish object limit.");
  return uploadedObjects;
}

async function uploadCommitGraph(workspace: WorkspaceIdentity, token: string, dir: string, head: string, stopAt: string | null): Promise<void> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const pending = [head];
  while (pending.length) {
    const oid = pending.pop()!;
    if (oid === stopAt || seen.has(oid)) continue;
    seen.add(oid);
    if (seen.size > MAX_REMOTE_COMMITS) failure("git_error", "This local history exceeds the Browser Git publish limit.");
    const { commit } = await git.readCommit({ fs, dir, oid });
    ordered.push(oid);
    pending.push(...commit.parent);
  }
  const uploadedTrees = new Set<string>();
  const uploadedBlobs = new Set<string>();
  let uploadedObjects = 0;
  for (const oid of ordered.reverse()) {
    const { commit } = await git.readCommit({ fs, dir, oid });
    uploadedObjects = await uploadTree(workspace, token, dir, commit.tree, uploadedTrees, uploadedBlobs, uploadedObjects);
    const response = await githubApi<{ sha: string }>(workspace, token, "/git/commits", {
      method: "POST",
      body: JSON.stringify({
        message: commit.message,
        tree: commit.tree,
        parents: commit.parent,
        author: { name: commit.author.name, email: commit.author.email, date: isoGitDate(commit.author) },
        committer: { name: commit.committer.name, email: commit.committer.email, date: isoGitDate(commit.committer) },
        ...(commit.gpgsig ? { signature: commit.gpgsig } : {}),
      }),
    });
    if (response?.sha !== oid) failure("rest_unsupported", "GitHub REST did not preserve a local commit SHA; retry with the scoped Git transport.");
    if (++uploadedObjects > MAX_REMOTE_OBJECTS) failure("git_error", "This local history exceeds the Browser Git publish object limit.");
  }
}

async function remoteContains(workspace: WorkspaceIdentity, token: string, head: string, wanted: string): Promise<boolean> {
  const pending = [head];
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (oid === wanted) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (seen.size > MAX_REMOTE_COMMITS) return false;
    const commit = await githubApi<GitHubCommit>(workspace, token, `/commits/${oid}`);
    if (!commit || commit.sha !== oid) return false;
    pending.push(...commit.parents.map(parent => parent.sha));
  }
  return false;
}

async function reconcilePublish(workspace: WorkspaceIdentity, token: string, expectedRemoteHead: string | null, targetHead: string): Promise<{ state: "published"; head: string; remoteHead: string } | { state: "conflict"; expectedRemoteHead: string | null; remoteHead: string | null } | { state: "remote-unknown"; expectedRemoteHead: string | null; observedRemoteHead: string | null }> {
  let observed: string | null;
  try { observed = await readRemoteHead(workspace, token); }
  catch (error) {
    if (error && typeof error === "object" && "propriumCode" in error
        && ["authentication_expired", "permission_denied"].includes(String(error.propriumCode))) throw error;
    return { state: "remote-unknown", expectedRemoteHead, observedRemoteHead: null };
  }
  try {
    if (observed === targetHead || (observed && await remoteContains(workspace, token, observed, targetHead))) {
      return { state: "published", head: targetHead, remoteHead: observed! };
    }
  } catch (error) {
    if (error && typeof error === "object" && "propriumCode" in error
        && ["authentication_expired", "permission_denied"].includes(String(error.propriumCode))) throw error;
    return { state: "remote-unknown", expectedRemoteHead, observedRemoteHead: observed };
  }
  if (observed !== expectedRemoteHead) return { state: "conflict", expectedRemoteHead, remoteHead: observed };
  return { state: "remote-unknown", expectedRemoteHead, observedRemoteHead: observed };
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(() => true, (error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    return failure("storage_unknown", "Browser storage could not confirm a local filesystem path.");
  });
}

async function ensureDirectory(path: string): Promise<void> {
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current += `/${segment}`;
    if (!(await exists(current))) await fs.mkdir(current);
    else if (!(await fs.lstat(current)).isDirectory()) failure("storage_unknown", "A local repository storage path is not a directory.");
  }
}

async function workspacePaths(workspace: WorkspaceIdentity): Promise<{ dir: string; binding: string; lock: string }> {
  validateWorkspaceIdentity(workspace);
  const id = await digest(workspace.localWorkspaceId);
  return { dir: `${dataRoot}/repositories/${id}`, binding: `${dataRoot}/bindings/${id}.json`, lock: `proprium-workspace-${id}` };
}

interface WorkspaceBinding { identity: WorkspaceIdentity; lastConfirmedHead: string | null; }

async function checkBinding(workspace: WorkspaceIdentity, binding: string, dir: string): Promise<WorkspaceBinding | null> {
  if (!(await exists(binding))) return null;
  let previous: WorkspaceBinding;
  try { previous = JSON.parse(await fs.readFile(binding, "utf8")) as WorkspaceBinding; }
  catch { failure("storage_unknown", "The stored workspace identity could not be read safely."); }
  const identity = previous!.identity;
  if (identity.origin !== workspace.origin || identity.repositoryId !== workspace.repositoryId
    || identity.owner !== workspace.owner || identity.repository !== workspace.repository
    || identity.branch !== workspace.branch || identity.localWorkspaceId !== workspace.localWorkspaceId) {
    failure("identity_mismatch", "This local workspace ID is already bound to a different origin, repository, or branch.");
  }
  if (previous!.lastConfirmedHead !== null && !/^[a-f0-9]{40}$/u.test(previous!.lastConfirmedHead ?? "")) {
    failure("storage_unknown", "The saved local Git head receipt is malformed.");
  }
  knownHeads.set(dir, previous!.lastConfirmedHead);
  return previous!;
}

async function assertNoSymlinkParents(dir: string, path: string, includeLeaf: boolean): Promise<void> {
  const segments = path.split("/");
  let current = dir;
  const count = includeLeaf ? segments.length : segments.length - 1;
  for (let index = 0; index < count; index += 1) {
    current += `/${segments[index]}`;
    if (!(await exists(current))) continue;
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) failure("invalid_path", "Symbolic links are not followed by the Browser Git adapter.");
    if (index < count - 1 && !stats.isDirectory()) failure("invalid_path", "A repository path parent is not a directory.");
  }
}

async function fileRevision(dir: string, path: string): Promise<string | null> {
  const file = `${dir}/${path}`;
  if (!(await exists(file))) return null;
  const stats = await fs.lstat(file);
  if (!stats.isFile()) failure("invalid_path", "Only regular repository files can be revision checked.");
  const content = new Uint8Array(await fs.readFile(file));
  return (await git.hashBlob({ object: content })).oid;
}

async function currentHead(dir: string): Promise<string | null> {
  try { return await git.resolveRef({ fs, dir, ref: "HEAD" }); }
  catch (error) {
    const message = String(error);
    if (message.includes("Could not find refs/heads/") || message.includes("Could not resolve reference")) {
      if ((await git.listBranches({ fs, dir })).length === 0 && knownHeads.get(dir) === null) return null;
      failure("storage_unknown", "The active branch reference is missing while other local branches exist.");
    }
    if (message.includes("NoRefspecError")) return null;
    throw error;
  }
}

async function persistConfirmedHead(workspace: WorkspaceIdentity, binding: string, dir: string, head: string): Promise<void> {
  const value: WorkspaceBinding = { identity: workspace, lastConfirmedHead: head };
  try {
    await fs.writeFile(binding, JSON.stringify(value), "utf8");
    await flush();
  } catch { failure("storage_unknown", "The local commit ref exists but its workspace receipt could not be persisted."); }
  knownHeads.set(dir, head);
}

async function assertRevision(dir: string, expected: string | null): Promise<void> {
  const actual = await currentHead(dir);
  if (actual !== expected) failure("revision_conflict", "The repository HEAD changed; reload status before continuing.");
}

async function status(dir: string): Promise<StatusEntry[]> {
  return (await worktreeMatrix(dir, "HEAD")).filter((entry) => entry.head !== entry.worktree || entry.head !== entry.stage)
    .map(({ path, head, worktree, stage }) => ({ path, head, worktree, stage }));
}

async function hasUnbornWorktreeChanges(dir: string): Promise<boolean> {
  const rows = await git.statusMatrix({ fs, dir });
  for (const [path, head, worktree, stage] of rows) {
    if (head === worktree && head === stage) continue;
    if (head === 0 && stage === 0 && worktree === 2 && await git.isIgnored({ fs, dir, filepath: path })) continue;
    return true;
  }
  return false;
}

interface WorkingMatrixEntry extends StatusEntry {
  headFile: Uint8Array | null;
  worktreeFile: Uint8Array | null;
}

async function worktreeMatrix(dir: string, ref: string): Promise<WorkingMatrixEntry[]> {
  const rows = await git.walk({
    fs,
    dir,
    trees: [git.TREE({ ref }), git.WORKDIR({ refresh: false }), git.STAGE()],
    map: async (path, [head, worktree, stage]) => {
      if (path === ".git" || path.startsWith(".git/")) return null;
      const [headType, worktreeType, stageType] = await Promise.all([
        head?.type(), worktree?.type(), stage?.type(),
      ]);
      const isBlob = [headType, worktreeType, stageType].includes("blob");
      if (headType === "commit" || stageType === "commit") return null;
      if (!isBlob && [headType, worktreeType, stageType].some((type) => type === "tree" || type === "special")) return;
      if (!isBlob) return;
      if (!head && !stage && worktree && await git.isIgnored({ fs, dir, filepath: path })) return null;
      validateGitPath(path);
      await assertNoSymlinkParents(dir, path, true);
      const headOid = headType === "blob" ? await head!.oid() : undefined;
      const stageOid = stageType === "blob" ? await stage!.oid() : undefined;
      let worktreeOid: string | undefined;
      if (worktreeType === "blob") {
        const content = await worktree!.content();
        if (content === undefined) failure("storage_unknown", "A worktree file disappeared during Git status inspection.");
        worktreeOid = (await git.hashBlob({ object: content as Uint8Array })).oid;
      }
      const values = [undefined, headOid, worktreeOid, stageOid];
      const [headState, worktreeState, stageState] = values.map((value) => values.indexOf(value)).slice(1);
      if (headState === worktreeState && headState === stageState) return;
      const headFile = headType === "blob" ? new Uint8Array((await head!.content()) ?? []) : null;
      let worktreeFile: Uint8Array | null = null;
      if (worktreeType === "blob") {
        const mode = await worktree!.mode();
        worktreeFile = mode >> 12 === 0b1010
          ? new TextEncoder().encode(await fs.readlink(`${dir}/${path}`))
          : new Uint8Array(await fs.readFile(`${dir}/${path}`));
      }
      return { path, head: headState!, worktree: worktreeState!, stage: stageState!, headFile, worktreeFile };
    },
  }) as WorkingMatrixEntry[];
  return rows.filter(Boolean);
}

async function verifyObjects(dir: string): Promise<void> {
  const commits = new Set<string>();
  const trees = new Set<string>();
  const verifyTree = async (oid: string): Promise<void> => {
    if (trees.has(oid)) return;
    trees.add(oid);
    const { tree } = await git.readTree({ fs, dir, oid });
    for (const entry of tree) {
      if (entry.type === "tree") await verifyTree(entry.oid);
      else if (entry.type === "blob") await git.readBlob({ fs, dir, oid: entry.oid });
      else await git.readCommit({ fs, dir, oid: entry.oid });
    }
  };
  for (const branch of await git.listBranches({ fs, dir })) {
    const pending = [await git.resolveRef({ fs, dir, ref: branch })];
    while (pending.length) {
      const oid = pending.pop()!;
      if (commits.has(oid)) continue;
      commits.add(oid);
      const { commit } = await git.readCommit({ fs, dir, oid });
      await verifyTree(commit.tree);
      pending.push(...commit.parent);
    }
  }
  await status(dir);
}

async function operation(request: LocalGitRequest): Promise<unknown> {
  const paths = await workspacePaths(request.workspace);
  const bound = await checkBinding(request.workspace, paths.binding, paths.dir);
  if (request.operation === "init") {
    if (bound && !(await exists(`${paths.dir}/.git/HEAD`))) failure("storage_unknown", "Workspace metadata exists but its Git metadata is missing.");
    await ensureDirectory(`${dataRoot}/repositories`);
    await ensureDirectory(`${dataRoot}/bindings`);
    await ensureDirectory(paths.dir);
    if (!bound) {
      try {
        await git.init({ fs, dir: paths.dir, defaultBranch: request.workspace.branch });
        await git.addRemote({ fs, dir: paths.dir, remote: "origin", url: `https://github.com/${request.workspace.owner}/${request.workspace.repository}.git` });
        await fs.writeFile(paths.binding, JSON.stringify({ identity: request.workspace, lastConfirmedHead: null } satisfies WorkspaceBinding), "utf8");
        await flush();
        knownHeads.set(paths.dir, null);
      } catch { failure("storage_unknown", "Local repository initialization did not reach a confirmed storage state."); }
    }
    const head = await currentHead(paths.dir);
    if (!head) uncertainWorkspaces.delete(paths.lock);
    return { head, branch: request.workspace.branch, localState: head && (await status(paths.dir)).length === 0 ? "local-committed" : "draft" };
  }
  if (!bound || !(await exists(`${paths.dir}/.git/HEAD`))) failure("not_initialized", "Initialize this local workspace before using Git operations.");
  if (request.operation === "remote-head") {
    await verifyRemoteRepository(request.workspace, request.token, false);
    return { repositoryId: request.workspace.repositoryId, branch: request.workspace.branch, head: await readRemoteHead(request.workspace, request.token) };
  }
  if (request.operation === "remote-fetch" || request.operation === "remote-pull") {
    await verifyRemoteRepository(request.workspace, request.token, false);
    const remoteHead = await readRemoteHead(request.workspace, request.token);
    const localHead = await currentHead(paths.dir);
    if (request.operation === "remote-pull") {
      const dirty = localHead ? (await status(paths.dir)).length > 0 : await hasUnbornWorktreeChanges(paths.dir);
      if (dirty) return { state: "conflict", localHead, remoteHead };
    }
    let importedCommits: number;
    const hydrationState = createHydrationState();
    try {
      await hydrateRemoteHead(request.workspace, request.token, paths.dir, remoteHead, hydrationState);
      importedCommits = hydrationState.imported.size;
    } catch (error) {
      if (!isRestUnsupported(error) || !remoteHead) throw error;
      importedCommits = hydrationState.imported.size
        + await countMissingRemoteCommits(request.workspace, request.token, paths.dir, remoteHead);
      await fetchViaSmartHttp(request.workspace, request.token, request.authRelayUrl, paths.dir, remoteHead);
      if (await readRemoteHead(request.workspace, request.token) !== remoteHead) {
        failure("remote_unknown", "The GitHub branch changed during Smart HTTP fetch; fetched objects remain unreferenced locally.");
      }
    }
    const trackingRef = `refs/remotes/origin/${request.workspace.branch}`;
    try {
      if (remoteHead) await git.writeRef({ fs, dir: paths.dir, ref: trackingRef, value: remoteHead, force: true });
      else if (await git.resolveRef({ fs, dir: paths.dir, ref: trackingRef }).then(() => true, () => false)) await git.deleteRef({ fs, dir: paths.dir, ref: trackingRef });
      await flush();
    } catch { failure("storage_unknown", "Fetched Git objects could not be confirmed in browser storage."); }
    if (request.operation === "remote-fetch") {
      return { repositoryId: request.workspace.repositoryId, branch: request.workspace.branch, head: remoteHead, localHead, importedCommits };
    }
    if (remoteHead === localHead) return { state: "up-to-date", head: localHead };
    if (!remoteHead) {
      if (!localHead) return { state: "up-to-date", head: null };
      return { state: "local-ahead", head: localHead, remoteHead };
    }
    if (localHead && await isAncestor(paths.dir, remoteHead, localHead)) {
      return { state: "local-ahead", head: localHead, remoteHead };
    }
    if (localHead && !(await isAncestor(paths.dir, localHead, remoteHead))) {
      return { state: "conflict", localHead, remoteHead };
    }
    const previousHead = localHead;
    try {
      await git.writeRef({ fs, dir: paths.dir, ref: `refs/heads/${request.workspace.branch}`, value: remoteHead, force: true });
      await git.checkout({ fs, dir: paths.dir, ref: request.workspace.branch, force: false });
      await flush();
      if (await currentHead(paths.dir) !== remoteHead || (await status(paths.dir)).length) {
        failure("storage_unknown", "The local worktree did not confirm the fetched GitHub commit after pull.");
      }
    } catch (error) {
      if (error && typeof error === "object" && "propriumCode" in error) throw error;
      failure("storage_unknown", "The local branch or worktree could not be confirmed after pull.");
    }
    return { state: "fast-forwarded", previousHead, head: remoteHead };
  }
  if (request.operation === "remote-publish") {
    await verifyRemoteRepository(request.workspace, request.token, true);
    const localHead = await currentHead(paths.dir);
    const localStatus = await status(paths.dir);
    if (localHead !== request.expectedHead || localStatus.length) failure("revision_conflict", "Publishing requires the unchanged local commit and a clean worktree.");
    const observedRemoteHead = await readRemoteHead(request.workspace, request.token);
    if (observedRemoteHead !== request.expectedRemoteHead) {
      return { state: "conflict", expectedRemoteHead: request.expectedRemoteHead, remoteHead: observedRemoteHead };
    }
    if (observedRemoteHead && !(await isAncestor(paths.dir, observedRemoteHead, request.expectedHead))) {
      return { state: "conflict", expectedRemoteHead: request.expectedRemoteHead, remoteHead: observedRemoteHead };
    }
    if (observedRemoteHead === request.expectedHead) {
      return { state: "published", head: request.expectedHead, remoteHead: observedRemoteHead };
    }
    try {
      await uploadCommitGraph(request.workspace, request.token, paths.dir, request.expectedHead, observedRemoteHead);
    } catch (error) {
      if (!isRestUnsupported(error)) throw error;
      let rejected = false;
      let pushFailure: unknown;
      try {
        const pushed = await git.push({
          fs, dir: paths.dir,
          url: `https://github.com/${request.workspace.owner}/${request.workspace.repository}.git`,
          http: smartHttpClient(request.workspace, request.token, request.authRelayUrl),
          ref: request.workspace.branch,
          remoteRef: request.workspace.branch,
          force: false,
        });
        rejected = !pushed.ok;
      } catch (failureValue) { pushFailure = failureValue; }
      const result = await reconcilePublish(request.workspace, request.token, request.expectedRemoteHead, request.expectedHead);
      if (result.state === "published" || result.state === "conflict") return result;
      if (pushFailure && typeof pushFailure === "object" && "propriumCode" in pushFailure) {
        if (["authentication_expired", "permission_denied"].includes(String(pushFailure.propriumCode))) throw pushFailure;
      }
      if (rejected && result.observedRemoteHead === request.expectedRemoteHead) {
        failure("permission_denied", "GitHub rejected the Smart HTTP ref update. Check repository write access and branch protection.");
      }
      return result;
    }
    let updateFailure: unknown;
    try {
      const refPath = observedRemoteHead ? `/git/refs/heads/${request.workspace.branch.split("/").map(encodeURIComponent).join("/")}` : "/git/refs";
      const result = observedRemoteHead
        ? await githubApi<GitHubRef>(request.workspace, request.token, refPath, { method: "PATCH", body: JSON.stringify({ sha: request.expectedHead, force: false }) })
        : await githubApi<GitHubRef>(request.workspace, request.token, refPath, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${request.workspace.branch}`, sha: request.expectedHead }) });
      if (result?.object?.sha !== request.expectedHead) {
        failure("remote_unknown", "GitHub accepted a ref update without confirming the requested commit SHA.");
      }
    } catch (error) {
      updateFailure = error;
    }
    const reconciled = await reconcilePublish(request.workspace, request.token, request.expectedRemoteHead, request.expectedHead);
    if (reconciled.state === "published" || reconciled.state === "conflict" || reconciled.state === "remote-unknown") {
      if (reconciled.state === "conflict") return reconciled;
      if (reconciled.state === "published") return reconciled;
    }
    if (updateFailure) {
      const statusCode = updateFailure instanceof GitHubApiError ? updateFailure.status : 0;
      if (statusCode === 401) failure("authentication_expired", "GitHub authorization expired while publishing. Reauthorize and verify the remote branch.");
      if (statusCode === 403) failure("permission_denied", "GitHub rejected publication. Check repository write access and branch protection.");
      if (statusCode >= 500) return reconciled;
      if (statusCode === 409 || statusCode === 422) {
        if (reconciled.state === "remote-unknown") return { state: "conflict", expectedRemoteHead: request.expectedRemoteHead, remoteHead: reconciled.observedRemoteHead };
      }
      if (updateFailure instanceof GitHubApiError) throw Object.assign(updateFailure, { propriumCode: "git_error" as const });
      return reconciled;
    }
    return reconciled;
  }
  if (request.operation === "verify") {
    try {
      await flush();
      await verifyObjects(paths.dir);
    } catch { failure("storage_unknown", "Local Git objects or refs could not be verified after an uncertain storage result."); }
    const head = await currentHead(paths.dir);
    const entries = await status(paths.dir);
    if (head) await persistConfirmedHead(request.workspace, paths.binding, paths.dir, head);
    uncertainWorkspaces.delete(paths.lock);
    return { verified: true, head, entries };
  }
  if (request.operation === "read") {
    validateGitPath(request.path);
    await assertNoSymlinkParents(paths.dir, request.path, true);
    const file = `${paths.dir}/${request.path}`;
    if (!(await exists(file))) return { data: null, oid: null };
    const stats = await fs.lstat(file);
    if (!stats.isFile()) failure("invalid_path", "Only regular repository files can be read.");
    const data = new Uint8Array(await fs.readFile(file));
    const { oid } = await git.hashBlob({ object: data });
    return { data, oid };
  }
  if (request.operation === "write") {
    validateGitPath(request.path);
    await assertNoSymlinkParents(paths.dir, request.path, true);
    const file = `${paths.dir}/${request.path}`;
    const found = await exists(file);
    if (found && !(await fs.lstat(file)).isFile()) failure("invalid_path", "Only regular repository files can be replaced.");
    const current = found ? await git.hashBlob({ object: new Uint8Array(await fs.readFile(file)) }) : null;
    if ((current?.oid ?? null) !== request.expected.oid) failure("revision_conflict", "The file changed since it was read; reload it before applying this edit.");
    const updated = await git.hashBlob({ object: request.data });
    await ensureDirectory(file.slice(0, file.lastIndexOf("/")));
    try {
      await fs.writeFile(file, request.data);
      await flush();
    } catch { failure("storage_unknown", "The local write could not be confirmed in browser storage."); }
    return { oid: updated.oid, localState: "draft" };
  }
  if (request.operation === "delete") {
    validateGitPath(request.path);
    await assertNoSymlinkParents(paths.dir, request.path, true);
    const file = `${paths.dir}/${request.path}`;
    const found = await exists(file);
    if (!found) {
      if (request.expected.oid !== null) failure("revision_conflict", "The file disappeared since it was read; reload it before deleting.");
      return;
    }
    const stats = await fs.lstat(file);
    if (!stats.isFile()) failure("invalid_path", "Only regular repository files can be deleted.");
    const current = await git.hashBlob({ object: new Uint8Array(await fs.readFile(file)) });
    if (current.oid !== request.expected.oid) failure("revision_conflict", "The file changed since it was read; reload it before deleting.");
    try {
      await fs.unlink(file);
      await flush();
    } catch { failure("storage_unknown", "The local deletion could not be confirmed in browser storage."); }
    return;
  }
  if (request.operation === "apply-changes") {
    if (!Array.isArray(request.changes) || request.changes.length > MAX_WORKSPACE_CHANGE_COUNT ||
        !Array.isArray(request.readSet) || request.readSet.length > MAX_WORKSPACE_READ_SET_COUNT) {
      failure("invalid_path", "The approved change set exceeds browser workspace limits.");
    }
    let totalBytes = 0;
    const changes = new Map<string, { content: Uint8Array | null; expectedRevision: string | null; resultingRevision: string | null }>();
    const expectations = new Map<string, string | null>();
    const validRevision = (revision: unknown): revision is { oid: string | null } => Boolean(
      revision && typeof revision === "object" && !Array.isArray(revision) && Object.hasOwn(revision, "oid") &&
      ((revision as { oid?: unknown }).oid === null || typeof (revision as { oid?: unknown }).oid === "string" && /^[a-f0-9]{40}$/u.test((revision as { oid: string }).oid)),
    );
    for (const expected of request.readSet) {
      if (!expected || typeof expected !== "object" || typeof expected.path !== "string" || !validRevision(expected.revision)) {
        failure("invalid_path", "The approved read set contains an invalid revision check.");
      }
      validateGitPath(expected.path);
      if (expectations.has(expected.path)) failure("invalid_path", "The approved read set contains a duplicate path.");
      expectations.set(expected.path, expected.revision.oid);
    }
    for (const change of request.changes) {
      if (!change || typeof change !== "object" || typeof change.path !== "string" || !validRevision(change.expectedRevision) ||
          !(change.content === null || change.content instanceof Uint8Array)) {
        failure("invalid_path", "The approved change set contains an invalid file change.");
      }
      validateGitPath(change.path);
      if (changes.has(change.path)) failure("invalid_path", "The approved change set contains a duplicate path.");
      const previousExpectation = expectations.get(change.path);
      if (expectations.has(change.path) && previousExpectation !== change.expectedRevision.oid) {
        failure("revision_conflict", "The approved read set and write set disagree about a file revision.");
      }
      if (change.content) {
        totalBytes += change.content.byteLength;
        if (totalBytes > MAX_WORKSPACE_CHANGE_BYTES) failure("invalid_path", "The approved change content exceeds the browser workspace limit.");
      }
      expectations.set(change.path, change.expectedRevision.oid);
      const resultingRevision = change.content ? (await git.hashBlob({ object: change.content })).oid : null;
      changes.set(change.path, { content: change.content, expectedRevision: change.expectedRevision.oid, resultingRevision });
    }

    // A proposal cannot treat one file path as the parent directory of another.
    const expectedPaths = [...expectations.keys()].sort();
    for (let index = 0; index + 1 < expectedPaths.length; index += 1) {
      if (expectedPaths[index + 1]!.startsWith(`${expectedPaths[index]!}/`)) {
        failure("invalid_path", "The approved read and write paths contain a file/directory collision.");
      }
    }

    // Verify every read dependency and every write/delete base while holding the workspace lock.
    let totalReadBytes = 0;
    for (const [path, expectedRevision] of expectations) {
      validateGitPath(path);
      await assertNoSymlinkParents(paths.dir, path, true);
      const currentFile = `${paths.dir}/${path}`;
      if (await exists(currentFile)) {
        const stats = await fs.lstat(currentFile);
        if (!stats.isFile()) failure("invalid_path", "Only regular repository files can be revision checked.");
        totalReadBytes += stats.size;
        if (totalReadBytes > MAX_WORKSPACE_READ_BYTES) failure("invalid_path", "The approved read set exceeds the browser workspace limit.");
      }
      let actualRevision: string | null = null;
      try { actualRevision = await fileRevision(paths.dir, path); }
      catch (error) {
        if (error && typeof error === "object" && "propriumCode" in error) throw error;
        failure("storage_unknown", "A workspace file revision could not be read safely before applying changes.");
      }
      if (actualRevision !== expectedRevision) failure("revision_conflict", `The file ${path} changed since the approved proposal was prepared.`);
    }

    let mutationStarted = false;
    try {
      for (const [path, change] of changes) {
        const file = `${paths.dir}/${path}`;
        if (change.content === null) {
          if (change.expectedRevision === null) continue;
          mutationStarted = true;
          await fs.unlink(file);
        } else {
          mutationStarted = true;
          await ensureDirectory(file.slice(0, file.lastIndexOf("/")));
          await fs.writeFile(file, change.content);
        }
      }
      if (mutationStarted) await flush();
      const applied: Array<{ path: string; revision: { oid: string | null } }> = [];
      for (const [path, change] of changes) {
        const actualRevision = await fileRevision(paths.dir, path);
        if (actualRevision !== change.resultingRevision) failure("storage_unknown", "The complete approved change set could not be confirmed after browser storage flush.");
        applied.push({ path, revision: { oid: actualRevision } });
      }
      return applied;
    } catch (error) {
      if (!mutationStarted) throw error;
      if (error && typeof error === "object" && "propriumCode" in error && error.propriumCode === "storage_unknown") throw error;
      failure("storage_unknown", "Applying the approved change set did not reach a confirmed browser storage state; verify this workspace before continuing.");
    }
  }
  if (request.operation === "list-files") {
    const rows = await git.statusMatrix({ fs, dir: paths.dir });
    const files: Array<{ path: string; type: "blob"; oid: string; bytes: number }> = [];
    for (const [path, , worktree] of rows) {
      if (!worktree || path === ".git" || path.startsWith(".git/")) continue;
      if (await git.isIgnored({ fs, dir: paths.dir, filepath: path })) continue;
      validateGitPath(path);
      await assertNoSymlinkParents(paths.dir, path, true);
      const file = `${paths.dir}/${path}`;
      const stats = await fs.lstat(file);
      if (!stats.isFile()) failure("invalid_path", "Only regular repository files can be listed in the workspace.");
      const data = new Uint8Array(await fs.readFile(file));
      const { oid } = await git.hashBlob({ object: data });
      files.push({ path, type: "blob", oid, bytes: data.byteLength });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }
  if (request.operation === "status") {
    const entries = await status(paths.dir);
    const head = await currentHead(paths.dir);
    return { head, entries, localState: entries.length || !head ? "draft" : "local-committed" };
  }
  if (request.operation === "diff") {
    const entries = await worktreeMatrix(paths.dir, request.workspace.branch);
    return Promise.all(entries.map(async (entry) => ({
      path: entry.path,
      head: entry.head,
      worktree: entry.worktree,
      stage: entry.stage,
      kind: entry.head === 0 ? "added" : entry.worktree === 0 ? "deleted" : entry.worktree === 2 ? "modified" : "staged",
      headFile: entry.headFile ? { oid: (await git.hashBlob({ object: entry.headFile })).oid, data: entry.headFile } : null,
      worktreeFile: entry.worktreeFile ? { oid: (await git.hashBlob({ object: entry.worktreeFile })).oid, data: entry.worktreeFile } : null,
    })));
  }
  if (request.operation === "add") {
    await assertRevision(paths.dir, request.expectedHead);
    const selected = [...new Set(request.paths)];
    if (selected.length === 0) failure("invalid_path", "Choose at least one path to stage.");
    for (const path of selected) {
      validateGitPath(path);
      await assertNoSymlinkParents(paths.dir, path, true);
    }
    try {
      for (const path of selected) {
        await git.add({ fs, dir: paths.dir, filepath: path });
      }
      await flush();
    } catch (error) {
      if (error && typeof error === "object" && "propriumCode" in error) throw error;
      failure("storage_unknown", `The staged index could not be confirmed in browser storage: ${String(error)}`);
    }
    return { entries: await status(paths.dir), head: await currentHead(paths.dir) };
  }
  if (request.operation === "commit") {
    if (!request.message.trim() || request.message.length > 100_000 || !request.author.name.trim() || !request.author.email.includes("@")) {
      failure("git_error", "A commit requires a message and valid author identity.");
    }
    await assertRevision(paths.dir, request.expectedHead);
    const staged = await git.statusMatrix({ fs, dir: paths.dir });
    if (!staged.some(([, head, , stage]) => head !== stage)) failure("git_error", "There are no staged changes to commit.");
    const author = { ...request.author, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() };
    let oid: string;
    try {
      oid = await git.commit({ fs, dir: paths.dir, message: request.message, author, committer: author });
      await flush();
      const actualHead = await currentHead(paths.dir);
      if (actualHead !== oid) failure("storage_unknown", "The commit SHA does not match the resulting local branch head.");
      await persistConfirmedHead(request.workspace, paths.binding, paths.dir, oid);
    } catch (error) {
      if (error && typeof error === "object" && "propriumCode" in error) throw error;
      failure("storage_unknown", "Commit object or ref persistence is uncertain; verify local history before retrying.");
    }
    let entries: StatusEntry[] = [];
    try { entries = await status(paths.dir); }
    catch { failure("storage_unknown", "The commit was created but its resulting worktree state could not be inspected."); }
    return { oid: oid!, head: oid!, localState: entries.length ? "draft" : "local-committed" };
  }
  if (request.operation === "log") {
    if (!Number.isSafeInteger(request.depth) || request.depth < 1 || request.depth > 500) failure("git_error", "Log depth must be between 1 and 500.");
    if (!(await currentHead(paths.dir))) return [];
    const commits = await git.log({ fs, dir: paths.dir, ref: request.workspace.branch, depth: request.depth });
    return commits.map(({ oid, commit }): unknown => ({ oid, message: commit.message, timestamp: commit.author.timestamp, author: { name: commit.author.name, email: commit.author.email }, parent: commit.parent }));
  }
  if (request.operation === "branches") {
    const all = await git.listBranches({ fs, dir: paths.dir });
    return { current: request.workspace.branch, branches: all };
  }
  if (request.operation === "create-branch") {
    await assertRevision(paths.dir, request.expectedHead);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(request.name) || request.name.includes("..") || request.name.includes("//") || request.name.endsWith("/") || request.name.endsWith(".lock")) {
      failure("git_error", "The branch name is invalid.");
    }
    if ((await git.listBranches({ fs, dir: paths.dir })).includes(request.name)) failure("git_error", "That local branch already exists.");
    try {
      await git.branch({ fs, dir: paths.dir, ref: request.name });
      await flush();
    } catch (error) {
      if (error && typeof error === "object" && "propriumCode" in error) throw error;
      failure("storage_unknown", "The new branch ref could not be confirmed in browser storage.");
    }
    let head: string | null;
    try { head = await currentHead(paths.dir); }
    catch { failure("storage_unknown", "The new branch ref could not be inspected after persistence."); }
    return { branch: request.name, head: head! };
  }
  failure("git_error", "Unsupported local Git operation.");
}

scope.addEventListener("message", async (event: MessageEvent<LocalGitRequest>) => {
  const request = event.data;
  if (!request || typeof request.id !== "string" || typeof request.operation !== "string") return;
  const workspaceId = request.workspace?.localWorkspaceId ?? "";
  try {
    if (!scope.navigator.locks) failure("lock_unavailable", "This browser does not provide Web Locks; local Git workspace access is disabled.");
    const write = ["init", "write", "delete", "apply-changes", "add", "commit", "create-branch", "verify", "remote-fetch", "remote-pull", "remote-publish"].includes(request.operation);
    const paths = await workspacePaths(request.workspace);
    const result = await scope.navigator.locks.request(paths.lock, { mode: write ? "exclusive" : "shared", ifAvailable: true }, async (lock) => {
      if (!lock) failure("workspace_busy", "Another tab is using this local workspace. Retry when its operation finishes.");
      if (uncertainWorkspaces.has(paths.lock) && request.operation !== "verify") {
        failure("storage_unknown", "A previous local Git operation had an uncertain result; reopen and verify this workspace before continuing.");
      }
      return operation(request);
    });
    scope.postMessage({ id: request.id, workspaceId, result } satisfies LocalGitResponse);
  } catch (error) {
    const known = error && typeof error === "object" && "propriumCode" in error ? String(error.propriumCode) as LocalGitErrorCode : null;
    const message = error instanceof Error ? error.message : String(error);
    if (known === "storage_unknown" && request.workspace) {
      try { uncertainWorkspaces.add((await workspacePaths(request.workspace)).lock); } catch { /* Identity validation is reported below. */ }
    }
    const response: LocalGitResponse = {
      id: request.id,
      workspaceId,
      error: { code: known ?? (message.startsWith("invalid_identity:") ? "invalid_identity" : message.startsWith("invalid_path:") ? "invalid_path" : "git_error"), message },
    };
    scope.postMessage(response);
  }
});
