import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";

import { createServer } from "../../packages/api/dist/server.js";
import { CoreStore } from "../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../packages/module-runtime/dist/index.js";

const execFile = promisify(execFileCallback);
const repositoryUrl = process.env.SCRIPTORIUM_ACCEPTANCE_GITHUB_URL?.trim() ?? "";
const accessToken = randomBytes(32).toString("base64url");
const modulePackageUrl = new URL("../../modules/publishing/package.json", import.meta.url);
const modulePackage = JSON.parse(await readFile(modulePackageUrl, "utf8"));
const publishingManifest = modulePackage.scriptoriumModule;
const publishingEntryUrl = new URL("../../modules/publishing/dist/index.js", import.meta.url).href;
const publishingRequire = createRequire(modulePackageUrl);
const JSZip = publishingRequire("jszip");
const YAML = publishingRequire("yaml");
const appStaticDirectory = resolve(fileURLToPath(new URL("../../app/dist", import.meta.url)));

const profileName = "publishing-integration";
const episodePath = "meta/scriptorium/modules/publishing/episodes.yaml";
const grantsPath = "meta/scriptorium/modules/publishing/share-grants.jsonl";
const coverPath = "meta/scriptorium/modules/publishing/assets/p13-acceptance-cover.jpg";
const episodeId = "p13-acceptance-episode";
const manuscriptMarker = "星の灯りが、静かな港を照らした。｜星《ほし》の物語 & <夜>。";
const voiceMarker = "P13_VOICE_HELPER_ONLY";
const coverBytes = Buffer.from([0xff, 0xd8, 0x00, 0x81, 0xfe, 0x00, 0xd9, 0x26, 0x00]);
async function parseResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("Acceptance API returned invalid JSON");
  }
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

async function expectStatus(response, expected) {
  assert.ok(response.status === expected, `Expected HTTP ${expected}; received HTTP ${response.status}`);
}

async function ownerJson(host, cookie, route, { method = "GET", body, status = 200 } = {}) {
  const response = await apiRequest(host, route, { method, body, cookie });
  await expectStatus(response, status);
  return response.status === 204 ? undefined : parseResponse(response);
}

async function githubToken() {
  const configured = process.env.SCRIPTORIUM_GITHUB_TOKEN?.trim();
  if (configured) return configured;
  try {
    const { stdout } = await execFile("gh", ["auth", "token"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // The error below is intentionally independent of gh output.
  }
  throw new Error("Set SCRIPTORIUM_GITHUB_TOKEN or authenticate gh before running the GitHub acceptance");
}

async function githubRepositoryInfo(url, token) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error("SCRIPTORIUM_ACCEPTANCE_GITHUB_URL must be a GitHub repository URL"); }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repository = segments[1]?.replace(/\.git$/iu, "");
  assert.ok(parsed.protocol === "https:" && parsed.hostname === "github.com" && segments.length === 2 &&
    !parsed.search && !parsed.hash && owner && repository,
  "SCRIPTORIUM_ACCEPTANCE_GITHUB_URL must identify an HTTPS GitHub repository");
  let response;
  try {
    response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Scriptorium-P13-Publishing-Acceptance",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new Error("Unable to read the synthetic GitHub fixture repository");
  }
  assert.ok(response.ok, `Unable to read the synthetic GitHub fixture repository (HTTP ${response.status})`);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error("GitHub returned an invalid fixture repository response"); }
  assert.ok(Number.isSafeInteger(payload?.id) && typeof payload?.default_branch === "string" &&
    typeof payload?.private === "boolean", "GitHub fixture repository identity is incomplete");
  return { id: String(payload.id), defaultBranch: payload.default_branch, private: payload.private };
}

async function githubBranchHead(url, branch, token) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SCRIPTORIUM_ACCEPTANCE_GITHUB_URL must be a GitHub repository URL");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repository = segments[1]?.replace(/\.git$/iu, "");
  assert.ok(parsed.protocol === "https:" && parsed.hostname === "github.com" && segments.length === 2 &&
    !parsed.search && !parsed.hash && owner && repository,
    "SCRIPTORIUM_ACCEPTANCE_GITHUB_URL must identify an HTTPS GitHub repository");
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${ref}`;
  let response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "Scriptorium-P13-Publishing-Acceptance",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    throw new Error("Unable to read the synthetic GitHub fixture ref");
  }
  assert.ok(response.ok, `Unable to read the synthetic GitHub fixture ref (HTTP ${response.status})`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("GitHub returned an invalid fixture ref response");
  }
  assert.ok(typeof payload?.object?.sha === "string", "GitHub fixture ref has no commit ID");
  return payload.object.sha;
}

async function startHost({ dataDir, cacheDir, token }) {
  await mkdir(cacheDir, { recursive: true });
  let loaderCalls = 0;
  const runtime = new ModuleRuntime({
    manifests: [publishingManifest],
    enabled: ["publishing"],
    cacheDirectory: cacheDir,
    loaders: {
      publishing: async (context) => {
        loaderCalls += 1;
        let module;
        try {
          module = await import(publishingEntryUrl);
        } catch {
          throw new Error("The compiled Publishing module could not be loaded");
        }
        return module.createModule(context);
      },
    },
  });
  const store = new CoreStore({ dataDir, githubToken: token });
  const server = createServer({
    store,
    authToken: accessToken,
    staticDir: appStaticDirectory,
    runtime,
    profile: profileName,
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Acceptance API did not open a TCP listener");
  let closePromise;
  return {
    base: `http://127.0.0.1:${address.port}`,
    server,
    store,
    githubToken: token,
    get loaderCalls() { return loaderCalls; },
    close() {
      closePromise ??= new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      return closePromise;
    },
  };
}

async function login(host) {
  const response = await apiRequest(host, "/api/login", { method: "POST", body: { token: accessToken } });
  await expectStatus(response, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Owner login did not return a session cookie");
  return setCookie.split(";", 1)[0];
}

async function registerProject(host, cookie, url) {
  const value = await ownerJson(host, cookie, "/api/projects", { method: "POST", status: 201, body: { url } });
  assert.ok(typeof value?.id === "string" && value.branch, "Core did not register the synthetic repository");
  return value;
}

async function observe(host, cookie, projectId) {
  return ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/observation`);
}

async function remoteSnapshot(host, cookie, projectId) {
  return ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/snapshot?view=remote`);
}

function flattenScenes(tree) {
  return (tree.volumes ?? []).flatMap((volume) => (volume.chapters ?? []).flatMap((chapter) =>
    (chapter.scenes ?? []).map((scene) => ({ scene, chapterId: chapter.id, volumeId: volume.id }))));
}

async function tree(host, cookie, projectId) {
  return ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/tree?view=remote`);
}

async function readScene(host, cookie, projectId, sceneId) {
  return ownerJson(host, cookie,
    `/api/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}?view=remote`);
}

async function proposeOwnerOperations(host, cookie, projectId, snapshot, operations, batchLabel) {
  const proposalId = `p13_${randomUUID().replaceAll("-", "")}`;
  const proposed = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals`, {
    method: "POST",
    status: 201,
    body: { id: proposalId, snapshot, operations },
  });
  assert.ok(proposed?.id === proposalId && Array.isArray(proposed.operations), "Core did not accept the synthetic owner proposal");
  await publishOperations(host, cookie, projectId, proposed, batchLabel);
}

async function proposalFromAction(host, cookie, projectId, proposalId) {
  const result = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals`);
  const status = result.proposals?.find((item) => item.proposal?.id === proposalId);
  assert.ok(status?.proposal && Array.isArray(status.proposal.operations), "Publishing action proposal was not recorded by Core");
  return status.proposal;
}

async function publishOperations(host, cookie, projectId, proposal, batchLabel, beforePush) {
  const operations = proposal.operations;
  const operationIds = operations.map((operation) => operation.id);
  const approved = await apiRequest(host, `/api/projects/${encodeURIComponent(projectId)}/approvals`, {
    method: "POST", cookie, body: { proposalId: proposal.id, operationIds },
  });
  await expectStatus(approved, 204);

  for (const operation of operations) {
    const checkpoint = await apiRequest(host, `/api/projects/${encodeURIComponent(projectId)}/checkpoints`, {
      method: "POST", cookie, body: operation,
    });
    await expectStatus(checkpoint, 201);
  }

  await beforePush?.();

  const batchId = `${batchLabel}_${randomUUID().replaceAll("-", "")}`;
  const publication = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/publish`, {
    method: "POST", body: { batchId },
  });
  assert.ok(publication.state === "confirmed", "Core did not confirm the synthetic GitHub push");
  assert.ok(operationIds.every((id) => publication.acknowledged?.some((receipt) => receipt.operationId === id)),
    "Confirmed publication did not acknowledge every approved operation");

  const branch = proposal.snapshot.repository.defaultBranch;
  const remoteHead = await githubBranchHead(repositoryUrl, branch, host.githubToken);
  assert.ok(publication.remoteCommit === remoteHead, "Publish receipt does not match the actual GitHub default-branch head");
  return { publication, remoteHead };
}

async function ownerAction(host, cookie, projectId, actionId, input) {
  const result = await apiRequest(host,
    `/api/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}`,
    { method: "POST", cookie, body: { input } });
  await expectStatus(result, 200);
  const payload = await parseResponse(result);
  assert.ok(payload?.ok === true && payload.data && typeof payload.data === "object",
    "Publishing action failed through the composed HTTP host");
  return payload.data;
}

function createChangeOperation(snapshot, effect, reads, writes, message) {
  return {
    id: `p13_${randomUUID().replaceAll("-", "")}`,
    generation: 0,
    repository: snapshot.repository,
    baseRemoteCommit: snapshot.remoteCommit,
    effect,
    reads,
    writes,
    message,
  };
}

async function seedSyntheticManuscript(host, cookie, projectId, primaryScene) {
  const current = await readScene(host, cookie, projectId, primaryScene.scene.id);
  assert.ok(current.document?.path && typeof current.document.content === "string" && current.document.revision,
    "Core did not return the synthetic source manuscript");
  if (current.document.content.includes(manuscriptMarker)) return;

  const snapshot = current.snapshot;
  const separator = current.document.content.endsWith("\n") ? "\n" : "\n\n";
  const operation = createChangeOperation(snapshot, "manuscript", [
    { path: current.document.path, revision: current.document.revision },
  ], [{
    path: current.document.path,
    revision: current.document.revision,
    content: `${current.document.content}${separator}${manuscriptMarker}\n`,
  }], "Add synthetic Japanese Publishing acceptance prose");
  await proposeOwnerOperations(host, cookie, projectId, snapshot, [operation], "p13_manuscript");
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function seedSyntheticPublishingMetadata(host, cookie, projectId, primaryScene, secondaryScene) {
  const snapshotEnvelope = await remoteSnapshot(host, cookie, projectId);
  assert.ok(Array.isArray(snapshotEnvelope.files), "Core did not return the synthetic remote file snapshot");
  const files = new Map((snapshotEnvelope.files ?? []).map((file) => [file.path, file]));
  const episodeFile = files.get(episodePath);
  let episodeRoot = {};
  if (episodeFile) {
    try { episodeRoot = record(YAML.parse(episodeFile.content)); }
    catch { throw new Error("The synthetic Publishing episode map is invalid YAML"); }
  }
  const priorEpisodes = Array.isArray(episodeRoot.episodes) ? episodeRoot.episodes.map(record) : [];
  const prior = priorEpisodes.find((episode) => episode.id === episodeId) ?? {};
  const otherEpisodes = priorEpisodes.filter((episode) => episode.id !== episodeId);
  const maxNumber = Math.max(0, ...priorEpisodes.map((episode) => Number.isSafeInteger(episode.number) ? episode.number : 0));
  const testEpisode = {
    ...prior,
    id: episodeId,
    number: Number.isSafeInteger(prior.number) ? prior.number : maxNumber + 1,
    title: "合成公開回",
    scope: "chapter",
    scopeId: primaryScene.chapterId,
    publishedAt: "2025-05-04T03:02:01Z",
    sceneIds: [primaryScene.scene.id, secondaryScene.scene.id],
    p13AcceptanceEpisodeField: prior.p13AcceptanceEpisodeField ?? { retain: true },
  };
  const root = {
    ...episodeRoot,
    p13AcceptanceRootField: episodeRoot.p13AcceptanceRootField ?? { source: "synthetic-fixture", retain: true },
    episodes: [...otherEpisodes, testEpisode],
  };
  const episodeContent = YAML.stringify(root);
  const episodeRevision = episodeFile?.revision ?? null;
  const coverRevision = files.get(coverPath)?.revision ?? null;
  const operation = createChangeOperation(snapshotEnvelope.snapshot, "metadata", [
    { path: episodePath, revision: episodeRevision },
    { path: coverPath, revision: coverRevision },
    { path: "bible/characters/p13-acceptance/profile.yaml", revision: files.get("bible/characters/p13-acceptance/profile.yaml")?.revision ?? null },
    { path: "bible/characters/p13-acceptance/voice.yaml", revision: files.get("bible/characters/p13-acceptance/voice.yaml")?.revision ?? null },
  ], [
    { path: episodePath, revision: episodeRevision, content: episodeContent },
    { path: coverPath, revision: coverRevision, content: coverBytes.toString("base64"), encoding: "base64" },
    {
      path: "bible/characters/p13-acceptance/profile.yaml",
      revision: files.get("bible/characters/p13-acceptance/profile.yaml")?.revision ?? null,
      content: YAML.stringify({
        id: "p13-acceptance-character",
        name: "P13_SYNTHETIC_CHARACTER",
        notes: {
          lead: [{ type: "paragraph", text: "P13_NOTES_LEAD_日本語" }],
          sections: [{
            heading: "P13_NOTES_PARENT",
            body: [{ type: "definitions", items: [{ term: "P13_NOTES_TERM", description: "P13_NOTES_DESCRIPTION" }] }],
            children: [{
              heading: "P13_NOTES_CHILD",
              body: [{ type: "paragraph", text: "P13_NOTES_CHILD_TEXT" }],
              children: [],
            }],
          }],
        },
      }),
    },
    {
      path: "bible/characters/p13-acceptance/voice.yaml",
      revision: files.get("bible/characters/p13-acceptance/voice.yaml")?.revision ?? null,
      content: YAML.stringify({ name: voiceMarker, style: "Synthetic id-less helper data" }),
    },
  ], "Seed synthetic Publishing metadata and binary cover");
  await proposeOwnerOperations(host, cookie, projectId, snapshotEnvelope.snapshot, [operation], "p13_metadata");
}

async function findSyntheticScenes(host, cookie, projectId) {
  const value = await tree(host, cookie, projectId);
  const scenes = flattenScenes(value.tree ?? value);
  assert.ok(scenes.length >= 2, "The authorized synthetic GitHub fixture must contain at least two scenes");
  return scenes;
}

function publicSharePath(repositoryId, token) {
  return `/api/public/repos/${encodeURIComponent(repositoryId)}/modules/publishing/share/${encodeURIComponent(token)}`;
}

async function publicJson(host, route, expectedStatus) {
  const response = await apiRequest(host, route);
  await expectStatus(response, expectedStatus);
  return { response, ...(expectedStatus === 204 ? {} : { body: await parseResponse(response) }) };
}

async function openBrowserShare(browser, host, repositoryId, token) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const ownerSessionRequests = [];
  const publicReadRequests = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/session") ownerSessionRequests.push(pathname);
    if (pathname.startsWith("/api/public/repos/")) publicReadRequests.push(pathname);
  });
  const response = await page.goto(`${host.base}/r/publishing/${encodeURIComponent(repositoryId)}/${encodeURIComponent(token)}`, {
    waitUntil: "domcontentloaded",
  });
  assert.ok(response, "The anonymous browser did not receive a public reader page response");
  return { context, page, response, ownerSessionRequests, publicReadRequests };
}

test("Publishing exports and share lifecycle survive real GitHub publication and a complete Core data-root replacement", {
  skip: repositoryUrl ? false : "NOT_CHECKED: set SCRIPTORIUM_ACCEPTANCE_GITHUB_URL to the authorized synthetic repository",
  timeout: 600_000,
}, async (t) => {
  let parsedUrl;
  try { parsedUrl = new URL(repositoryUrl); }
  catch { throw new Error("SCRIPTORIUM_ACCEPTANCE_GITHUB_URL must be an HTTPS GitHub repository URL"); }
  assert.ok(parsedUrl.protocol === "https:" && parsedUrl.hostname === "github.com" &&
    parsedUrl.pathname.split("/").filter(Boolean).length === 2 && !parsedUrl.search && !parsedUrl.hash,
    "SCRIPTORIUM_ACCEPTANCE_GITHUB_URL must be an HTTPS GitHub repository URL");
  const token = await githubToken();
  const githubRepository = await githubRepositoryInfo(repositoryUrl, token);
  assert.ok(githubRepository.private, "Publishing acceptance requires the authorized private synthetic GitHub repository");
  const root = await mkdtemp(resolve(tmpdir(), "scriptorium-p13-publishing-"));
  const dataDir = resolve(root, "data");
  let host;
  t.after(async () => {
    await host?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  let browser;
  t.after(async () => { await browser?.close().catch(() => undefined); });

  host = await startHost({ dataDir, cacheDir: resolve(root, "module-cache-first"), token });
  let cookie = await login(host);
  let project = await registerProject(host, cookie, repositoryUrl);
  let observation = await observe(host, cookie, project.id);
  const identity = observation.snapshot?.repository;
  assert.ok(identity && identity.repositoryId === githubRepository.id && identity.defaultBranch === githubRepository.defaultBranch &&
    identity.defaultBranch === project.branch && /^\d{1,32}$/u.test(identity.repositoryId),
    "Core did not identify the registered GitHub default branch");
  const version = await ownerJson(host, cookie, "/api/version");
  assert.ok(version.profile === profileName && version.profile !== "full", "The integration fixture must remain distinct from the full profile");
  assert.ok(host.loaderCalls === 0, "Publishing code was imported before module activation");

  const descriptorResponse = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(project.id)}/actions`);
  const actionIds = new Set((descriptorResponse.actions ?? []).map((action) => action.id));
  for (const actionId of [
    "publishing.export.plaintext",
    "publishing.export.epub",
    "publishing.episodes.propose",
    "publishing.episodes.read",
    "publishing.shares.create",
    "publishing.shares.list",
    "publishing.shares.revoke",
  ]) assert.ok(actionIds.has(actionId), "The actual Publishing module did not register a required action");
  assert.ok(host.loaderCalls === 1, "Publishing was not activated through its lazy compiled module loader");

  // A prior interrupted opt-in run may have committed its hash-only grant
  // before its final assertions. Revoke those clearly labeled fixture grants
  // through the same approval/checkpoint/publish path before creating a new one.
  const oldShareList = await ownerAction(host, cookie, project.id, "publishing.shares.list", {});
  const abandonedShares = (oldShareList.shares ?? []).filter((share) =>
    share.label === "P13 synthetic scene share" && share.active);
  for (const share of abandonedShares) {
    const revoke = await ownerAction(host, cookie, project.id, "publishing.shares.revoke", { id: share.id });
    const revokeProposal = await proposalFromAction(host, cookie, project.id, revoke.proposalId);
    await publishOperations(host, cookie, project.id, revokeProposal, "p13_recover_abandoned_share");
  }

  const scenes = await findSyntheticScenes(host, cookie, project.id);
  const primaryScene = scenes[0];
  const secondaryScene = scenes.find((item) => item.scene.id !== primaryScene.scene.id);
  assert.ok(primaryScene && secondaryScene, "The fixture does not expose two distinct scenes");
  await seedSyntheticManuscript(host, cookie, project.id, primaryScene);
  await seedSyntheticPublishingMetadata(host, cookie, project.id, primaryScene, secondaryScene);

  const plaintextData = await ownerAction(host, cookie, project.id, "publishing.export.plaintext", { scope: "all" });
  const plaintext = Buffer.from(plaintextData.contentBase64, "base64").toString("utf8");
  assert.ok(plaintext.includes(manuscriptMarker), "Plaintext export omitted the committed Japanese source manuscript");

  const epubData = await ownerAction(host, cookie, project.id, "publishing.export.epub", {
    scope: "all",
    coverPath,
    includeBibleAppendix: true,
  });
  const epub = await JSZip.loadAsync(Buffer.from(epubData.contentBase64, "base64"));
  assert.ok(await epub.file("mimetype")?.async("string") === "application/epub+zip", "EPUB output is missing its stored EPUB mimetype");
  const packageDocument = await epub.file("OEBPS/content.opf")?.async("string");
  const navigation = await epub.file("OEBPS/nav.xhtml")?.async("string");
  const sceneDocuments = await Promise.all(Object.entries(epub.files)
    .filter(([name]) => name.startsWith("OEBPS/scene-") && name.endsWith(".xhtml"))
    .map(([, file]) => file.async("string")));
  const sceneDocument = sceneDocuments.find((content) => content.includes("星の灯りが"));
  const appendix = await epub.file("OEBPS/bible-appendix.xhtml")?.async("string");
  const embeddedCover = await epub.file("OEBPS/images/cover.jpg")?.async("nodebuffer");
  assert.ok(packageDocument?.includes('version="3.0"') && navigation?.includes("図鑑付録"),
    "EPUB output is missing its package or navigation documents");
  assert.ok(sceneDocument?.includes("<ruby>星<rt>ほし</rt></ruby>") && sceneDocument.includes("&amp;") && sceneDocument.includes("&lt;夜&gt;"),
    "EPUB XHTML did not preserve ruby or escape the synthetic source prose");
  assert.ok(embeddedCover?.equals(coverBytes), "EPUB did not preserve the generated binary cover byte for byte");
  assert.ok(appendix?.includes("P13_SYNTHETIC_CHARACTER") && !appendix.includes(voiceMarker),
    "EPUB appendix did not keep the character profile separate from its id-less voice helper");
  for (const note of ["P13_NOTES_LEAD_日本語", "P13_NOTES_TERM", "P13_NOTES_DESCRIPTION", "P13_NOTES_CHILD_TEXT"])
    assert.ok(appendix?.includes(note), "EPUB appendix omitted a structured note block");

  const episodeList = await ownerAction(host, cookie, project.id, "publishing.episodes.read", {});
  assert.ok(Array.isArray(episodeList.episodes), "Publishing read action did not return the complete episode list");
  const existingEpisode = episodeList.episodes?.find((episode) => episode.id === episodeId);
  assert.ok(existingEpisode, "Synthetic episode was not visible through the Publishing read action");
  const episodeData = await ownerAction(host, cookie, project.id, "publishing.episodes.propose", {
    episodes: episodeList.episodes.map((episode) => episode.id === episodeId ? {
      ...episode,
      title: "合成公開回の確認",
      scope: "chapter",
      scopeId: primaryScene.chapterId,
      publishedAt: null,
      sceneIds: null,
    } : episode),
  });
  const proposedEpisode = episodeData.episodes?.find((episode) => episode.id === episodeId);
  assert.ok(episodeData.proposalId && proposedEpisode && !Object.hasOwn(proposedEpisode, "publishedAt") && !Object.hasOwn(proposedEpisode, "sceneIds"),
    "Episode proposal did not apply explicit clears for optional publication fields");
  const episodeProposal = await proposalFromAction(host, cookie, project.id, episodeData.proposalId);
  const episodeWrite = episodeProposal.operations[0]?.writes?.find((write) => write.path === episodePath);
  assert.ok(episodeWrite?.content && episodeWrite.content.includes("p13AcceptanceRootField") && episodeWrite.content.includes("p13AcceptanceEpisodeField"),
    "Episode proposal did not retain module-owned unknown YAML fields");
  await publishOperations(host, cookie, project.id, episodeProposal, "p13_episode");
  const persistedEpisodes = await ownerAction(host, cookie, project.id, "publishing.episodes.read", {});
  const persistedEpisode = persistedEpisodes.episodes?.find((episode) => episode.id === episodeId);
  assert.ok(persistedEpisode && !Object.hasOwn(persistedEpisode, "publishedAt") && !Object.hasOwn(persistedEpisode, "sceneIds"),
    "Confirmed episode map did not retain the requested clear state");
  assert.ok(persistedEpisode.p13AcceptanceEpisodeField?.retain === true, "Confirmed episode map lost an unknown episode field");

  const shareData = await ownerAction(host, cookie, project.id, "publishing.shares.create", {
    kind: "scene",
    id: primaryScene.scene.id,
    label: "P13 synthetic scene share",
    expiresInHours: 24,
  });
  const shareToken = shareData.token;
  const shareId = shareData.share?.id;
  assert.ok(typeof shareToken === "string" && shareId, "Publishing did not return a synthetic share bearer and grant ID");
  const shareProposal = await proposalFromAction(host, cookie, project.id, shareData.proposalId);
  const grantWrite = shareProposal.operations[0]?.writes?.find((write) => write.path === grantsPath);
  assert.ok(grantWrite?.content && !grantWrite.content.includes(shareToken), "Raw share bearer appeared in proposed repository content");

  let publicRoute = publicSharePath(identity.repositoryId, shareToken);
  await publicJson(host, publicRoute, 404);
  const sharePublication = await publishOperations(host, cookie, project.id, shareProposal, "p13_share", async () => {
    await publicJson(host, publicRoute, 404);
  });
  const activeShare = await publicJson(host, publicRoute, 200);
  assert.ok(activeShare.body.snapshot?.remoteCommit === sharePublication.remoteHead,
    "Public share did not use the confirmed GitHub snapshot");
  assert.ok(activeShare.body.sceneCount === 1 && activeShare.body.tree?.[0]?.chapters?.[0]?.scenes?.length === 1,
    "Public share escaped its single-scene scope");
  assert.ok(activeShare.response.headers.get("referrer-policy") === "no-referrer" &&
    activeShare.response.headers.get("x-robots-tag") === "noindex, nofollow",
    "Public share response did not carry its privacy and indexing headers");
  await publicJson(host, `${publicRoute}/scenes/${encodeURIComponent(secondaryScene.scene.id)}`, 404);

  browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}),
  });
  const browserShare = await openBrowserShare(browser, host, identity.repositoryId, shareToken);
  try {
    assert.equal(browserShare.response.status(), 200, "The anonymous browser route did not serve its public reader shell");
    assert.equal(browserShare.response.headers()["referrer-policy"], "no-referrer");
    assert.equal(browserShare.response.headers()["x-robots-tag"], "noindex, nofollow");
    await browserShare.page.getByRole("heading", { name: "P13 synthetic scene share" }).waitFor({ state: "visible" });
    await browserShare.page.getByRole("button", { name: primaryScene.scene.title, exact: true }).waitFor({ state: "visible" });
    assert.equal(await browserShare.page.getByRole("button", { name: secondaryScene.scene.title, exact: true }).count(), 0,
      "The rendered anonymous reader exposed a scene outside the grant scope");
    assert.equal(await browserShare.page.locator('meta[name="robots"]').getAttribute("content"), "noindex, nofollow");
    assert.equal(await browserShare.page.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer");
    await browserShare.page.getByRole("button", { name: primaryScene.scene.title, exact: true }).click();
    await browserShare.page.getByText(manuscriptMarker, { exact: false }).waitFor({ state: "visible" });
    assert.deepEqual(browserShare.ownerSessionRequests, [], "Public browser reads did not request an owner session");
    assert.ok(browserShare.publicReadRequests.includes(`/api/public/repos/${identity.repositoryId}/modules/publishing/share/${shareToken}`));
    assert.ok(browserShare.publicReadRequests.includes(`/api/public/repos/${identity.repositoryId}/modules/publishing/share/${shareToken}/scenes/${primaryScene.scene.id}`));
  } finally {
    await browserShare.context.close();
  }

  const actualNow = Date.now;
  Date.now = () => actualNow() + 25 * 60 * 60 * 1000;
  try {
    await publicJson(host, publicRoute, 404);
    const expiredBrowserShare = await openBrowserShare(browser, host, identity.repositoryId, shareToken);
    try {
      await expiredBrowserShare.page.getByRole("alert").waitFor({ state: "visible" });
      assert.match(await expiredBrowserShare.page.getByRole("alert").innerText(), /期限切れ/u,
        "The anonymous browser did not show the expired-link state");
      assert.deepEqual(expiredBrowserShare.ownerSessionRequests, [], "Expired public views did not request an owner session");
    } finally {
      await expiredBrowserShare.context.close();
    }
  } finally {
    Date.now = actualNow;
  }

  const expectedEpisodeBytes = episodeWrite.content;
  const publishedSnapshot = await remoteSnapshot(host, cookie, project.id);
  const grantFile = publishedSnapshot.files?.find((file) => file.path === grantsPath);
  const episodeFile = publishedSnapshot.files?.find((file) => file.path === episodePath);
  assert.ok(grantFile && episodeFile && grantFile.content && episodeFile.content,
    "Confirmed Publishing metadata was missing from the remote repository snapshot");
  assert.ok(episodeFile.content.includes("p13AcceptanceRootField") && episodeFile.content.includes("p13AcceptanceEpisodeField"),
    "Remote episode bytes lost unknown metadata");
  assert.ok(!grantFile.content.includes(shareToken), "Raw share bearer was committed to GitHub");

  await host.close();
  host = undefined;
  await rm(dataDir, { recursive: true, force: true });
  host = await startHost({ dataDir, cacheDir: resolve(root, "module-cache-reclone"), token });
  cookie = await login(host);
  const restoredProject = await registerProject(host, cookie, repositoryUrl);
  const restoredObservation = await observe(host, cookie, restoredProject.id);
  const restoredIdentity = restoredObservation.snapshot?.repository;
  const restoredRemoteHead = await githubBranchHead(repositoryUrl, restoredProject.branch, token);
  assert.ok(restoredIdentity?.repositoryId === identity.repositoryId &&
    restoredIdentity?.defaultBranch === identity.defaultBranch && restoredIdentity?.ownerScope === identity.ownerScope,
    "Re-clone did not recover the same registered GitHub repository identity");
  assert.ok(restoredProject.branch === project.branch, "Re-clone did not select the repository default branch");
  const restoredSnapshot = await remoteSnapshot(host, cookie, restoredProject.id);
  const restoredEpisodeFile = restoredSnapshot.files?.find((file) => file.path === episodePath);
  const restoredGrantFile = restoredSnapshot.files?.find((file) => file.path === grantsPath);
  assert.ok(restoredEpisodeFile?.content === expectedEpisodeBytes, "Episode bytes changed after deleting the complete Core data root and re-cloning");
  assert.ok(restoredGrantFile?.content === grantFile.content, "Share grant bytes changed after deleting the complete Core data root and re-cloning");
  const restoredEpisodes = await ownerAction(host, cookie, restoredProject.id, "publishing.episodes.read", {});
  assert.ok(restoredEpisodes.episodes?.some((episode) => episode.id === episodeId),
    "Publishing could not read the confirmed episode after re-clone");
  const restoredShare = await publicJson(host, publicRoute, 200);
  assert.ok(restoredObservation.snapshot?.remoteCommit === restoredRemoteHead && restoredShare.body.snapshot?.remoteCommit === restoredRemoteHead,
    "Public share did not read the re-cloned GitHub default branch");

  const revokeData = await ownerAction(host, cookie, restoredProject.id, "publishing.shares.revoke", { id: shareId });
  const revokeProposal = await proposalFromAction(host, cookie, restoredProject.id, revokeData.proposalId);
  await publicJson(host, publicRoute, 200);
  const revokePublication = await publishOperations(host, cookie, restoredProject.id, revokeProposal, "p13_revoke", async () => {
    await publicJson(host, publicRoute, 200);
  });
  assert.ok(revokePublication.remoteHead !== sharePublication.remoteHead,
    "Revocation publication did not advance the actual GitHub default branch");
  await publicJson(host, publicRoute, 404);
  const revokedBrowserShare = await openBrowserShare(browser, host, identity.repositoryId, shareToken);
  try {
    await revokedBrowserShare.page.getByRole("alert").waitFor({ state: "visible" });
    assert.match(await revokedBrowserShare.page.getByRole("alert").innerText(), /無効/u,
      "The anonymous browser did not display the pushed revocation");
    assert.deepEqual(revokedBrowserShare.ownerSessionRequests, [], "Revoked public views did not request an owner session");
  } finally {
    await revokedBrowserShare.context.close();
  }
  const afterRevoke = await observe(host, cookie, restoredProject.id);
  assert.ok(afterRevoke.snapshot?.remoteCommit === revokePublication.remoteHead,
    "Core did not freshly observe the confirmed revocation commit");
  assert.ok(host.loaderCalls === 1, "Re-cloned Publishing module was not lazily composed through the actual factory");
});
