import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { CoreError, CoreStore } from "./index.js";

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
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

test("reports divergent local and remote histories without replacing the local draft", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  try {
    const store = new CoreStore({ dataDir: path.join(tempDir, "state"), allowLocalRemotes: true });
    const project = await store.registerProject({ url: remote });
    const original = await store.readScene(project.id, "scene-1");
    await store.saveScene(project.id, "scene-1", { text: "Local edit.\n", revision: original.revision });

    await fs.writeFile(path.join(seed, "manuscript/vol-1/ch-1/scene-1.md"), "Remote edit.\n", "utf8");
    await runGit(seed, "add", "manuscript/vol-1/ch-1/scene-1.md");
    await runGit(seed, "commit", "-m", "Competing remote edit");
    await runGit(seed, "push", "origin", "main");

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

test("search and writing statistics read one pinned remote snapshot", async () => {
  const { tempDir, remote, seed } = await makeRemote();
  const sceneOnePath = path.join(seed, "manuscript/vol-1/ch-1/scene-1.md");
  const sceneTwoYamlPath = path.join(seed, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml");
  const sceneTwoMarkdownPath = path.join(seed, "manuscript/vol-1/ch-1/scene-2.md");
  const scratchPath = path.join(seed, "meta/scratch/side-note.md");
  try {
    const firstBody = `${"a".repeat(10)}Needle${"b".repeat(384)}`;
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

    await fs.writeFile(sceneOnePath, "Updated without the old literal.\n", "utf8");
    await runGit(seed, "add", sceneOnePath);
    await runGit(seed, "commit", "-m", "Change manuscript after pinned snapshot");
    await runGit(seed, "push", "origin", "main");
    await store.observe(project.id);
    const latest = await store.searchSnapshot(project.id, "needle");
    assert.equal(latest.results.length, 0);
    const pinnedAgain = await store.searchSnapshot(project.id, "needle", 20, "remote", originalSnapshot);
    assert.equal(pinnedAgain.results[0]?.offset, 10);
    const latestStats = await store.writingStatsSnapshot(project.id);
    assert.equal(latestStats.stats.totalCharCount, "Updated without the old literal.\n".length + 1);
    const pinnedStats = await store.writingStatsSnapshot(project.id, "remote", originalSnapshot);
    assert.equal(pinnedStats.stats.totalCharCount, 401);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
