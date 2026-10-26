import assert from "node:assert/strict";
import test from "node:test";
import type { RepositoryIdentity } from "@scriptorium/contracts";
import type { JournalEntry } from "../../../storage/journal.js";
import type { WorkspaceIdentity } from "../git/protocol.js";
import { documentKey, repositoryKey } from "../../../storage/journal.js";
import { discoverWorkspaceDrafts, draftBaseMatches, journalRepositoryForWorkspace } from "./workspace-drafts.js";

const workspace: WorkspaceIdentity = {
  origin: "https://github.com",
  repositoryId: 12345,
  owner: "writer",
  repository: "novel",
  branch: "main",
  localWorkspaceId: "workspace12345678",
};
const repo = journalRepositoryForWorkspace(workspace);

function protectedDraft(path: string, text: string, revision: string | null, authorScope = "writer@example.test", repository = repo): JournalEntry {
  const owner = repositoryKey(repository);
  const entry: JournalEntry = {
    version: 1,
    key: `entry:${path}:${authorScope}`,
    repositoryKey: owner,
    documentKey: documentKey(repository, path),
    authorScope,
    repository,
    documentPath: path,
    sceneId: path,
    snapshot: { repository, remoteCommit: "" },
    text,
    baseText: "",
    operation: {
      id: `draft:${path}`,
      generation: 1,
      repository,
      baseRemoteCommit: "",
      effect: "manuscript",
      reads: [{ path, revision }],
      writes: [{ path, revision, content: text }],
      message: `Draft ${path}`,
    },
    state: "draft",
    updatedAt: 100,
  };
  return entry;
}

test("workspace draft discovery includes protected paths missing from the Git worktree and applies scope guards", () => {
  const untracked = protectedDraft("chapters/second-draft.md", "Protected text", null);
  const otherAuthor = protectedDraft("chapters/private.md", "Other author", null, "other@example.test");
  const otherWorkspace = { ...repo, ownerScope: "different-local-clone" } satisfies RepositoryIdentity;
  const otherRepository = protectedDraft("chapters/other.md", "Other workspace", null, "writer@example.test", otherWorkspace);

  const discovered = discoverWorkspaceDrafts([untracked, otherAuthor, otherRepository], workspace, "writer@example.test");
  const worktreePaths = new Set(["README.md"]);
  assert.deepEqual(discovered.map((entry) => entry.documentPath), ["chapters/second-draft.md"]);
  assert.equal(worktreePaths.has(discovered[0]!.documentPath), false, "the protected draft remains discoverable when Git has no file at that path");
});

test("draft recovery checks exact base bytes, including an expected absent path", async () => {
  const absent = protectedDraft("chapters/new.md", "New draft", null);
  assert.equal(await draftBaseMatches(absent, null), true);
  assert.equal(await draftBaseMatches(absent, new TextEncoder().encode("a file appeared")), false);

  const base = new TextEncoder().encode("original base");
  const digest = await crypto.subtle.digest("SHA-256", base);
  const revision = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const existing = protectedDraft("chapters/saved.md", "Edited draft", revision);
  assert.equal(await draftBaseMatches(existing, base), true);
  assert.equal(await draftBaseMatches(existing, new TextEncoder().encode("changed base")), false);
});

