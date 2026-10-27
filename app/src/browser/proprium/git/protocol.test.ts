import assert from "node:assert/strict";
import test from "node:test";
import { isGitHubWorkspaceIdentity, isValidGitBranchName, validateWorkspaceIdentity, type LocalWorkspaceIdentity, type WorkspaceIdentity } from "./protocol.js";

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

test("accepts legal plus branch names but blocks unsafe Git refnames", () => {
  for (const branch of ["feature+draft", "fix/topic.v2", "release_01"]) {
    assert.equal(isValidGitBranchName(branch), true);
    assert.doesNotThrow(() => validateWorkspaceIdentity({ ...localIdentity, branch }));
  }
  for (const branch of ["../token", "x//y", "x.lock/y", "name@{0", "a:secret", "ends.", "-option"]) {
    assert.equal(isValidGitBranchName(branch), false);
    assert.throws(() => validateWorkspaceIdentity({ ...localIdentity, branch }));
  }
});
