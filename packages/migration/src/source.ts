import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { assertProjectPath } from "@scriptorium/contracts";
import { isSecretLegacyPath } from "./classification.js";
import type {
  GitWorktreeInspection,
  GitPendingFile,
  LegacySourceReader,
  SqliteColumn,
  SqliteRow,
  SqliteTableInfo,
  SqliteValue,
} from "./types.js";

const execFile = promisify(execFileCallback);
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

function toProjectPath(value: string): string {
  assertProjectPath(value);
  return value;
}

async function checkedPath(root: string | undefined, relativePath: string): Promise<string | null> {
  if (!root) return null;
  const relative = toProjectPath(relativePath);
  let current = path.resolve(root);
  try {
    const rootInfo = await fs.lstat(current);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Legacy root must be a real directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Legacy source contains a symlink: ${relativePath}`);
      if (!info.isFile() && !info.isDirectory()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return current;
}

async function listFiles(root: string | undefined, prefix: string): Promise<string[]> {
  if (!root) return [];
  let start: string | null;
  if (prefix) {
    start = await checkedPath(root, prefix);
  } else {
    start = path.resolve(root);
    try {
      const info = await fs.lstat(start);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Legacy root must be a real directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  if (!start) return [];
  const rootPath = path.resolve(root);
  const result: string[] = [];
  const walk = async (absolute: string): Promise<void> => {
    const info = await fs.lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Legacy source contains a symlink: ${absolute}`);
    if (info.isFile()) {
      result.push(path.relative(rootPath, absolute).split(path.sep).join("/"));
      return;
    }
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const child = path.join(absolute, entry.name);
      // The data root may contain compatibility aliases (for example the old
      // root-level app-state symlink). Never follow or copy a symlink.
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() || entry.isDirectory()) await walk(child);
    }
  };
  await walk(start);
  return result.sort((a, b) => a.localeCompare(b));
}

async function readFile(root: string | undefined, relativePath: string): Promise<Buffer | null> {
  const filePath = await checkedPath(root, relativePath);
  if (!filePath) return null;
  const info = await fs.lstat(filePath);
  if (!info.isFile()) return null;
  return fs.readFile(filePath);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqliteValue(value: unknown): SqliteValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return { encoding: "integer", data: value.toString() };
  if (typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return { encoding: "base64", data: Buffer.from(value).toString("base64") };
  return String(value);
}

async function openReadonlyDatabase(root: string, relativePath: string): Promise<{
  db: DatabaseSync;
  cleanup(): Promise<void>;
} | null> {
  const filePath = await checkedPath(root, relativePath);
  if (!filePath) return null;
  const info = await fs.lstat(filePath);
  if (!info.isFile()) return null;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-migration-sqlite-"));
  const copyPath = path.join(tempDirectory, path.basename(relativePath));
  try {
    await fs.copyFile(filePath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = await checkedPath(root, relativePath + suffix);
      if (sidecar) await fs.copyFile(sidecar, copyPath + suffix);
    }
    const db = new DatabaseSync(copyPath, { readOnly: true });
    return {
      db,
      async cleanup() {
        try {
          db.close();
        } finally {
          await fs.rm(tempDirectory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function inspectSqlite(root: string, relativePath: string): Promise<SqliteTableInfo[]> {
  const opened = await openReadonlyDatabase(root, relativePath);
  if (!opened) return [];
  const { db } = opened;
  try {
    const tableRows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string | null }>;
    const shadowPrefixes = tableRows
      .filter(({ sql }) => sql?.toUpperCase().includes("USING FTS"))
      .map(({ name }) => `${name}_`);
    const visible = tableRows.filter(({ name }) => !shadowPrefixes.some((prefix) => name.startsWith(prefix)));
    return visible.map(({ name, sql }) => {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;
      return {
        name,
        sql,
        columns: columns.map((column): SqliteColumn => ({
          name: column.name,
          type: column.type,
          notNull: column.notnull === 1,
          primaryKey: column.pk > 0,
        })),
      };
    });
  } finally {
    await opened.cleanup();
  }
}

async function readSqliteTable(root: string, relativePath: string, table: string): Promise<SqliteRow[]> {
  const opened = await openReadonlyDatabase(root, relativePath);
  if (!opened) return [];
  const { db } = opened;
  try {
    const found = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!found) return [];
    const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sqliteValue(value)])));
  } finally {
    await opened.cleanup();
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 15_000,
    windowsHide: true,
    // `git status` can refresh and rewrite the index as an optimization. Migration
    // inspection must leave even Git's administrative files byte-for-byte alone.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function inspectGit(root: string): Promise<GitWorktreeInspection> {
  const fallback: GitWorktreeInspection = {
    repository: false,
    pendingCommitCount: 0,
    workingTreePaths: [],
    untrackedPaths: [],
    stagedPaths: [],
    blockers: [],
  };
  try {
    await git(root, ["rev-parse", "--show-toplevel"]);
  } catch {
    return fallback;
  }
  const state: GitWorktreeInspection = { ...fallback, repository: true };
  try {
    state.head = (await git(root, ["rev-parse", "HEAD"])).trim();
    state.branch = (await git(root, ["branch", "--show-current"])).trim() || undefined;
    try {
      state.upstream = (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim();
      state.upstreamCommit = (await git(root, ["rev-parse", "@{upstream}"])).trim();
      const commits = await git(root, ["rev-list", "--reverse", `${state.upstreamCommit}..${state.head}`]);
      state.pendingCommitCount = commits.split(/\r?\n/).filter((part) => /^[a-f0-9]{40,64}$/.test(part)).length;
    } catch {
      state.blockers.push("The current branch has no readable upstream; pending commits cannot be compared safely.");
    }
    const status = splitNul(await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]));
    for (let index = 0; index < status.length; index += 1) {
      const item = status[index]!;
      if (item.length < 4) continue;
      const code = item.slice(0, 2);
      let filePath = item.slice(3);
      state.workingTreePaths.push(filePath);
      if (code === "??") state.untrackedPaths.push(filePath);
      // The index status column includes additions and type changes as well as
      // modifications/deletions. `??` is an untracked worktree entry, not staged.
      if (code[0] !== " " && code[0] !== "?") state.stagedPaths.push(filePath);
      // Porcelain v1 -z emits a second NUL field for the old name of a rename/copy.
      if (code.includes("R") || code.includes("C")) {
        const previous = status[index + 1];
        if (previous) {
          state.workingTreePaths.push(previous);
          index += 1;
        }
      }
    }
    state.workingTreePaths = [...new Set(state.workingTreePaths)].sort();
    state.untrackedPaths = [...new Set(state.untrackedPaths)].sort();
    state.stagedPaths = [...new Set(state.stagedPaths)].sort();
  } catch (error) {
    state.blockers.push(`Git inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return state;
}

const MIGRATION_MANAGED_PATHS = new Set([
  "meta/speaker-corrections.jsonl",
  "meta/speaker-model.json",
  "meta/synonyms.yaml",
  "meta/candidate-ignore-list.yaml",
  "meta/contradiction-dismissals.jsonl",
  "meta/publish-episodes.yaml",
  "meta/speaker-rule-gates.json",
  ".arcadia/index.sqlite",
  ".arcadia/llm-model-settings.json",
  ".arcadia/nlp-feature-settings.json",
  ".arcadia/llm-usage.jsonl",
  ".arcadia/cover.jpg",
]);

function normalizeGitPath(value: string): string {
  const pathValue = value.replaceAll("\\", "/");
  assertProjectPath(pathValue);
  return pathValue;
}

async function readGitPendingFiles(
  root: string,
  inspection: GitWorktreeInspection,
): Promise<GitPendingFile[]> {
  if (!inspection.repository || !inspection.head) return [];
  const pending = new Set<string>();
  if (inspection.upstream && inspection.upstreamCommit) {
    const committed = splitNul(await git(root, ["diff", "--name-only", "--no-renames", "-z", `${inspection.upstreamCommit}..${inspection.head}`]));
    for (const value of committed) pending.add(normalizeGitPath(value));
  }

  // `git status -z` is the source of truth for staged, unstaged, deleted and untracked work.
  for (const value of inspection.workingTreePaths) pending.add(normalizeGitPath(value));

  const result: GitPendingFile[] = [];
  for (const relativePath of [...pending].sort((a, b) => a.localeCompare(b))) {
    if (MIGRATION_MANAGED_PATHS.has(relativePath) || relativePath.startsWith(".arcadia/")) continue;
    if (isSecretLegacyPath(relativePath)) {
      result.push({ path: relativePath, bytes: null, excluded: "secret" });
      continue;
    }
    const absolutePath = path.resolve(root, relativePath);
    const rootPath = path.resolve(root);
    if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) {
      throw new Error(`Git reported an unsafe source path: ${relativePath}`);
    }
    const source = await checkedPath(root, relativePath);
    if (!source) {
      result.push({ path: relativePath, bytes: null });
      continue;
    }
    const info = await fs.lstat(source);
    if (!info.isFile()) throw new Error(`Git pending path is not a regular file: ${relativePath}`);
    result.push({ path: relativePath, bytes: await fs.readFile(source) });
  }
  return result;
}

export function createLegacySourceReader(projectRoot: string, workspaceDataRoot?: string): LegacySourceReader {
  const project = path.resolve(projectRoot);
  const workspace = workspaceDataRoot ? path.resolve(workspaceDataRoot) : undefined;
  return {
    projectRoot: project,
    workspaceDataRoot: workspace,
    readProjectFile: (relativePath) => readFile(project, relativePath),
    listProjectFiles: (prefix) => listFiles(project, prefix),
    readWorkspaceFile: (relativePath) => readFile(workspace, relativePath),
    listWorkspaceFiles: (prefix) => listFiles(workspace, prefix),
    inspectSqlite: (relativePath) => inspectSqlite(project, relativePath),
    readSqliteTable: (relativePath, table) => readSqliteTable(project, relativePath, table),
    inspectWorkspaceSqlite: (relativePath) => workspace ? inspectSqlite(workspace, relativePath) : Promise.resolve([]),
    readWorkspaceSqliteTable: (relativePath, table) => workspace ? readSqliteTable(workspace, relativePath, table) : Promise.resolve([]),
    inspectGit: () => inspectGit(project),
    readGitPendingFiles: (inspection) => readGitPendingFiles(project, inspection ?? { repository: false, pendingCommitCount: 0, workingTreePaths: [], untrackedPaths: [], stagedPaths: [], blockers: [] }),
  };
}
