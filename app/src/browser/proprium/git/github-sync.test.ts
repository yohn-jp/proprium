import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubSyncClient, GitHubSyncError } from "./github-sync.js";

const head = { repositoryId: 12345, branch: "main", head: null };

test("Host credential stays in memory and sign-out clears the sync session", async () => {
  let supplied = "";
  const client = createGitHubSyncClient("ghp_fixture_token", async <T>(_kind: "remote-head" | "remote-fetch" | "remote-pull" | "remote-publish", token: string) => {
    supplied = token;
    return head as T;
  });
  assert.deepEqual(await client.remoteHead(), head);
  assert.equal(supplied, "ghp_fixture_token");
  client.signOut();
  await assert.rejects(client.remoteHead(), (error: unknown) => error instanceof GitHubSyncError && error.code === "authentication_required");
});
