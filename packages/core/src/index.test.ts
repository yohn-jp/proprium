import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { createDocumentSource } from "@scriptorium/contracts";
import { CoreError, CoreStore } from "./index.js";

const execFile = promisify(execFileCallback);
const READ_OBSERVATION_MAX_AGE_MS_FOR_TEST = 15_001;

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-c", "user.name=Test Writer", "-c", "user.email=writer@example.test", ...args], { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function writeYaml(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, YAML.stringify(value), "utf8");
}

async function makeProjectFiles(root: string): Promise<void> {
  await writeYaml(path.join(root, "meta", "project.yaml"), { id: "sample", title: "Sample Work", extra: "keep" });
  await writeYaml(path.join(root, "plot", "volumes", "vol-1", "volume.yaml"), {
    id: "vol-1", name: "Volume One", order: 1, unknown: { keep: true },
  });
  await writeYaml(path.join(root, "plot", "volumes", "vol-1", "chapters", "ch-1", "chapter.yaml"), {
    id: "ch-1", volume: "vol-1", title: "Chapter One", order: 1,
  });
  await writeYaml(path.join(root, "plot", "volumes", "vol-1", "chapters", "ch-1", "scenes", "scene-1.yaml"), {
    id: "scene-1",
    type: "scene",
    name: "Scene Name",
    title: "Scene One",
    volume: "vol-1",
    chapter: "ch-1",
    manuscript: "manuscript/vol-1/ch-1/scene-1.md",
    custom: { nested: ["preserve", "me"] },
  });
  const manuscript = path.join(root, "manuscript", "vol-1", "ch-1", "scene-1.md");
  await fs.mkdir(path.dirname(manuscript), { recursive: true });
  await fs.writeFile(manuscript, "---\ntitle: Draft title\nauthor_note: Preserve this\ncustom:\n  nested: true\n---\nOriginal body.\n", "utf8");
}

async function makeRemote(withProject = true): Promise<{ tempDir: string; remote: string; seed: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-core-test-"));
  const remote = path.join(tempDir, "remote.git");
  const seed = path.join(tempDir, "seed");
  await fs.mkdir(seed);
  await runGit(tempDir, "init", "--bare", "--initial-branch=main", remote);
  await runGit(seed, "init", "--initial-branch=main");
  await runGit(seed, "config", "user.name", "Test Writer");
  await runGit(seed, "config", "user.email", "writer@example.test");
  if (withProject) await makeProjectFiles(seed);
  else await fs.writeFile(path.join(seed, "README.md"), "Empty compatible work.\n", "utf8");
  await runGit(seed, "add", ".");
  await runGit(seed, "commit", "-m", "Initial project");
  await runGit(seed, "remote", "add", "origin", remote);
  await runGit(seed, "push", "-u", "origin", "main");
  await runGit(tempDir, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { tempDir, remote, seed };
}

async function projectWorkspace(dataDir: string, projectId: string): Promise<string> {
  return path.join(dataDir, "projects", projectId);
}

test("registers a Git project, preserves frontmatter, rejects stale saves, and synchronizes history", async () => {
  const { tempDir, remote } = await makeRemote();
  const dataDir = path.join(tempDir, "state");
  try {
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    assert.match(project.id, /^[0-9a-f-]{36}$/i);
    assert.equal(project.branch, "main");
    assert.deepEqual(await store.listProjects(), [project]);

    assert.deepEqual(await store.tree(project.id), {
      title: "Sample Work",
      volumes: [{
        id: "vol-1",
        title: "Volume One",
        chapters: [{
          id: "ch-1",
          title: "Chapter One",
          scenes: [{ id: "scene-1", title: "Scene One" }],
        }],
      }],
    });
    const loaded = await store.readScene(project.id, "scene-1");
    assert.equal(loaded.text, "Original body.\n");

    const saved = await store.saveScene(project.id, "scene-1", {
      text: "Edited body.\nSecond line.",
      revision: loaded.revision,
    });
    assert.equal(saved.text, "Edited body.\nSecond line.");
    assert.ok((await store.history(project.id)).every((commit) => /^[0-9a-f]{40}$/i.test(commit.hash)));
    const savedVersions = await store.listManuscriptSnapshots(project.id, "ms-one", "scene-1", "checkpoint");
    assert.equal(savedVersions.snapshots[0]?.sceneId, "scene-1");
    const savedVersion = await store.readManuscriptSnapshot(project.id, "ms-one", savedVersions.snapshots[0]!.id, "checkpoint", savedVersions.snapshot);
    assert.equal(savedVersion?.manuscript.body, "Edited body.\nSecond line.");
    assert.match(savedVersion?.manuscript.document.content ?? "", /author_note: Preserve this/);
    const markdownPath = path.join(await projectWorkspace(dataDir, project.id), "manuscript/vol-1/ch-1/scene-1.md");
    const markdown = await fs.readFile(markdownPath, "utf8");
    assert.ok(markdown.startsWith("---\ntitle: Draft title\nauthor_note: Preserve this\ncustom:\n  nested: true\n---\n"));
    assert.ok(markdown.endsWith("Edited body.\nSecond line."));

    await assert.rejects(
      store.saveScene(project.id, "scene-1", { text: "stale overwrite", revision: loaded.revision }),
      (error: unknown) => error instanceof CoreError && error.status === 409 && error.code === "revision_conflict",
    );
    const latest = await store.readScene(project.id, "scene-1");
    const historyBeforeNoop = await store.history(project.id);
    await store.saveScene(project.id, "scene-1", { text: latest.text, revision: latest.revision });
    assert.equal((await store.history(project.id)).length, historyBeforeNoop.length);
    assert.equal((await store.status(project.id)).ahead, 1);

    const synced = await store.sync(project.id);
    assert.equal(synced.ahead, 0);
    assert.equal(synced.behind, 0);
    const remoteHead = await runGit(tempDir, "--git-dir", remote, "rev-parse", "refs/heads/main");
    assert.equal(synced.head, remoteHead);

    const upstream = path.join(tempDir, "upstream");
    await runGit(tempDir, "clone", remote, upstream);
    await runGit(upstream, "config", "user.name", "Upstream Writer");
    await runGit(upstream, "config", "user.email", "upstream@example.test");
    await fs.writeFile(path.join(upstream, "manuscript/vol-1/ch-1/scene-1.md"), `${markdown}Remote paragraph.\n`, "utf8");
    await runGit(upstream, "add", "manuscript/vol-1/ch-1/scene-1.md");
    await runGit(upstream, "commit", "-m", "Upstream edit");
    await runGit(upstream, "push", "origin", "main");

    const pulled = await store.sync(project.id);
    assert.equal(pulled.ahead, 0);
    assert.equal(pulled.behind, 0);
    assert.equal((await store.readScene(project.id, "scene-1")).text, "Edited body.\nSecond line.Remote paragraph.\n");
    assert.equal((await store.history(project.id))[0]?.message, "Upstream edit");

    const freshStore = new CoreStore({ dataDir, allowLocalRemotes: true });
    assert.deepEqual(await freshStore.listProjects(), [project]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("local durability census reuses only a recent remote observation and catches later checkpoints without fetching", async () => {
  const { tempDir, remote } = await makeRemote();
  const dataDir = path.join(tempDir, "state");
  try {
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const observed = await store.observe(project.id);
    const workspace = await projectWorkspace(dataDir, project.id);
    const clean = await store.localDurabilityCensus(project.id);
    assert.equal(clean.observation.observedAt, observed.observedAt, "the local census preserves the actual remote observation time");
    assert.equal(clean.pendingCheckpoints.length, 0);
    assert.equal(clean.localWorkspaceDirty, false);

    const scene = await store.readScene(project.id, "scene-1");
    await store.saveScene(project.id, "scene-1", { text: "A checkpoint after the status preflight.\n", revision: scene.revision });
    const checkpointObservation = await store.observe(project.id);
    const unavailableRemote = path.join(tempDir, "remote-unavailable.git");
    await fs.rename(remote, unavailableRemote);

    const dirty = await store.localDurabilityCensus(project.id);
    assert.equal(dirty.observation.observedAt, checkpointObservation.observedAt, "a local census cannot relabel local work as a remote observation");
    assert.equal(dirty.observation.snapshot.remoteCommit, checkpointObservation.snapshot.remoteCommit);
    assert.equal(dirty.pendingCheckpoints.length, 1);
    assert.equal(dirty.observation.pending.length, 1, "pending receipts are recomputed from current local refs");
    assert.equal(dirty.localWorkspaceDirty, true);
    assert.equal(await runGit(workspace, "rev-parse", "refs/remotes/origin/main"), checkpointObservation.snapshot.remoteCommit);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("local durability accepts the default remote HEAD alias but rejects other remote HEAD targets", async () => {
  const { tempDir, remote } = await makeRemote();
  const dataDir = path.join(tempDir, "state");
  try {
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    await store.observe(project.id);
    const workspace = await projectWorkspace(dataDir, project.id);
    await runGit(workspace, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    assert.equal((await store.localDurabilityCensus(project.id)).localWorkspaceDirty, false);
    await runGit(workspace, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main");
    assert.equal((await store.localDurabilityCensus(project.id)).localWorkspaceDirty, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("local durability census rejects stale observations and changed remote refs without refreshing", async () => {
  const { tempDir, remote } = await makeRemote();
  const dataDir = path.join(tempDir, "state");
  try {
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const observed = await store.observe(project.id);
    const workspace = await projectWorkspace(dataDir, project.id);
    const realNow = Date.now;
    Date.now = () => realNow() + READ_OBSERVATION_MAX_AGE_MS_FOR_TEST;
    try {
      await assert.rejects(store.localDurabilityCensus(project.id), (error: unknown) =>
        error instanceof CoreError && error.code === "local_observation_stale");
    } finally {
      Date.now = realNow;
    }

    const oldCommit = observed.snapshot.remoteCommit;
    const tree = await runGit(workspace, "rev-parse", `${oldCommit}^{tree}`);
    const changedCommit = await runGit(workspace, "commit-tree", tree, "-p", oldCommit, "-m", "simulated changed tracking ref");
    await runGit(workspace, "update-ref", "refs/remotes/origin/main", changedCommit);
    await assert.rejects(store.localDurabilityCensus(project.id), (error: unknown) =>
      error instanceof CoreError && error.code === "local_observation_ref_changed");
    assert.equal(await runGit(workspace, "rev-parse", "refs/remotes/origin/main"), changedCommit,
      "a failed local census must not fetch and replace the observed tracking ref");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a fresh HEAD probe skips Git fetch when status sees the tracked commit unchanged", async () => {
  const { tempDir, remote } = await makeRemote();
  try {
    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    await store.status(project.id);
    const workspace = await projectWorkspace(path.join(tempDir, "state"), project.id);
    const fetchHeadPath = path.join(workspace, ".git", "FETCH_HEAD");
    const before = await fs.stat(fetchHeadPath, { bigint: true }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await store.status(project.id);
    const after = await fs.stat(fetchHeadPath, { bigint: true }).catch(() => undefined);
    assert.equal(after?.mtimeNs, before?.mtimeNs, "an unchanged remote commit does not create or rewrite FETCH_HEAD");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("reports divergent local and remote histories without replacing the local draft", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  try {
    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const original = await store.readScene(project.id, "scene-1");
    await store.saveScene(project.id, "scene-1", { text: "Local edit.\n", revision: original.revision });
    const firstReconcile = await store.reconcile(project.id);
    assert.ok(firstReconcile.snapshot.overlayCommit, "a checkpoint based on the current remote is visible as a local overlay");
    const repeatedReconcile = await store.reconcile(project.id);
    assert.deepEqual(repeatedReconcile, firstReconcile, "an unchanged remote and local checkpoint reuse the same reconciliation result");

    await fs.writeFile(path.join(seed, "manuscript/vol-1/ch-1/scene-1.md"), "Remote edit.\n", "utf8");
    await runGit(seed, "add", "manuscript/vol-1/ch-1/scene-1.md");
    await runGit(seed, "commit", "-m", "Competing remote edit");
    await runGit(seed, "push", "origin", "main");

    const changedHead = await store.reconcile(project.id);
    assert.notEqual(changedHead.snapshot.remoteCommit, firstReconcile.snapshot.remoteCommit,
      "a new remote HEAD invalidates the cached overlay");
    assert.equal(changedHead.snapshot.overlayCommit, undefined,
      "a conflicting checkpoint is not replayed onto the changed remote snapshot");
    assert.ok(changedHead.operations.some((operation) => operation.state === "conflict"));

    await assert.rejects(
      store.sync(project.id),
      (error: unknown) => error instanceof CoreError && error.status === 409 && error.code === "sync_conflict",
    );
    assert.equal((await store.readScene(project.id, "scene-1")).text, "Local edit.\n");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("preserves history records with empty commit subjects", async () => {
  const { tempDir, remote } = await makeRemote();
  try {
    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const workspace = await projectWorkspace(path.join(tempDir, "state"), project.id);
    const historyFile = path.join(workspace, "history.md");
    await runGit(workspace, "config", "user.name", "History Writer");
    await runGit(workspace, "config", "user.email", "history@example.test");

    await fs.writeFile(historyFile, "Before empty message.\n", "utf8");
    await runGit(workspace, "add", "history.md");
    await runGit(workspace, "commit", "-m", "History before empty subject");
    await fs.writeFile(historyFile, "Empty message commit.\n", "utf8");
    await runGit(workspace, "add", "history.md");
    await runGit(workspace, "commit", "--allow-empty-message", "-m", "");
    await fs.writeFile(historyFile, "After empty message.\n", "utf8");
    await runGit(workspace, "add", "history.md");
    await runGit(workspace, "commit", "-m", "History after empty subject");

    const history = await store.history(project.id);
    assert.deepEqual(history.slice(0, 3).map((commit) => commit.message), [
      "History after empty subject",
      "",
      "History before empty subject",
    ]);
    assert.ok(history.every((commit) => /^[0-9a-f]{40}$/i.test(commit.hash)));
    assert.ok(history.every((commit) => !Number.isNaN(Date.parse(commit.date))));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("serializes simultaneous stale-revision saves through one CoreStore", async () => {
  const { tempDir, remote } = await makeRemote();
  try {
    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const scene = await store.readScene(project.id, "scene-1");
    const historyLength = (await store.history(project.id)).length;
    const outcomes = await Promise.allSettled([
      store.saveScene(project.id, "scene-1", { text: "Concurrent winner A.\n", revision: scene.revision }),
      store.saveScene(project.id, "scene-1", { text: "Concurrent winner B.\n", revision: scene.revision }),
    ]);

    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0]?.status === "rejected" && losers[0].reason instanceof CoreError);
    if (losers[0]?.status === "rejected") {
      assert.equal(losers[0].reason.code, "revision_conflict");
    }
    assert.equal((await store.readScene(project.id, "scene-1")).text, winners[0]?.status === "fulfilled" ? winners[0].value.text : "");
    assert.equal((await store.history(project.id)).length, historyLength + 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("serializes saves from separate CoreStore instances sharing one data directory", async () => {
  const { tempDir, remote } = await makeRemote();
  const dataDir = path.join(tempDir, "state");
  try {
    const firstStore = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await firstStore.registerProject({ url: remote });
    const secondStore = new CoreStore({ dataDir, allowLocalRemotes: true });
    const scene = await firstStore.readScene(project.id, "scene-1");
    const historyLength = (await firstStore.history(project.id)).length;
    const outcomes = await Promise.allSettled([
      firstStore.saveScene(project.id, "scene-1", { text: "Cross-instance winner A.\n", revision: scene.revision }),
      secondStore.saveScene(project.id, "scene-1", { text: "Cross-instance winner B.\n", revision: scene.revision }),
    ]);

    const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.ok(losers[0]?.status === "rejected" && losers[0].reason instanceof CoreError);
    if (losers[0]?.status === "rejected") {
      assert.ok(
        (losers[0].reason.code === "project_busy" && losers[0].reason.status === 423) ||
        (losers[0].reason.code === "revision_conflict" && losers[0].reason.status === 409),
      );
    }

    const winnerText = winners[0]?.status === "fulfilled" ? winners[0].value.text : "";
    assert.match(winnerText, /^Cross-instance winner [AB]\.\n$/);
    assert.equal((await new CoreStore({ dataDir, allowLocalRemotes: true }).readScene(project.id, "scene-1")).text, winnerText);
    assert.equal((await firstStore.history(project.id)).length, historyLength + 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("loads a truly empty remote and protects project paths from traversal and symlinks", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-empty-test-"));
  const remote = path.join(tempDir, "empty.git");
  try {
    await runGit(tempDir, "init", "--bare", "--initial-branch=main", remote);
    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    assert.deepEqual((await store.tree(project.id)).volumes, []);
    assert.deepEqual(await store.history(project.id), []);
    assert.deepEqual(await store.status(project.id), { branch: "main", head: "", ahead: 0, behind: 0, dirty: false });
    assert.deepEqual(await store.sync(project.id), { branch: "main", head: "", ahead: 0, behind: 0, dirty: false });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("creates a missing manuscript link and its nested Markdown file on first save", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  try {
    const yamlPath = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml");
    const sceneData = YAML.parse(await fs.readFile(yamlPath, "utf8")) as Record<string, unknown>;
    delete sceneData.manuscript;
    await fs.writeFile(yamlPath, YAML.stringify(sceneData), "utf8");
    await fs.rm(path.join(seed, "manuscript"), { recursive: true, force: true });
    await runGit(seed, "add", ".");
    await runGit(seed, "commit", "-m", "Remove optional manuscript link");
    await runGit(seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const scene = await store.readScene(project.id, "scene-1");
    assert.equal(scene.text, "");
    const saved = await store.saveScene(project.id, "scene-1", { text: "First draft.", revision: scene.revision });
    assert.equal(saved.text, "First draft.");
    assert.equal((await store.readScene(project.id, "scene-1")).text, "First draft.");
    const storedYaml = YAML.parse(await fs.readFile(path.join(await projectWorkspace(path.join(tempDir, "state"), project.id), "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml"), "utf8")) as Record<string, unknown>;
    assert.equal(storedYaml.manuscript, "manuscript/vol-1/ch-1/scene-1.md");
    assert.deepEqual(storedYaml.custom, { nested: ["preserve", "me"] });
    assert.equal(storedYaml.name, "Scene Name");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("uses literal manuscript paths for commits so wildcard names cannot capture unrelated edits", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  try {
    const sceneYaml = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml");
    const sceneData = YAML.parse(await fs.readFile(sceneYaml, "utf8")) as Record<string, unknown>;
    sceneData.manuscript = "manuscript/vol-1/ch-1/*.md";
    await fs.writeFile(sceneYaml, YAML.stringify(sceneData), "utf8");
    const chapterDir = path.join(seed, "manuscript/vol-1/ch-1");
    await fs.writeFile(path.join(chapterDir, "*.md"), "Wildcard scene.\n", "utf8");
    await fs.writeFile(path.join(chapterDir, "other.md"), "Unrelated original.\n", "utf8");
    await runGit(seed, "add", ".");
    await runGit(seed, "commit", "-m", "Use a wildcard character in manuscript filename");
    await runGit(seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const workspace = await projectWorkspace(path.join(tempDir, "state"), project.id);
    const unrelatedPath = path.join(workspace, "manuscript/vol-1/ch-1/other.md");
    await fs.writeFile(unrelatedPath, "Unrelated local edit.\n", "utf8");
    const scene = await store.readScene(project.id, "scene-1");
    await store.saveScene(project.id, "scene-1", { text: "Updated wildcard scene.\n", revision: scene.revision });

    assert.equal(await runGit(workspace, "show", "HEAD:manuscript/vol-1/ch-1/other.md"), "Unrelated original.");
    assert.match(await runGit(workspace, "status", "--porcelain"), /other\.md/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects an invalid project ID before creating a project lock path", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-id-test-"));
  const dataDir = path.join(tempDir, "state");
  const store = new CoreStore({ dataDir, allowLocalRemotes: true });
  const invalidId = `../${"x".repeat(33)}`;
  const escapedLockPath = path.resolve(dataDir, ".locks", invalidId);
  try {
    await assert.rejects(store.status(invalidId), (error: unknown) =>
      error instanceof CoreError && error.status === 404 && error.code === "project_not_found");
    await assert.rejects(fs.access(escapedLockPath), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects manuscript paths that escape the project or pass through a symlink", async () => {
  const traversal = await makeRemote();
  const link = await makeRemote();
  try {
    const sceneYaml = path.join(traversal.seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml");
    const sceneData = YAML.parse(await fs.readFile(sceneYaml, "utf8")) as Record<string, unknown>;
    sceneData.manuscript = "../../../../etc/passwd";
    await fs.writeFile(sceneYaml, YAML.stringify(sceneData), "utf8");
    await runGit(traversal.seed, "add", ".");
    await runGit(traversal.seed, "commit", "-m", "Unsafe manuscript path");
    await runGit(traversal.seed, "push", "origin", "main");

    const storeA = new CoreStore({ dataDir: path.join(traversal.tempDir, "state"), allowLocalRemotes: true });
    const projectA = await storeA.registerProject({ url: traversal.remote });
    await assert.rejects(storeA.readScene(projectA.id, "scene-1"), (error: unknown) =>
      error instanceof CoreError && error.code === "invalid_manuscript_path");

    const manuscript = path.join(link.seed, "manuscript/vol-1/ch-1/scene-1.md");
    await fs.rm(manuscript);
    await fs.symlink("/etc/passwd", manuscript);
    await runGit(link.seed, "add", ".");
    await runGit(link.seed, "commit", "-m", "Symbolic link manuscript");
    await runGit(link.seed, "push", "origin", "main");

    const storeB = new CoreStore({ dataDir: path.join(link.tempDir, "state"), allowLocalRemotes: true });
    const projectB = await storeB.registerProject({ url: link.remote });
    await assert.rejects(storeB.readScene(projectB.id, "scene-1"), (error: unknown) =>
      error instanceof CoreError && error.code === "unsafe_manuscript_path");
  } finally {
    await fs.rm(traversal.tempDir, { recursive: true, force: true });
    await fs.rm(link.tempDir, { recursive: true, force: true });
  }
});

test("remembers when an initially empty remote acquires a branch", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-empty-remote-test-"));
  const remote = path.join(tempDir, "remote.git");
  const seed = path.join(tempDir, "seed");
  try {
    await runGit(tempDir, "init", "--bare", "--initial-branch=main", remote);
    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    await fs.mkdir(seed);
    await runGit(seed, "init", "--initial-branch=main");
    await runGit(seed, "config", "user.name", "Test Writer");
    await runGit(seed, "config", "user.email", "writer@example.test");
    await fs.writeFile(path.join(seed, "README.md"), "Remote content.\n", "utf8");
    await runGit(seed, "add", "README.md");
    await runGit(seed, "commit", "-m", "Populate remote");
    await runGit(seed, "remote", "add", "origin", remote);
    await runGit(seed, "push", "origin", "main");

    assert.equal((await store.sync(project.id)).head, await runGit(seed, "rev-parse", "HEAD"));
    await runGit(tempDir, "--git-dir", remote, "update-ref", "-d", "refs/heads/main");
    await assert.rejects(store.sync(project.id), (error: unknown) =>
      error instanceof CoreError && error.status === 409 && error.code === "remote_branch_missing");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("rejects .git manuscript paths without corrupting an active dotted branch ref", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  try {
    const sceneYaml = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml");
    const sceneData = YAML.parse(await fs.readFile(sceneYaml, "utf8")) as Record<string, unknown>;
    sceneData.manuscript = ".git/refs/heads/main.md";
    await fs.writeFile(sceneYaml, YAML.stringify(sceneData), "utf8");
    await runGit(seed, "add", sceneYaml);
    await runGit(seed, "commit", "-m", "Use a forbidden Git metadata path");
    await runGit(seed, "push", "origin", "main");
    await runGit(seed, "branch", "main.md");
    await runGit(seed, "push", "origin", "main.md");
    await runGit(tempDir, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main.md");

    const dataDir = path.join(tempDir, "state");
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote, branch: "main.md" });
    const workspace = await projectWorkspace(dataDir, project.id);
    const headBefore = await runGit(workspace, "rev-parse", "HEAD");
    const yamlPath = path.join(workspace, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml");
    const yamlBefore = await fs.readFile(yamlPath, "utf8");
    const rejectsUnsafePath = (error: unknown) =>
      error instanceof CoreError && error.status === 422 && error.code === "invalid_manuscript_path";

    await assert.rejects(store.readScene(project.id, "scene-1"), rejectsUnsafePath);
    await assert.rejects(
      store.saveScene(project.id, "scene-1", { text: "Must not overwrite Git metadata.\n", revision: "0".repeat(64) }),
      rejectsUnsafePath,
    );

    assert.equal(await runGit(workspace, "rev-parse", "HEAD"), headBefore);
    assert.equal(await runGit(workspace, "show-ref", "--verify", "--hash", "refs/heads/main.md"), headBefore);
    assert.equal(await runGit(workspace, "cat-file", "-e", `${headBefore}^{commit}`), "");
    assert.equal(await fs.readFile(yamlPath, "utf8"), yamlBefore);
    assert.equal(await runGit(workspace, "status", "--porcelain"), "");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("requires a GitHub HTTPS URL in production mode", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-url-test-"));
  try {
    const store = new CoreStore({ dataDir: path.join(tempDir, "state") });
    await assert.rejects(
      store.registerProject({ url: "https://github.com.evil.invalid/owner/repo" }),
      (error: unknown) => error instanceof CoreError && error.code === "invalid_repository_url",
    );
    await assert.rejects(
      store.registerProject({ url: "https://user:secret@github.com/owner/repo" }),
      (error: unknown) => error instanceof CoreError && error.code === "invalid_repository_url",
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("hosted CoreStore has no shared-token or local-remote fallback and rejects unassigned repositories before network access", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-hosted-core-test-"));
  const binding = {
    repositoryId: 342_100_801,
    repositoryLocator: "https://github.com/yohn-jp/assigned-work",
    instanceId: "instance_hosted_test",
    runtimeEpoch: 7,
  };
  let credentialRequests = 0;
  const provider = {
    async getCredential() {
      credentialRequests += 1;
      return {
        username: "x-access-token" as const,
        token: "test-scoped-token",
        repositoryId: binding.repositoryId,
        permission: "read" as const,
        runtimeEpoch: binding.runtimeEpoch,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  const previousToken = process.env.SCRIPTORIUM_GITHUB_TOKEN;
  try {
    delete process.env.SCRIPTORIUM_GITHUB_TOKEN;
    assert.throws(
      () => new CoreStore({ dataDir: path.join(tempDir, "missing-provider"), hostedRepository: binding }),
      /requires a GitCredentialProvider/u,
    );
    assert.throws(
      () => new CoreStore({ dataDir: path.join(tempDir, "static-option"), hostedRepository: binding, githubToken: "static-token", gitCredentialProvider: provider }),
      /Shared GitHub tokens are forbidden/u,
    );
    process.env.SCRIPTORIUM_GITHUB_TOKEN = "static-environment-token";
    assert.throws(
      () => new CoreStore({ dataDir: path.join(tempDir, "static-environment"), hostedRepository: binding, gitCredentialProvider: provider }),
      /Shared GitHub tokens are forbidden/u,
    );
    delete process.env.SCRIPTORIUM_GITHUB_TOKEN;
    assert.throws(
      () => new CoreStore({ dataDir: path.join(tempDir, "local-remote"), hostedRepository: binding, gitCredentialProvider: provider, allowLocalRemotes: true }),
      /Local remotes are forbidden/u,
    );

    const store = new CoreStore({ dataDir: path.join(tempDir, "assigned-only"), hostedRepository: binding, gitCredentialProvider: provider });
    await assert.rejects(
      store.registerProject({ url: "https://github.com/yohn-jp/other-work" }),
      (error: unknown) => error instanceof CoreError && error.status === 403 && error.code === "hosted_repository_mismatch",
    );
    assert.equal(credentialRequests, 0);
  } finally {
    if (previousToken === undefined) delete process.env.SCRIPTORIUM_GITHUB_TOKEN;
    else process.env.SCRIPTORIUM_GITHUB_TOKEN = previousToken;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("hosted clones omit remote tags but keep manually created tags unsafe", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  const hostedUrl = "https://github.com/yohn-jp/tagged-work.git";
  const binding = {
    repositoryId: 342_100_802,
    repositoryLocator: hostedUrl,
    instanceId: "instance_tagged_test",
    runtimeEpoch: 8,
  };
  const previousToken = process.env.SCRIPTORIUM_GITHUB_TOKEN;
  try {
    delete process.env.SCRIPTORIUM_GITHUB_TOKEN;
    await runGit(seed, "tag", "remote-release-v1");
    await runGit(seed, "push", "origin", "refs/tags/remote-release-v1");

    const standaloneStore = new CoreStore({ dataDir: path.join(tempDir, "standalone"), allowLocalRemotes: true });
    const standaloneProject = await standaloneStore.registerProject({ url: remote });
    const standaloneWorkspace = await projectWorkspace(standaloneStore.dataDir, standaloneProject.id);
    assert.equal(await runGit(standaloneWorkspace, "for-each-ref", "--format=%(refname)", "refs/tags"), "refs/tags/remote-release-v1");

    const credentialProvider = {
      async getCredential() {
        return {
          username: "x-access-token" as const,
          token: "test-scoped-token",
          repositoryId: binding.repositoryId,
          permission: "read" as const,
          runtimeEpoch: binding.runtimeEpoch,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const store = new CoreStore({
      dataDir: path.join(tempDir, "hosted"),
      hostedRepository: binding,
      gitCredentialProvider: credentialProvider,
      fetch: async () => Response.json({
        id: binding.repositoryId,
        default_branch: "main",
        owner: { id: 100_200_300, login: "yohn-jp" },
      }),
    });
    const originalAuthenticatedGit = Reflect.get(store, "authenticatedGit");
    assert.equal(typeof originalAuthenticatedGit, "function");
    Reflect.set(store, "authenticatedGit", async (...values: unknown[]): Promise<string> => {
      const args = values[2];
      if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string")) {
        throw new Error("Core passed invalid arguments to authenticatedGit");
      }
      const gitArgs = args as string[];
      if (gitArgs[0] === "clone") {
        assert.ok(gitArgs.includes("--no-tags"), "every Hosted clone must suppress implicit remote-tag fetches");
      }
      const localArgs = gitArgs.map((argument) => argument === hostedUrl ? remote : argument);
      const output: unknown = await Reflect.apply(originalAuthenticatedGit, store, [
        values[0], values[1], localArgs, ...values.slice(3),
      ]);
      if (typeof output !== "string") throw new Error("authenticatedGit returned an invalid result");
      return output;
    });

    const project = await store.registerProject({ url: binding.repositoryLocator });
    let workspace = await projectWorkspace(store.dataDir, project.id);
    assert.equal(await runGit(workspace, "for-each-ref", "--format=%(refname)", "refs/tags"), "",
      "the initial Hosted clone must not import ordinary remote tags as local refs");
    await store.observe(project.id);
    const initialCensus = await store.localDurabilityCensus(project.id);
    assert.equal(initialCensus.localWorkspaceDirty, false, "remote tags alone must not block Hosted safe stop");

    await store.reconstructProject(project.id);
    workspace = await projectWorkspace(store.dataDir, project.id);
    assert.equal(await runGit(workspace, "for-each-ref", "--format=%(refname)", "refs/tags"), "",
      "the verified replacement clone must also omit remote tags");
    await store.observe(project.id);
    assert.equal((await store.localDurabilityCensus(project.id)).localWorkspaceDirty, false,
      "the replacement workspace with remote tags must remain quiesce-safe");
    const head = await runGit(workspace, "rev-parse", "HEAD");
    await runGit(workspace, "tag", "manual-unverified", head);
    const manualTagCensus = await store.localDurabilityCensus(project.id);
    assert.equal(manualTagCensus.localWorkspaceDirty, true,
      "a user-created tag remains an unknown local durability reference");
  } finally {
    if (previousToken === undefined) delete process.env.SCRIPTORIUM_GITHUB_TOKEN;
    else process.env.SCRIPTORIUM_GITHUB_TOKEN = previousToken;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("search and writing statistics read one pinned remote snapshot", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  const sceneOnePath = path.join(seed, "manuscript/vol-1/ch-1/scene-1.md");
  const sceneOneYamlPath = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml");
  const renamedSceneOnePath = path.join(seed, "manuscript/vol-1/ch-1/renamed-scene-1.md");
  const sceneTwoYamlPath = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml");
  const sceneTwoMarkdownPath = path.join(seed, "manuscript/vol-1/ch-1/scene-2.md");
  const scratchPath = path.join(seed, "meta/scratch/side-note.md");
  try {
    const firstBody = `📝${"a".repeat(8)}Needle${"b".repeat(384)}`;
    assert.equal(firstBody.length, 400);
    await fs.writeFile(sceneOnePath, `---\ntitle: Draft\nstatus: done\n---\n${firstBody}`, "utf8");
    await writeYaml(sceneTwoYamlPath, {
      id: "scene-2",
      type: "scene",
      title: "Second Scene",
      volume: "vol-1",
      chapter: "ch-1",
      manuscript: "manuscript/vol-1/ch-1/scene-2.md",
    });
    await fs.writeFile(sceneTwoMarkdownPath, "---\nstatus: drafting\n---\nx", "utf8");
    await fs.mkdir(path.dirname(scratchPath), { recursive: true });
    await fs.writeFile(scratchPath, "---\ntitle: Scratch\n---\nA scratchword [literal]+ is here.\n", "utf8");
    await runGit(seed, "add", ".");
    await runGit(seed, "commit", "-m", "Add searchable manuscript and scratch content");
    await runGit(seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const originalSnapshot = (await store.observe(project.id)).snapshot;
    const documentSource = createDocumentSource(await store.reader(project.id, "remote", originalSnapshot));
    const indexedDocuments = await documentSource.enumerate("manuscript");
    const sceneDocument = indexedDocuments.find(({ path: filePath }) => filePath === "manuscript/vol-1/ch-1/scene-1.md");
    assert.ok(sceneDocument?.revision);
    assert.equal((await documentSource.readMany(["manuscript/vol-1/ch-1/scene-1.md"]))[0]?.revision, sceneDocument.revision,
      "document enumeration and reads share Core's canonical content revision");
    assert.deepEqual(await store.resolveDocumentScene(
      project.id, "manuscript/vol-1/ch-1/scene-1.md", originalSnapshot,
    ), { snapshot: originalSnapshot, sceneId: "scene-1" });
    assert.equal((await store.resolveDocumentScene(project.id, "meta/scratch/side-note.md", originalSnapshot)).sceneId, null);
    const found = await store.searchSnapshot(project.id, "needle", 20, "remote", originalSnapshot);
    assert.equal(found.snapshot.remoteCommit, originalSnapshot.remoteCommit);
    assert.deepEqual(found.results.map(({ id, field, offset, length }) => ({ id, field, offset, length })), [
      { id: "scene-1", field: "body", offset: 10, length: 6 },
    ]);
    const scratch = await store.searchSnapshot(project.id, "SCRATCHWORD", 20, "remote", originalSnapshot);
    assert.equal(scratch.results[0]?.id, "scratch:meta/scratch/side-note.md");
    assert.equal(scratch.results[0]?.filePath, "meta/scratch/side-note.md");
    const punctuation = await store.searchSnapshot(project.id, "[literal]+", 20, "remote", originalSnapshot);
    assert.equal(punctuation.results[0]?.filePath, "meta/scratch/side-note.md");
    const title = await store.searchSnapshot(project.id, "scene one", 20, "remote", originalSnapshot);
    assert.equal(title.results[0]?.id, "scene-1");
    assert.equal(title.results[0]?.field, "name");

    const stats = await store.writingStatsSnapshot(project.id, "remote", originalSnapshot);
    assert.equal(stats.snapshot.remoteCommit, originalSnapshot.remoteCommit);
    assert.equal(stats.stats.totalCharCount, 401);
    assert.equal(stats.stats.totalPages400, 2);
    assert.equal(stats.stats.volumes[0]?.chapters[0]?.scenes[0]?.sceneId, "scene-1");
    assert.equal(stats.stats.sceneById["scene-1"]?.charCount, 400);
    assert.equal(stats.stats.sceneById["scene-1"]?.status, "done");
    assert.equal(stats.stats.sceneById["scene-2"]?.charCount, 1);
    assert.equal(stats.stats.sceneById["scene-2"]?.status, "drafting");

    await fs.rename(sceneOnePath, renamedSceneOnePath);
    const renamedScene = YAML.parse(await fs.readFile(sceneOneYamlPath, "utf8")) as Record<string, unknown>;
    renamedScene.manuscript = "manuscript/vol-1/ch-1/renamed-scene-1.md";
    await fs.writeFile(sceneOneYamlPath, YAML.stringify(renamedScene), "utf8");
    await fs.writeFile(renamedSceneOnePath, "Updated without the old literal.\n", "utf8");
    await runGit(seed, "add", "-A");
    await runGit(seed, "commit", "-m", "Rename manuscript after pinned snapshot");
    await runGit(seed, "push", "origin", "main");
    await store.observe(project.id);
    const latest = await store.searchSnapshot(project.id, "needle");
    assert.equal(latest.results.length, 0);
    const latestReader = await store.reader(project.id, "remote");
    assert.equal(await latestReader.read("manuscript/vol-1/ch-1/scene-1.md"), null);
    assert.equal((await latestReader.read("manuscript/vol-1/ch-1/renamed-scene-1.md"))?.content, "Updated without the old literal.\n");
    const renamedSearch = await store.searchSnapshot(project.id, "updated without the old literal");
    assert.equal(renamedSearch.results[0]?.filePath, "manuscript/vol-1/ch-1/renamed-scene-1.md");
    const pinnedAgain = await store.searchSnapshot(project.id, "needle", 20, "remote", originalSnapshot);
    assert.equal(pinnedAgain.results[0]?.offset, 10);
    assert.deepEqual(await store.resolveDocumentScene(
      project.id, "manuscript/vol-1/ch-1/scene-1.md", originalSnapshot,
    ), { snapshot: originalSnapshot, sceneId: "scene-1" }, "pinned navigation remains bound to the original hierarchy");
    const latestStats = await store.writingStatsSnapshot(project.id);
    assert.equal(latestStats.stats.totalCharCount, "Updated without the old literal.\n".length + 1);
    const pinnedStats = await store.writingStatsSnapshot(project.id, "remote", originalSnapshot);
    assert.equal(pinnedStats.stats.totalCharCount, 401);

    const checkpointText = "checkpoint-only manuscript marker\n";
    const secondScene = await store.readScene(project.id, "scene-2");
    await store.saveScene(project.id, "scene-2", { text: checkpointText, revision: secondScene.revision });
    const checkpointSearch = await store.searchSnapshot(project.id, "checkpoint-only", 20, "checkpoint");
    assert.equal(checkpointSearch.results[0]?.id, "scene-2");
    assert.equal(checkpointSearch.results[0]?.filePath, "manuscript/vol-1/ch-1/scene-2.md");
    assert.deepEqual((await store.searchSnapshot(project.id, "checkpoint-only", 20, "remote")).results, []);
    const checkpointStats = await store.writingStatsSnapshot(project.id, "checkpoint");
    assert.equal(checkpointStats.stats.sceneById["scene-2"]?.charCount, checkpointText.length);
    const remoteStats = await store.writingStatsSnapshot(project.id, "remote");
    assert.equal(remoteStats.stats.sceneById["scene-2"]?.charCount, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("hierarchy grouping preserves order and fallback metadata while rejecting malformed YAML", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  const volumeYamlPath = path.join(seed, "plot/volumes/vol-1/volume.yaml");
  const chapterYamlPath = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/chapter.yaml");
  const sceneOneYamlPath = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml");
  const sceneTwoYamlPath = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml");
  try {
    await fs.rm(volumeYamlPath);
    await fs.rm(chapterYamlPath);
    const sceneOne = YAML.parse(await fs.readFile(sceneOneYamlPath, "utf8")) as Record<string, unknown>;
    sceneOne.title = "Second scene";
    sceneOne.order = 2;
    await fs.writeFile(sceneOneYamlPath, YAML.stringify(sceneOne), "utf8");
    await writeYaml(sceneTwoYamlPath, {
      id: "scene-2",
      type: "scene",
      title: "First scene",
      volume: "vol-1",
      chapter: "ch-1",
      manuscript: "manuscript/vol-1/ch-1/scene-2.md",
      order: 1,
    });
    await runGit(seed, "add", "-A");
    await runGit(seed, "commit", "-m", "Exercise hierarchy fallbacks and explicit ordering");
    await runGit(seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const tree = await store.readTreeSnapshot(project.id, "remote");
    assert.deepEqual(tree.tree, {
      title: "Sample Work",
      volumes: [{
        id: "vol-1",
        title: "vol-1",
        chapters: [{
          id: "ch-1",
          title: "ch-1",
          scenes: [
            { id: "scene-2", title: "First scene" },
            { id: "scene-1", title: "Second scene" },
          ],
        }],
      }],
    });

    await fs.writeFile(sceneTwoYamlPath, "id: [malformed\n", "utf8");
    await runGit(seed, "add", sceneTwoYamlPath);
    await runGit(seed, "commit", "-m", "Add malformed hierarchy metadata");
    await runGit(seed, "push", "origin", "main");
    await store.observe(project.id);
    await assert.rejects(store.readTreeSnapshot(project.id, "remote"), (error: unknown) =>
      error instanceof CoreError && error.status === 422 && error.code === "project_data_invalid");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("lists byte-derived revisions from a pinned snapshot while batching duplicate and binary blobs", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  const binary = Buffer.from([0x00, 0x0a, 0xff, 0x00, 0x0a, 0x80]);
  const duplicate = Buffer.from("same immutable blob\n");
  const empty = Buffer.alloc(0);
  const paths = {
    binary: "wave1/data.bin",
    empty: "wave1/empty.bin",
    duplicateA: "wave1/duplicate-a.md",
    duplicateB: "wave1/duplicate-b.md",
    executable: "wave1/executable.sh",
    nested: "wave1/nested/only.txt",
  };
  try {
    for (const [relative, bytes] of [
      [paths.binary, binary],
      [paths.empty, empty],
      [paths.duplicateA, duplicate],
      [paths.duplicateB, duplicate],
      [paths.executable, Buffer.from("#!/bin/sh\nexit 0\n")],
      [paths.nested, Buffer.from("nested only\n")],
    ] as const) {
      const filePath = path.join(seed, relative);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, bytes);
    }
    await runGit(seed, "add", ".");
    await runGit(seed, "update-index", "--chmod=+x", paths.executable);
    await runGit(seed, "commit", "-m", "Add binary and duplicate revision fixtures");
    await runGit(seed, "push", "origin", "main");
    assert.match(await runGit(seed, "ls-tree", "HEAD", paths.executable), /^100755 blob /);

    const dataDir = path.join(tempDir, "state");
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const pinned = (await store.observe(project.id)).snapshot;
    const reader = await store.reader(project.id, "remote", pinned);
    assert.ok(reader.listRevisions);
    const listRevisions = reader.listRevisions;
    const revision = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const pinnedBinary = { content: binary.toString("base64"), revision: revision(binary) };
    assert.deepEqual(await reader.read(paths.binary, "base64"), pinnedBinary);
    assert.deepEqual(await reader.read(paths.binary, "base64"), pinnedBinary,
      "repeated reads through one reader keep the same pinned file revision");
    assert.deepEqual(await reader.read(paths.executable), {
      content: "#!/bin/sh\nexit 0\n",
      revision: revision(Buffer.from("#!/bin/sh\nexit 0\n")),
    });
    assert.deepEqual(await reader.read(paths.nested), {
      content: "nested only\n",
      revision: revision(Buffer.from("nested only\n")),
    });
    assert.equal(await reader.read("wave1/missing.txt"), null);
    assert.equal(await reader.read("wave1/missing.txt"), null, "a cached missing entry remains missing");
    const unsafePath = (error: unknown) => error instanceof CoreError && error.status === 422 && error.code === "unsafe_project_path";
    await assert.rejects(reader.read("wave1/nested"), unsafePath, "a directory is not a regular file");
    await assert.rejects(reader.read(`${paths.nested}/child`), unsafePath, "a file cannot be used as a parent directory");
    const expected = [
      { path: paths.binary, revision: revision(binary) },
      { path: paths.empty, revision: revision(empty) },
      { path: paths.duplicateA, revision: revision(duplicate) },
      { path: paths.duplicateB, revision: revision(duplicate) },
      { path: paths.executable, revision: revision(Buffer.from("#!/bin/sh\nexit 0\n")) },
      { path: paths.nested, revision: revision(Buffer.from("nested only\n")) },
    ].sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(await listRevisions("wave1"), expected);
    assert.equal(expected.find(({ path: filePath }) => filePath === paths.duplicateA)?.revision,
      expected.find(({ path: filePath }) => filePath === paths.duplicateB)?.revision);
    assert.deepEqual(await listRevisions("wave1/nested"), [
      { path: paths.nested, revision: revision(Buffer.from("nested only\n")) },
    ]);

    await fs.writeFile(path.join(seed, paths.binary), Buffer.from("new content\n"));
    await fs.symlink("only.txt", path.join(seed, "wave1/nested/unsafe-link"));
    await runGit(seed, "add", "wave1");
    await runGit(seed, "commit", "-m", "Advance snapshot and add a symlink");
    await runGit(seed, "push", "origin", "main");
    const latestSnapshot = (await store.observe(project.id)).snapshot;
    const latestReader = await store.reader(project.id, "remote", latestSnapshot);
    assert.deepEqual(await latestReader.read(paths.binary), {
      content: "new content\n",
      revision: revision(Buffer.from("new content\n")),
    });
    assert.deepEqual(await reader.read(paths.binary, "base64"), pinnedBinary,
      "a reader created for the old commit remains bound to its cached tree entries");
    await assert.rejects(latestReader.read("wave1/nested/unsafe-link"), unsafePath,
      "the cached reader lookup still rejects a symbolic link");
    await assert.rejects(latestReader.read("wave1/nested/unsafe-link/child"), unsafePath,
      "a symbolic link cannot be traversed as a parent directory");
    assert.ok(latestReader.listRevisions);
    await assert.rejects(latestReader.listRevisions("wave1"), (error: unknown) =>
      error instanceof CoreError && error.status === 422 && error.code === "unsafe_project_path");

    const restarted = new CoreStore({ dataDir, allowLocalRemotes: true });
    const restartedReader = await restarted.reader(project.id, "remote", pinned);
    assert.ok(restartedReader.listRevisions);
    assert.deepEqual(await restartedReader.listRevisions("wave1"), expected,
      "a fresh CoreStore can still read the exact files from the pinned historical commit");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("retains every request revision after the persistent blob cache reaches its limit", async () => {
  const { tempDir, remote, seed } = await makeRemote(false);
  const dataDir = path.join(tempDir, "state");
  const fixtureDir = path.join(seed, "revision-cache");
  const expected = new Map<string, string>();
  try {
    await fs.mkdir(fixtureDir, { recursive: true });
    expected.set("README.md", createHash("sha256").update("Empty compatible work.\n").digest("hex"));
    for (let index = 0; index < 16_385; index += 1) {
      const name = String(index).padStart(5, "0") + ".txt";
      const relative = path.posix.join("revision-cache", name);
      const bytes = Buffer.from("revision " + index + "\n");
      await fs.writeFile(path.join(seed, relative), bytes);
      expected.set(relative, createHash("sha256").update(bytes).digest("hex"));
    }
    await runGit(seed, "add", "revision-cache");
    await runGit(seed, "commit", "-m", "Add blobs beyond the revision cache capacity");
    await runGit(seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const reader = await store.reader(project.id, "remote", (await store.observe(project.id)).snapshot);
    assert.ok(reader.listRevisions);
    const actual = await reader.listRevisions("");
    assert.equal(actual.length, expected.size);
    for (const item of actual) assert.equal(item.revision, expected.get(item.path), item.path);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("bounds revision batches by object bytes and reads one oversized blob separately", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  const fixtures = [
    { path: "bounded/first.bin", bytes: Buffer.alloc(12 * 1024 * 1024, 0x41) },
    { path: "bounded/second.bin", bytes: Buffer.alloc(13 * 1024 * 1024, 0x42) },
    { path: "bounded/oversized.bin", bytes: Buffer.alloc(24 * 1024 * 1024 + 1, 0x43) },
  ];
  try {
    for (const fixture of fixtures) {
      const filePath = path.join(seed, fixture.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, fixture.bytes);
    }
    await runGit(seed, "add", "bounded");
    await runGit(seed, "commit", "-m", "Add bounded revision batch fixtures");
    await runGit(seed, "push", "origin", "main");

    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const reader = await store.reader(project.id, "remote", (await store.observe(project.id)).snapshot);
    assert.ok(reader.listRevisions);
    const actual = await reader.listRevisions("bounded");
    const expected = fixtures.map(({ path: filePath, bytes }) => ({
      path: filePath,
      revision: createHash("sha256").update(bytes).digest("hex"),
    })).sort((left, right) => left.path.localeCompare(right.path));
    assert.deepEqual(actual, expected);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
