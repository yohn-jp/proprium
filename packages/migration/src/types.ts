import type {
  ChangeOperation,
  ModuleId,
  MutationCoordinator,
  RepositoryIdentity,
  SnapshotId,
  SnapshotReader,
} from "@scriptorium/contracts";

export type PersistenceCategory =
  | "authoritative"
  | "provisional"
  | "secret"
  | "derived"
  | "relocated";

export type MigrationDisposition =
  | "planned"
  | "deferred"
  | "excluded"
  | "rebuild"
  | "relocated"
  | "unchanged"
  | "conflict"
  | "blocked"
  | "preserved-unreadable"
  | "unclassified";

export interface MigrationEntry {
  producerId: string;
  source: string;
  category: PersistenceCategory;
  disposition: MigrationDisposition;
  target?: string;
  recordCount?: number;
  detail?: string;
}

/** A local-only recovery payload for state that must not be silently published. */
export interface MigrationRecoveryRecord {
  id: string;
  source: string;
  category: "provisional";
  content: string;
  encoding: "utf8" | "base64";
  detail: string;
}

export interface MigrationContribution {
  entries: MigrationEntry[];
  operations: ChangeOperation[];
  recovery: MigrationRecoveryRecord[];
}

export interface SqliteColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface SqliteTableInfo {
  name: string;
  sql: string | null;
  columns: SqliteColumn[];
}

export type SqliteValue =
  | null
  | string
  | number
  | boolean
  | { encoding: "base64"; data: string }
  | { encoding: "integer"; data: string };

export type SqliteRow = Record<string, SqliteValue>;

export interface GitWorktreeInspection {
  repository: boolean;
  branch?: string;
  upstream?: string;
  upstreamCommit?: string;
  head?: string;
  pendingCommitCount: number;
  workingTreePaths: string[];
  untrackedPaths: string[];
  stagedPaths: string[];
  blockers: string[];
}

export interface GitPendingFile {
  path: string;
  /** Final source checkout content, including uncommitted edits; null without `excluded` represents a deletion. */
  bytes: Buffer | null;
  /** Secret-like path: it was detected by name and its contents were not read. */
  excluded?: "secret";
}

export interface LegacySourceReader {
  readonly projectRoot: string;
  readonly workspaceDataRoot?: string;
  readProjectFile(path: string): Promise<Buffer | null>;
  listProjectFiles(prefix: string): Promise<string[]>;
  readWorkspaceFile(path: string): Promise<Buffer | null>;
  listWorkspaceFiles(prefix: string): Promise<string[]>;
  inspectSqlite(path: string): Promise<SqliteTableInfo[]>;
  readSqliteTable(path: string, table: string): Promise<SqliteRow[]>;
  inspectWorkspaceSqlite(path: string): Promise<SqliteTableInfo[]>;
  readWorkspaceSqliteTable(path: string, table: string): Promise<SqliteRow[]>;
  inspectGit(): Promise<GitWorktreeInspection>;
  readGitPendingFiles(inspection?: GitWorktreeInspection): Promise<GitPendingFile[]>;
}

export interface MigrationContext {
  source: LegacySourceReader;
  target: SnapshotReader;
  repository: RepositoryIdentity;
  snapshot: SnapshotId;
  enabledModules: ReadonlySet<ModuleId>;
  workspaceProjectId?: string;
}

export interface MigrationProducer {
  /** Stable name used in dry-run reports and deterministic operation IDs. */
  id: string;
  /** A producer for a disabled module is inspected and reported but emits no target writes. */
  moduleId?: ModuleId;
  inspect(context: MigrationContext): Promise<MigrationContribution>;
}

export interface MigrationProducerRegistryLike {
  list(): readonly MigrationProducer[];
}

export interface MigrationInspection {
  snapshot: SnapshotId;
  entries: MigrationEntry[];
  operations: ChangeOperation[];
  recovery: MigrationRecoveryRecord[];
  pendingWorkspace: GitWorktreeInspection;
}

export interface InspectLegacyOptions {
  sourceRoot: string;
  target: SnapshotReader;
  /** Explicit legacy /data root. No home directory or environment default is read implicitly. */
  workspaceDataRoot?: string;
  /** Old workspace project ID used only to select its share grant records. */
  workspaceProjectId?: string;
  enabledModules?: readonly ModuleId[];
  registry?: MigrationProducerRegistryLike;
}

export interface MigrationProposalInput {
  projectId: string;
  snapshot: SnapshotId;
  operations: ChangeOperation[];
}

export type MigrationProposalCoordinator = Pick<MutationCoordinator, "propose">;
