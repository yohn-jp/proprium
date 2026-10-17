import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

import { createServer } from "../../../packages/api/dist/server.js";
import { CoreStore } from "../../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../../packages/module-runtime/dist/index.js";

const execFile = promisify(execFileCallback);
const packageUrl = new URL("../package.json", import.meta.url);
const storyPackage = JSON.parse(await readFile(packageUrl, "utf8"));
const manifest = storyPackage.scriptoriumModule;
const storyEntry = new URL("../dist/index.js", import.meta.url).href;

async function git(cwd, args) {
  try {
    const { stdout } = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    throw new Error("Local Story acceptance Git fixture failed");
  }
}

async function startHost(root, authToken) {
  const staticDir = resolve(root, "static");
  const cacheDirectory = resolve(root, "module-cache");
  await mkdir(staticDir, { recursive: true });
  const runtime = new ModuleRuntime({
    manifests: [manifest],
    enabled: ["story"],
    cacheDirectory,
    loaders: {
      story: async (context) => {
        const module = await import(storyEntry);
        return module.createModule(context);
      },
    },
  });
  const store = new CoreStore({ dataDir: resolve(root, "core-data"), allowLocalRemotes: true });
  const server = createServer({ store, authToken, staticDir, runtime, profile: "story-zukan-core-acceptance" });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, server };
}

async function request(host, path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Origin = host.base;
  }
  const response = await fetch(host.base + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : undefined;
  return { response, value };
}

async function owner(host, cookie, path, { method = "GET", body, status = 200 } = {}) {
  const { response, value } = await request(host, path, { method, body, cookie });
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function invoke(host, cookie, projectId, actionId, input) {
  return owner(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`, {
    method: "POST", body: { input },
  });
}

async function seedRemote(root) {
  const remote = resolve(root, "remote.git");
  const seed = resolve(root, "seed");
  await mkdir(seed, { recursive: true });
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(seed, ["init", "--initial-branch=main"]);
  await git(seed, ["config", "user.name", "Story Acceptance"]);
  await git(seed, ["config", "user.email", "story-acceptance@example.invalid"]);
  const files = {
    "meta/project.yaml": "id: zukan-acceptance\ntitle: Zukan Acceptance\n",
    "bible/characters/char-uma/profile.yaml": "id: char-uma\ntype: character\nname: Uma\nnotes:\n  lead:\n    - type: paragraph\n      text: Character notes.\n  sections: []\n",
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml": "id: ch-main-1\ntype: chapter\nname: Arrival\nvolume: vol-main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": "id: sc-1\ntype: scene\nname: Door\nvolume: vol-main\nchapter: ch-main-1\norder: 1\npov: char-uma\nlocation: null\nrelations: []\nmanuscript: manuscript/vol-main/ch-main-1/sc-1.md\n",
    "manuscript/vol-main/ch-main-1/sc-1.md": "---\ntitle: Door\nstatus: draft\n---\nUma enters the cafe.\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const destination = resolve(seed, relative);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, content);
  }
  await git(seed, ["add", "--all"]);
  await git(seed, ["commit", "-m", "Create synthetic Story project"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "origin", "HEAD:refs/heads/main"]);
  return remote;
}

async function registerAndLogin(host, authToken, remote) {
  const login = await request(host, "/api/login", { method: "POST", body: { token: authToken } });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const project = await owner(host, cookie, "/api/projects", { method: "POST", status: 201, body: { url: remote, branch: "main" } });
  return { cookie, project };
}

async function stopHost(host) {
  await new Promise((resolveClose, reject) => host.server.close((error) => error ? reject(error) : resolveClose()));
}

test("Zukan suggestion creation runs through Story, Core review, checkpoint, publish, and reclone", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "scriptorium-story-zukan-core-"));
  const authToken = randomBytes(32).toString("base64url");
  let host;
  try {
    const remote = await seedRemote(root);
    host = await startHost(root, authToken);
    const { cookie, project } = await registerAndLogin(host, authToken, remote);
    const actions = await owner(host, cookie, `/api/projects/${encodeURIComponent(project.id)}/actions`);
    assert.ok(actions.actions.some((action) => action.id === "story.zukan-suggestions.create"));
    assert.ok(actions.actions.some((action) => action.id === "story.snapshot.materialize"));
    const headBeforeReads = await git(resolve(root, "remote.git"), ["rev-parse", "refs/heads/main"]);
    const entityList = await invoke(host, cookie, project.id, "story.entities.list", {});
    assert.equal(entityList.ok, true, JSON.stringify(entityList.error));
    const materialized = await invoke(host, cookie, project.id, "story.snapshot.materialize", {});
    assert.equal(materialized.ok, true, JSON.stringify(materialized.error));
    assert.deepEqual(materialized.data, { entities: entityList.data.length, links: 2 });
    assert.deepEqual(materialized.snapshot, entityList.snapshot, "the action reports counts from its pinned Core reader snapshot");
    assert.equal(materialized.snapshot.remoteCommit, headBeforeReads);
    assert.equal(materialized.proposals, undefined, "materialization is a read action");
    const graph = await invoke(host, cookie, project.id, "story.graph.query", { types: ["character"] });
    assert.equal(graph.ok, true, JSON.stringify(graph.error));
    assert.deepEqual(graph.data.nodes.map((node) => node.type), ["character"]);
    const invalidGraph = await invoke(host, cookie, project.id, "story.graph.query", { types: "character" });
    assert.equal(invalidGraph.ok, false);
    assert.equal(invalidGraph.error.code, "invalid_input");
    assert.equal(await git(resolve(root, "remote.git"), ["rev-parse", "refs/heads/main"]), headBeforeReads,
      "read actions do not mutate the real Git remote");
    const input = {
      entityId: "char-uma",
      proposedText: "Uma enters the cafe.",
      evidence: [{ quote: "Uma enters the cafe.", sceneId: "sc-1" }],
      source: "manuscript",
      kind: "fact",
      confidence: "high",
      operation_id: `acceptance-${randomUUID()}`,
    };
    const created = await invoke(host, cookie, project.id, "story.zukan-suggestions.create", input);
    assert.equal(created.ok, true, JSON.stringify(created.error));
    assert.equal(created.data.created, true);
    assert.equal(created.data.suggestion.status, "pending");
    assert.equal(created.proposals.length, 1);
    const retried = await invoke(host, cookie, project.id, "story.zukan-suggestions.create", input);
    assert.equal(retried.ok, true, JSON.stringify(retried.error));
    assert.equal(retried.proposals.length, 1, "an exact retry returns the same host proposal while it is still pending");
    assert.equal(retried.proposals[0].id, created.proposals[0].id);
    const proposal = created.proposals[0];
    const operationIds = proposal.operations.map((operation) => operation.id);
    await owner(host, cookie, `/api/projects/${encodeURIComponent(project.id)}/approvals`, {
      method: "POST", status: 204, body: { proposalId: proposal.id, operationIds },
    });
    for (const operation of proposal.operations) {
      await owner(host, cookie, `/api/projects/${encodeURIComponent(project.id)}/checkpoints`, {
        method: "POST", status: 201, body: operation,
      });
    }
    const published = await owner(host, cookie, `/api/projects/${encodeURIComponent(project.id)}/publish`, {
      method: "POST", body: { batchId: `zukan-${randomUUID()}` },
    });
    assert.equal(published.state, "confirmed");
    const list = await invoke(host, cookie, project.id, "story.zukan-suggestions.list", { entityId: "char-uma", status: "pending" });
    assert.equal(list.ok, true, JSON.stringify(list.error));
    assert.ok(list.data.suggestions.some((suggestion) => suggestion.id === created.data.suggestion.id));
    await stopHost(host);
    host = undefined;

    await rm(resolve(root, "core-data"), { recursive: true, force: true });
    host = await startHost(root, authToken);
    const recovered = await registerAndLogin(host, authToken, remote);
    const recoveredList = await invoke(host, recovered.cookie, recovered.project.id, "story.zukan-suggestions.list", { entityId: "char-uma", status: "pending" });
    assert.equal(recoveredList.ok, true, JSON.stringify(recoveredList.error));
    assert.ok(recoveredList.data.suggestions.some((suggestion) => suggestion.id === created.data.suggestion.id), "the pending proposal row survives Core-data removal and remote reclone");
    t.diagnostic("Verified the actual Story module action against Core, the HTTP owner workflow, a bare Git remote, and a fresh Core-data root.");
  } finally {
    if (host) await stopHost(host);
    await rm(root, { recursive: true, force: true });
  }
});
