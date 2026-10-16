import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ChangeOperation, SnapshotId } from "@scriptorium/contracts";
import { CoreError, CoreStore } from "./index.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function remoteFixture(): Promise<{ root: string; remote: string; seed: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-transactions-"));
  const remote = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  await fs.mkdir(seed);
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.name", "Test Writer");
  await git(seed, "config", "user.email", "writer@example.test");
  await fs.writeFile(path.join(seed, "README.md"), "Initial.\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "Initial project");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { root, remote, seed };
}

function operation(snapshot: SnapshotId, filePath: string, content: string, revision: string | null = null, id = "operation_1"): ChangeOperation {
  return {
    id,
    generation: 1,
    repository: snapshot.repository,
    baseRemoteCommit: snapshot.remoteCommit,
    effect: "manuscript",
    reads: [{ path: filePath, revision }],
    writes: [{ path: filePath, revision, content }],
    message: `Write ${filePath}`,
  };
}

async function approveAndCheckpoint(store: CoreStore, projectId: string, snapshot: SnapshotId, op: ChangeOperation) {
  const proposal = await store.propose(projectId, { id: `proposal_${op.id}`, snapshot, operations: [op], source: "author" });
  await store.approve(projectId, { proposalId: proposal.id, operationIds: [op.id], authorScope: "owner" });
  return store.checkpoint(projectId, op);
}

test("checkpoints require approval, replay idempotently, and survive a clone from the remote receipt", async () => {
  const fixture = await remoteFixture();
  const dataDir = path.join(fixture.root, "state");
  try {
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const observation = await store.observe(project.id);
    const op = operation(observation.snapshot, "manuscript/scene.md", "Draft.\n");
    await assert.rejects(store.checkpoint(project.id, op), (error: unknown) => error instanceof CoreError && error.code === "author_approval_required");
    const first = await approveAndCheckpoint(store, project.id, observation.snapshot, op);
    assert.deepEqual(await (await store.reader(project.id, "checkpoint")).read("manuscript/scene.md"), {
      content: "Draft.\n",
      revision: createHash("sha256").update("Draft.\n").digest("hex"),
    });
    assert.deepEqual(await store.checkpoint(project.id, op), first);
    const reused = { ...op, writes: [{ ...op.writes[0]!, content: "Different.\n" }] };
    await assert.rejects(store.checkpoint(project.id, reused), (error: unknown) => error instanceof CoreError && error.code === "operation_id_reused");

    const receipt = await store.publish(project.id, "batch_first");
    assert.equal(receipt.state, "confirmed");
    assert.deepEqual(receipt.acknowledged, [first]);
    const remoteHead = await git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/main");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "merge-base", "--is-ancestor", first.localCommit, remoteHead), "");

    const newStore = new CoreStore({ dataDir: path.join(fixture.root, "new-state"), allowLocalRemotes: true });
    const clone = await newStore.registerProject({ url: fixture.remote });
    const replayed = await newStore.publish(clone.id, "batch_first");
    assert.equal(replayed.state, "confirmed");
    assert.deepEqual(replayed.acknowledged, [first]);
    assert.deepEqual((await newStore.observe(clone.id)).pending, []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a browser journal can restore an unpublished checkpoint after the Core clone is lost", async () => {
  const fixture = await remoteFixture();
  try {
    const firstStore = new CoreStore({ dataDir: path.join(fixture.root, "first-state"), allowLocalRemotes: true });
    const firstProject = await firstStore.registerProject({ url: fixture.remote });
    const snapshot = (await firstStore.observe(firstProject.id)).snapshot;
    const op = operation(snapshot, "manuscript/recovered.md", "Recovered from browser journal.\n", null, "browser_recovery_operation");
    await approveAndCheckpoint(firstStore, firstProject.id, snapshot, op);

    const restoredStore = new CoreStore({ dataDir: path.join(fixture.root, "restored-state"), allowLocalRemotes: true });
    const restoredProject = await restoredStore.registerProject({ url: fixture.remote });
    const receipt = await approveAndCheckpoint(restoredStore, restoredProject.id, snapshot, op);
    assert.equal(receipt.operationId, op.id);
    assert.equal((await restoredStore.observe(restoredProject.id)).pending.length, 1);
    assert.equal((await (await restoredStore.reader(restoredProject.id, "checkpoint")).read("manuscript/recovered.md"))?.content, "Recovered from browser journal.\n");

    const published = await restoredStore.publish(restoredProject.id, "batch_browser_recovery");
    assert.equal(published.state, "confirmed");
    assert.deepEqual(published.acknowledged.map((item) => item.operationId), [op.id]);
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:manuscript/recovered.md`), "Recovered from browser journal.");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("disjoint remote changes replay as an explicit overlay and publish without merging prose", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const observed = await store.observe(project.id);
    const op = operation(observed.snapshot, "manuscript/scene.md", "Author draft.\n");
    await approveAndCheckpoint(store, project.id, observed.snapshot, op);

    await fs.writeFile(path.join(fixture.seed, "remote-note.txt"), "Upstream addition.\n");
    await git(fixture.seed, "add", "remote-note.txt");
    await git(fixture.seed, "commit", "-m", "Disjoint upstream change");
    await git(fixture.seed, "push", "origin", "main");

    const reconciliation = await store.reconcile(project.id);
    assert.deepEqual(reconciliation.operations.map(({ operationId, state }) => ({ operationId, state })), [{ operationId: op.id, state: "replayed" }]);
    const checkpoint = await store.reader(project.id, "checkpoint");
    assert.equal((await checkpoint.read("manuscript/scene.md"))?.content, "Author draft.\n");
    assert.equal((await checkpoint.read("remote-note.txt"))?.content, "Upstream addition.\n");

    const published = await store.publish(project.id, "batch_disjoint");
    assert.equal(published.state, "confirmed");
    assert.deepEqual(published.acknowledged.map((item) => item.operationId), [op.id]);
    const upstreamCommit = await git(fixture.seed, "rev-parse", "HEAD");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "merge-base", "--is-ancestor", upstreamCommit, published.remoteCommit), "");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:remote-note.txt`), "Upstream addition.");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:manuscript/scene.md`), "Author draft.");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("publication reports only unacknowledged operations across successive checkpoint batches", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    let snapshot = (await store.observe(project.id)).snapshot;
    const first = operation(snapshot, "manuscript/first.md", "First.\n", null, "first_batch_operation");
    await approveAndCheckpoint(store, project.id, snapshot, first);
    const firstBatch = await store.publish(project.id, "batch_one");
    assert.equal(firstBatch.state, "confirmed");
    assert.deepEqual(firstBatch.acknowledged.map((item) => item.operationId), [first.id]);

    snapshot = (await store.observe(project.id)).snapshot;
    const second = operation(snapshot, "manuscript/second.md", "Second.\n", null, "second_batch_operation");
    await approveAndCheckpoint(store, project.id, snapshot, second);
    assert.deepEqual((await store.observe(project.id)).pending.map((item) => item.operationId), [second.id]);
    const secondBatch = await store.publish(project.id, "batch_two");
    assert.equal(secondBatch.state, "confirmed");
    assert.deepEqual(secondBatch.acknowledged.map((item) => item.operationId), [second.id]);
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${secondBatch.remoteCommit}:manuscript/first.md`), "First.");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${secondBatch.remoteCommit}:manuscript/second.md`), "Second.");
    assert.deepEqual((await store.publish(project.id, "batch_one")).acknowledged.map((item) => item.operationId), [first.id]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-file remote updates remain conflicts while the local checkpoint remains readable", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const observed = await store.observe(project.id);
    const original = await (await store.reader(project.id)).read("README.md");
    const op = operation(observed.snapshot, "README.md", "Local draft.\n", original?.revision ?? null, "same_file_op");
    await approveAndCheckpoint(store, project.id, observed.snapshot, op);
    await fs.writeFile(path.join(fixture.seed, "README.md"), "Remote draft.\n");
    await git(fixture.seed, "add", "README.md");
    await git(fixture.seed, "commit", "-m", "Competing remote edit");
    await git(fixture.seed, "push", "origin", "main");

    const reconciliation = await store.reconcile(project.id);
    assert.equal(reconciliation.operations[0]?.state, "conflict");
    assert.equal((await (await store.reader(project.id, "checkpoint")).read("README.md"))?.content, "Local draft.\n");
    const publication = await store.publish(project.id, "batch_conflict");
    assert.equal(publication.state, "conflict");
    assert.equal((await store.observe(project.id)).pending.length, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("fresh status detects a changed repository default branch before mutation", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    await git(fixture.seed, "checkout", "-b", "renamed-default");
    await git(fixture.seed, "push", "origin", "renamed-default");
    await git(fixture.root, "--git-dir", fixture.remote, "symbolic-ref", "HEAD", "refs/heads/renamed-default");
    await assert.rejects(store.observe(project.id), (error: unknown) => error instanceof CoreError && error.code === "default_branch_changed");
    await assert.rejects(store.status(project.id), (error: unknown) => error instanceof CoreError && error.code === "default_branch_changed");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a non-fast-forward push race retries from the new remote head", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true, maxPushRetries: 3 });
    const project = await store.registerProject({ url: fixture.remote });
    const observed = await store.observe(project.id);
    const op = operation(observed.snapshot, "manuscript/scene.md", "Local checkpoint.\n", null, "race_operation");
    await approveAndCheckpoint(store, project.id, observed.snapshot, op);

    await fs.writeFile(path.join(fixture.seed, "race-note.txt"), "Racing upstream commit.\n");
    await git(fixture.seed, "add", "race-note.txt");
    await git(fixture.seed, "commit", "-m", "Racing upstream change");
    const competing = await git(fixture.seed, "rev-parse", "HEAD");
    await git(fixture.seed, "push", "origin", `${competing}:refs/race/competing`);
    const marker = path.join(fixture.remote, "scriptorium-race-fired");
    const hookPath = path.join(fixture.remote, "hooks", "post-receive");
    await fs.writeFile(hookPath, `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ] && [ ! -f "${marker}" ]; then\n    git --git-dir="$GIT_DIR" update-ref "$ref" "${competing}" "$new" || exit 1\n    : > "${marker}"\n  fi\ndone\n`, "utf8");
    await fs.chmod(hookPath, 0o755);

    const published = await store.publish(project.id, "batch_race");
    assert.equal(published.state, "confirmed");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "merge-base", "--is-ancestor", competing, published.remoteCommit), "");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:race-note.txt`), "Racing upstream commit.");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:manuscript/scene.md`), "Local checkpoint.");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a lost push response is confirmed from the fetched publication ancestor", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const observed = await store.observe(project.id);
    const op = operation(observed.snapshot, "manuscript/scene.md", "Recoverable draft.\n", null, "lost_response_operation");
    const checkpoint = await approveAndCheckpoint(store, project.id, observed.snapshot, op);
    const hookPath = path.join(fixture.remote, "hooks", "post-receive");
    await fs.writeFile(hookPath, "#!/bin/sh\nkill -9 \"$PPID\"\n", "utf8");
    await fs.chmod(hookPath, 0o755);

    const published = await store.publish(project.id, "batch_lost_response");
    assert.equal(published.state, "confirmed");
    assert.deepEqual(published.acknowledged.map((item) => item.operationId), [op.id]);
    assert.ok(await git(fixture.root, "--git-dir", fixture.remote, "merge-base", "--is-ancestor", checkpoint.localCommit, published.remoteCommit).then(() => true, () => false));
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a rejected receive hook leaves the checkpoint pending and unacknowledged", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true, maxPushRetries: 2 });
    const project = await store.registerProject({ url: fixture.remote });
    const observed = await store.observe(project.id);
    const op = operation(observed.snapshot, "manuscript/scene.md", "Not yet published.\n", null, "rejected_operation");
    const checkpoint = await approveAndCheckpoint(store, project.id, observed.snapshot, op);
    const hookPath = path.join(fixture.remote, "hooks", "pre-receive");
    await fs.writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf8");
    await fs.chmod(hookPath, 0o755);

    const before = await git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/main");
    const published = await store.publish(project.id, "batch_rejected");
    assert.equal(published.state, "conflict");
    assert.deepEqual(published.acknowledged, []);
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/main"), before);
    assert.equal((await store.observe(project.id)).pending[0]?.operationId, op.id);
    assert.equal((await (await store.reader(project.id, "checkpoint")).read("manuscript/scene.md"))?.content, "Not yet published.\n");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
