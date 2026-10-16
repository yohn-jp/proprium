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

async function seedHierarchy(fixture: { seed: string }, chapterIds: string[]): Promise<void> {
  const volumeDir = path.join(fixture.seed, "plot/volumes/vol1");
  await fs.mkdir(volumeDir, { recursive: true });
  await fs.writeFile(path.join(volumeDir, "volume.yaml"), "id: vol1\nname: Volume One\norder: 1\n");
  for (const chapterId of chapterIds) {
    const chapterDir = path.join(volumeDir, "chapters", chapterId);
    await fs.mkdir(chapterDir, { recursive: true });
    await fs.writeFile(path.join(chapterDir, "chapter.yaml"), `id: ${chapterId}\nvolume: vol1\ntitle: ${chapterId}\norder: 1\n`);
  }
  await git(fixture.seed, "add", "plot/volumes");
  await git(fixture.seed, "commit", "-m", "Add Core hierarchy for concurrency test");
  await git(fixture.seed, "push", "origin", "main");
}

async function addRemoteScene(fixture: { seed: string }, chapterId: string, sceneId: string): Promise<void> {
  const directory = path.join(fixture.seed, "plot/volumes/vol1/chapters", chapterId, "scenes");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${sceneId}.yaml`), `id: ${sceneId}\ntype: scene\nvolume: vol1\nchapter: ${chapterId}\ntitle: ${sceneId}\norder: 1\n`);
  await git(fixture.seed, "add", "plot/volumes");
  await git(fixture.seed, "commit", "-m", "Add a remote scene during an approved operation");
  await git(fixture.seed, "push", "origin", "main");
}

test("manuscript snapshots enumerate and read exact documents at a pinned reachable commit", async () => {
  const fixture = await remoteFixture();
  try {
    const fullDocument = "---\ntitle: Keep title\ncustom: preserve\n---\nFirst version.\n";
    await fs.mkdir(path.join(fixture.seed, "manuscript/vol1"), { recursive: true });
    await fs.writeFile(path.join(fixture.seed, "manuscript/vol1/scene1.md"), fullDocument);
    await git(fixture.seed, "add", "manuscript/vol1/scene1.md");
    await git(
      fixture.seed,
      "commit",
      "-m", "loom(scene): scene1 (+15字)",
      "-m", "Loom-Manuscript: ms-one\nLoom-File: manuscript/vol1/scene1.md\nLoom-Char-Count: 15\nLoom-Label: First pass\nLoom-Trigger: manual",
    );
    const firstCommit = await git(fixture.seed, "rev-parse", "HEAD");
    await git(fixture.seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const changedDocument = fullDocument.replace("First version.", "Second version.");
    await fs.writeFile(path.join(fixture.seed, "manuscript/vol1/scene1.md"), changedDocument);
    await git(fixture.seed, "add", "manuscript/vol1/scene1.md");
    await git(
      fixture.seed,
      "commit",
      "-m", "loom(scene): scene1 (+16字)",
      "-m", "Loom-Manuscript: ms-one\nLoom-File: manuscript/vol1/scene1.md\nLoom-Char-Count: 16\nLoom-Label: Second pass\nLoom-Trigger: submit",
    );
    const secondCommit = await git(fixture.seed, "rev-parse", "HEAD");
    await git(fixture.seed, "push", "origin", "main");

    const listed = await store.listManuscriptSnapshots(project.id, "ms-one", "scene1");
    assert.equal(listed.snapshot.remoteCommit, secondCommit);
    assert.deepEqual(listed.snapshots.map((item) => item.id), [secondCommit, firstCommit]);
    assert.equal(listed.snapshots[0]?.label, "Second pass");
    assert.equal(listed.snapshots[0]?.trigger, "submit");

    const pinnedList = await store.listManuscriptSnapshots(project.id, "ms-one", "scene1", "remote", firstCommit);
    assert.equal(pinnedList.snapshot.remoteCommit, firstCommit);
    assert.deepEqual(pinnedList.snapshots.map((item) => item.id), [firstCommit]);
    const historical = await store.readManuscriptSnapshot(project.id, "ms-one", firstCommit, "remote", secondCommit);
    assert.ok(historical);
    assert.equal(historical.snapshot.remoteCommit, secondCommit);
    assert.equal(historical.manuscript.body, "First version.\n");
    assert.deepEqual(historical.manuscript.document, {
      path: "manuscript/vol1/scene1.md",
      content: fullDocument,
      revision: createHash("sha256").update(fullDocument).digest("hex"),
    });
    const pinnedReader = await store.reader(project.id, "remote", firstCommit);
    assert.equal(pinnedReader.snapshot.remoteCommit, firstCommit);
    assert.equal((await pinnedReader.read("manuscript/vol1/scene1.md"))?.content, fullDocument);
    assert.equal(await store.readManuscriptSnapshot(project.id, "ms-one", secondCommit, "remote", firstCommit), null);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Core hierarchy builders create, reorder, restore, and delete only through approved operations", async () => {
  const fixture = await remoteFixture();
  try {
    const volumeDir = path.join(fixture.seed, "plot/volumes/vol1");
    const chapterDir = path.join(volumeDir, "chapters/ch1");
    const sceneDir = path.join(chapterDir, "scenes");
    const manuscriptDir = path.join(fixture.seed, "manuscript/vol1/ch1");
    await fs.mkdir(sceneDir, { recursive: true });
    await fs.mkdir(manuscriptDir, { recursive: true });
    await fs.writeFile(path.join(volumeDir, "volume.yaml"), "id: vol1\nname: Volume One\norder: 1\nunknown: preserve-volume\n");
    await fs.writeFile(path.join(chapterDir, "chapter.yaml"), "id: ch1\nvolume: vol1\ntitle: Chapter One\norder: 1\nunknown: preserve-chapter\n");
    await fs.writeFile(path.join(sceneDir, "scene1.yaml"), "id: scene1\ntype: scene\nvolume: vol1\nchapter: ch1\ntitle: First Scene\nmanuscript: manuscript/vol1/ch1/scene1.md\norder: 1\ncustom: keep-this\n");
    await fs.writeFile(path.join(manuscriptDir, "scene1.md"), "First body.\n");
    await git(fixture.seed, "add", ".");
    await git(fixture.seed, "commit", "-m", "Add hierarchy for Core builder test");
    await git(fixture.seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    await assert.rejects(
      store.buildCreateHierarchyOperation(project.id, { kind: "volume", id: "../escape", title: "Unsafe" }),
      (error: unknown) => error instanceof CoreError && error.code === "invalid_hierarchy_id",
    );
    const created = await store.buildCreateHierarchyOperation(project.id, {
      kind: "scene",
      id: "scene2",
      title: "Second Scene",
      volumeId: "vol1",
      chapterId: "ch1",
      manuscriptBody: "Second body.\n",
    });
    assert.equal(created.operation.effect, "structure");
    assert.deepEqual(created.operation.writes.map((write) => ({ path: write.path, revision: write.revision })), [
      { path: "plot/volumes/vol1/chapters/ch1/scenes/scene2.yaml", revision: null },
      { path: "manuscript/vol1/ch1/scene2.md", revision: null },
    ]);
    await assert.rejects(store.checkpoint(project.id, created.operation), (error: unknown) =>
      error instanceof CoreError && error.code === "author_approval_required");
    await assert.rejects(store.readSceneSnapshot(project.id, "scene2", "remote"), (error: unknown) =>
      error instanceof CoreError && error.code === "scene_not_found");
    await approveAndCheckpoint(store, project.id, created.snapshot, created.operation);
    assert.equal((await store.readSceneSnapshot(project.id, "scene2", "checkpoint")).scene.text, "Second body.\n");
    let tree = (await store.readTreeSnapshot(project.id, "checkpoint")).tree;
    assert.deepEqual(tree.volumes[0]?.chapters[0]?.scenes.map((scene) => scene.id), ["scene1", "scene2"]);

    await assert.rejects(
      store.buildDeleteHierarchyOperation(project.id, { kind: "chapter", id: "ch1", volumeId: "vol1" }),
      (error: unknown) => error instanceof CoreError && error.code === "hierarchy_not_empty",
    );
    const reordered = await store.buildReorderHierarchyOperation(project.id, {
      kind: "scene",
      volumeId: "vol1",
      chapterId: "ch1",
      orderedIds: ["scene2", "scene1"],
    }, "checkpoint");
    const originalSceneWrite = reordered.operation.writes.find((write) => write.path.endsWith("/scene1.yaml"));
    assert.match(originalSceneWrite?.content ?? "", /custom: keep-this/);
    await approveAndCheckpoint(store, project.id, reordered.snapshot, reordered.operation);
    tree = (await store.readTreeSnapshot(project.id, "checkpoint")).tree;
    assert.deepEqual(tree.volumes[0]?.chapters[0]?.scenes.map((scene) => scene.id), ["scene2", "scene1"]);
    assert.match((await (await store.reader(project.id, "checkpoint")).read("plot/volumes/vol1/chapters/ch1/scenes/scene1.yaml"))?.content ?? "", /custom: keep-this/);

    const restoredOrder = await store.buildRestoreOperation(project.id, reordered.operation.id, "checkpoint");
    assert.equal(restoredOrder.operation.writes.length, 2);
    await approveAndCheckpoint(store, project.id, restoredOrder.snapshot, restoredOrder.operation);
    tree = (await store.readTreeSnapshot(project.id, "checkpoint")).tree;
    assert.deepEqual(tree.volumes[0]?.chapters[0]?.scenes.map((scene) => scene.id), ["scene1", "scene2"]);
    await assert.rejects(
      store.buildRestoreOperation(project.id, reordered.operation.id, "checkpoint"),
      (error: unknown) => error instanceof CoreError && error.code === "restore_target_changed",
    );

    const deleted = await store.buildDeleteHierarchyOperation(project.id, {
      kind: "scene",
      id: "scene2",
      volumeId: "vol1",
      chapterId: "ch1",
    }, "checkpoint");
    assert.deepEqual(deleted.operation.writes.map((write) => write.path), [
      "plot/volumes/vol1/chapters/ch1/scenes/scene2.yaml",
      "manuscript/vol1/ch1/scene2.md",
    ]);
    await approveAndCheckpoint(store, project.id, deleted.snapshot, deleted.operation);
    assert.deepEqual(await (await store.reader(project.id, "checkpoint")).read("manuscript/vol1/ch1/scene2.md"), null);
    await assert.rejects(store.readSceneSnapshot(project.id, "scene2", "checkpoint"), (error: unknown) =>
      error instanceof CoreError && error.code === "scene_not_found");
    assert.equal((await store.readSceneSnapshot(project.id, "scene1", "checkpoint")).scene.text, "First body.\n");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("stale chapter deletion is rejected when the remote hierarchy gains a child", async () => {
  const fixture = await remoteFixture();
  try {
    await seedHierarchy(fixture, ["ch1"]);
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const deletion = await store.buildDeleteHierarchyOperation(project.id, { kind: "chapter", id: "ch1", volumeId: "vol1" });
    const proposal = await store.propose(project.id, {
      id: "proposal_delete_chapter_stale_remote",
      snapshot: deletion.snapshot,
      operations: [deletion.operation],
      source: "author",
    });
    await store.approve(project.id, { proposalId: proposal.id, operationIds: [deletion.operation.id], authorScope: "owner" });

    await addRemoteScene(fixture, "ch1", "remote_scene");
    await assert.rejects(store.checkpoint(project.id, deletion.operation), (error: unknown) =>
      error instanceof CoreError && error.code === "hierarchy_precondition_conflict");
    assert.match(await git(fixture.root, "--git-dir", fixture.remote, "show", "main:plot/volumes/vol1/chapters/ch1/chapter.yaml"), /id: ch1/);
    assert.match(await git(fixture.root, "--git-dir", fixture.remote, "show", "main:plot/volumes/vol1/chapters/ch1/scenes/remote_scene.yaml"), /id: remote_scene/);
    assert.equal((await store.observe(project.id)).pending.length, 0);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("reconcile retains a structure checkpoint as conflicted when remote hierarchy membership changed", async () => {
  const fixture = await remoteFixture();
  try {
    await seedHierarchy(fixture, ["ch1"]);
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const deletion = await store.buildDeleteHierarchyOperation(project.id, { kind: "chapter", id: "ch1", volumeId: "vol1" });
    await approveAndCheckpoint(store, project.id, deletion.snapshot, deletion.operation);

    await addRemoteScene(fixture, "ch1", "remote_scene");
    const reconciliation = await store.reconcile(project.id);
    assert.deepEqual(reconciliation.operations.map(({ operationId, state, paths }) => ({ operationId, state, paths })), [{
      operationId: deletion.operation.id,
      state: "conflict",
      paths: ["plot/volumes/vol1/chapters/ch1/chapter.yaml"],
    }]);
    assert.match(await git(fixture.root, "--git-dir", fixture.remote, "show", "main:plot/volumes/vol1/chapters/ch1/scenes/remote_scene.yaml"), /id: remote_scene/);
    assert.equal(await (await store.reader(project.id, "checkpoint")).read("plot/volumes/vol1/chapters/ch1/chapter.yaml"), null);
    assert.match((await store.reader(project.id, "remote")).snapshot.remoteCommit, /^[a-f0-9]{40}$/);
    assert.equal((await store.observe(project.id)).pending.length, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-snapshot hierarchy creations with a duplicate global ID cannot both checkpoint", async () => {
  const fixture = await remoteFixture();
  try {
    await seedHierarchy(fixture, ["ch1", "ch2"]);
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const first = await store.buildCreateHierarchyOperation(project.id, {
      kind: "scene", id: "shared_scene", title: "Shared", volumeId: "vol1", chapterId: "ch1", manuscriptBody: "First.\n",
    }, "remote", snapshot);
    const second = await store.buildCreateHierarchyOperation(project.id, {
      kind: "scene", id: "shared_scene", title: "Shared", volumeId: "vol1", chapterId: "ch2", manuscriptBody: "Second.\n",
    }, "remote", snapshot);
    assert.notEqual(first.operation.writes[0]?.path, second.operation.writes[0]?.path);
    await approveAndCheckpoint(store, project.id, first.snapshot, first.operation);
    const secondProposal = await store.propose(project.id, {
      id: `proposal_${second.operation.id}`,
      snapshot: second.snapshot,
      operations: [second.operation],
      source: "author",
    });
    await store.approve(project.id, { proposalId: secondProposal.id, operationIds: [second.operation.id], authorScope: "owner" });

    await assert.rejects(store.checkpoint(project.id, second.operation), (error: unknown) =>
      error instanceof CoreError && error.code === "hierarchy_precondition_conflict");
    const checkpointTree = (await store.readTreeSnapshot(project.id, "checkpoint")).tree;
    assert.deepEqual(checkpointTree.volumes[0]?.chapters.map((chapter) => chapter.scenes.map((scene) => scene.id)), [["shared_scene"], []]);
    assert.equal((await store.observe(project.id)).pending.length, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("Core compensating operations restore exact prior binary bytes from the checkpoint parent", async () => {
  const fixture = await remoteFixture();
  const originalBytes = Buffer.from([0, 255, 1, 128, 13, 10, 42]);
  const changedBytes = Buffer.from([9, 8, 7, 0, 255]);
  const filePath = "assets/cover.bin";
  try {
    await fs.mkdir(path.dirname(path.join(fixture.seed, filePath)), { recursive: true });
    await fs.writeFile(path.join(fixture.seed, filePath), originalBytes);
    await git(fixture.seed, "add", filePath);
    await git(fixture.seed, "commit", "-m", "Add original binary attachment");
    await git(fixture.seed, "push", "origin", "main");
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const original = await (await store.reader(project.id, "remote")).read(filePath, "base64");
    assert.equal(original?.content, originalBytes.toString("base64"));
    const changed = {
      id: "binary_attachment_change",
      generation: 1,
      repository: snapshot.repository,
      baseRemoteCommit: snapshot.remoteCommit,
      effect: "metadata" as const,
      reads: [{ path: filePath, revision: original?.revision ?? null }],
      writes: [{ path: filePath, revision: original?.revision ?? null, content: changedBytes.toString("base64"), encoding: "base64" as const }],
      message: "Replace binary attachment",
    };
    await approveAndCheckpoint(store, project.id, snapshot, changed);

    const restore = await store.buildRestoreOperation(project.id, changed.id, "checkpoint");
    assert.equal(restore.operation.writes[0]?.encoding, "base64");
    assert.equal(restore.operation.writes[0]?.content, originalBytes.toString("base64"));
    await approveAndCheckpoint(store, project.id, restore.snapshot, restore.operation);
    assert.deepEqual(await (await store.reader(project.id, "checkpoint")).read(filePath, "base64"), original);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

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

test("deleted publication metadata cannot release a batch ID for different operations", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    let snapshot = (await store.observe(project.id)).snapshot;
    const first = operation(snapshot, "manuscript/first-batch.md", "First batch payload.\n", null, "deleted_batch_first_operation");
    await approveAndCheckpoint(store, project.id, snapshot, first);
    const firstPublication = await store.publish(project.id, "batch_deleted_metadata");
    assert.equal(firstPublication.state, "confirmed");
    assert.deepEqual(firstPublication.acknowledged.map((item) => item.operationId), [first.id]);

    await git(fixture.seed, "fetch", "origin", "main");
    await git(fixture.seed, "reset", "--hard", "origin/main");
    await git(fixture.seed, "rm", "meta/scriptorium/publications/v1/batch_deleted_metadata.json");
    await git(fixture.seed, "commit", "-m", "Remove visible publication metadata");
    await git(fixture.seed, "push", "origin", "main");
    const deletedMetadataHead = await git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/main");

    const sameBatchReplay = await store.publish(project.id, "batch_deleted_metadata");
    assert.equal(sameBatchReplay.state, "confirmed");
    assert.deepEqual(sameBatchReplay.acknowledged.map((item) => item.operationId), [first.id]);
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/main"), deletedMetadataHead);

    snapshot = (await store.observe(project.id)).snapshot;
    const second = operation(snapshot, "manuscript/second-batch.md", "Second batch payload.\n", null, "deleted_batch_second_operation");
    await approveAndCheckpoint(store, project.id, snapshot, second);
    await assert.rejects(
      store.publish(project.id, "batch_deleted_metadata"),
      (error: unknown) => error instanceof CoreError && error.code === "batch_id_reused",
    );
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "rev-parse", "refs/heads/main"), deletedMetadataHead);
    const healthyObservation = await store.observe(project.id);
    assert.equal(healthyObservation.state, "fresh");
    assert.deepEqual(healthyObservation.pending.map((item) => item.operationId), [second.id]);

    const secondPublication = await store.publish(project.id, "batch_second_after_deleted_metadata");
    assert.equal(secondPublication.state, "confirmed");
    assert.deepEqual(secondPublication.acknowledged.map((item) => item.operationId), [second.id]);
    const replayedFirstBatch = await store.publish(project.id, "batch_deleted_metadata");
    assert.equal(replayedFirstBatch.state, "confirmed");
    assert.deepEqual(replayedFirstBatch.acknowledged.map((item) => item.operationId), [first.id]);
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

test("author approval binds to the exact operation payload", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const approved = operation(snapshot, "manuscript/approved.md", "Approved text.\n", null, "approval_binding_op");
    const proposal = await store.propose(project.id, { id: "proposal_approved", snapshot, operations: [approved], source: "author" });
    await store.approve(project.id, { proposalId: proposal.id, operationIds: [approved.id], authorScope: "owner" });

    const replacement = { ...approved, writes: [{ ...approved.writes[0]!, content: "Changed after approval.\n" }] };
    await store.propose(project.id, { id: "proposal_replacement", snapshot, operations: [replacement], source: "module" });
    await assert.rejects(store.checkpoint(project.id, replacement), (error: unknown) => error instanceof CoreError && error.code === "author_approval_required");

    await assert.rejects(
      store.propose(project.id, { id: proposal.id, snapshot, operations: [replacement], source: "module" }),
      (error: unknown) => error instanceof CoreError && error.code === "proposal_id_reused",
    );
    assert.equal((await store.getProposal(project.id, proposal.id))?.state, "approved");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("author proposal review exposes defensive copies and durable checkpoint status", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const op = operation(snapshot, "manuscript/reviewed.md", "Review this version.\n", null, "review_status_operation");
    const proposal = await store.propose(project.id, { id: "review_status_proposal", snapshot, operations: [op], source: "module" });
    const initial = await store.getProposal(project.id, proposal.id);
    assert.equal(initial?.state, "proposed");
    assert.equal(initial?.stale, false);
    initial!.proposal.operations[0]!.writes[0]!.content = "mutated returned value";
    assert.equal((await store.getProposal(project.id, proposal.id))?.proposal.operations[0]?.writes[0]?.content, "Review this version.\n");

    await store.approve(project.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: "owner" });
    assert.equal((await store.listProposals(project.id))[0]?.state, "approved");
    const receipt = await store.checkpoint(project.id, op);
    const checkpointed = await store.getProposal(project.id, proposal.id);
    assert.equal(checkpointed?.state, "checkpointed");
    assert.deepEqual(checkpointed?.checkpoints, [receipt]);
    assert.deepEqual(checkpointed?.approvedOperationIds, [op.id]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("concurrent proposal ID reuse rejects changed payloads and preserves approval on exact retry", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const readme = await (await store.reader(project.id, "remote")).read("README.md");
    const evidence = {
      id: "mcp_goal_evidence",
      snapshot,
      module: "mcp" as const,
      kind: "task_context",
      paths: [{ path: "README.md", revision: readme?.revision ?? null }],
      details: { goal: "first goal" },
    };
    const op = {
      ...operation(snapshot, "manuscript/proposal-id.md", "Same operation bytes.\n", null, "proposal_id_binding_op"),
      evidenceIds: [evidence.id],
    };
    const firstPayload = {
      id: "proposal_id_binding",
      snapshot,
      operations: [op],
      source: "mcp" as const,
      evidence: [evidence],
    };
    const changedPayload = {
      ...firstPayload,
      evidence: [{ ...evidence, details: { goal: "changed goal" } }],
    };
    const outcomes = await Promise.allSettled([
      store.propose(project.id, firstPayload),
      store.propose(project.id, changedPayload),
    ]);
    const accepted = outcomes.filter((outcome): outcome is PromiseFulfilledResult<typeof firstPayload> => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof CoreError);
    assert.equal((rejected[0]?.reason as CoreError).code, "proposal_id_reused");

    const originalProposal = accepted[0]!.value;
    await store.approve(project.id, { proposalId: originalProposal.id, operationIds: [op.id], authorScope: "owner" });
    assert.deepEqual(await store.propose(project.id, originalProposal), originalProposal);
    assert.equal((await store.getProposal(project.id, originalProposal.id))?.state, "approved");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("pending proposals survive a CoreStore process restart through the local journal", async () => {
  const fixture = await remoteFixture();
  try {
    const dataDir = path.join(fixture.root, "state");
    const firstStore = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await firstStore.registerProject({ url: fixture.remote });
    const snapshot = (await firstStore.observe(project.id)).snapshot;
    const op = {
      ...operation(snapshot, "manuscript/journaled.md", "Pending draft.\n", null, "journaled_pending_operation"),
      evidenceIds: ["pending_evidence"],
    };
    const proposal = await firstStore.propose(project.id, {
      id: "journaled_pending_proposal",
      snapshot,
      operations: [op],
      source: "mcp",
      evidence: [{
        id: "pending_evidence",
        snapshot,
        module: "mcp",
        kind: "source_ncs_mapping",
        paths: [],
        details: { sourceChangeSetId: "source-set-17", goalToOperation: { goalA: op.id } },
      }],
    });

    const restartedStore = new CoreStore({ dataDir, allowLocalRemotes: true });
    const recovered = await restartedStore.getProposal(project.id, proposal.id);
    assert.equal(recovered?.state, "proposed");
    assert.deepEqual(recovered?.proposal, proposal);
    assert.deepEqual(recovered?.publishedOperationIds, []);
    assert.deepEqual(recovered?.checkpoints, []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("accepted proposal evidence and publication state reconstruct after full Core data loss", async () => {
  const fixture = await remoteFixture();
  try {
    const dataDir = path.join(fixture.root, "state");
    const originalStore = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await originalStore.registerProject({ url: fixture.remote });
    const snapshot = (await originalStore.observe(project.id)).snapshot;
    const selected = operation(snapshot, "manuscript/selected.md", "Selected effect.\n", null, "selected_manifest_operation");
    const unselected = operation(snapshot, "manuscript/unselected.md", "Unselected workflow data.\n", null, "unselected_manifest_operation");
    const proposal = {
      id: "accepted_mcp_proposal_manifest",
      snapshot,
      operations: [selected, unselected],
      source: "mcp" as const,
      evidence: [{
        id: "source_ncs_map",
        snapshot,
        module: "mcp" as const,
        kind: "source_change_set_mapping",
        paths: [],
        details: { sourceChangeSetId: "ncs-22", goalToOperation: { acceptedGoal: selected.id, pendingGoal: unselected.id } },
      }],
    };
    await originalStore.propose(project.id, proposal);
    await originalStore.approve(project.id, { proposalId: proposal.id, operationIds: [selected.id], authorScope: "owner" });
    const checkpoint = await originalStore.checkpoint(project.id, selected);
    await fs.writeFile(path.join(fixture.seed, "remote-note.txt"), "Upstream disjoint change.\n");
    await git(fixture.seed, "add", "remote-note.txt");
    await git(fixture.seed, "commit", "-m", "Disjoint upstream change for proposal recovery");
    await git(fixture.seed, "push", "origin", "main");
    const published = await originalStore.publish(project.id, "proposal_manifest_publish");
    assert.equal(published.state, "confirmed");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:manuscript/selected.md`), "Selected effect.");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:remote-note.txt`), "Upstream disjoint change.");
    await assert.rejects(git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:manuscript/unselected.md`));

    await git(fixture.seed, "fetch", "origin", "main");
    await git(fixture.seed, "reset", "--hard", "origin/main");
    await git(fixture.seed, "rm", `meta/scriptorium/proposals/v1/${proposal.id}.json`);
    await git(fixture.seed, "commit", "-m", "Remove visible accepted proposal metadata");
    await git(fixture.seed, "push", "origin", "main");
    await fs.rm(dataDir, { recursive: true, force: true });
    const recoveredStore = new CoreStore({ dataDir, allowLocalRemotes: true });
    const recoveredProject = await recoveredStore.registerProject({ url: fixture.remote });
    const recovered = await recoveredStore.getProposal(recoveredProject.id, proposal.id);
    assert.equal(recovered?.state, "partially_approved");
    assert.deepEqual(recovered?.proposal, proposal);
    assert.deepEqual(recovered?.approvedOperationIds, [selected.id]);
    assert.deepEqual(recovered?.checkpoints.map((receipt) => receipt.operationId), [selected.id]);
    assert.deepEqual(recovered?.publishedOperationIds, [selected.id]);
    assert.equal(recovered?.checkpoints[0]?.operationId, checkpoint.operationId);
    assert.deepEqual((await recoveredStore.listProposals(recoveredProject.id)).map((item) => item.proposal.id), [proposal.id]);

    const rebound = {
      ...proposal,
      evidence: [{ ...proposal.evidence[0]!, details: { sourceChangeSetId: "different-source-set" } }],
    };
    await assert.rejects(recoveredStore.propose(recoveredProject.id, rebound), (error: unknown) =>
      error instanceof CoreError && error.code === "proposal_id_reused");
    assert.deepEqual((await recoveredStore.observe(recoveredProject.id)).pending, []);
    assert.equal(await recoveredStore.reader(recoveredProject.id, "remote").then((reader) => reader.read("manuscript/unselected.md")), null);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("proposal status counts approved and checkpointed operations only once", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const first = operation(snapshot, "manuscript/status-first.md", "First operation.\n", null, "status_union_first");
    const second = operation(snapshot, "manuscript/status-second.md", "Second operation.\n", null, "status_union_second");
    const proposal = await store.propose(project.id, {
      id: "status_union_proposal",
      snapshot,
      operations: [first, second],
      source: "module",
    });

    await store.approve(project.id, { proposalId: proposal.id, operationIds: [first.id], authorScope: "owner" });
    await store.checkpoint(project.id, first);
    let status = await store.getProposal(project.id, proposal.id);
    assert.equal(status?.state, "partially_approved");
    assert.deepEqual(status?.approvedOperationIds, [first.id]);
    assert.deepEqual(status?.checkpoints.map((receipt) => receipt.operationId), [first.id]);

    await store.approve(project.id, { proposalId: proposal.id, operationIds: [first.id, second.id], authorScope: "owner" });
    status = await store.getProposal(project.id, proposal.id);
    assert.equal(status?.state, "approved");
    await store.checkpoint(project.id, second);
    status = await store.getProposal(project.id, proposal.id);
    assert.equal(status?.state, "checkpointed");
    assert.deepEqual(status?.checkpoints.map((receipt) => receipt.operationId), [first.id, second.id]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("approval is rejected when the proposal's remote snapshot has changed", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const op = operation(snapshot, "manuscript/stale-approval.md", "Proposed text.\n", null, "stale_approval_op");
    const proposal = await store.propose(project.id, { id: "stale_approval_proposal", snapshot, operations: [op], source: "author" });

    await fs.writeFile(path.join(fixture.seed, "upstream.md"), "Changed after proposal.\n");
    await git(fixture.seed, "add", "upstream.md");
    await git(fixture.seed, "commit", "-m", "Change repository after proposal");
    await git(fixture.seed, "push", "origin", "main");
    assert.equal((await store.getProposal(project.id, proposal.id))?.stale, true);
    await assert.rejects(
      store.approve(project.id, { proposalId: proposal.id, operationIds: [op.id], authorScope: "owner" }),
      (error: unknown) => error instanceof CoreError && error.code === "proposal_snapshot_stale",
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("scene snapshot exposes full documents, preserved YAML, and absent-file preconditions", async () => {
  const fixture = await remoteFixture();
  try {
    const volume = path.join(fixture.seed, "plot/volumes/v1");
    const chapter = path.join(volume, "chapters/c1");
    await fs.mkdir(path.join(chapter, "scenes"), { recursive: true });
    await fs.mkdir(path.join(fixture.seed, "manuscript/v1/c1"), { recursive: true });
    await fs.writeFile(path.join(volume, "volume.yaml"), "id: v1\ntitle: Volume\ncustom: preserve-volume\n");
    await fs.writeFile(path.join(chapter, "chapter.yaml"), "id: c1\ntitle: Chapter\ncustom: preserve-chapter\n");
    const sceneYaml = "id: scene1\ntitle: First Scene\nmanuscript: manuscript/v1/c1/scene1.md\ncustom: preserve-scene\n";
    await fs.writeFile(path.join(chapter, "scenes/scene1.yaml"), sceneYaml);
    await git(fixture.seed, "add", ".");
    await git(fixture.seed, "commit", "-m", "Add scene metadata without manuscript");
    await git(fixture.seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const first = await store.readTreeSnapshot(project.id, "remote");
    const scene = await store.readSceneSnapshot(project.id, "scene1", "remote", first.snapshot);
    assert.deepEqual(scene.snapshot, first.snapshot);
    assert.equal(scene.document.path, "manuscript/v1/c1/scene1.md");
    assert.equal(scene.document.content, "");
    assert.equal(scene.document.revision, null);
    assert.equal(scene.metadata.content, sceneYaml);
    assert.equal(scene.scene.title, "First Scene");

    const fullDocument = "---\ncustom: preserve-frontmatter\n---\nBody text.\n";
    await fs.writeFile(path.join(fixture.seed, "manuscript/v1/c1/scene1.md"), fullDocument);
    await git(fixture.seed, "add", "manuscript/v1/c1/scene1.md");
    await git(fixture.seed, "commit", "-m", "Add scene manuscript");
    await git(fixture.seed, "push", "origin", "main");
    const latest = await store.readSceneSnapshot(project.id, "scene1", "remote");
    assert.equal(latest.document.content, fullDocument);
    assert.equal(latest.document.revision, createHash("sha256").update(fullDocument).digest("hex"));
    assert.equal(latest.scene.text, "Body text.\n");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("binary operation writes preserve exact bytes in the workspace and a replacement clone", async () => {
  const fixture = await remoteFixture();
  try {
    const dataDir = path.join(fixture.root, "state");
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const bytes = Buffer.from([0, 255, 128, 13, 10, 65, 0]);
    const op: ChangeOperation = {
      id: "binary_attachment_op",
      generation: 1,
      repository: snapshot.repository,
      baseRemoteCommit: snapshot.remoteCommit,
      effect: "metadata",
      reads: [{ path: "attachments/raw.bin", revision: null }],
      writes: [{ path: "attachments/raw.bin", revision: null, content: bytes.toString("base64"), encoding: "base64" }],
      message: "Store a binary attachment",
    };
    await approveAndCheckpoint(store, project.id, snapshot, op);
    assert.deepEqual(await fs.readFile(path.join(dataDir, "projects", project.id, "attachments/raw.bin")), bytes);
    const publication = await store.publish(project.id, "batch_binary_attachment");
    assert.equal(publication.state, "confirmed");
    const remoteBinary = await (await store.reader(project.id, "remote")).read("attachments/raw.bin", "base64");
    assert.equal(remoteBinary?.content, bytes.toString("base64"));
    assert.equal(remoteBinary?.revision, createHash("sha256").update(bytes).digest("hex"));

    const replacement = new CoreStore({ dataDir: path.join(fixture.root, "replacement-state"), allowLocalRemotes: true });
    const clone = await replacement.registerProject({ url: fixture.remote });
    assert.deepEqual(await fs.readFile(path.join(replacement.dataDir, "projects", clone.id, "attachments/raw.bin")), bytes);
    const clonedBinary = await (await replacement.reader(clone.id, "remote")).read("attachments/raw.bin", "base64");
    assert.equal(clonedBinary?.content, bytes.toString("base64"));
    assert.equal(clonedBinary?.revision, createHash("sha256").update(bytes).digest("hex"));
    assert.equal((await replacement.observe(clone.id)).pending.length, 0);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("checkpoints preserve unrelated staged and untracked project files", async () => {
  const fixture = await remoteFixture();
  try {
    const dataDir = path.join(fixture.root, "state");
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const workspace = path.join(dataDir, "projects", project.id);
    await fs.writeFile(path.join(workspace, "unknown-author.yaml"), "custom: staged\n");
    await git(workspace, "add", "unknown-author.yaml");
    await fs.writeFile(path.join(workspace, "untracked-note.md"), "Keep this local note.\n");

    const snapshot = (await store.observe(project.id)).snapshot;
    const op = operation(snapshot, "manuscript/saved.md", "Saved through the operation queue.\n", null, "preserve_other_files_op");
    await approveAndCheckpoint(store, project.id, snapshot, op);
    assert.equal(await fs.readFile(path.join(workspace, "unknown-author.yaml"), "utf8"), "custom: staged\n");
    assert.equal(await fs.readFile(path.join(workspace, "untracked-note.md"), "utf8"), "Keep this local note.\n");
    assert.deepEqual((await git(workspace, "diff", "--cached", "--name-only")).split(/\r?\n/).filter(Boolean), ["unknown-author.yaml"]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("scratch Markdown and attachments use the generic multi-file checkpoint queue", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const attachment = Buffer.from([0, 255, 128, 65]);
    const operation: ChangeOperation = {
      id: "scratch_multi_file_op",
      generation: 1,
      repository: snapshot.repository,
      baseRemoteCommit: snapshot.remoteCommit,
      effect: "metadata",
      reads: [
        { path: "meta/scratch/ideas/scene.md", revision: null },
        { path: "meta/scratch/ideas/reference.bin", revision: null },
      ],
      writes: [
        { path: "meta/scratch/ideas/scene.md", revision: null, content: "Scratch notes.\n" },
        { path: "meta/scratch/ideas/reference.bin", revision: null, content: attachment.toString("base64"), encoding: "base64" },
      ],
      message: "Save scratch scene and reference",
    };
    const receipt = await approveAndCheckpoint(store, project.id, snapshot, operation);
    const checkpointReader = await store.reader(project.id, "checkpoint");
    assert.equal((await checkpointReader.read("meta/scratch/ideas/scene.md"))?.content, "Scratch notes.\n");
    assert.equal((await store.observe(project.id)).pending[0]?.operationId, operation.id);
    const published = await store.publish(project.id, "scratch_publish_batch");
    assert.equal(published.state, "confirmed");
    assert.deepEqual(published.acknowledged, [receipt]);

    const replacement = new CoreStore({ dataDir: path.join(fixture.root, "replacement-state"), allowLocalRemotes: true });
    const clone = await replacement.registerProject({ url: fixture.remote });
    const restoredReader = await replacement.reader(clone.id, "remote");
    assert.equal((await restoredReader.read("meta/scratch/ideas/scene.md"))?.content, "Scratch notes.\n");
    const restoredAttachment = await fs.readFile(path.join(replacement.dataDir, "projects", clone.id, "meta/scratch/ideas/reference.bin"));
    assert.deepEqual(restoredAttachment, attachment);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("generic operations cannot replace Core authority metadata but may write module metadata", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const reserved = operation(snapshot, "meta/scriptorium/operations/v1/forged.json", "{}\n", null, "reserved_metadata_op");
    await assert.rejects(
      store.propose(project.id, { id: "proposal_reserved", snapshot, operations: [reserved], source: "module" }),
      (error: unknown) => error instanceof CoreError && error.code === "invalid_change_operation",
    );
    const forgedProposalBinding = operation(snapshot, "meta/scriptorium/proposals/v1/forged.json", "{}\n", null, "reserved_proposal_metadata_op");
    await assert.rejects(
      store.propose(project.id, { id: "proposal_reserved_binding", snapshot, operations: [forgedProposalBinding], source: "module" }),
      (error: unknown) => error instanceof CoreError && error.code === "invalid_change_operation",
    );
    const moduleData = operation(snapshot, "meta/scriptorium/modules/assistant/settings.yaml", "enabled: true\n", null, "module_settings_op");
    const evidence = {
      id: "evidence_module_read",
      snapshot,
      module: "assistant" as const,
      kind: "file_read",
      paths: [{ path: "README.md", revision: "0".repeat(64) }],
      details: { source: "test" },
    };
    await assert.rejects(
      store.propose(project.id, { id: "proposal_bad_evidence", snapshot, operations: [moduleData], source: "module", evidence: [evidence] }),
      (error: unknown) => error instanceof CoreError && error.code === "evidence_snapshot_mismatch",
    );
    const actualReadme = await (await store.reader(project.id, "remote")).read("README.md");
    const evidencedOperation = { ...moduleData, evidenceIds: [evidence.id] };
    const validEvidence = { ...evidence, paths: [{ path: "README.md", revision: actualReadme?.revision ?? null }] };
    const proposed = await store.propose(project.id, {
      id: "proposal_module_metadata",
      snapshot,
      operations: [evidencedOperation],
      source: "module",
      evidence: [validEvidence],
    });
    assert.equal(proposed.operations[0]?.id, moduleData.id);
    assert.deepEqual(proposed.evidence, [validEvidence]);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("reachable Git history keeps operation IDs bound after authority metadata is deleted", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const snapshot = (await store.observe(project.id)).snapshot;
    const op = operation(snapshot, "manuscript/history-bound.md", "Durable ID binding.\n", null, "history_bound_operation");
    const first = await approveAndCheckpoint(store, project.id, snapshot, op);
    const publication = await store.publish(project.id, "batch_history_binding");
    assert.deepEqual(publication.acknowledged, [first]);

    await git(fixture.seed, "fetch", "origin", "main");
    await git(fixture.seed, "reset", "--hard", "origin/main");
    await git(fixture.seed, "rm", `meta/scriptorium/operations/v1/${op.id}.json`, "meta/scriptorium/publications/v1/batch_history_binding.json");
    await git(fixture.seed, "commit", "-m", "Remove visible authority metadata");
    await git(fixture.seed, "push", "origin", "main");

    const replacement = new CoreStore({ dataDir: path.join(fixture.root, "replacement-state"), allowLocalRemotes: true });
    const clone = await replacement.registerProject({ url: fixture.remote });
    assert.deepEqual((await replacement.observe(clone.id)).pending, []);
    assert.deepEqual(await replacement.checkpoint(clone.id, op), first);
    const reused = { ...op, writes: [{ ...op.writes[0]!, content: "Different payload.\n" }] };
    await assert.rejects(replacement.checkpoint(clone.id, reused), (error: unknown) => error instanceof CoreError && error.code === "operation_id_reused");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a clean checkpoint queue advances with the fetched remote before the next edit", async () => {
  const fixture = await remoteFixture();
  try {
    const store = new CoreStore({ dataDir: path.join(fixture.root, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    let snapshot = (await store.observe(project.id)).snapshot;
    const first = operation(snapshot, "manuscript/first.md", "First checkpoint.\n", null, "first_clean_queue_op");
    await approveAndCheckpoint(store, project.id, snapshot, first);
    await fs.writeFile(path.join(fixture.seed, "upstream-before-publish.txt"), "Remote update before replay.\n");
    await git(fixture.seed, "add", "upstream-before-publish.txt");
    await git(fixture.seed, "commit", "-m", "External update before publication");
    await git(fixture.seed, "push", "origin", "main");
    assert.equal((await store.publish(project.id, "batch_first_clean_queue")).state, "confirmed");

    await git(fixture.seed, "fetch", "origin", "main");
    await git(fixture.seed, "reset", "--hard", "origin/main");
    await fs.writeFile(path.join(fixture.seed, "README.md"), "Remote update.\n");
    await git(fixture.seed, "add", "README.md");
    await git(fixture.seed, "commit", "-m", "External update after publication");
    await git(fixture.seed, "push", "origin", "main");
    await store.sync(project.id);

    snapshot = (await store.observe(project.id)).snapshot;
    const remoteReadme = await (await store.reader(project.id, "remote")).read("README.md");
    const next = operation(snapshot, "README.md", "Author update based on fetched remote.\n", remoteReadme?.revision ?? null, "second_clean_queue_op");
    await approveAndCheckpoint(store, project.id, snapshot, next);
    const published = await store.publish(project.id, "batch_second_clean_queue");
    assert.equal(published.state, "confirmed");
    assert.equal(await git(fixture.root, "--git-dir", fixture.remote, "show", `${published.remoteCommit}:README.md`), "Author update based on fetched remote.");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
