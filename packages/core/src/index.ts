import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const execFile = promisify(execFileCallback);
const DEFAULT_BRANCH = "main";
const MAX_HISTORY = 100;
const GIT_TIMEOUT_MS = 120_000;

export interface Project {
  id: string;
  url: string;
  branch: string;
}

export interface TreeScene {
  id: string;
  title: string;
}

export interface TreeChapter {
  id: string;
  title: string;
  scenes: TreeScene[];
}

export interface TreeVolume {
  id: string;
  title: string;
  chapters: TreeChapter[];
}

export interface Tree {
  title: string;
  volumes: TreeVolume[];
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

export class CoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreError";
  }
}

export interface CoreStoreOptions {
  dataDir: string;
  githubToken?: string;
  /** Allows local filesystem remotes for isolated tests and development. */
  allowLocalRemotes?: boolean;
}

interface ProjectRecord extends Project {
  directory: string;
  emptyRemote: boolean;
}

interface SceneRecord {
  id: string;
  title: string;
  yamlPath: string;
  manuscriptPath: string;
  yamlText: string;
  yamlData: Record<string, unknown>;
}

interface FrontmatterDocument {
  prefix: string;
  body: string;
}

function coreError(status: number, code: string, message: string): CoreError {
  return new CoreError(status, code, message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function titleOf(data: Record<string, unknown>, fallback: string): string {
  if (typeof data.title === "string" && data.title.trim()) return data.title.trim();
  if (typeof data.name === "string" && data.name.trim()) return data.name.trim();
  return fallback;
}

function sortByOrderAndTitle<T extends { id: string; title: string; order?: number }>(items: T[]): T[] {
  return items.sort((a, b) => {
    const aOrder = typeof a.order === "number" && Number.isFinite(a.order) ? a.order : null;
    const bOrder = typeof b.order === "number" && Number.isFinite(b.order) ? b.order : null;
    if (aOrder !== null && bOrder !== null && aOrder !== bOrder) return aOrder - bOrder;
    if (aOrder !== null && bOrder === null) return -1;
    if (aOrder === null && bOrder !== null) return 1;
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw coreError(422, "invalid_manuscript_path", "The scene has an unsafe manuscript path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw coreError(422, "invalid_manuscript_path", "The scene has an unsafe manuscript path");
  }
  if (!value.toLowerCase().endsWith(".md")) {
    throw coreError(422, "invalid_manuscript_path", "The scene manuscript must be a Markdown file");
  }
  return segments.join(path.sep);
}

function parseMarkdownDocument(document: string): FrontmatterDocument {
  const opening = /^(---)[ \t]*\r?\n/.exec(document);
  if (!opening) return { prefix: "", body: document };

  const delimiter = /^---[ \t]*\r?$/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(document);
  if (!closing) throw coreError(422, "invalid_frontmatter", "The scene Markdown has unclosed YAML frontmatter");

  const frontmatter = document.slice(opening[0].length, closing.index);
  try {
    const parsed = YAML.parse(frontmatter);
    if (parsed !== null && asRecord(parsed) === null) {
      throw new Error("Frontmatter must be a YAML mapping");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid YAML frontmatter";
    throw coreError(422, "invalid_frontmatter", `The scene Markdown has invalid YAML frontmatter: ${message}`);
  }

  let bodyStart = closing.index + closing[0].length;
  if (document.startsWith("\r\n", bodyStart)) bodyStart += 2;
  else if (document.startsWith("\n", bodyStart)) bodyStart += 1;
  const prefix = document.slice(0, bodyStart);
  return { prefix, body: document.slice(bodyStart) };
}

function revisionFor(yamlText: string, markdownText: string): string {
  return createHash("sha256").update(yamlText).update("\0").update(markdownText).digest("hex");
}

function normalizeGitHubUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw coreError(400, "invalid_repository_url", "Use an HTTPS GitHub repository URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw coreError(400, "invalid_repository_url", "Only HTTPS repositories hosted at github.com are supported");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || !segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment))) {
    throw coreError(400, "invalid_repository_url", "Use a GitHub repository URL in the form https://github.com/owner/repository");
  }
  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  if (!owner || !repository || owner === "." || owner === ".." || repository === "." || repository === "..") {
    throw coreError(400, "invalid_repository_url", "The GitHub repository URL is invalid");
  }
  return `https://github.com/${owner}/${repository}.git`;
}

function repositoryTitle(url: string): string {
  const last = url.replace(/\/+$/, "").split("/").at(-1) ?? "Project";
  return last.replace(/\.git$/i, "") || "Project";
}

function branchName(value: string | undefined): string {
  const branch = value?.trim() || DEFAULT_BRANCH;
  if (
    branch.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith("/") ||
    branch.includes("//") ||
    branch.endsWith(".lock")
  ) {
    throw coreError(400, "invalid_branch", "The branch name is invalid");
  }
  return branch;
}

function sanitizedEnvironment(token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_CONFIG;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  if (token) env.SCRIPTORIUM_GIT_TOKEN = token;
  else delete env.SCRIPTORIUM_GIT_TOKEN;
  return env;
}

function makeAskpassScript(directory: string): Promise<string> {
  const scriptPath = path.join(directory, "askpass");
  const script = "#!/bin/sh\ncase \"$1\" in\n  *sername*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' \"$SCRIPTORIUM_GIT_TOKEN\" ;;\nesac\n";
  return fs.writeFile(scriptPath, script, { mode: 0o700 }).then(() => scriptPath);
}

async function git(
  cwd: string,
  args: string[],
  options: { token?: string; askpass?: string; timeout?: number } = {},
): Promise<string> {
  const baseArgs = [
    "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "init.templateDir=/dev/null",
    ...args,
  ];
  const env = sanitizedEnvironment(options.token);
  if (options.askpass) {
    env.GIT_ASKPASS = options.askpass;
    env.GIT_ASKPASS_REQUIRE = "force";
  }
  try {
    const result = await execFile("git", baseArgs, {
      cwd,
      env,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Git command failed";
    const redacted = options.token ? detail.split(options.token).join("[redacted]") : detail;
    throw coreError(502, "git_operation_failed", `Git operation failed: ${redacted}`);
  }
}

function validateProjectId(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw coreError(404, "project_not_found", "Project not found");
}

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw coreError(500, "unsafe_data_directory", "The application data directory is unsafe");
  }
  await fs.chmod(directory, 0o700);
  const resolved = await fs.realpath(directory);
  if (resolved !== path.resolve(directory)) {
    throw coreError(500, "unsafe_data_directory", "The application data directory is unsafe");
  }
}

async function pathUnderRoot(root: string, relativePath: string): Promise<string> {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    throw coreError(422, "unsafe_project_path", "The project path is unsafe");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw coreError(422, "unsafe_project_path", "The project path is unsafe");
  }
  const resolvedRoot = await fs.realpath(root);
  let current = resolvedRoot;
  let missingParent = false;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    if (missingParent) continue;
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw coreError(422, "unsafe_manuscript_path", "The scene manuscript path crosses a symbolic link");
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        throw coreError(422, "unsafe_manuscript_path", "The scene manuscript path contains a non-directory parent");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingParent = true;
        continue;
      }
      throw error;
    }
  }
  const relative = path.relative(resolvedRoot, current);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw coreError(422, "unsafe_manuscript_path", "The scene manuscript path escapes the project");
  }
  return current;
}

async function pathIsWithinProject(root: string, relativePath: string): Promise<string> {
  return pathUnderRoot(root, safeRelativePath(relativePath));
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class CoreStore {
  readonly dataDir: string;
  private readonly projectsDir: string;
  private readonly locksDir: string;
  private readonly registryPath: string;
  private readonly token?: string;
  private readonly allowLocalRemotes: boolean;
  private readonly queueTails = new Map<string, Promise<void>>();

  constructor(options: CoreStoreOptions) {
    if (!options?.dataDir) throw new TypeError("CoreStore requires dataDir");
    this.dataDir = path.resolve(options.dataDir);
    this.projectsDir = path.join(this.dataDir, "projects");
    this.locksDir = path.join(this.dataDir, ".locks");
    this.registryPath = path.join(this.dataDir, "projects.json");
    this.token = options.githubToken ?? process.env.SCRIPTORIUM_GITHUB_TOKEN;
    this.allowLocalRemotes = options.allowLocalRemotes ?? false;
  }

  private async initialize(): Promise<void> {
    await ensureDirectory(this.dataDir);
    await ensureDirectory(this.projectsDir);
    await ensureDirectory(this.locksDir);
  }

  private async readRegistry(): Promise<ProjectRecord[]> {
    await this.initialize();
    try {
      const registryStat = await fs.lstat(this.registryPath);
      if (registryStat.isSymbolicLink() || !registryStat.isFile()) {
        throw new Error("Project registry must be a regular file");
      }
      const raw = JSON.parse(await fs.readFile(this.registryPath, "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error("Project registry must be an array");
      return raw.map((value) => {
        const item = asRecord(value);
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.url !== "string" ||
          typeof item.branch !== "string" ||
          typeof item.directory !== "string"
        ) {
          throw new Error("Project registry entry is invalid");
        }
        validateProjectId(item.id);
        if (item.directory !== item.id) throw new Error("Project registry directory is invalid");
        return {
          id: item.id,
          url: item.url,
          branch: item.branch,
          directory: item.directory,
          emptyRemote: typeof item.emptyRemote === "boolean" ? item.emptyRemote : false,
        };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw coreError(500, "project_registry_invalid", "The project registry could not be read safely");
    }
  }

  private async writeRegistry(records: ProjectRecord[]): Promise<void> {
    await atomicWrite(this.registryPath, `${JSON.stringify(records, null, 2)}\n`);
  }

  private async getProject(projectId: string): Promise<{ record: ProjectRecord; root: string }> {
    validateProjectId(projectId);
    const records = await this.readRegistry();
    const record = records.find((item) => item.id === projectId);
    if (!record) throw coreError(404, "project_not_found", "Project not found");
    const root = path.join(this.projectsDir, record.directory);
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw coreError(500, "project_workspace_invalid", "The project workspace is missing or unsafe");
    }
    return { record, root };
  }

  private withProjectLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    validateProjectId(projectId);
    return this.withLock(projectId, action);
  }

  private withRegistryLock<T>(action: () => Promise<T>): Promise<T> {
    return this.withLock("registry", action);
  }

  private async withLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    let releaseQueue!: () => void;
    const prior = this.queueTails.get(projectId) ?? Promise.resolve();
    const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.queueTails.set(projectId, tail);
    await prior.catch(() => undefined);

    const lockDir = path.join(this.locksDir, projectId);
    const ownerPath = path.join(lockDir, "owner.json");
    const lockToken = randomUUID();
    let ownsLock = false;
    try {
      await this.initialize();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await fs.mkdir(lockDir, { mode: 0o700 });
          ownsLock = true;
          await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, hostname: process.env.HOSTNAME ?? "", token: lockToken }), { mode: 0o600, flag: "wx", flush: true });
          break;
        } catch (error) {
          if (ownsLock) {
            await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
            ownsLock = false;
          }
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          let owner: { pid?: unknown; hostname?: unknown } | null = null;
          try {
            const ownerStat = await fs.lstat(ownerPath);
            if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
              throw coreError(500, "unsafe_project_lock", "The project lock owner file is unsafe");
            }
            owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as { pid?: unknown; hostname?: unknown };
          } catch (ownerError) {
            if (ownerError instanceof CoreError) throw ownerError;
            /* owner can be between mkdir and write */
          }
          const sameHost = owner?.hostname === (process.env.HOSTNAME ?? "");
          const pid = typeof owner?.pid === "number" ? owner.pid : null;
          let alive = true;
          if (sameHost && pid !== null) {
            try { process.kill(pid, 0); } catch (probeError) { alive = (probeError as NodeJS.ErrnoException).code !== "ESRCH"; }
          }
          const lockStat = await fs.lstat(lockDir).catch(() => null);
          if (lockStat?.isSymbolicLink() || (lockStat && !lockStat.isDirectory())) {
            throw coreError(500, "unsafe_project_lock", "The project lock path is unsafe");
          }
          if (sameHost && pid !== null && !alive) {
            throw coreError(423, "stale_project_lock", `An abandoned lock remains at dataDir/.locks/${projectId}; stop all Scriptorium processes and remove that directory before retrying`);
          }
          throw coreError(423, "project_busy", "Another Scriptorium process is using this project; retry shortly");
        }
      }
      if (!ownsLock) throw coreError(423, "project_busy", "Another Scriptorium process is using this project; retry shortly");
      return await action();
    } finally {
      if (ownsLock) {
        try {
          const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as { token?: unknown };
          if (owner.token === lockToken) await fs.rm(lockDir, { recursive: true, force: true });
        } catch { /* the lock may have been reclaimed after a process failure */ }
      }
      releaseQueue();
      if (this.queueTails.get(projectId) === tail) this.queueTails.delete(projectId);
    }
  }

  async listProjects(): Promise<Project[]> {
    const records = await this.readRegistry();
    return records.map(({ id, url, branch }) => ({ id, url, branch }));
  }

  async registerProject(input: { url: string; branch?: string }): Promise<Project> {
    if (!input || typeof input.url !== "string" || !input.url.trim()) {
      throw coreError(400, "invalid_repository_url", "A repository URL is required");
    }
    const explicitBranch = input.branch === undefined ? undefined : branchName(input.branch);
    const url = this.allowLocalRemotes ? await this.normalizeRemote(input.url.trim()) : normalizeGitHubUrl(input.url.trim());
    const id = randomUUID();
    const directory = id;
    const root = path.join(this.projectsDir, directory);
    const askpassDir = path.join(this.dataDir, `.askpass-${id}`);
    await this.initialize();
    await fs.mkdir(askpassDir, { mode: 0o700 });
    let branch = explicitBranch ?? DEFAULT_BRANCH;
    let remoteWasEmpty = false;
    try {
      const askpass = await makeAskpassScript(askpassDir);
      const headInfo = await git(this.dataDir, ["ls-remote", "--symref", url, "HEAD"], { token: this.token, askpass });
      const remoteHead = headInfo.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
      const remoteHeads = (await git(this.dataDir, ["ls-remote", "--heads", url], { token: this.token, askpass }))
        .split(/\r?\n/)
        .map((line) => line.split("\t")[1])
        .filter((ref): ref is string => typeof ref === "string" && ref.startsWith("refs/heads/"))
        .map((ref) => ref.slice("refs/heads/".length));
      remoteWasEmpty = remoteHeads.length === 0;
      if (!explicitBranch) {
        branch = remoteHead ?? (remoteHeads.includes(DEFAULT_BRANCH) ? DEFAULT_BRANCH : remoteHeads[0] ?? DEFAULT_BRANCH);
        branch = branchName(branch);
      }
      const branchExists = remoteHeads.includes(branch);
      if (!branchExists && remoteHeads.length > 0) {
        throw coreError(404, "branch_not_found", `Branch "${branch}" was not found in the repository`);
      }
      if (branchExists) {
        await git(this.dataDir, [
          "clone", "--no-recurse-submodules", "--branch", branch, "--single-branch", "--", url, root,
        ], { token: this.token, askpass });
      } else {
        await git(this.dataDir, ["clone", "--no-recurse-submodules", "--", url, root], { token: this.token, askpass });
        await git(root, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
      }
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(askpassDir, { recursive: true, force: true }).catch(() => undefined);
    }

    const record: ProjectRecord = { id, url, branch, directory, emptyRemote: false };
    try {
      const registered = await this.withRegistryLock(async () => {
        const records = await this.readRegistry();
        const collision = records.find((item) => item.url === url && item.branch === branch);
        if (collision) return collision;
        const stored = { ...record, emptyRemote: remoteWasEmpty };
        await this.writeRegistry([...records, stored]);
        return stored;
      });
      if (registered.id !== id) {
        await fs.rm(root, { recursive: true, force: true });
        return { id: registered.id, url: registered.url, branch: registered.branch };
      }
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { id, url, branch };
  }

  private async normalizeRemote(input: string): Promise<string> {
    if (/^https:\/\//i.test(input)) return normalizeGitHubUrl(input);
    if (input.startsWith("file://")) {
      let local: URL;
      try { local = new URL(input); } catch { throw coreError(400, "invalid_repository_url", "The local repository URL is invalid"); }
      if (local.hostname && local.hostname !== "localhost") throw coreError(400, "invalid_repository_url", "Only local filesystem remotes are supported in development mode");
      return path.resolve(decodeURIComponent(local.pathname));
    }
    if (input.includes("://") || input.startsWith("-") || input.includes("@")) {
      throw coreError(400, "invalid_repository_url", "Only local filesystem remotes or GitHub HTTPS URLs are supported");
    }
    return path.resolve(input);
  }

  private async readYaml(root: string, relativePath: string): Promise<{ text: string; data: Record<string, unknown> }> {
    const filePath = await pathUnderRoot(root, relativePath);
    const text = await fs.readFile(filePath, "utf8");
    let data: Record<string, unknown> | null;
    try { data = asRecord(YAML.parse(text)); } catch (error) {
      const detail = error instanceof Error ? error.message : "Invalid YAML";
      throw coreError(422, "project_data_invalid", `A hierarchy YAML file is invalid: ${detail}`);
    }
    if (!data) throw coreError(422, "project_data_invalid", "A hierarchy YAML file must contain a mapping");
    return { text, data };
  }

  private async resolveScene(root: string, sceneId: string): Promise<SceneRecord> {
    if (typeof sceneId !== "string" || !sceneId) throw coreError(400, "invalid_scene_id", "A scene id is required");
    const volumesDir = await pathUnderRoot(root, "plot/volumes");
    const volumeDirs = await fs.readdir(volumesDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const found: SceneRecord[] = [];
    for (const volumeEntry of volumeDirs) {
      if (volumeEntry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
      if (!volumeEntry.isDirectory()) continue;
      const volumeId = volumeEntry.name;
      const chaptersDir = await pathUnderRoot(root, `plot/volumes/${volumeId}/chapters`);
      const chapters = await fs.readdir(chaptersDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const chapterEntry of chapters) {
        if (chapterEntry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
        if (!chapterEntry.isDirectory()) continue;
        const sceneDir = await pathUnderRoot(root, `plot/volumes/${volumeId}/chapters/${chapterEntry.name}/scenes`);
        const sceneEntries = await fs.readdir(sceneDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const entry of sceneEntries) {
          if (entry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
          if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
          const yamlPath = path.join(sceneDir, entry.name);
          const yamlRelativePath = path.relative(root, yamlPath).split(path.sep).join("/");
          const { text, data } = await this.readYaml(root, yamlRelativePath);
          const id = typeof data.id === "string" ? data.id : path.basename(entry.name, ".yaml");
          if (id !== sceneId) continue;
          const linkedPath = typeof data.manuscript === "string"
            ? data.manuscript
            : `manuscript/${volumeId}/${chapterEntry.name}/${id}.md`;
          found.push({
            id,
            title: titleOf(data, id),
            yamlPath: path.relative(root, yamlPath).split(path.sep).join("/"),
            manuscriptPath: safeRelativePath(linkedPath),
            yamlText: text,
            yamlData: data,
          });
        }
      }
    }
    if (found.length === 0) throw coreError(404, "scene_not_found", "Scene not found");
    if (found.length > 1) throw coreError(409, "duplicate_scene_id", "The project contains duplicate scene ids");
    return found[0];
  }

  async tree(projectId: string): Promise<Tree> {
    return this.withProjectLock(projectId, async () => {
      const { root, record } = await this.getProject(projectId);
      const projectMeta = path.join(root, "meta", "project.yaml");
      let title = repositoryTitle(record.url);
      try { title = titleOf((await this.readYaml(root, "meta/project.yaml")).data, title); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof CoreError && error.code === "project_data_invalid")) throw error; }

      const volumesRoot = await pathUnderRoot(root, "plot/volumes");
      const volumeEntries = await fs.readdir(volumesRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const volumes: Array<TreeVolume & { order?: number }> = [];
      const seenEntityIds = new Set<string>();
      for (const volumeEntry of volumeEntries) {
        if (volumeEntry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
        if (!volumeEntry.isDirectory()) continue;
        const volumeId = volumeEntry.name;
        const volumeData: Record<string, unknown> = await this.readYaml(root, `plot/volumes/${volumeId}/volume.yaml`).then((value) => value.data).catch((error): Record<string, unknown> => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id: volumeId };
          throw error;
        });
        const actualVolumeId = typeof volumeData.id === "string" ? volumeData.id : volumeId;
        if (seenEntityIds.has(actualVolumeId)) throw coreError(409, "duplicate_entity_id", "The project contains duplicate hierarchy ids");
        seenEntityIds.add(actualVolumeId);
        const chapterDir = await pathUnderRoot(root, `plot/volumes/${volumeId}/chapters`);
        const chapterEntries = await fs.readdir(chapterDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        const chapters: Array<TreeChapter & { order?: number }> = [];
        for (const chapterEntry of chapterEntries) {
          if (chapterEntry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
          if (!chapterEntry.isDirectory()) continue;
          const chapterId = chapterEntry.name;
          const chapterData: Record<string, unknown> = await this.readYaml(root, `plot/volumes/${volumeId}/chapters/${chapterId}/chapter.yaml`).then((value) => value.data).catch((error): Record<string, unknown> => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id: chapterId };
            throw error;
          });
          const actualChapterId = typeof chapterData.id === "string" ? chapterData.id : chapterId;
          if (seenEntityIds.has(actualChapterId)) throw coreError(409, "duplicate_entity_id", "The project contains duplicate hierarchy ids");
          seenEntityIds.add(actualChapterId);
          const sceneDir = await pathUnderRoot(root, `plot/volumes/${volumeId}/chapters/${chapterId}/scenes`);
          const sceneEntries = await fs.readdir(sceneDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          const scenes: Array<TreeScene & { order?: number }> = [];
          for (const sceneEntry of sceneEntries) {
            if (sceneEntry.isSymbolicLink()) throw coreError(422, "unsafe_project_tree", "The project hierarchy contains a symbolic link");
            if (!sceneEntry.isFile() || !sceneEntry.name.endsWith(".yaml")) continue;
            const data = (await this.readYaml(root, `plot/volumes/${volumeId}/chapters/${chapterId}/scenes/${sceneEntry.name}`)).data;
            const sceneId = typeof data.id === "string" ? data.id : path.basename(sceneEntry.name, ".yaml");
            if (seenEntityIds.has(sceneId)) throw coreError(409, "duplicate_scene_id", "The project contains duplicate hierarchy ids");
            seenEntityIds.add(sceneId);
            scenes.push({ id: sceneId, title: titleOf(data, sceneId), order: typeof data.order === "number" ? data.order : undefined });
          }
          chapters.push({
            id: actualChapterId,
            title: titleOf(chapterData, actualChapterId),
            order: typeof chapterData.order === "number" ? chapterData.order : undefined,
            scenes: sortByOrderAndTitle(scenes),
          });
        }
        volumes.push({
          id: actualVolumeId,
          title: titleOf(volumeData, actualVolumeId),
          order: typeof volumeData.order === "number" ? volumeData.order : undefined,
          chapters: sortByOrderAndTitle(chapters),
        });
      }
      return {
        title,
        volumes: sortByOrderAndTitle(volumes).map(({ id, title: volumeTitle, chapters }) => ({
          id,
          title: volumeTitle,
          chapters: chapters.map(({ id: chapterId, title: chapterTitle, scenes }) => ({
            id: chapterId,
            title: chapterTitle,
            scenes: scenes.map(({ id: sceneId, title: sceneTitle }) => ({ id: sceneId, title: sceneTitle })),
          })),
        })),
      };
    });
  }

  async readScene(projectId: string, sceneId: string): Promise<Scene> {
    return this.withProjectLock(projectId, async () => {
      const { root } = await this.getProject(projectId);
      const scene = await this.resolveScene(root, sceneId);
      const markdownFile = await pathIsWithinProject(root, scene.manuscriptPath);
      let markdownText = "";
      try { markdownText = await fs.readFile(markdownFile, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const document = parseMarkdownDocument(markdownText);
      return { id: scene.id, title: scene.title, text: document.body, revision: revisionFor(scene.yamlText, markdownText) };
    });
  }

  async saveScene(
    projectId: string,
    sceneId: string,
    input: { text: string; revision: string },
  ): Promise<Scene> {
    if (!input || typeof input.text !== "string" || typeof input.revision !== "string") {
      throw coreError(400, "invalid_scene_save", "Scene text and revision are required");
    }
    return this.withProjectLock(projectId, async () => {
      const { root } = await this.getProject(projectId);
      const scene = await this.resolveScene(root, sceneId);
      const markdownFile = await pathIsWithinProject(root, scene.manuscriptPath);
      let oldMarkdown = "";
      try { oldMarkdown = await fs.readFile(markdownFile, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const currentRevision = revisionFor(scene.yamlText, oldMarkdown);
      if (input.revision !== currentRevision) {
        throw coreError(409, "revision_conflict", "The scene changed after it was loaded. Reload it before saving.");
      }
      const document = parseMarkdownDocument(oldMarkdown);
      const nextMarkdown = `${document.prefix}${input.text}`;
      const missingLink = typeof scene.yamlData.manuscript !== "string";
      const nextYaml = missingLink
        ? YAML.stringify({ ...scene.yamlData, manuscript: scene.manuscriptPath })
        : scene.yamlText;
      const yamlFile = await pathUnderRoot(root, scene.yamlPath);
      if (missingLink) {
        await atomicWrite(yamlFile, nextYaml);
      }
      let markdownExists = true;
      try { await fs.access(markdownFile); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") markdownExists = false;
        else throw error;
      }
      if (markdownExists && nextMarkdown === oldMarkdown && !missingLink) {
        return {
          id: scene.id,
          title: scene.title,
          text: input.text,
          revision: currentRevision,
        };
      }
      await atomicWrite(markdownFile, nextMarkdown);
      try {
        const paths = [scene.manuscriptPath, ...(missingLink ? [scene.yamlPath] : [])];
        await git(root, ["add", "--", ...paths]);
        await git(root, [
          "-c", "user.name=Scriptorium",
          "-c", "user.email=scriptorium@localhost",
          "commit", "--only", "-m", `Write scene: ${scene.title.replace(/[\r\n]+/g, " ").slice(0, 120)}`, "--", ...paths,
        ]);
      } catch {
        throw coreError(500, "save_commit_failed", "The manuscript file was written but could not be committed; check project status before retrying");
      }
      return {
        id: scene.id,
        title: scene.title,
        text: input.text,
        revision: revisionFor(nextYaml, nextMarkdown),
      };
    });
  }

  async history(projectId: string): Promise<Commit[]> {
    return this.withProjectLock(projectId, async () => {
      const { root } = await this.getProject(projectId);
      const head = await git(root, ["rev-parse", "--verify", "HEAD"]).catch((error) => {
        if (error instanceof CoreError && error.code === "git_operation_failed") return "";
        throw error;
      });
      if (!head.trim()) return [];
      const raw = await git(root, ["log", "-z", `-n${MAX_HISTORY}`, "--format=%H%x00%cI%x00%s"]);
      const fields = raw.split("\0").filter((value) => value.length > 0);
      const commits: Commit[] = [];
      for (let index = 0; index + 2 < fields.length; index += 3) {
        commits.push({ hash: fields[index], date: fields[index + 1], message: fields[index + 2] });
      }
      return commits;
    });
  }

  private async statusUnlocked(root: string, record: ProjectRecord): Promise<SyncStatus> {
    const [head, branchOutput, dirtyOutput] = await Promise.all([
      git(root, ["rev-parse", "--verify", "HEAD"]).catch((error) => {
        if (error instanceof CoreError && error.code === "git_operation_failed") return "";
        throw error;
      }),
      git(root, ["branch", "--show-current"]),
      git(root, ["status", "--porcelain", "--untracked-files=all"]),
    ]);
    const branch = branchOutput.trim();
    if (!branch || branch !== record.branch) {
      throw coreError(409, "branch_changed", "The project is no longer on its registered branch");
    }
    if (!head.trim()) return { branch, head: "", ahead: 0, behind: 0, dirty: dirtyOutput.length > 0 };
    let ahead = 0;
    let behind = 0;
    const remoteRef = `refs/remotes/origin/${record.branch}`;
    const exists = await git(root, ["show-ref", "--verify", "--quiet", remoteRef]).then(() => true).catch((error) => {
      if (error instanceof CoreError && error.code === "git_operation_failed") return false;
      throw error;
    });
    if (exists) {
      const counts = (await git(root, ["rev-list", "--left-right", "--count", `HEAD...origin/${record.branch}`])).trim().split(/\s+/);
      ahead = Number.parseInt(counts[0] ?? "0", 10) || 0;
      behind = Number.parseInt(counts[1] ?? "0", 10) || 0;
    } else {
      ahead = Number.parseInt((await git(root, ["rev-list", "--count", "HEAD"])).trim(), 10) || 0;
    }
    return { branch, head: head.trim(), ahead, behind, dirty: dirtyOutput.length > 0 };
  }

  async status(projectId: string): Promise<SyncStatus> {
    return this.withProjectLock(projectId, async () => {
      const { root, record } = await this.getProject(projectId);
      return this.statusUnlocked(root, record);
    });
  }

  async sync(projectId: string): Promise<SyncStatus> {
    return this.withProjectLock(projectId, async () => {
      const { root, record } = await this.getProject(projectId);
      let status = await this.statusUnlocked(root, record);
      if (status.dirty) throw coreError(409, "working_tree_dirty", "Commit or discard local project changes before synchronizing");

      const askpassDir = path.join(this.dataDir, `.askpass-${record.id}`);
      await fs.mkdir(askpassDir, { mode: 0o700 });
      try {
        const askpass = await makeAskpassScript(askpassDir);
        const remoteHeads = await git(root, ["ls-remote", "--heads", "origin", `refs/heads/${record.branch}`], { token: this.token, askpass });
        const remoteBranchExists = remoteHeads.split(/\r?\n/).some((line) => line.endsWith(`\trefs/heads/${record.branch}`));
        if (!remoteBranchExists) {
          if (!record.emptyRemote) throw coreError(409, "remote_branch_missing", "The registered GitHub branch no longer exists");
          if (status.head) {
            await git(root, ["push", "origin", `HEAD:refs/heads/${record.branch}`], { token: this.token, askpass });
            await git(root, ["fetch", "--no-tags", "origin", record.branch], { token: this.token, askpass });
            await this.withRegistryLock(async () => {
              const records = await this.readRegistry();
              await this.writeRegistry(records.map((item) => item.id === record.id ? { ...item, emptyRemote: false } : item));
            });
          }
        } else {
          await git(root, ["fetch", "--no-tags", "origin", record.branch], { token: this.token, askpass });
          if (record.emptyRemote) {
            await this.withRegistryLock(async () => {
              const records = await this.readRegistry();
              await this.writeRegistry(records.map((item) => item.id === record.id ? { ...item, emptyRemote: false } : item));
            });
            record.emptyRemote = false;
          }
          if (!status.head) await git(root, ["checkout", "-B", record.branch, `origin/${record.branch}`]);
          const counts = (await git(root, ["rev-list", "--left-right", "--count", `HEAD...origin/${record.branch}`])).trim().split(/\s+/);
          const ahead = Number.parseInt(counts[0] ?? "0", 10) || 0;
          const behind = Number.parseInt(counts[1] ?? "0", 10) || 0;
          if (ahead > 0 && behind > 0) throw coreError(409, "sync_conflict", "Local and GitHub histories diverged; resolve the conflict in Git before synchronizing");
          if (behind > 0 && status.head) await git(root, ["merge", "--ff-only", `origin/${record.branch}`]);
          if (ahead > 0) await git(root, ["push", "origin", `HEAD:refs/heads/${record.branch}`], { token: this.token, askpass });
        }
      } catch (error) {
        if (error instanceof CoreError) throw error;
        throw error;
      } finally {
        await fs.rm(askpassDir, { recursive: true, force: true }).catch(() => undefined);
      }
      status = await this.statusUnlocked(root, record);
      if (status.dirty || status.ahead !== 0 || status.behind !== 0) {
        throw coreError(502, "sync_incomplete", "Git synchronization did not finish cleanly");
      }
      return status;
    });
  }
}
