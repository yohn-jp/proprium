import type {
  CommitAuthor,
  CommitSummary,
  FileRevision,
  LocalGitError,
  LocalGitErrorCode,
  LocalGitRequest,
  LocalGitResponse,
  StatusEntry,
  DiffChange,
  WorkspaceIdentity,
} from "./protocol.js";
import { validateGitPath, validateWorkspaceIdentity } from "./protocol.js";

export { validateGitPath, validateWorkspaceIdentity } from "./protocol.js";
export type { CommitAuthor, CommitSummary, DiffChange, FileRevision, LocalGitError, LocalGitErrorCode, StatusEntry, WorkspaceIdentity };

type LocalGitCommand = LocalGitRequest extends infer Request
  ? Request extends { id: string; workspace: WorkspaceIdentity } ? Omit<Request, "id" | "workspace"> : never
  : never;

export class BrowserLocalGitError extends Error {
  constructor(readonly code: LocalGitErrorCode, message: string) {
    super(message);
    this.name = "BrowserLocalGitError";
  }
}

export interface LocalGitStatus {
  head: string | null;
  entries: StatusEntry[];
  localState: "draft" | "local-committed";
}

interface ReadResult { data: Uint8Array | null; oid: string | null; }

/** Host-only browser Git client. It never exposes the Worker filesystem or Git API. */
export class BrowserLocalGit {
  private worker: Worker;
  private readonly pending = new Map<string, { workspaceId: string; resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private uncertain: boolean;
  private readonly uncertaintyKey: string;

  constructor(private readonly workspace: WorkspaceIdentity) {
    validateWorkspaceIdentity(workspace);
    this.uncertaintyKey = `proprium.git.storage-unknown.${workspace.localWorkspaceId}`;
    this.uncertain = this.readUncertaintyMarker();
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("./git.worker.ts", import.meta.url), { type: "module", name: "proprium-local-git" });
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    return worker;
  }

  private readUncertaintyMarker(): boolean {
    try { return localStorage.getItem(this.uncertaintyKey) === "1"; }
    catch { return true; }
  }

  private markUncertain(): void {
    this.uncertain = true;
    try { localStorage.setItem(this.uncertaintyKey, "1"); }
    catch { /* Keep this instance fail-closed if local uncertainty cannot be persisted. */ }
  }

  private readonly onMessage = (event: MessageEvent<LocalGitResponse>): void => {
    const response = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.workspaceId !== response.workspaceId) {
      pending.reject(new BrowserLocalGitError("identity_mismatch", "Git worker response did not match the requested workspace."));
    } else if (response.error) {
      if (response.error.code === "storage_unknown") this.markUncertain();
      pending.reject(new BrowserLocalGitError(response.error.code, response.error.message));
    } else pending.resolve(response.result);
  };

  private readonly onError = (event: ErrorEvent): void => {
    const message = event.message || "Browser Git worker stopped unexpectedly.";
    if (this.pending.size) this.markUncertain();
    for (const entry of this.pending.values()) entry.reject(new BrowserLocalGitError("storage_unknown", message));
    this.pending.clear();
  };

  private call<T>(command: LocalGitCommand): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserLocalGitError("git_error", "This Browser Git session has been closed."));
    this.uncertain ||= this.readUncertaintyMarker();
    if (this.uncertain && command.operation !== "verify") {
      return Promise.reject(new BrowserLocalGitError("storage_unknown", "A previous local Git operation has an uncertain result. Verify browser storage before continuing."));
    }
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        workspaceId: this.workspace.localWorkspaceId,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ ...command, id, workspace: this.workspace } as LocalGitRequest);
    });
  }

  init(): Promise<{ head: string | null; branch: string; localState: "draft" | "local-committed" }> {
    return this.call({ operation: "init" });
  }

  async read(path: string): Promise<{ data: Uint8Array | null; revision: FileRevision }> {
    validateGitPath(path);
    const result = await this.call<ReadResult>({ operation: "read", path });
    return { data: result.data, revision: { oid: result.oid } };
  }

  async write(path: string, data: Uint8Array, expected: FileRevision): Promise<FileRevision> {
    validateGitPath(path);
    const result = await this.call<{ oid: string }>({ operation: "write", path, data, expected });
    return { oid: result.oid };
  }

  status(): Promise<LocalGitStatus> { return this.call({ operation: "status" }); }

  diff(): Promise<DiffChange[]> {
    return this.call({ operation: "diff" });
  }

  async verifyStorage(): Promise<{ verified: true; head: string | null; entries: StatusEntry[] }> {
    if (this.uncertain) {
      this.worker.removeEventListener("message", this.onMessage);
      this.worker.removeEventListener("error", this.onError);
      this.worker.terminate();
      this.worker = this.createWorker();
    }
    const result = await this.call<{ verified: true; head: string | null; entries: StatusEntry[] }>({ operation: "verify" });
    this.uncertain = false;
    try { localStorage.removeItem(this.uncertaintyKey); }
    catch { this.markUncertain(); }
    return result;
  }

  add(paths: string[], expectedHead: string | null): Promise<{ entries: StatusEntry[]; head: string | null }> {
    for (const path of paths) validateGitPath(path);
    return this.call({ operation: "add", paths, expectedHead });
  }

  commit(message: string, author: CommitAuthor, expectedHead: string | null): Promise<{ oid: string; head: string; localState: "draft" | "local-committed" }> {
    return this.call({ operation: "commit", message, author, expectedHead });
  }

  log(depth = 50): Promise<CommitSummary[]> { return this.call({ operation: "log", depth }); }

  branches(): Promise<{ current: string; branches: string[] }> { return this.call({ operation: "branches" }); }

  createBranch(name: string, expectedHead: string): Promise<{ branch: string; head: string | null }> {
    return this.call({ operation: "create-branch", name, expectedHead });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.terminate();
    if (this.pending.size) this.markUncertain();
    for (const entry of this.pending.values()) entry.reject(new BrowserLocalGitError("storage_unknown", "The Git worker was closed before the operation was confirmed."));
    this.pending.clear();
  }
}
