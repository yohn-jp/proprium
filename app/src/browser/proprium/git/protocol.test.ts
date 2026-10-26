import assert from "node:assert/strict";
import test from "node:test";
import { isGitHubWorkspaceIdentity, validateWorkspaceIdentity, type LocalWorkspaceIdentity, type WorkspaceIdentity } from "./protocol.js";

const localIdentity: LocalWorkspaceIdentity = {
  provider: "local",
  name: "Draft workspace",
  branch: "main",
  localWorkspaceId: "local-1234567890abcdef",
};

test("validates an explicit local identity without a GitHub repository ID", () => {
  assert.doesNotThrow(() => validateWorkspaceIdentity(localIdentity));
  assert.equal(isGitHubWorkspaceIdentity(localIdentity), false);
});

test("keeps legacy GitHub identities bound to positive immutable repository IDs", () => {
  const github: WorkspaceIdentity = {
    origin: "https://github.com",
    repositoryId: 823456789,
    owner: "proprium-test",
    repository: "generic-files",
    branch: "main",
    localWorkspaceId: "gh-1234567890abcdef",
  };
  assert.doesNotThrow(() => validateWorkspaceIdentity(github));
  assert.equal(isGitHubWorkspaceIdentity(github), true);
  assert.throws(() => validateWorkspaceIdentity({ ...github, repositoryId: 0 }));
});

test("rejects local identities that try to claim GitHub identity fields", () => {
  assert.throws(() => validateWorkspaceIdentity({
    ...localIdentity,
    repositoryId: 823456789,
  } as WorkspaceIdentity));
});
