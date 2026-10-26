import { BrowserLocalGit } from "./index.js";
import type { WorkspaceIdentity } from "./protocol.js";
import { BrowserGitSnapshotPort } from "./authoring-snapshot-port.js";
import { AuthoringSnapshotReader, type AuthoringScope } from "../authoring/snapshots.js";

declare global {
  interface Window {
    browserGitTest: {
      open(localWorkspaceId: string, changes?: Partial<WorkspaceIdentity>): BrowserLocalGit;
      openAuthoringSession(localWorkspaceId: string): {
        git: BrowserLocalGit;
        reader: AuthoringSnapshotReader;
        scope: AuthoringScope;
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
