import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceIdentity } from "../git/protocol.js";
import { readRecentDocument, rememberRecentDocument, resolveRecentDocument, type RecentDocumentStorage } from "./recent-document.js";

const workspace: WorkspaceIdentity = {
  origin: "https://github.com",
  repositoryId: 12345,
  owner: "writer",
  repository: "novel",
  branch: "main",
  localWorkspaceId: "workspace12345678",
};

class MemoryStorage implements RecentDocumentStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("recent document preference survives a new Host instance and resumes only a current workspace file", () => {
  const storage = new MemoryStorage();
  rememberRecentDocument(workspace, "chapters/second-draft.md", storage);

  // A newly mounted Host reads the same storage record after reopening this workspace.
  assert.equal(readRecentDocument({ ...workspace }, storage), "chapters/second-draft.md");
  assert.equal(resolveRecentDocument(workspace, new Set(["chapters/second-draft.md"]), storage), "chapters/second-draft.md");
  assert.equal(resolveRecentDocument(workspace, ["README.md"], storage), null);
  assert.equal(readRecentDocument({ ...workspace, branch: "draft-branch" }, storage), null);
});

test("recent document storage rejects unsafe paths and cannot cross local workspace identities", () => {
  const storage = new MemoryStorage();
  rememberRecentDocument(workspace, "../outside.md", storage);
  assert.equal(readRecentDocument(workspace, storage), null);

  rememberRecentDocument(workspace, "chapters/first.md", storage);
  assert.equal(readRecentDocument({ ...workspace, localWorkspaceId: "workspace87654321" }, storage), null);
});
