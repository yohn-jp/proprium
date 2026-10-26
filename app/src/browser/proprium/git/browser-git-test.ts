import { BrowserLocalGit } from "./index.js";
import type { WorkspaceIdentity } from "./protocol.js";
import { BrowserGitSnapshotPort } from "./authoring-snapshot-port.js";
import { AuthoringSnapshotReader, type AuthoringScope } from "../authoring/snapshots.js";
import { ChangeWriter, type WriterScope } from "../authoring/writer.js";
import { IndexedDbWriterJournalStore } from "../authoring/store.js";
import { BrowserGitWriterWorkspace } from "../authoring/writer-browser.js";

declare global {
  interface Window {
    browserGitTest: {
      open(localWorkspaceId: string, changes?: Partial<WorkspaceIdentity>): BrowserLocalGit;
      openAuthoringSession(localWorkspaceId: string): {
        git: BrowserLocalGit;
        reader: AuthoringSnapshotReader;
        scope: AuthoringScope;
      };
      openWriterSession(localWorkspaceId: string, databaseName?: string): {
        git: BrowserLocalGit;
        writer: ChangeWriter;
        scope: WriterScope;
      };
      holdLock(localWorkspaceId: string): Promise<boolean>;
      releaseLock(): void;
    };
    releaseBrowserGitLock?: () => void;
  }
}

window.browserGitTest = {
  open(localWorkspaceId, changes = {}) {
    return new BrowserLocalGit({
      origin: window.location.origin,
      repositoryId: 923456789,
      owner: "proprium-test",
      repository: "browser-git-fixture",
      branch: "main",
      localWorkspaceId,
      ...changes,
    });
  },
  openAuthoringSession(localWorkspaceId) {
    const workspace: WorkspaceIdentity = {
      origin: window.location.origin,
      repositoryId: 923456789,
      owner: "proprium-test",
      repository: "browser-git-fixture",
      branch: "main",
      localWorkspaceId,
    };
    const git = new BrowserLocalGit(workspace);
    const scope: AuthoringScope = {
      workspace_id: localWorkspaceId,
      repository_id: workspace.repositoryId,
      branch: workspace.branch,
      generation: "browser-git-test-generation",
    };
    return { git, reader: new AuthoringSnapshotReader(new BrowserGitSnapshotPort(git, workspace)), scope };
  },
  openWriterSession(localWorkspaceId, databaseName = "proprium-authoring-writer-browser-test") {
    const workspace: WorkspaceIdentity = {
      origin: window.location.origin,
      repositoryId: 923456789,
      owner: "proprium-test",
      repository: "browser-git-fixture",
      branch: "main",
      localWorkspaceId,
    };
    const git = new BrowserLocalGit(workspace);
    const scope: WriterScope = {
      workspace_id: localWorkspaceId,
      repository_id: workspace.repositoryId,
      branch: workspace.branch,
      generation: "browser-git-test-generation",
    };
    const writer = new ChangeWriter({
      journal: new IndexedDbWriterJournalStore(databaseName),
      workspace: new BrowserGitWriterWorkspace(git, workspace, {
        selected_scope: () => scope,
        is_editor_dirty: () => false,
        with_editor_write_guard: async (_scope, operation) => operation(),
      }),
      new_proposal_id: () => crypto.randomUUID(),
    });
    return { git, writer, scope };
  },
  async holdLock(localWorkspaceId) {
    const input = new TextEncoder().encode(localWorkspaceId);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    const id = Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("");
    return new Promise<boolean>((resolve) => {
      void navigator.locks.request(`proprium-workspace-${id}`, { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) return resolve(false);
        resolve(true);
        await new Promise<void>((release) => { window.releaseBrowserGitLock = release; });
      });
    });
  },
  releaseLock() {
    window.releaseBrowserGitLock?.();
    window.releaseBrowserGitLock = undefined;
  },
};
document.querySelector("#ready")!.textContent = "ready";
