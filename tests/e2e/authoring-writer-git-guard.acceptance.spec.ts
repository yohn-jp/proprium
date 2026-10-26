import { expect, test } from "@playwright/test";
import type { BrowserLocalGit } from "../../app/src/browser/proprium/git/index.js";
import type { ChangeWriter, WriterScope } from "../../app/src/browser/proprium/authoring/writer.js";

declare global {
  interface Window {
    browserGitTest: {
      open(localWorkspaceId: string): BrowserLocalGit;
      openWriterSession(localWorkspaceId: string, databaseName?: string): { git: BrowserLocalGit; writer: ChangeWriter; scope: WriterScope };
    };
  }
}

test("Browser Git reasserts the authoring generation inside its sole writer lock", async ({ page }) => {
  const workspaceId = `writer-guard-${crypto.randomUUID()}`;
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");

  const result = await page.evaluate(async id => {
    const git = window.browserGitTest.open(id);
    await git.init();
    const pinned = await git.pinAuthoringSnapshot();
    await git.applyChanges([{ path: "outside.md", content: new TextEncoder().encode("concurrent"), expectedRevision: { oid: null } }]);
    let staleCode = "none";
    try {
      await git.applyChanges(
        [{ path: "proposal.md", content: new TextEncoder().encode("approved"), expectedRevision: { oid: null } }],
        [{ path: "proposal.md", revision: { oid: null } }],
        pinned.snapshot_id,
      );
    } catch (error) { staleCode = (error as { code?: string }).code ?? "unknown"; }

    const current = await git.pinAuthoringSnapshot();
    const applied = await git.applyChanges(
      [{ path: "proposal.md", content: new TextEncoder().encode("approved"), expectedRevision: { oid: null } }],
      [{ path: "proposal.md", revision: { oid: null } }],
      current.snapshot_id,
    );
    const stored = await git.read("proposal.md");
    git.close();
    return { staleCode, appliedCount: applied.length, stored: new TextDecoder().decode(stored.data!) };
  }, workspaceId);

  expect(result.staleCode).toBe("snapshot_stale");
  expect(result.appliedCount).toBe(1);
  expect(result.stored).toBe("approved");
});

test("Host proposal receipt survives page reload and applies through Browser Git", async ({ page }) => {
  const workspaceId = `writer-reload-${crypto.randomUUID()}`;
  const databaseName = `writer-receipt-${crypto.randomUUID()}`;
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");

  const proposalId = await page.evaluate(async ({ workspaceId, databaseName }) => {
    const { git, writer, scope } = window.browserGitTest.openWriterSession(workspaceId, databaseName);
    await git.init();
    const pinned = await git.pinAuthoringSnapshot();
    const sourcePayload = new TextEncoder().encode('{"termId":"term-1"}');
    const digest = async (data: Uint8Array) => {
      const value = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const termBytes = new TextEncoder().encode('{"schemaVersion":1,"terms":[{"id":"term-1","canonical":"term"}]}');
    const payloadObject = { termId: "term-1" };
    const caller = {
      caller: "ui" as const,
      producer_plugin_id: "proprium.research",
      action_id: "proprium.research.terms.propose",
      scope,
      idempotency_key: "writer-reload-key",
      request_digest: await digest(sourcePayload),
      source_payload: sourcePayload,
    };
    const result = await writer.propose({
      id: "guest-change-id",
      idempotency_key: caller.idempotency_key,
      scope,
      snapshot: { id: pinned.snapshot_id, local_commit: pinned.local_commit, worktree_generation: pinned.worktree_generation, draft_generation: null },
      title: "Register term",
      reason: "Browser persistence acceptance",
      read_set: [{ path: "meta/terms.json", revision: null }],
      units: [{ id: "term", label: "Register term", depends_on: [], operations: [{ id: "register", kind: "create", path: "meta/terms.json", expected_revision: null, content: termBytes }] }],
      evidence: [],
      source_payload: payloadObject,
      source_payload_digest: await digest(new TextEncoder().encode('{"termId":"term-1"}')),
    }, caller, [{ path: "meta/terms.json", revision: null }]);
    git.close();
    return result.proposal_id;
  }, { workspaceId, databaseName });

  await page.reload();
  await expect(page.locator("#ready")).toHaveText("ready");
  const receipt = await page.evaluate(async ({ workspaceId, databaseName, proposalId }) => {
    const { git, writer, scope } = window.browserGitTest.openWriterSession(workspaceId, databaseName);
    await git.init();
    const before = await writer.status(scope, proposalId);
    const after = await writer.apply(scope, proposalId, ["term"], "ui", true);
    const stored = await git.read("meta/terms.json");
    git.close();
    return { before: before.status, after: after.status, stored: new TextDecoder().decode(stored.data!) };
  }, { workspaceId, databaseName, proposalId });

  expect(receipt.before).toBe("proposed");
  expect(receipt.after).toBe("applied");
  expect(receipt.stored).toContain("term-1");
});
