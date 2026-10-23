import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import JSZip from "jszip";
import YAML from "yaml";
import type { ChangeOperation, ChangeProposal, ModuleActionContext, ModuleContext, SnapshotId, SnapshotReader } from "@scriptorium/contracts";
import { createWorkspaceProducer, proposeMigrationImport, type LegacySourceReader, type MigrationContext, type MigrationInspection } from "@scriptorium/migration";
import { createModule } from "./index.js";
import { readEpubBibleEntries } from "./bible.js";
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
  if (!result.ok) throw new Error("Expected successful result");
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
  files.set("bible/characters/character-ari/profile.yaml", YAML.stringify({
    id: "character-ari",
    name: "アリ",
    aliases: ["あり"],
    notes: {
      lead: [{ type: "paragraph", text: "星を読む。" }],
      sections: [{
        heading: "記録",
        body: [{ type: "definitions", items: [{ term: "声紋の核", description: "星の力" }] }],
        children: [{
          heading: "補注",
          body: [{ type: "steps", items: [{ term: "第一の段階", description: "薄明から始める" }] }],
          children: [],
        }],
      }],
    },
  }));
  // The source loader attaches this id-less helper to profile.yaml; it is not
  // a separate character or bibliography entry.
  files.set("bible/characters/character-ari/voice.yaml", "first_person:\n  - name: 我\nduality:\n  outer:\n    tone: 静かな話し方\n");
  const reader = new MemoryReader(files);
  const bibleEntries = await readEpubBibleEntries(reader);
  assert.equal(bibleEntries.length, 1, "profile.yaml contributes one character; voice.yaml is a helper");
  assert.equal(bibleEntries[0]!.id, "character-ari");
  const exported = await buildEpubExport(
    project,
    { scope: "all", coverPath: "meta/scriptorium/modules/publishing/assets/cover.jpg", includeBibleAppendix: true },
    reader,
    bibleEntries,
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
  assert.match(appendix, /星を読む/u);
  assert.match(appendix, /声紋の核/u);
  assert.match(appendix, /星の力/u);
  assert.match(appendix, /第一の段階/u);
  assert.match(appendix, /薄明から始める/u);
  assert.doesNotMatch(appendix, /静かな話し方|<h3>voice<\/h3>/u);
  assert.deepEqual(await zip.file("OEBPS/images/cover.jpg")!.async("nodebuffer"), cover);
});

test("EPUB bible reader keeps source flat character entities and typed lore/location YAML", async () => {
  const reader = new MemoryReader(new Map([
    ["bible/characters/char-flat.yaml", "id: char-flat\ntype: character\nname: 古い人物\n"],
    ["bible/characters/char-flat/voice.yaml", "first_person:\n  - name: 我\n"],
    ["bible/lore/lore-1.yaml", "id: lore-1\nname: 星の法則\n"],
    ["bible/locations/location-1.yaml", "id: location-1\nname: 海辺\n"],
  ]));
  const entries = await readEpubBibleEntries(reader);
  assert.deepEqual(entries.map((entry) => entry.id).sort(), ["char-flat", "location-1", "lore-1"]);
  assert.equal(entries.find((entry) => entry.id === "char-flat")!.name, "古い人物");
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

  const cleared = await invokeAction(definition, "publishing.episodes.propose", {
    episodes: [{
      id: "ep-1", number: 2, title: "改題", scope: "chapter", scopeId: "ch-1",
      publishedAt: null, sceneIds: null,
    }],
  }, context);
  const clearedEpisode = (cleared.episodes as Array<Record<string, unknown>>)[0]!;
  const clearedYaml = YAML.parse(proposals.at(-1)!.operations[0]!.writes[0]!.content!);
  assert.ok(!Object.hasOwn(clearedEpisode, "publishedAt"), "explicit null clears the date from the action result");
  assert.ok(!Object.hasOwn(clearedEpisode, "sceneIds"), "explicit null clears scene annotations from the action result");
  assert.ok(!Object.hasOwn(clearedYaml.episodes[0], "publishedAt"), "explicit null clears the persisted date");
  assert.ok(!Object.hasOwn(clearedYaml.episodes[0], "sceneIds"), "explicit null clears persisted scene annotations");
  assert.deepEqual(clearedYaml.episodes[0].futureEpisodeField, { retain: "yes" }, "unknown episode fields remain preserved on clear");
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
  assert.equal(metadataResponse.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(metadataResponse.headers.get("referrer-policy"), "no-referrer");
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
  const expiredReader = new MemoryReader(new Map<string, Buffer | string>([...remote.files, [SHARE_GRANTS_PATH, JSON.stringify(expired) + "\n"]]), remote.snapshot);
  const expiredUrl = url.slice(0, url.lastIndexOf("/") + 1) + expiredToken;
  assert.equal((await publicBase.handle(new Request(expiredUrl), publicContext(expiredReader))).status, 404);
});

test("publishing migration hook validates the exact-byte episode map and selected hashed share records without duplicate writes", async () => {
  const map = "episodes:\n  - id: ep-old\n    number: 3\n    title: 古い話\n    publishedAt: 2024-02-03\n    scope: chapter\n    scopeId: ch-1\n    legacyNote: keep-me\n";
  const workspace = JSON.stringify([
    { id: "share-1", ownerId: "host-user", projectId: "legacy-project", scope: "ch-1", label: "校正", tokenHash: "d".repeat(64), tokenPrefix: "share_secret", createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", revokedAt: "2024-02-01T00:00:00.000Z" },
    { id: "share-nested", ownerId: "host-user", projectId: "legacy-project", scope: { kind: "scene", id: "sc-1", token: "nested-source-scope-secret" }, label: "nested", tokenHash: "c".repeat(64), createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" },
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
  assert.ok(semantic.entries.some((entry) => entry.source === "app-state/share-tokens.json" && entry.disposition === "blocked" && entry.recordCount === 1), "Publishing inspection withholds unsupported nested source scopes");

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
  assert.ok(!JSON.stringify(generic).includes("nested-source-scope-secret"), "unsupported nested legacy scopes are withheld without leaking their fields");
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

test("publishing reactivation proposes retained episode bytes and safely merges hashed grants", async () => {
  const episodeBytes = "# author comment stays byte-for-byte\nepisodes:\n  - id: ep-kept\n    number: 4\n    title: 保存された話\n    publishedAt: 2024-05-06\n    scope: chapter\n    scopeId: ch-1\n    vendorField: keep-me\n";
  const grantRows = [
    { id: "grant-z", projectId: repository.repositoryId, scope: { kind: "scene", id: "sc-1", token: "nested-reactivation-scope-secret" }, label: "scene", tokenHash: "f".repeat(64), createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", revokedAt: "2024-02-01T00:00:00.000Z", ownerId: "must-not-return", tokenPrefix: "share_never-return", token: "raw-bearer-never-return" },
    { id: "grant-a", projectId: repository.repositoryId, scope: "ch-1", label: "chapter", tokenHash: "e".repeat(64), createdAt: "2024-03-01T00:00:00.000Z", expiresAt: "2030-03-01T00:00:00.000Z", lastUsedAt: "2024-04-01T00:00:00.000Z" },
  ];
  const retainedEpisodePath = "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml";
  const retainedGrantPath = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  const retainedGrants = grantRows.map((grant) => JSON.stringify(grant)).join("\n") + "\n";
  const target = new MemoryReader(new Map([
    [retainedEpisodePath, episodeBytes],
    [retainedGrantPath, retainedGrants],
  ]));
  const source = {
    projectRoot: "/synthetic/legacy-project-gone",
    workspaceDataRoot: "/synthetic/workspace-gone",
    readProjectFile: async () => null,
    listProjectFiles: async () => [],
    readWorkspaceFile: async () => null,
    listWorkspaceFiles: async () => [],
  } as unknown as LegacySourceReader;
  const migrationContext: MigrationContext = {
    source,
    target,
    repository,
    snapshot: target.snapshot,
    enabledModules: new Set(["publishing"]),
  };

  const producer = createPublishingMigrationProducer();
  const inspection = await producer.inspect(migrationContext);
  assert.equal(inspection.operations.length, 2);
  const episodeOperation = inspection.operations.find((operation) => operation.writes[0]?.path === EPISODES_PATH)!;
  const grantsOperation = inspection.operations.find((operation) => operation.writes[0]?.path === SHARE_GRANTS_PATH)!;
  assert.equal(episodeOperation.writes[0]!.content, episodeBytes, "episode YAML comments and unknown fields are restored as exact bytes");
  for (const [operation, targetPath, retainedPath] of [
    [episodeOperation, EPISODES_PATH, retainedEpisodePath],
    [grantsOperation, SHARE_GRANTS_PATH, retainedGrantPath],
  ] as const) {
    assert.ok(operation.reads.some((read) => read.path === targetPath && read.revision === null), "new canonical file is guarded as absent");
    assert.equal(operation.reads.find((read) => read.path === retainedPath)?.revision, (await target.read(retainedPath))!.revision, "retained source revision is part of the proposal precondition");
  }
  const mergedRows = grantsOperation.writes[0]!.content!.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(mergedRows.map((grant) => grant.id), ["grant-a", "grant-z"], "new grants are appended in stable ID order");
  assert.equal(mergedRows[0]!.projectId, repository.repositoryId);
  assert.equal(mergedRows[0]!.lastUsedAt, "2024-04-01T00:00:00.000Z");
  assert.equal(mergedRows[1]!.revokedAt, "2024-02-01T00:00:00.000Z");
  assert.deepEqual(mergedRows[1]!.scope, { kind: "scene", id: "sc-1" }, "reactivated object scopes retain only the supported kind and ID");
  const proposalJson = JSON.stringify(inspection);
  for (const secret of ["must-not-return", "share_never-return", "raw-bearer-never-return", "nested-reactivation-scope-secret"]) {
    assert.ok(!proposalJson.includes(secret), `reactivation proposal excludes ${secret}`);
  }
  const repeatedPlan = await producer.inspect(migrationContext);
  assert.deepEqual(repeatedPlan.operations.map((operation) => operation.id), inspection.operations.map((operation) => operation.id), "same retained revisions produce stable operation identities");

  const coreProposal: MigrationInspection = {
    snapshot: target.snapshot,
    entries: inspection.entries,
    operations: inspection.operations,
    recovery: [],
    pendingWorkspace: { repository: false, pendingCommitCount: 0, workingTreePaths: [], untrackedPaths: [], stagedPaths: [], blockers: [] },
  };
  let submitted: ChangeProposal | undefined;
  await proposeMigrationImport({
    async propose(projectId, proposal) {
      assert.equal(projectId, "module-project-1");
      submitted = proposal;
      return proposal;
    },
  }, "module-project-1", coreProposal);
  assert.equal(submitted?.source, "author");
  assert.deepEqual(submitted?.operations.map((operation) => operation.id), inspection.operations.map((operation) => operation.id));
  assert.ok(!JSON.stringify(submitted).includes("nested-reactivation-scope-secret"), "Core proposal payload excludes nested scope secrets");

  const appliedEpisodes = applyOperation(target, episodeOperation, NEXT_COMMIT);
  const appliedAll = applyOperation(appliedEpisodes, grantsOperation, NEXT_COMMIT);
  const alreadyRestored = await producer.inspect({ ...migrationContext, target: appliedAll, snapshot: appliedAll.snapshot });
  assert.deepEqual(alreadyRestored.operations, [], "reinspection after applying the proposal is idempotent");
  assert.ok(alreadyRestored.entries.some((entry) => entry.target === EPISODES_PATH && entry.disposition === "unchanged"));
  assert.ok(alreadyRestored.entries.some((entry) => entry.target === SHARE_GRANTS_PATH && entry.disposition === "unchanged"));

  const existingGrant = grantRows[0]!;
  const existingContent = JSON.stringify({
    id: existingGrant.id,
    projectId: existingGrant.projectId,
    scope: existingGrant.scope,
    label: existingGrant.label,
    tokenHash: existingGrant.tokenHash,
    createdAt: existingGrant.createdAt,
    expiresAt: existingGrant.expiresAt,
    revokedAt: existingGrant.revokedAt,
  }) + "\n";
  const conflictTarget = new MemoryReader(new Map([
    [retainedGrantPath, retainedGrants],
    [SHARE_GRANTS_PATH, existingContent.replace('"label":"scene"', '"label":"edited"')],
  ]));
  const grantConflict = await producer.inspect({ ...migrationContext, target: conflictTarget, snapshot: conflictTarget.snapshot });
  assert.ok(grantConflict.entries.some((entry) => entry.target === SHARE_GRANTS_PATH && entry.disposition === "conflict"));
  assert.ok(!grantConflict.operations.some((operation) => operation.writes.some((write) => write.path === SHARE_GRANTS_PATH)), "divergent same-ID metadata is never overwritten");

  const episodeConflictTarget = new MemoryReader(new Map([
    [retainedEpisodePath, episodeBytes],
    [EPISODES_PATH, "episodes: []\n"],
  ]));
  const episodeConflict = await producer.inspect({ ...migrationContext, target: episodeConflictTarget, snapshot: episodeConflictTarget.snapshot });
  assert.ok(episodeConflict.entries.some((entry) => entry.target === EPISODES_PATH && entry.disposition === "conflict"));
  assert.ok(!episodeConflict.operations.some((operation) => operation.writes.some((write) => write.path === EPISODES_PATH)), "different canonical episode bytes are never overwritten");
});

test("publishing reactivation defers to live stores and does nothing while disabled", async () => {
  const retainedEpisodePath = "meta/scriptorium/modules/publishing/legacy/files/meta/publish-episodes.yaml";
  const retainedGrantPath = "meta/scriptorium/modules/publishing/legacy/share-grants.jsonl";
  const target = new MemoryReader(new Map([
    [retainedEpisodePath, "episodes: []\n"],
    [retainedGrantPath, JSON.stringify({ id: "grant-1", projectId: repository.repositoryId, scope: "ch-1", label: "chapter", tokenHash: "e".repeat(64), createdAt: "2024-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" }) + "\n"],
  ]));
  const projectFiles = new Map([["meta/publish-episodes.yaml", Buffer.from("episodes: []\n")]]);
  const workspaceFiles = new Map([["share-tokens.json", Buffer.from("[]")]]);
  const source = {
    projectRoot: "/synthetic/live-source",
    workspaceDataRoot: "/synthetic/live-workspace",
    readProjectFile: async (path: string) => projectFiles.get(path) ?? null,
    listProjectFiles: async () => [...projectFiles.keys()],
    readWorkspaceFile: async (path: string) => workspaceFiles.get(path) ?? null,
    listWorkspaceFiles: async () => [...workspaceFiles.keys()],
  } as unknown as LegacySourceReader;
  const producer = createPublishingMigrationProducer();
  const live = await producer.inspect({ source, target, repository, snapshot: target.snapshot, enabledModules: new Set(["publishing"]) });
  assert.ok(!live.operations.some((operation) => operation.writes.some((write) => write.path === EPISODES_PATH || write.path === SHARE_GRANTS_PATH)));
  assert.ok(!live.entries.some((entry) => entry.source.startsWith("meta/scriptorium/modules/publishing/legacy/")), "live source keeps ownership with its importer");

  const disabled = await producer.inspect({
    source: { ...source, workspaceDataRoot: undefined, readProjectFile: async () => null, readWorkspaceFile: async () => null, listWorkspaceFiles: async () => [] } as LegacySourceReader,
    target,
    repository,
    snapshot: target.snapshot,
    enabledModules: new Set(),
  });
  assert.deepEqual(disabled.operations, [], "retained values stay unreadable until Publishing is enabled");
  assert.deepEqual(disabled.entries, []);
});
