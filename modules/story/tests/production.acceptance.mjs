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
const workUrl = process.env.SCRIPTORIUM_P05_ACCEPTANCE_WORK_URL?.trim() ?? "";
const bibleUrl = process.env.SCRIPTORIUM_P05_ACCEPTANCE_BIBLE_URL?.trim() ?? "";
const authToken = randomBytes(32).toString("base64url");
const modulePackageUrl = new URL("../package.json", import.meta.url);
const storyPackage = JSON.parse(await readFile(modulePackageUrl, "utf8"));
const storyManifest = storyPackage.scriptoriumModule;
const storyEntryUrl = new URL("../dist/index.js", import.meta.url).href;
const profileName = "story-production-acceptance";

function requireGitHubUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTPS GitHub repository URL`); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash ||
      url.pathname.split("/").filter(Boolean).length !== 2) {
    throw new Error(`${label} must be an HTTPS GitHub repository URL`);
  }
  return value;
}

async function getGitHubToken() {
  const configured = process.env.SCRIPTORIUM_P05_GITHUB_TOKEN?.trim() || process.env.SCRIPTORIUM_GITHUB_TOKEN?.trim();
  if (configured) return configured;
  try {
    const { stdout } = await execFile("gh", ["auth", "token"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* Use one generic error without exposing CLI output. */ }
  throw new Error("Set SCRIPTORIUM_P05_GITHUB_TOKEN or authenticate gh before running this acceptance");
}

async function git(cwd, args, { token, askpass } = {}) {
  try {
    const result = await execFile("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...(token ? { SCRIPTORIUM_ACCEPTANCE_TOKEN: token } : {}),
        ...(askpass ? { GIT_ASKPASS: askpass, GIT_ASKPASS_REQUIRE: "force" } : {}),
      },
    });
    return result.stdout.trim();
  } catch {
    throw new Error("Synthetic Git fixture operation failed");
  }
}

async function makeAskpass(root) {
  const askpass = resolve(root, "acceptance-askpass");
  await writeFile(askpass,
    "#!/bin/sh\ncase \"$1\" in\n  *sername*) printf '%s\\n' 'x-access-token' ;;\n  *) printf '%s\\n' \"$SCRIPTORIUM_ACCEPTANCE_TOKEN\" ;;\nesac\n",
    { mode: 0o700 });
  return askpass;
}

function yamlEntity({ id, type, name, extra = "" }) {
  return `id: ${id}\ntype: ${type}\nname: ${name}\n${extra}`;
}

function workFiles() {
  return {
    "bible/characters/char-uma/profile.yaml": yamlEntity({ id: "char-uma", type: "character", name: "Work Uma", extra: "aliases:\n  - Uma\nnotes:\n  lead:\n    - type: paragraph\n      text: Work record.\n  sections: []\n" }),
    "bible/locations/loc-cafe.yaml": yamlEntity({ id: "loc-cafe", type: "location", name: "Work Cafe" }),
    "bible/locations/loc-park.yaml": yamlEntity({ id: "loc-park", type: "location", name: "Work Park" }),
    "plot/volumes/vol-main/volume.yaml": yamlEntity({ id: "vol-main", type: "volume", name: "Main", extra: "order: 1\n" }),
    "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml": yamlEntity({ id: "ch-main-1", type: "chapter", name: "Arrival", extra: "volume: vol-main\norder: 1\n" }),
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": yamlEntity({ id: "sc-1", type: "scene", name: "Door", extra: "volume: vol-main\nchapter: ch-main-1\norder: 1\npov: char-uma\nlocation: loc-cafe\nrelations:\n  - to: char-uma\n    kind: appears\nmanuscript: manuscript/vol-main/ch-main-1/sc-1.md\n" }),
    "manuscript/vol-main/ch-main-1/sc-1.md": "---\ntitle: Door\nstatus: draft\n---\nUma enters the cafe.\n",
  };
}

function bibleFiles() {
  return {
    "bible/characters/char-uma/profile.yaml": yamlEntity({ id: "char-uma", type: "character", name: "Bible Uma", extra: "aliases:\n  - Bible-U\nnotes:\n  lead:\n    - type: paragraph\n      text: Bible source record.\n  sections: []\n" }),
    "bible/locations/loc-cafe.yaml": yamlEntity({ id: "loc-cafe", type: "location", name: "Bible Cafe" }),
    "bible/lore/lore-river.yaml": yamlEntity({ id: "lore-river", type: "lore", name: "Silver River" }),
  };
}

async function githubDefaultBranch(url, token) {
  const parsed = new URL(url);
  const [owner, repository] = parsed.pathname.split("/").filter(Boolean);
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`Could not read synthetic GitHub repository metadata (HTTP ${response.status})`);
  const metadata = await parseJson(response);
  assert.equal(metadata.private, true, "Production acceptance fixtures must be private repositories");
  assert.ok(typeof metadata.default_branch === "string" && metadata.default_branch.length > 0,
    "Synthetic GitHub repository has no configured default branch");
  return metadata.default_branch;
}

async function restoreDefaultBranch({ root, label, url, files, token, askpass }) {
  const branch = await githubDefaultBranch(url, token);
  const directory = resolve(root, `seed-${label}`);
  await git(root, ["clone", "--quiet", "--single-branch", "--branch", branch, url, directory], { token, askpass });
  await git(directory, ["config", "user.name", "Scriptorium Acceptance"]);
  await git(directory, ["config", "user.email", "scriptorium-acceptance@example.invalid"]);
  const generatedFiles = [
    "bible/locations/loc-p05-garden.yaml",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-p05-garden.yaml",
    "meta/scriptorium/modules/story/v1/series.json",
  ];
  for (const relative of generatedFiles) {
    if (Object.hasOwn(files, relative)) continue;
    await rm(resolve(directory, relative), { force: true });
  }
  for (const [relative, content] of Object.entries(files)) {
    const destination = resolve(directory, relative);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, content);
  }
  await git(directory, ["add", "--all"]);
  const changes = await git(directory, ["status", "--porcelain", "--untracked-files=all"]);
  if (changes) {
    await git(directory, ["commit", "-m", `Restore owned synthetic ${label} Story fixture`]);
    await git(directory, ["push", "origin", `HEAD:refs/heads/${branch}`], { token, askpass });
  }
  return { directory, branch };
}

async function parseJson(response) {
  try { return await response.json(); }
  catch { throw new Error("Acceptance API returned invalid JSON"); }
}

async function apiRequest(host, route, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Origin = host.base;
  }
  try {
    return await fetch(host.base + route, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("Acceptance API request failed");
  }
}

async function ownerResponse(host, cookie, route, { method = "GET", body } = {}) {
  return apiRequest(host, route, { method, body, cookie });
}

async function ownerJson(host, cookie, route, { method = "GET", body, status = 200 } = {}) {
  const response = await ownerResponse(host, cookie, route, { method, body });
  const value = response.status === 204 ? undefined : await parseJson(response);
  assert.equal(response.status, status, `Expected HTTP ${status}; received HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function startHost({ dataDir, cacheDir, staticDir, githubToken }) {
  await mkdir(cacheDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  const runtime = new ModuleRuntime({
    manifests: [storyManifest],
    enabled: ["story"],
    cacheDirectory: cacheDir,
    loaders: {
      story: async (context) => {
        const module = await import(storyEntryUrl);
        return module.createModule(context);
      },
    },
  });
  const store = new CoreStore({ dataDir, githubToken });
  const server = createServer({ store, authToken, staticDir, runtime, profile: profileName });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Acceptance API did not open a TCP listener");
  return {
    base: `http://127.0.0.1:${address.port}`,
    server,
    store,
    async close() {
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    },
  };
}

async function login(host) {
  const response = await apiRequest(host, "/api/login", { method: "POST", body: { token: authToken } });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Owner login did not return a session cookie");
  return setCookie.split(";", 1)[0];
}

async function registerProject(host, cookie, url, branch) {
  const result = await ownerJson(host, cookie, "/api/projects", {
    method: "POST", status: 201, body: { url, branch },
  });
  assert.equal(result.branch, branch);
  assert.ok(typeof result.id === "string");
  return result;
}

async function invoke(host, cookie, projectId, actionId, input) {
  const result = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`, {
    method: "POST", body: { input },
  });
  return result;
}

async function publishProposal(host, cookie, projectId, proposal, batchId) {
  assert.ok(proposal && typeof proposal.id === "string" && Array.isArray(proposal.operations) && proposal.operations.length > 0);
  const operationIds = proposal.operations.map((operation) => operation.id);
  await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/approvals`, {
    method: "POST", status: 204, body: { proposalId: proposal.id, operationIds },
  });
  for (const operation of proposal.operations) {
    await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/checkpoints`, {
      method: "POST", status: 201, body: operation,
    });
  }
  const status = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposal.id)}`);
  assert.equal(status.state, "checkpointed");
  const receipt = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/publish`, {
    method: "POST", body: { batchId },
  });
  assert.equal(receipt.state, "confirmed");
  assert.ok(receipt.remoteCommit);
  return receipt;
}

async function remoteHead(url, branch, token, askpass, cwd) {
  const output = await git(cwd, ["ls-remote", "--heads", url, `refs/heads/${branch}`], { token, askpass });
  const head = output.split(/\s+/)[0];
  assert.match(head ?? "", /^[a-f0-9]{40,64}$/u, "Synthetic remote branch has no commit");
  return head;
}

function proposalStatusPath(projectId, proposalId) {
  return `/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}`;
}

test("Story actions compose with Core over GitHub snapshots, approvals, recovery, and read-only Bible overlay", {
  skip: !workUrl || !bibleUrl,
}, async (t) => {
  requireGitHubUrl(workUrl, "SCRIPTORIUM_P05_ACCEPTANCE_WORK_URL");
  requireGitHubUrl(bibleUrl, "SCRIPTORIUM_P05_ACCEPTANCE_BIBLE_URL");
  assert.notEqual(workUrl, bibleUrl, "Work and Bible fixtures must be separate repositories");
  const githubToken = await getGitHubToken();
  const root = await mkdtemp(resolve(tmpdir(), "scriptorium-p05-production-"));
  const dataDir = resolve(root, "core-data");
  const cacheDir = resolve(root, "module-cache");
  const staticDir = resolve(root, "static");
  const askpass = await makeAskpass(root);
  let host;
  try {
    const workFixture = await restoreDefaultBranch({ root, label: "work", url: workUrl, files: workFiles(), token: githubToken, askpass });
    const bibleFixture = await restoreDefaultBranch({ root, label: "bible", url: bibleUrl, files: bibleFiles(), token: githubToken, askpass });
    const workSeed = workFixture.directory;
    const workBranch = workFixture.branch;
    const bibleBranch = bibleFixture.branch;
    const bibleHeadBefore = await remoteHead(bibleUrl, bibleBranch, githubToken, askpass, workSeed);

    host = await startHost({ dataDir, cacheDir, staticDir, githubToken });
    let cookie = await login(host);
    const bibleProject = await registerProject(host, cookie, bibleUrl, bibleBranch);
    const workProject = await registerProject(host, cookie, workUrl, workBranch);
    const projectId = workProject.id;

    const descriptors = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/actions`);
    const available = new Set(descriptors.actions.map((item) => item.id));
    for (const actionId of ["story.entities.list", "story.entities.get", "story.changes.propose", "story.series.create", "story.series.binding.update", "story.series.overlay"]) {
      assert.ok(available.has(actionId), `Composed host is missing ${actionId}`);
    }

    const registered = await invoke(host, cookie, projectId, "core.repositories.list", {});
    assert.equal(registered.ok, true, registered.ok ? undefined : registered.error.message);
    const bibleIdentity = registered.data.repositories.find((item) => item.projectId === bibleProject.id)?.repository;
    const workIdentity = registered.data.repositories.find((item) => item.projectId === workProject.id)?.repository;
    assert.ok(bibleIdentity?.repositoryId && workIdentity?.repositoryId);
    assert.notEqual(bibleIdentity.repositoryId, workIdentity.repositoryId, "Fixtures must have distinct stable repository identities");
    assert.equal(bibleIdentity.ownerScope, workIdentity.ownerScope, "GitHub repositories must share an owner identity for the linked read");

    const workEntitiesResult = await invoke(host, cookie, projectId, "story.entities.list", {});
    assert.equal(workEntitiesResult.ok, true, workEntitiesResult.ok ? undefined : workEntitiesResult.error.message);
    const workEntities = workEntitiesResult.data;
    assert.ok(Array.isArray(workEntities), "Story entity listing is the public bare-array projection");
    const workCharacter = workEntities.find((entity) => entity.id === "char-uma");
    assert.equal(workCharacter?.name, "Work Uma");
    assert.ok(workCharacter?.fileRevision);
    const characterRead = await invoke(host, cookie, projectId, "story.entities.get", { id: "char-uma" });
    assert.equal(characterRead.ok, true, characterRead.ok ? undefined : characterRead.error.message);
    assert.equal(characterRead.data.revision, workCharacter.revision);

    const seriesCreated = await invoke(host, cookie, projectId, "story.series.create", {
      name: "Synthetic Story Acceptance",
      bibleRepositoryId: bibleIdentity.repositoryId,
      operation_id: `p05-series-create-${randomUUID().replaceAll("-", "")}`,
    });
    assert.equal(seriesCreated.ok, true, seriesCreated.ok ? undefined : seriesCreated.error.message);
    assert.equal(seriesCreated.proposals?.length, 1);
    const seriesId = seriesCreated.data.id;
    await publishProposal(host, cookie, projectId, seriesCreated.proposals[0], `p05_series_create_${randomUUID().replaceAll("-", "")}`);

    const binding = await invoke(host, cookie, projectId, "story.series.binding.update", {
      seriesId,
      operation_id: `p05-series-bind-${randomUUID().replaceAll("-", "")}`,
    });
    assert.equal(binding.ok, true, binding.ok ? undefined : binding.error.message);
    assert.equal(binding.proposals?.length, 1);
    await publishProposal(host, cookie, projectId, binding.proposals[0], `p05_series_bind_${randomUUID().replaceAll("-", "")}`);

    const overlayResult = await invoke(host, cookie, projectId, "story.series.overlay", {});
    assert.equal(overlayResult.ok, true, overlayResult.ok ? undefined : overlayResult.error.message);
    assert.equal(overlayResult.data.workSnapshot.repository.repositoryId, workIdentity.repositoryId);
    assert.equal(overlayResult.data.bibleSnapshot.repository.repositoryId, bibleIdentity.repositoryId);
    assert.equal(overlayResult.data.bibleSnapshot.remoteCommit, bibleHeadBefore);
    assert.equal(overlayResult.data.workEntities.find((entity) => entity.id === "char-uma")?.name, "Work Uma");
    assert.equal(overlayResult.data.bibleEntities.find((entity) => entity.id === "char-uma")?.name, "Bible Uma");
    assert.equal(overlayResult.data.entities.find((entity) => entity.id === "char-uma")?.name, "Work Uma", "the merged view keeps work precedence while retaining the separately browsable Bible entity");
    assert.ok(overlayResult.data.bibleEntities.some((entity) => entity.id === "lore-river"));

    const entityRevision = (id) => workEntities.find((entity) => entity.id === id)?.revision;
    const changeSetId = `p05-ncs-${randomUUID().replaceAll("-", "")}`;
    const changeSet = {
      schemaVersion: 1,
      id: changeSetId,
      projectId,
      goal: "Create a location and scene using virtual Story scopes, then add a referenced relation",
      status: "proposed",
      assessment: { confidence: 0.95, risk: "medium" },
      operations: [
        { id: "create-garden", kind: "entity.create", precondition: { kind: "absent" }, target: { entityId: "loc-p05-garden", entityType: "location" }, values: { id: "loc-p05-garden", type: "location", name: "Acceptance Garden" }, evidenceIds: ["fixture-source"], assessment: { confidence: 0.95, risk: "low" } },
        { id: "create-scene", kind: "scene.create", precondition: { kind: "absent" }, target: { sceneId: "sc-p05-garden" }, values: { id: "sc-p05-garden", type: "scene", title: "Garden Visit", volume: "vol-main", chapter: "ch-main-1", order: 2, pov: "char-uma", location: "loc-p05-garden" }, evidenceIds: ["fixture-source"], assessment: { confidence: 0.9, risk: "medium" } },
        { id: "link-character-location", kind: "reference.link", precondition: { kind: "revision", value: entityRevision("char-uma") }, target: { from: "char-uma", to: "loc-cafe", kind: "related" }, note: "Acceptance relation", evidenceIds: ["fixture-source"], assessment: { confidence: 0.85, risk: "low" } },
      ],
      evidence: [{ id: "fixture-source", sourceKind: "entity", sourceId: "char-uma", revision: entityRevision("char-uma") }],
      diagnostics: { before: null, after: null },
    };
    const submitted = await invoke(host, cookie, projectId, "story.changes.propose", changeSet);
    assert.equal(submitted.ok, true, submitted.ok ? undefined : `${submitted.error.code}: ${submitted.error.message}`);
    assert.equal(submitted.data.replayed, false);
    assert.equal(submitted.data.dependencies["create-scene"]?.[0], "create-garden", "the scene scope includes the earlier virtual Bible write");
    assert.equal(submitted.proposals?.length, 1, "the complete source change set becomes one atomic Core proposal");
    const coreProposalId = submitted.data.coreProposalId;
    const statusRoute = proposalStatusPath(projectId, coreProposalId);
    const persisted = await ownerJson(host, cookie, statusRoute);
    const persistedProposal = persisted.proposal;
    assert.equal(persistedProposal.id, coreProposalId);
    const sourceEvidence = persistedProposal.evidence.find((item) => item.kind === "source.narrative-change-set.v1");
    assert.deepEqual(sourceEvidence.details.sourceChangeSet, changeSet);
    const coreOperations = persistedProposal.operations;
    assert.equal(coreOperations.length, 3);
    const firstScopes = new Map(coreOperations[0].readScopes.map((scope) => [scope.prefix, scope.revision]));
    const sceneScopes = new Map(coreOperations[1].readScopes.map((scope) => [scope.prefix, scope.revision]));
    assert.notEqual(sceneScopes.get("bible"), firstScopes.get("bible"), "the second create hashes the first operation's virtual Bible membership");
    assert.equal(sceneScopes.get("plot"), firstScopes.get("plot"), "the virtual scene creation starts from the same plot membership");
    assert.ok(coreOperations[1].reads.some((read) => read.path === "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml" && read.revision));
    assert.ok(coreOperations[1].reads.some((read) => read.path === "bible/characters/char-uma/profile.yaml" && read.revision), "scene POV reference carries its target file precondition");
    assert.ok(coreOperations[2].reads.some((read) => read.path === "bible/locations/loc-cafe.yaml" && read.revision), "reference.link carries the referenced target file precondition");

    const replayed = await invoke(host, cookie, projectId, "story.changes.propose", changeSet);
    assert.equal(replayed.ok, true, replayed.ok ? undefined : replayed.error.message);
    assert.equal(replayed.data.replayed, true);
    assert.equal(replayed.data.coreProposalId, coreProposalId);
    const changedMeaning = { ...changeSet, goal: `${changeSet.goal} with changed meaning` };
    const conflictingRetry = await invoke(host, cookie, projectId, "story.changes.propose", changedMeaning);
    assert.equal(conflictingRetry.ok, false);
    assert.equal(conflictingRetry.error.code, "change_set_identity_conflict");
    const proposalList = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals`);
    assert.equal(proposalList.proposals.filter((item) => item.proposal.id === coreProposalId).length, 1, "same-ID retries never create duplicate Core proposals");

    const firstOperation = coreOperations[0];
    const remainingOperations = coreOperations.slice(1);
    await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/approvals`, {
      method: "POST", status: 204, body: { proposalId: coreProposalId, operationIds: [firstOperation.id] },
    });
    await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/checkpoints`, {
      method: "POST", status: 201, body: firstOperation,
    });
    let partial = await ownerJson(host, cookie, statusRoute);
    assert.equal(partial.state, "partially_approved");
    assert.deepEqual(partial.approvedOperationIds, [firstOperation.id]);
    await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/approvals`, {
      method: "POST", status: 204, body: { proposalId: coreProposalId, operationIds: coreOperations.map((operation) => operation.id) },
    });
    for (const operation of remainingOperations) {
      await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/checkpoints`, {
        method: "POST", status: 201, body: operation,
      });
    }
    partial = await ownerJson(host, cookie, statusRoute);
    assert.equal(partial.state, "checkpointed");
    assert.deepEqual(partial.checkpoints.map((receipt) => receipt.operationId), coreOperations.map((operation) => operation.id));
    const published = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/publish`, {
      method: "POST", body: { batchId: `p05_ncs_${randomUUID().replaceAll("-", "")}` },
    });
    assert.equal(published.state, "confirmed");
    assert.equal(published.acknowledged.length, coreOperations.length);

    const postPublish = await invoke(host, cookie, projectId, "story.entities.list", {});
    assert.equal(postPublish.ok, true, postPublish.ok ? undefined : postPublish.error.message);
    assert.ok(postPublish.data.some((entity) => entity.id === "loc-p05-garden"));
    assert.ok(postPublish.data.some((entity) => entity.id === "sc-p05-garden"));
    const bibleHeadAfterPublish = await remoteHead(bibleUrl, bibleBranch, githubToken, askpass, workSeed);
    assert.equal(bibleHeadAfterPublish, bibleHeadBefore, "Story proposal approval, checkpoint and publish leave the linked Bible repository unchanged");

    const guardChangeSet = {
      ...changeSet,
      id: `p05-reference-guard-${randomUUID().replaceAll("-", "")}`,
      goal: "Guard the target entity revision of a relationship",
      operations: [{
        id: "link-park",
        kind: "reference.link",
        precondition: { kind: "revision", value: postPublish.data.find((entity) => entity.id === "char-uma").revision },
        target: { from: "char-uma", to: "loc-park", kind: "related" },
        note: "Target file must remain unchanged",
        evidenceIds: ["fixture-source"],
        assessment: { confidence: 0.9, risk: "low" },
      }],
      evidence: [{ id: "fixture-source", sourceKind: "entity", sourceId: "char-uma", revision: postPublish.data.find((entity) => entity.id === "char-uma").revision }],
    };
    const guarded = await invoke(host, cookie, projectId, "story.changes.propose", guardChangeSet);
    assert.equal(guarded.ok, true, guarded.ok ? undefined : guarded.error.message);
    const guardProposal = guarded.proposals[0];
    const guardOperation = guardProposal.operations[0];
    assert.ok(guardOperation.reads.some((read) => read.path === "bible/locations/loc-park.yaml" && read.revision));
    await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/approvals`, {
      method: "POST", status: 204, body: { proposalId: guardProposal.id, operationIds: [guardOperation.id] },
    });

    await git(workSeed, ["fetch", "origin", workBranch], { token: githubToken, askpass });
    await git(workSeed, ["reset", "--hard", `origin/${workBranch}`]);
    const changedReferencePath = resolve(workSeed, "bible/locations/loc-park.yaml");
    const changedReference = await readFile(changedReferencePath, "utf8");
    await writeFile(changedReferencePath, `${changedReference}\n# changed after owner approval\n`);
    await git(workSeed, ["add", "bible/locations/loc-park.yaml"]);
    await git(workSeed, ["commit", "-m", "Change referenced entity after Story review"]);
    await git(workSeed, ["push", "origin", `HEAD:${workBranch}`], { token: githubToken, askpass });
    await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/observation`);
    const staleCheckpoint = await ownerResponse(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/checkpoints`, {
      method: "POST", body: guardOperation,
    });
    const staleBody = await parseJson(staleCheckpoint);
    assert.equal(staleCheckpoint.status, 409, `Expected the changed reference file to conflict at checkpoint: ${JSON.stringify(staleBody)}`);
    assert.ok(["operation_precondition_conflict", "read_precondition_conflict"].includes(staleBody.code), `Unexpected reference conflict code: ${staleBody.code}`);

    await host.close();
    host = undefined;
    await rm(dataDir, { recursive: true, force: true });
    assert.equal(await import("node:fs/promises").then(({ access }) => access(dataDir).then(() => true, () => false)), false, "the complete Core data root was removed");

    host = await startHost({ dataDir, cacheDir, staticDir, githubToken });
    cookie = await login(host);
    const recoveredBible = await registerProject(host, cookie, bibleUrl, bibleBranch);
    const recoveredWork = await registerProject(host, cookie, workUrl, workBranch);
    const recoveredEntities = await invoke(host, cookie, recoveredWork.id, "story.entities.list", {});
    assert.equal(recoveredEntities.ok, true, recoveredEntities.ok ? undefined : recoveredEntities.error.message);
    assert.ok(recoveredEntities.data.some((entity) => entity.id === "sc-p05-garden"), "a clean Core clone re-reads published Story entities from Git");
    const recoveredOverlay = await invoke(host, cookie, recoveredWork.id, "story.series.overlay", {});
    assert.equal(recoveredOverlay.ok, true, recoveredOverlay.ok ? undefined : recoveredOverlay.error.message);
    assert.equal(recoveredOverlay.data.workSnapshot.repository.repositoryId, workIdentity.repositoryId);
    assert.equal(recoveredOverlay.data.bibleSnapshot.repository.repositoryId, bibleIdentity.repositoryId);
    assert.equal(recoveredOverlay.data.workSnapshot.remoteCommit, await remoteHead(workUrl, workBranch, githubToken, askpass, workSeed));
    assert.equal(recoveredOverlay.data.bibleSnapshot.remoteCommit, bibleHeadBefore);
    assert.equal(recoveredOverlay.data.bibleEntities.find((entity) => entity.id === "char-uma")?.name, "Bible Uma");
    assert.equal(await remoteHead(bibleUrl, bibleBranch, githubToken, askpass, workSeed), bibleHeadBefore, "the complete data-root recovery still leaves the other repository untouched");
    assert.ok(recoveredBible.id && recoveredWork.id);

    t.diagnostic(`Story production acceptance used each private synthetic repository's configured default branch; Core data root was removed and reconstructed from their remote snapshots.`);
  } finally {
    if (host) await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
