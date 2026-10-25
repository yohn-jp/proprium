/// <reference lib="webworker" />
import { Buffer } from "buffer";
import LightningFS from "@isomorphic-git/lightning-fs";
import * as git from "isomorphic-git";
import type { LocalGitErrorCode, LocalGitRequest, LocalGitResponse, StatusEntry, WorkspaceIdentity } from "./protocol.js";
import { validateGitPath, validateWorkspaceIdentity } from "./protocol.js";

const scope = self as DedicatedWorkerGlobalScope;
globalThis.Buffer = Buffer;
const storage = new LightningFS("proprium-git-v1");
const fs = storage.promises;
const flush = (): Promise<void> => (fs as unknown as { flush(): Promise<void> }).flush();
const dataRoot = "/proprium";
const uncertainWorkspaces = new Set<string>();
const knownHeads = new Map<string, string | null>();
const failure = (code: LocalGitErrorCode, message: string): never => { throw Object.assign(new Error(message), { propriumCode: code }); };

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
    const write = ["init", "write", "add", "commit", "create-branch", "verify"].includes(request.operation);
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
