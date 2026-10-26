import { expect, test } from "@playwright/test";
import type { BrowserLocalGit } from "../../app/src/browser/proprium/git/index.js";
import type { ChangeWriter, WriterScope } from "../../app/src/browser/proprium/authoring/writer.js";

declare global {
  interface Window {
    browserGitTest: {
      open(localWorkspaceId: string): BrowserLocalGit;
      openWriterSession(localWorkspaceId: string, databaseName?: string): { git: BrowserLocalGit; writer: ChangeWriter; writer_workspace: import("../../app/src/browser/proprium/authoring/writer-browser.js").BrowserGitWriterWorkspace; scope: WriterScope };
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

test("partial multi-file unit is restored from its persisted WAL after reload before retry", async ({ page }) => {
  const workspaceId = `writer-partial-${crypto.randomUUID()}`;
  const databaseName = `writer-partial-receipt-${crypto.randomUUID()}`;
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");

  const interrupted = await page.evaluate(async ({ workspaceId, databaseName }) => {
    const { git, writer, writer_workspace, scope } = window.browserGitTest.openWriterSession(workspaceId, databaseName);
    await git.init();
    const beforeOne = new TextEncoder().encode("before one\r\n");
    const beforeTwo = new TextEncoder().encode("before two\r\n");
    const afterOne = new TextEncoder().encode("after one\r\n");
    const afterTwo = new TextEncoder().encode("after two\r\n");
    const hash = async (data: Uint8Array) => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
      return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    };
    const source = new TextEncoder().encode('{"operation":"multi-file"}');
    await git.write("meta/one.json", beforeOne, { oid: null });
    await git.write("meta/two.json", beforeTwo, { oid: null });
    const pinned = await git.pinAuthoringSnapshot();
    const change = await writer.propose({
      id: "guest-multi-file-change",
      idempotency_key: "partial-multi-file-recovery",
      scope,
      snapshot: { id: pinned.snapshot_id, local_commit: pinned.local_commit, worktree_generation: pinned.worktree_generation, draft_generation: null },
      title: "Update two files",
      reason: "Exercise a real interrupted Browser Git unit",
      read_set: [
        { path: "meta/one.json", revision: await hash(beforeOne) },
        { path: "meta/two.json", revision: await hash(beforeTwo) },
      ],
      units: [{
        id: "multi-file",
        label: "Update both files",
        depends_on: [],
        operations: [
          { id: "one", kind: "replace", path: "meta/one.json", expected_revision: await hash(beforeOne), content: afterOne },
          { id: "two", kind: "replace", path: "meta/two.json", expected_revision: await hash(beforeTwo), content: afterTwo },
        ],
      }],
      evidence: [],
      source_payload: { operation: "multi-file" },
      source_payload_digest: await hash(new TextEncoder().encode('{"operation":"multi-file"}')),
    }, {
      caller: "ui",
      producer_plugin_id: "proprium.research",
      action_id: "proprium.research.terms.propose",
      scope,
      idempotency_key: "partial-multi-file-recovery",
      source_payload: source,
      request_digest: await hash(source),
    }, [
      { path: "meta/one.json", revision: await hash(beforeOne) },
      { path: "meta/two.json", revision: await hash(beforeTwo) },
    ]);

    const actualApply = writer_workspace.apply_changes.bind(writer_workspace);
    let injected = false;
    writer_workspace.apply_changes = async (targetScope, changes, readSet, expectedSnapshot, recovery) => {
      if (!injected && !recovery) {
        injected = true;
        await actualApply(targetScope, [changes[0]!], readSet, expectedSnapshot, false);
        throw Object.assign(new Error("Injected lost Browser Git response after the first persisted file."), { code: "storage_unknown" });
      }
      return actualApply(targetScope, changes, readSet, expectedSnapshot, recovery);
    };
    let applyCode = "none";
    try { await writer.apply(scope, change.proposal_id, ["multi-file"], "ui", true); }
    catch (error) { applyCode = (error as { code?: string }).code ?? "unknown"; }
    let blockedWriteCode = "none";
    try { await git.write("meta/other.json", new TextEncoder().encode("blocked"), { oid: null }); }
    catch (error) { blockedWriteCode = (error as { code?: string }).code ?? "unknown"; }
    git.close();
    return { proposalId: change.proposal_id, applyCode, blockedWriteCode, injected };
  }, { workspaceId, databaseName });

  expect(interrupted.injected).toBe(true);
  expect(interrupted.applyCode).toBe("storage_unknown");
  expect(interrupted.blockedWriteCode).toBe("storage_unknown");

  await page.reload();
  await expect(page.locator("#ready")).toHaveText("ready");
  const recovered = await page.evaluate(async ({ workspaceId, databaseName, proposalId }) => {
    const { git, writer, scope } = window.browserGitTest.openWriterSession(workspaceId, databaseName);
    await git.verifyStorage();
    const beforeRecoveryOne = new TextDecoder().decode((await git.read("meta/one.json")).data!);
    const beforeRecoveryTwo = new TextDecoder().decode((await git.read("meta/two.json")).data!);
    let blockedWriteCode = "none";
    try { await git.write("meta/other.json", new TextEncoder().encode("blocked"), { oid: null }); }
    catch (error) { blockedWriteCode = (error as { code?: string }).code ?? "unknown"; }
    const recoveryReceipt = await writer.recover(scope);
    const afterRecoveryOne = new TextDecoder().decode((await git.read("meta/one.json")).data!);
    const afterRecoveryTwo = new TextDecoder().decode((await git.read("meta/two.json")).data!);
    const afterRetry = await writer.apply(scope, proposalId, ["multi-file"], "ui", true);
    const finalOne = new TextDecoder().decode((await git.read("meta/one.json")).data!);
    const finalTwo = new TextDecoder().decode((await git.read("meta/two.json")).data!);
    let unblockedWriteCode = "none";
    try { await git.write("meta/other.json", new TextEncoder().encode("allowed"), { oid: null }); }
    catch (error) { unblockedWriteCode = (error as { code?: string }).code ?? "unknown"; }
    git.close();
    return { beforeRecoveryOne, beforeRecoveryTwo, blockedWriteCode, recoveryStatus: recoveryReceipt?.status, afterRecoveryOne, afterRecoveryTwo, finalStatus: afterRetry.status, finalOne, finalTwo, unblockedWriteCode };
  }, { workspaceId, databaseName, proposalId: interrupted.proposalId });

  expect(recovered.beforeRecoveryOne).toBe("after one\r\n");
  expect(recovered.beforeRecoveryTwo).toBe("before two\r\n");
  expect(recovered.blockedWriteCode).toBe("storage_unknown");
  expect(recovered.recoveryStatus).toBe("proposed");
  expect(recovered.afterRecoveryOne).toBe("before one\r\n");
  expect(recovered.afterRecoveryTwo).toBe("before two\r\n");
  expect(recovered.finalStatus).toBe("applied");
  expect(recovered.finalOne).toBe("after one\r\n");
  expect(recovered.finalTwo).toBe("after two\r\n");
  expect(recovered.unblockedWriteCode).toBe("none");
});
