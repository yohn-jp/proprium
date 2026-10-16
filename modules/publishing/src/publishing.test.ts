import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import JSZip from "jszip";
import YAML from "yaml";
import type { ChangeOperation, ChangeProposal, ModuleActionContext, ModuleContext, SnapshotId, SnapshotReader } from "@scriptorium/contracts";
import { createWorkspaceProducer, type LegacySourceReader, type MigrationContext } from "@scriptorium/migration";
import { createModule } from "./index.js";
import { buildEpubExport } from "./epub.js";
import { buildPlaintextExport, stripManuscriptMarkup, toNarouDialect } from "./plaintext.js";
import { composeVerticalPrintText } from "./verticalPrint.js";
import { createPublishingMigrationProducer } from "./migration.js";
import { hashShareToken, SHARE_GRANTS_PATH, type ShareGrant } from "./grants.js";
import { EPISODES_PATH } from "./episodes.js";
import type { PublishingProject } from "./project.js";

const BASE_COMMIT = "a".repeat(40);
const NEXT_COMMIT = "b".repeat(40);
const repository = {
  provider: "local" as const,
  repositoryId: "local-publishing-7",
  defaultBranch: "main",
  ownerScope: "owner-1",
  url: "file:///synthetic/publishing",
};

function makeSnapshot(remoteCommit = BASE_COMMIT, overlayCommit?: string): SnapshotId {
  return { repository, remoteCommit, ...(overlayCommit ? { overlayCommit } : {}) };
}

class MemoryReader implements SnapshotReader {
  readonly files: Map<string, Buffer>;
  constructor(files: Map<string, Buffer | string>, public snapshot: SnapshotId = makeSnapshot()) {
    this.files = new Map([...files].map(([path, content]) => [path, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8")]));
  }
  async read(path: string, encoding: "utf8" | "base64" = "utf8") {
    const bytes = this.files.get(path);
    if (!bytes) return null;
    return { content: encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf8"), revision: createHash("sha256").update(bytes).digest("hex") };
  }
  async list(prefix: string) { return [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort(); }
}

function fixtureFiles(): Map<string, Buffer | string> {
  return new Map([
    ["meta/project.yaml", "title: 星の図書館\nsubtitle: 第二巻\n"],
    ["plot/volumes/vol-1/volume.yaml", "id: vol-1\ntitle: 第一巻\norder: 1\n"],
    ["plot/volumes/vol-1/chapters/ch-1/chapter.yaml", "id: ch-1\ntitle: はじまり\norder: 1\n"],
    ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-1.yaml", "id: sc-1\ntitle: 夜の駅\norder: 1\nmanuscript: manuscript/vol-1/ch-1/sc-1.md\n"],
    ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-2.yaml", "id: sc-2\ntitle: 朝の港\norder: 2\nmanuscript: manuscript/vol-1/ch-1/sc-2.md\n"],
    ["manuscript/vol-1/ch-1/sc-1.md", "---\ntitle: 夜の駅\nprivateNote: 保持\n---\n|星《ほし》の駅で、《《彼女》》は待った。 & <物語>。\n"],
    ["manuscript/vol-1/ch-1/sc-2.md", "海から朝日が昇った。\n"],
    ["bible/characters/character-ari/profile.yaml", "id: character-ari\nname: アリ\naliases: [あり]\nnotes: 星を読む人\n"],
  ]);
}

const project: PublishingProject = {
  title: "星の図書館",
  subtitle: "第二巻",
  volumes: [{
    id: "vol-1", title: "第一巻", order: 1, chapters: [{
      id: "ch-1", title: "はじまり", order: 1, scenes: [
        { id: "sc-1", title: "夜の駅", body: "|星《ほし》の駅で、《《彼女》》は待った。 & <物語>。", path: "manuscript/vol-1/ch-1/sc-1.md", volumeId: "vol-1", chapterId: "ch-1", order: 1 },
        { id: "sc-2", title: "朝の港", body: "海から朝日が昇った。", path: "manuscript/vol-1/ch-1/sc-2.md", volumeId: "vol-1", chapterId: "ch-1", order: 2 },
      ],
    }],
  }],
};

function actionContext(reader: SnapshotReader, proposals: ChangeProposal[]): ModuleActionContext {
  return {
    projectId: "module-project-1",
    reader,
    invoke: async () => ({ ok: false, snapshot: reader.snapshot, error: { code: "unused", message: "unused", retryable: false } }),
    listActions: async () => [],
    linkedReader: async () => reader,
    signal: new AbortController().signal,
    propose: async (operations, evidence) => {
      const proposal = { id: "proposal-" + (proposals.length + 1), snapshot: reader.snapshot, operations, source: "module" as const, ...(evidence ? { evidence } : {}) };
      proposals.push(proposal);
      return proposal;
    },
    runJob: async () => ({ ok: false, id: "unused", snapshot: reader.snapshot, error: { code: "unused", message: "unused", retryable: false } }),
  };
}

async function createPublishing() {
  const moduleContext: ModuleContext = {
    cacheDirectory: "/tmp/publishing-test-cache",
    signal: new AbortController().signal,
    acquireCapability: async () => { throw new Error("no capabilities required"); },
    createWorkerService: async () => { throw new Error("no worker required"); },
  };
  return createModule(moduleContext);
}

async function invokeAction(definition: Awaited<ReturnType<typeof createModule>>, id: string, input: unknown, context: ModuleActionContext) {
  const action = definition.actions.find((candidate) => candidate.id === id);
  assert.ok(action, "expected action " + id);
  const parsed = action.inputSchema.parse(input);
  const result = await action.invoke(parsed, context);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, unknown>;
}

function applyOperation(reader: MemoryReader, operation: ChangeOperation, newCommit: string, overlay = false): MemoryReader {
  const files = new Map([...reader.files].map(([path, content]) => [path, Buffer.from(content)]));
  for (const write of operation.writes) {
    if (write.content === null) files.delete(write.path);
    else files.set(write.path, write.encoding === "base64" ? Buffer.from(write.content, "base64") : Buffer.from(write.content, "utf8"));
  }
  return new MemoryReader(files, makeSnapshot(newCommit, overlay ? "checkpoint-1" : undefined));
}

test("source plaintext conversion and vertical print keep Japanese text and scene order", () => {
  const raw = buildPlaintextExport(project, { scope: "chapter", id: "ch-1" });
  assert.equal(raw.filename, "arcadia-第一巻_はじまり-raw.txt");
  assert.match(raw.text, /夜の駅[\s\S]*朝の港/u);
  assert.match(stripManuscriptMarkup(raw.text), /星の駅で、彼女は待った/u);
  assert.match(toNarouDialect("|星《ほし》 《《彼女》》"), /\|星《ほし》/u);
  assert.equal(composeVerticalPrintText([
    { id: "sc-1", title: "夜の駅", body: "|星《ほし》の駅。\n" },
    { id: "empty", title: "空", body: " \n" },
    { id: "sc-2", title: "朝の港", body: "海。\n" },
  ]), "夜の駅\n\n|星《ほし》の駅。\n\n朝の港\n\n海。\n");
});

test("real EPUB ZIP contains EPUB3 manifest, Japanese XHTML, appendix, and binary cover bytes", async () => {
  const cover = Buffer.from([0xff, 0xd8, 0x00, 0x81, 0xfe, 0x00, 0xd9]);
  const files = fixtureFiles();
  files.set("meta/scriptorium/modules/publishing/assets/cover.jpg", cover);
  const exported = await buildEpubExport(
    project,
    { scope: "all", coverPath: "meta/scriptorium/modules/publishing/assets/cover.jpg", includeBibleAppendix: true },
    new MemoryReader(files),
    [{ id: "ari", type: "character", name: "アリ", aliases: ["あり"], notes: "星を読む。" }],
  );
  assert.equal(exported.filename, "arcadia-all.epub");
  const zip = await JSZip.loadAsync(exported.buffer);
  assert.equal(await zip.file("mimetype")!.async("string"), "application/epub+zip");
  const opf = await zip.file("OEBPS/content.opf")!.async("string");
  assert.match(opf, /version="3\.0"/u);
  assert.match(opf, /properties="cover-image"/u);
  const scene = await zip.file("OEBPS/scene-sc-1.xhtml")!.async("string");
  assert.match(scene, /星/u);
  assert.match(scene, /<ruby>星<rt>ほし<\/rt><\/ruby>/u);
  assert.match(scene, /<span class="bouten">彼女<\/span>/u);
  assert.match(scene, /&amp; &lt;物語&gt;/u);
  const appendix = await zip.file("OEBPS/bible-appendix.xhtml")!.async("string");
  assert.match(appendix, /アリ/u);
  assert.deepEqual(await zip.file("OEBPS/images/cover.jpg")!.async("nodebuffer"), cover);
});

test("episode edits propose metadata operations and preserve unknown YAML and publication dates", async () => {
  const existingMap = YAML.stringify({
    episodes: [{
      id: "ep-1", number: 1, title: "第一話", scope: "chapter", scopeId: "ch-1",
      publishedAt: "2025-05-04T03:02:01Z", sceneIds: ["sc-1"], futureEpisodeField: { retain: "yes" },
    }],
    futureMapField: { provider: "legacy", revision: 3 },
  });
  const reader = new MemoryReader(new Map([...fixtureFiles(), [EPISODES_PATH, existingMap]]));
  const definition = await createPublishing();
  const proposals: ChangeProposal[] = [];
  const context = actionContext(reader, proposals);
  const episodes = (await invokeAction(definition, "publishing.episodes.read", {}, context)).episodes as Array<Record<string, unknown>>;
  const proposalData = await invokeAction(definition, "publishing.episodes.propose", {
    episodes: [{ id: "ep-1", number: 2, title: "改題", scope: "chapter", scopeId: "ch-1" }],
  }, context);
  assert.equal(proposals.length, 1);
  const operation = proposals[0]!.operations[0]!;
  assert.equal(operation.effect, "metadata");
  assert.deepEqual(operation.writes.map((write) => write.path), [EPISODES_PATH]);
  const written = YAML.parse(operation.writes[0]!.content!);
  assert.deepEqual(written.futureMapField, { provider: "legacy", revision: 3 });
  assert.deepEqual(written.episodes[0].futureEpisodeField, { retain: "yes" });
  assert.equal(written.episodes[0].publishedAt, "2025-05-04T03:02:01Z");
  assert.deepEqual(written.episodes[0].sceneIds, ["sc-1"]);
  assert.equal((proposalData.episodes as unknown[]).length, 1);
  assert.equal(episodes.length, 1);
  assert.equal((await reader.read(EPISODES_PATH))!.content, existingMap, "actions never write source files");
});

test("a share activates only on the remote published snapshot and revocation is checked on every public read", async () => {
  const definition = await createPublishing();
  const proposals: ChangeProposal[] = [];
  let remote = new MemoryReader(fixtureFiles());
  const context = actionContext(remote, proposals);
  const created = await invokeAction(definition, "publishing.shares.create", {
    kind: "chapter", id: "ch-1", label: "校正用", expiresInHours: 24,
  }, context);
  const token = String(created.token);
  const createOperation = proposals[0]!.operations[0]!;
  const createJson = createOperation.writes[0]!.content!;
  assert.ok(!createJson.includes(token), "raw bearer is never committed");
  assert.equal(JSON.parse(createJson).tokenHash, hashShareToken(token));

  const publicBase = definition.http!.find((item) => item.id === "publishing.http.public-share")!;
  const publicScene = definition.http!.find((item) => item.id === "publishing.http.public-share-scene")!;
  const publicContext = (reader: SnapshotReader) => actionContext(reader, []);
  const url = "https://scriptorium.invalid/api/public/repos/local-publishing-7/modules/publishing/share/" + encodeURIComponent(token);
  const beforePublish = await publicBase.handle(new Request(url), publicContext(remote));
  assert.equal(beforePublish.status, 404, "an unpushed checkpoint/proposal is not public");

  const checkpoint = applyOperation(remote, createOperation, BASE_COMMIT, true);
  assert.equal((await publicBase.handle(new Request(url), publicContext(checkpoint))).status, 503, "public readers reject a checkpoint overlay");

  remote = applyOperation(remote, createOperation, NEXT_COMMIT);
  const metadataResponse = await publicBase.handle(new Request(url), publicContext(remote));
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json() as { sceneCount: number; tree: Array<{ chapters: Array<{ scenes: Array<{ id: string }> }> }> };
  assert.equal(metadata.sceneCount, 2);
  assert.deepEqual(metadata.tree[0]!.chapters[0]!.scenes.map((scene) => scene.id), ["sc-1", "sc-2"]);
  const sceneUrl = url + "/scenes/sc-1";
  assert.equal((await publicScene.handle(new Request(sceneUrl), publicContext(remote))).status, 200);
  assert.equal((await publicScene.handle(new Request(url + "/scenes/out-of-scope"), publicContext(remote))).status, 404);

  const listed = await invokeAction(definition, "publishing.shares.list", {}, actionContext(remote, []));
  const safeList = listed.shares as Array<Record<string, unknown>>;
  assert.ok(!JSON.stringify(safeList).includes(token));
  assert.ok(!JSON.stringify(safeList).includes(hashShareToken(token)));

  const revoked = await invokeAction(definition, "publishing.shares.revoke", { id: String((created.share as Record<string, unknown>).id) }, actionContext(remote, proposals));
  const revokeOperation = proposals.at(-1)!.operations[0]!;
  assert.ok(revoked.proposalId);
  assert.equal((await publicBase.handle(new Request(url), publicContext(remote))).status, 200, "local revocation does not alter the current remote snapshot");
  remote = applyOperation(remote, revokeOperation, "c".repeat(40));
  assert.equal((await publicBase.handle(new Request(url), publicContext(remote))).status, 404, "confirmed remote revocation blocks the next read");

  const expiredToken = "share_" + "x".repeat(43);
  const expired: ShareGrant = {
    version: 1, grantVersion: 2, revocationVersion: 0, id: "expired-grant",
    tokenHash: hashShareToken(expiredToken), scope: { kind: "scene", id: "sc-1" },
    label: "期限切れ", createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2024-01-02T00:00:00.000Z",
  };
  const expiredReader = new MemoryReader(new Map([...remote.files, [SHARE_GRANTS_PATH, JSON.stringify(expired) + "\n"]]), remote.snapshot);
  const expiredUrl = url.slice(0, url.lastIndexOf("/") + 1) + expiredToken;
  assert.equal((await publicBase.handle(new Request(expiredUrl), publicContext(expiredReader))).status, 404);
});

test("publishing migration hook validates the exact-byte episode map and selected hashed share records without duplicate writes", async () => {
  const map = "episodes:\n  - id: ep-old\n    number: 3\n    title: 古い話\n    publishedAt: 2024-02-03\n    scope: chapter\n    scopeId: ch-1\n    legacyNote: keep-me\n";
  const workspace = JSON.stringify([
    { id: "share-1", ownerId: "host-user", projectId: "legacy-project", scope: "ch-1", label: "校正", tokenHash: "d".repeat(64), tokenPrefix: "share_secret", createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", revokedAt: "2024-02-01T00:00:00.000Z" },
    { id: "other-project", ownerId: "host-user", projectId: "other", scope: "ch-9", label: "other", tokenHash: "e".repeat(64), createdAt: "2024-01-01", expiresAt: "2030-01-01" },
  ]);
  const projectFiles = new Map([["meta/publish-episodes.yaml", Buffer.from(map)]]);
  const workspaceFiles = new Map([["app-state/share-tokens.json", Buffer.from(workspace)]]);
  const source = {
    projectRoot: "/synthetic/legacy-project",
    workspaceDataRoot: "/synthetic/workspace",
    readProjectFile: async (path: string) => projectFiles.get(path) ?? null,
    listProjectFiles: async (prefix: string) => [...projectFiles.keys()].filter((path) => path.startsWith(prefix)),
    readWorkspaceFile: async (path: string) => workspaceFiles.get(path) ?? null,
    listWorkspaceFiles: async (prefix: string) => [...workspaceFiles.keys()].filter((path) => path.startsWith(prefix)),
  } as unknown as LegacySourceReader;
  const target = new MemoryReader(new Map());
  const migrationContext: MigrationContext = {
    source,
    target,
    repository,
    snapshot: target.snapshot,
    enabledModules: new Set(["publishing"]),
    workspaceProjectId: "legacy-project",
  };

  const semantic = await createPublishingMigrationProducer().inspect(migrationContext);
  assert.equal(semantic.operations.length, 0);
  assert.ok(semantic.entries.some((entry) => entry.source === "meta/publish-episodes.yaml" && entry.disposition === "planned"));
  assert.ok(semantic.entries.some((entry) => entry.source === "app-state/share-tokens.json" && entry.recordCount === 1));

  const generic = await createWorkspaceProducer().inspect(migrationContext);
  assert.equal(generic.operations.length, 1);
  const migrated = JSON.parse(generic.operations[0]!.writes[0]!.content!.trim());
  assert.equal(migrated.id, "share-1");
  assert.equal(migrated.tokenHash, "d".repeat(64));
  assert.equal(migrated.createdAt, "2024-01-01T00:00:00.000Z");
  assert.equal(migrated.expiresAt, "2030-01-01T00:00:00.000Z");
  assert.equal(migrated.revokedAt, "2024-02-01T00:00:00.000Z");
  assert.ok(!JSON.stringify(migrated).includes("host-user"));
  assert.ok(!JSON.stringify(migrated).includes("share_secret"));
  assert.equal(generic.operations[0]!.writes[0]!.path, SHARE_GRANTS_PATH);

  const exactTarget = new MemoryReader(new Map([[EPISODES_PATH, map]]));
  const roundTrip = await createPublishingMigrationProducer().inspect({ ...migrationContext, target: exactTarget });
  assert.ok(roundTrip.entries.some((entry) => entry.source === "meta/publish-episodes.yaml" && entry.disposition === "unchanged"));
  const module = await createPublishing();
  const episodes = await invokeAction(module, "publishing.episodes.read", {}, actionContext(exactTarget, []));
  const first = (episodes.episodes as Array<Record<string, unknown>>)[0]!;
  assert.equal(first.publishedAt, "2024-02-03");
  assert.equal(first.legacyNote, "keep-me");
});
