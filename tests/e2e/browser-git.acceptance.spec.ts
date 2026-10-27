import { expect, test } from "@playwright/test";
import type { BrowserLocalGit } from "../../app/src/browser/proprium/git/index.js";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/protocol.js";

declare global {
  interface Window {
    browserGitTest: {
      open(localWorkspaceId: string, changes?: Partial<WorkspaceIdentity>): BrowserLocalGit;
      openRegistryStore(): import("../../app/src/browser/proprium/plugins/store.js").IndexedDbPluginStore;
      holdLock(localWorkspaceId: string): Promise<boolean>;
      releaseLock(): void;
    };
  }
}

const workspaceId = () => `pw-${crypto.randomUUID()}`;

test("separate browser tabs cannot roll back an observed signed registry pointer", async ({ page, context }) => {
  const second = await context.newPage();
  try {
    await Promise.all([page.goto("/browser-git-test.html"), second.goto("/browser-git-test.html")]);
    await Promise.all([expect(page.locator("#ready")).toHaveText("ready"), expect(second.locator("#ready")).toHaveText("ready")]);
    const id = crypto.randomUUID();
    const url = `https://registry.example.test/${id}/registry.json`;
    const stateKey = `latest-observed-${id}`;
    // This exercises the real IndexedDB transaction after signed admission.
    // Signature admission itself is covered by manager tests, not mocked here.
    const advance = (target: typeof page, version: string, key: string) =>
      target.evaluate(async ({ url, version, key }) => {
        const store = window.browserGitTest.openRegistryStore();
        const document = { schema: "proprium.registry/v1" as const, id: "fixture.registry", version,
          artifactBase: "https://assets.example.test/", plugins: [] };
        const bytes = new TextEncoder().encode(JSON.stringify(document));
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const digest = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
        await store.advanceRegistry({ url, bytes, signature: new Uint8Array(64), digest, document }, key);
        return digest;
      }, { url, version, key });
    const latest = await advance(page, "1.0.2", stateKey);
    await expect(advance(second, "1.0.1", stateKey)).rejects.toThrow(/rollback/i);
    const observed = await second.evaluate(async key => window.browserGitTest.openRegistryStore().getState(key), stateKey);
    expect(observed).toBe(latest);

    const concurrentKey = `${stateKey}-concurrent`;
    const [older, newer] = await Promise.allSettled([
      advance(page, "1.0.1", concurrentKey),
      advance(second, "1.0.2", concurrentKey),
    ]);
    expect(newer.status).toBe("fulfilled");
    expect(older.status === "fulfilled" || older.reason instanceof Error).toBe(true);
    const raced = await page.evaluate(async key => window.browserGitTest.openRegistryStore().getState(key), concurrentKey);
    expect(raced).toBe(latest);
  } finally {
    await second.close();
  }
});

test("Worker Git commits preserve exact SHAs and binary bytes across a page restart", async ({ page }) => {
  const id = workspaceId();
  await page.route("**/git.worker.ts*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const workerStart = /const\s+scope\s*=\s*self(?:\s+as\s+DedicatedWorkerGlobalScope)?;/u;
    if (!workerStart.test(source)) throw new Error("The Browser Git worker clock fixture could not find the worker entry point.");
    const frozenClock = `const NativeDate = Date;
class FrozenDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [1700000000000])); }
  static now() { return 1700000000000; }
}
globalThis.Date = FrozenDate;
`;
    await route.fulfill({ response, body: source.replace(workerStart, (entry) => `${frozenClock}${entry}`) });
  });
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const first = await page.evaluate(async (workspaceId) => {
    const git = window.browserGitTest.open(workspaceId);
    const initialized = await git.init();
    const firstText = new TextEncoder().encode("one\n");
    const firstFile = await git.write("notes/日記.md", firstText, { oid: null });
    await git.add(["notes/日記.md"], initialized.head);
    const firstCommit = await git.commit("first", { name: "Browser Git", email: "browser@example.test" }, initialized.head);
    return { firstFile, firstCommit, status: await git.status() };
  }, id);
  expect(first.firstCommit.oid).toMatch(/^[a-f0-9]{40}$/u);
  expect(first.firstCommit.head).toBe(first.firstCommit.oid);
  expect(first.status.localState).toBe("local-committed");

  const second = await page.evaluate(async ({ workspaceId, expectedHead }) => {
    const git = window.browserGitTest.open(workspaceId);
    const text = await git.read("notes/日記.md");
    const bytes = new Uint8Array([0, 255, 128, 1, 13, 10]);
    await git.write("notes/日記.md", new TextEncoder().encode("two\n"), text.revision);
    await git.write("assets/sample.bin", bytes, { oid: null });
    const remaining = await git.write("draft.txt", new TextEncoder().encode("still draft"), { oid: null });
    const temporary = await git.write("remove-me.txt", new TextEncoder().encode("temporary"), { oid: null });
    const listedBeforeDelete = await git.listFiles();
    await git.delete("remove-me.txt", temporary);
    const listedAfterDelete = await git.listFiles();
    let staleDelete = "none";
    try { await git.delete("remove-me.txt", temporary); }
    catch (error) { staleDelete = (error as { code?: string }).code ?? "unknown"; }
    const diff = await git.diff();
    const preCommitStatus = await git.status();
    const binary = diff.find((entry) => entry.path === "assets/sample.bin");
    const binaryRoundTrip = binary?.worktreeFile?.data ? Array.from(binary.worktreeFile.data) : null;
    const textDiff = diff.find((entry) => entry.path === "notes/日記.md");
    const textDiffBytes = {
      head: textDiff?.headFile?.data ? Array.from(textDiff.headFile.data) : null,
      worktree: textDiff?.worktreeFile?.data ? Array.from(textDiff.worktreeFile.data) : null,
    };
    await git.add(["notes/日記.md", "assets/sample.bin"], expectedHead);
    const secondCommit = await git.commit("second", { name: "Browser Git", email: "browser@example.test" }, expectedHead);
    const status = await git.status();
    const log = await git.log();
    const branch = await git.createBranch("review", secondCommit.oid);
    git.close();
    return { secondCommit, status, log, branch, binaryRoundTrip, textDiffBytes, diffPaths: diff.map((entry) => entry.path), preCommitStatus, remaining, listedBeforeDelete, listedAfterDelete, staleDelete };
  }, { workspaceId: id, expectedHead: first.firstCommit.oid });
  expect(second.secondCommit.oid).toMatch(/^[a-f0-9]{40}$/u);
  expect(second.secondCommit.oid).not.toBe(first.firstCommit.oid);
  expect(second.secondCommit.localState).toBe("draft");
  expect(second.status.localState).toBe("draft");
  expect(second.status.entries.map((entry) => entry.path)).toEqual(["draft.txt"]);
  expect(second.log.map((entry) => entry.oid)).toEqual([second.secondCommit.oid, first.firstCommit.oid]);
  expect(second.branch).toEqual({ branch: "review", head: second.secondCommit.oid });
  expect(second.binaryRoundTrip).toEqual([0, 255, 128, 1, 13, 10]);
  expect(second.preCommitStatus.entries.map((entry) => entry.path)).toContain("notes/日記.md");
  expect(second.listedBeforeDelete.map((entry) => entry.path)).toContain("remove-me.txt");
  expect(second.listedAfterDelete.map((entry) => entry.path)).not.toContain("remove-me.txt");
  expect(second.staleDelete).toBe("revision_conflict");
  expect(second.diffPaths).toContain("notes/日記.md");
  expect(second.textDiffBytes).toEqual({ head: Array.from(new TextEncoder().encode("one\n")), worktree: Array.from(new TextEncoder().encode("two\n")) });

  await page.reload();
  const restored = await page.evaluate(async (workspaceId) => {
    const git = window.browserGitTest.open(workspaceId);
    const initialized = await git.init();
    const verification = await git.verifyStorage();
    const log = await git.log();
    const read = await git.read("assets/sample.bin");
    const branches = await git.branches();
    git.close();
    return { initialized, verification, log, binary: read.data ? Array.from(read.data) : null, branches };
  }, id);
  expect(restored.initialized.head).toBe(second.secondCommit.oid);
  expect(restored.initialized.localState).toBe("draft");
  expect(restored.verification).toMatchObject({ verified: true, head: second.secondCommit.oid });
  expect(restored.log.map((entry) => entry.oid)).toEqual([second.secondCommit.oid, first.firstCommit.oid]);
  expect(restored.binary).toEqual([0, 255, 128, 1, 13, 10]);
  expect(restored.branches).toEqual({ current: "main", branches: ["main", "review"] });
});

test("history diffs compare against the first parent and restore only guarded worktree paths", async ({ page }) => {
  const id = workspaceId();
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async (workspaceId) => {
    const git = window.browserGitTest.open(workspaceId);
    const initialized = await git.init();
    const first = await git.write("notes.md", new TextEncoder().encode("first version\n"), { oid: null });
    const removed = await git.write("remove.txt", new TextEncoder().encode("present in first commit\n"), { oid: null });
    const binary = await git.write("image.bin", new Uint8Array([0, 255, 1]), { oid: null });
    await git.add(["notes.md", "remove.txt", "image.bin"], initialized.head);
    const firstCommit = await git.commit("first", { name: "History Test", email: "history@example.test" }, initialized.head);
    const firstDiff = await git.commitDiff(firstCommit.oid);

    const noteBeforeSecond = await git.read("notes.md");
    const binaryBeforeSecond = await git.read("image.bin");
    await git.write("notes.md", new TextEncoder().encode("second version\n"), noteBeforeSecond.revision);
    await git.write("image.bin", new Uint8Array([0, 255, 2, 3]), binaryBeforeSecond.revision);
    await git.delete("remove.txt", removed);
    await git.write("new.txt", new TextEncoder().encode("added in second\n"), { oid: null });
    await git.add(["notes.md", "image.bin", "remove.txt", "new.txt"], firstCommit.head);
    const secondCommit = await git.commit("second", { name: "History Test", email: "history@example.test" }, firstCommit.head);
    const secondDiff = await git.commitDiff(secondCommit.oid);

    const noteBeforeThird = await git.read("notes.md");
    const deletedPath = await git.read("remove.txt");
    const newBeforeThird = await git.read("new.txt");
    await git.write("notes.md", new TextEncoder().encode("third version\n"), noteBeforeThird.revision);
    await git.write("remove.txt", new TextEncoder().encode("reborn after second commit\n"), deletedPath.revision);
    await git.write("new.txt", new TextEncoder().encode("changed after second commit\n"), newBeforeThird.revision);
    await git.add(["notes.md", "remove.txt", "new.txt"], secondCommit.head);
    const thirdCommit = await git.commit("third", { name: "History Test", email: "history@example.test" }, secondCommit.head);

    const selected = await git.commitDiff(secondCommit.oid);
    const changes = await Promise.all(selected.changes.map(async (change) => ({
      path: change.path,
      content: change.commitFile?.data ?? null,
      expectedRevision: (await git.read(change.path)).revision,
    })));
    await git.applyChanges(changes);
    const restored = {
      note: (await git.read("notes.md")).data,
      removed: (await git.read("remove.txt")).data,
      added: (await git.read("new.txt")).data,
    };

    const stale = await git.read("notes.md");
    await git.write("notes.md", new TextEncoder().encode("concurrent edit\n"), stale.revision);
    let staleRestore = "none";
    try {
      await git.applyChanges([{ path: "notes.md", content: new TextEncoder().encode("second version\n"), expectedRevision: stale.revision }]);
    } catch (error) { staleRestore = (error as { code?: string }).code ?? "unknown"; }
    const afterConflict = await git.read("notes.md");
    const finalStatus = await git.status();
    git.close();
    return {
      first: { parentOid: firstDiff.parentOid, paths: firstDiff.changes.map((change) => [change.path, change.kind]) },
      second: { parentOid: secondDiff.parentOid, paths: secondDiff.changes.map((change) => [change.path, change.kind]) },
      expectedParents: [firstCommit.oid, secondCommit.oid],
      currentHead: thirdCommit.oid,
      restored: Object.fromEntries(Object.entries(restored).map(([key, value]) => [key, value ? new TextDecoder().decode(value) : null])),
      restoredBinary: Array.from(selected.changes.find((change) => change.path === "image.bin")?.commitFile?.data ?? []),
      staleRestore,
      afterConflict: afterConflict.data ? new TextDecoder().decode(afterConflict.data) : null,
      head: finalStatus.head,
      status: finalStatus.entries.map((entry) => entry.path),
    };
  }, id);

  expect(result.first.parentOid).toBeNull();
  expect(result.first.paths).toEqual([["image.bin", "added"], ["notes.md", "added"], ["remove.txt", "added"]]);
  expect(result.second.parentOid).toBe(result.expectedParents[0]);
  expect(result.second.paths).toEqual([["image.bin", "modified"], ["new.txt", "added"], ["notes.md", "modified"], ["remove.txt", "deleted"]]);
  expect(result.restored).toEqual({ note: "second version\n", removed: null, added: "added in second\n" });
  expect(result.restoredBinary).toEqual([0, 255, 2, 3]);
  expect(result.staleRestore).toBe("revision_conflict");
  expect(result.afterConflict).toBe("concurrent edit\n");
  expect(result.head).toBe(result.currentHead);
  expect(result.status).toEqual(["new.txt", "notes.md", "remove.txt"]);
});

test("file revisions, repository bindings, unsafe paths, and browser writer locks fail closed", async ({ page }) => {
  const id = workspaceId();
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async (workspaceId) => {
    const git = window.browserGitTest.open(workspaceId);
    const initialized = await git.init();
    const first = await git.write("a.txt", new TextEncoder().encode("first"), { oid: null });
    let stale = "none";
    try { await git.write("a.txt", new TextEncoder().encode("stale"), { oid: null }); }
    catch (error) { stale = (error as { code?: string }).code ?? "unknown"; }
    let traversal = "none";
    try { await git.read("../outside.txt"); }
    catch (error) { traversal = (error as { code?: string }).code ?? "unknown"; }
    const alteredIdentity = window.browserGitTest.open(workspaceId, { repositoryId: 923456790 });
    let identity = "none";
    try { await alteredIdentity.init(); }
    catch (error) { identity = (error as { code?: string }).code ?? "unknown"; }
    alteredIdentity.close();
    const acquired = await window.browserGitTest.holdLock(workspaceId);
    let busy = "none";
    try { await git.write("b.txt", new TextEncoder().encode("blocked"), { oid: null }); }
    catch (error) { busy = (error as { code?: string }).code ?? "unknown"; }
    window.browserGitTest.releaseLock();
    localStorage.setItem(`proprium.git.storage-unknown.${workspaceId}`, "1");
    let uncertain = "none";
    try { await git.status(); }
    catch (error) { uncertain = (error as { code?: string }).code ?? "unknown"; }
    const verification = await git.verifyStorage();
    git.close();
    return { initialized, first, stale, traversal, identity, acquired, busy, uncertain, verification };
  }, id);
  expect(result.stale).toBe("revision_conflict");
  expect(result.traversal).toBe("invalid_path");
  expect(result.identity).toBe("identity_mismatch");
  expect(result.acquired).toBe(true);
  expect(result.busy).toBe("workspace_busy");
  expect(result.uncertain).toBe("storage_unknown");
  expect(result.verification.verified).toBe(true);
});


test("approved batch changes validate every read and write revision before applying any file", async ({ page }) => {
  const id = workspaceId();
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async (workspaceId) => {
    const git = window.browserGitTest.open(workspaceId);
    await git.init();
    const firstBytes = new TextEncoder().encode("first stays\n");
    const secondBytes = new TextEncoder().encode("second stays\n");
    const dependencyBytes = new TextEncoder().encode("dependency\n");
    const first = await git.write("first.txt", firstBytes, { oid: null });
    const second = await git.write("second.txt", secondBytes, { oid: null });
    const dependency = await git.write("dependency.txt", dependencyBytes, { oid: null });
    const changed = new TextEncoder().encode("would change\n");
    let staleReadSet = "none";
    try {
      await git.applyChanges(
        [{ path: "first.txt", content: changed, expectedRevision: first }],
        [{ path: "dependency.txt", revision: { oid: "0".repeat(40) } }],
      );
    } catch (error) { staleReadSet = (error as { code?: string }).code ?? "unknown"; }
    const afterStaleReadSet = await git.read("first.txt");

    let staleWriteSet = "none";
    try {
      await git.applyChanges([
        { path: "first.txt", content: changed, expectedRevision: first },
        { path: "second.txt", content: changed, expectedRevision: { oid: "f".repeat(40) } },
      ]);
    } catch (error) { staleWriteSet = (error as { code?: string }).code ?? "unknown"; }
    const afterStaleWriteSet = await git.read("first.txt");
    const secondAfterStaleWriteSet = await git.read("second.txt");

    const applied = await git.applyChanges(
      [
        { path: "first.txt", content: changed, expectedRevision: first },
        { path: "second.txt", content: null, expectedRevision: second },
      ],
      [{ path: "dependency.txt", revision: dependency }],
    );
    const firstAfterApply = await git.read("first.txt");
    const secondAfterApply = await git.read("second.txt");
    git.close();
    return {
      staleReadSet,
      staleWriteSet,
      afterStaleReadSet: afterStaleReadSet.data ? new TextDecoder().decode(afterStaleReadSet.data) : null,
      afterStaleWriteSet: afterStaleWriteSet.data ? new TextDecoder().decode(afterStaleWriteSet.data) : null,
      secondAfterStaleWriteSet: secondAfterStaleWriteSet.data ? new TextDecoder().decode(secondAfterStaleWriteSet.data) : null,
      applied,
      firstAfterApply: firstAfterApply.data ? new TextDecoder().decode(firstAfterApply.data) : null,
      secondAfterApply: secondAfterApply.data,
    };
  }, id);
  expect(result.staleReadSet).toBe("revision_conflict");
  expect(result.staleWriteSet).toBe("revision_conflict");
  expect(result.afterStaleReadSet).toBe("first stays\n");
  expect(result.afterStaleWriteSet).toBe("first stays\n");
  expect(result.secondAfterStaleWriteSet).toBe("second stays\n");
  expect(result.applied).toEqual([{ path: "first.txt", revision: { oid: expect.any(String) } }, { path: "second.txt", revision: { oid: null } }]);
  expect(result.firstAfterApply).toBe("would change\n");
  expect(result.secondAfterApply).toBeNull();
});

for (const mutation of ["edit", "add", "delete", "head"] as const) {
  test(`reviewed commit rejects another tab's ${mutation} before staging`, async ({ page, context }) => {
    await page.goto("/browser-git-test.html");
    await expect(page.locator("#ready")).toHaveText("ready");
    const id = workspaceId();
    const snapshot = await page.evaluate(async id => {
      const git = window.browserGitTest.open(id);
      const author = { name: "Review Test", email: "review@example.test" };
      await git.init();
      await git.write("notes.md", new TextEncoder().encode("original\n"), { oid: null });
      await git.add(["notes.md"], null);
      const base = await git.commit("base", author, null);
      await git.write("notes.md", new TextEncoder().encode("reviewed\n"), (await git.read("notes.md")).revision);
      const review = await git.reviewDiff();
      git.close();
      return { head: base.head, files: review.changes.map(change => ({ path: change.path, oid: change.worktreeFile?.oid ?? null })) };
    }, id);
    const other = await context.newPage();
    await other.goto("/browser-git-test.html");
    await expect(other.locator("#ready")).toHaveText("ready");
    const before = await other.evaluate(async ({ id, mutation }) => {
      const git = window.browserGitTest.open(id);
      await git.init();
      if (mutation === "add") await git.write("unreviewed.md", new TextEncoder().encode("unreviewed new file\n"), { oid: null });
      else if (mutation === "delete") await git.delete("notes.md", (await git.read("notes.md")).revision);
      else if (mutation === "head") {
        const status = await git.status();
        await git.add(["notes.md"], status.head);
        await git.commit("other tab commit", { name: "Other", email: "other@example.test" }, status.head);
      } else await git.write("notes.md", new TextEncoder().encode("unreviewed edit\n"), (await git.read("notes.md")).revision);
      const status = await git.status();
      git.close();
      return status;
    }, { id, mutation });
    const result = await page.evaluate(async ({ id, snapshot }) => {
      const git = window.browserGitTest.open(id);
      let code = "none";
      try { await git.commitReviewed("must not commit", { name: "Review", email: "review@example.test" }, snapshot); }
      catch (error) { code = (error as { code: string }).code; }
      const status = await git.status();
      const history = await git.log();
      let confirmed: string | null = null;
      const fresh = await git.reviewDiff();
      if (fresh.changes.length) {
        const committed = await git.commitReviewed("reviewed again", { name: "Review", email: "review@example.test" }, {
          head: fresh.head, files: fresh.changes.map(change => ({ path: change.path, oid: change.worktreeFile?.oid ?? null })),
        });
        confirmed = committed.head;
      }
      const after = await git.status();
      git.close();
      return { code, status, history: history.map(commit => commit.message.trim()), confirmed, after };
    }, { id, snapshot });
    expect(result.code).toBe("revision_conflict");
    expect(result.status).toEqual(before); // Neither index nor HEAD changed on rejection.
    expect(result.history).not.toContain("must not commit");
    if (mutation !== "head") {
      expect(result.confirmed).toMatch(/^[a-f0-9]{40}$/u);
      expect(result.after.entries).toEqual([]);
    }
    await other.close();
  });
}
