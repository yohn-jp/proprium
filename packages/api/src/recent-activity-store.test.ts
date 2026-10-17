import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { importLegacyRecentActivity, RecentActivityStore, type RecentActivityItem } from "./recent-activity-store.js";

const repository = {
  provider: "github" as const,
  repositoryId: "123",
  defaultBranch: "main",
  ownerScope: "owner-1",
  url: "https://github.com/owner/work.git",
};

function sourceItem(deviceType: "desktop" | "mobile", overrides: Partial<RecentActivityItem> = {}): RecentActivityItem {
  return {
    sceneId: "scene-one",
    sentenceOffset: 2,
    pageIndex: 3,
    deviceType,
    updatedAt: "2025-01-02T03:04:05.000Z",
    ...overrides,
  };
}

describe("RecentActivityStore", () => {
  it("keeps per-device cursors private, owner/repository scoped, and durable across store instances", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-recent-activity-"));
    const usageDirectory = resolve(root, "host-history");
    t.after(() => rm(root, { recursive: true, force: true }));
    const first = new RecentActivityStore(usageDirectory);
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "construction must not create storage");
    assert.deepEqual(await first.list("owner", repository), []);
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "empty reads must not create storage");

    await first.upsert("owner", repository, { sceneId: "scene-one", sentenceOffset: 2, pageIndex: 8, deviceType: "desktop" });
    const desktop = await first.upsert("owner", repository, { sceneId: "scene-two", sentenceOffset: null, deviceType: "desktop" });
    assert.equal(desktop.find((item) => item.deviceType === "desktop")?.pageIndex, 8, "omitted pageIndex keeps the existing device value");
    await first.upsert("owner", repository, { sceneId: "scene-mobile", sentenceOffset: 0, pageIndex: 1, deviceType: "mobile" });

    const restarted = new RecentActivityStore(usageDirectory);
    assert.equal((await restarted.list("owner", repository)).length, 2);
    assert.deepEqual(await restarted.list("another-owner", repository), []);
    assert.deepEqual(await restarted.list("owner", { ...repository, repositoryId: "456" }), []);
    assert.equal((await lstat(resolve(usageDirectory, "recent-activity"))).mode & 0o777, 0o700);
    assert.equal((await lstat(resolve(usageDirectory, "recent-activity", "recent-activity-state.json"))).mode & 0o777, 0o600);
  });

  it("archives exact canonical bytes and adopts only explicitly mapped rows without regressing live cursors", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-recent-import-"));
    const workspaceDataRoot = resolve(root, "workspace");
    const usageDirectory = resolve(root, "host-history");
    const appState = resolve(workspaceDataRoot, "app-state");
    await mkdir(appState, { recursive: true, mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const bytes = Buffer.from(JSON.stringify({ futureRootField: "archive-only", byKey: {
      "legacy-user:legacy-project": [{ ...sourceItem("mobile"), futureCursorField: "must-not-reach-api" }],
      "unmapped-user:legacy-project": [sourceItem("desktop")],
      "legacy-user:unmapped-project": [sourceItem("desktop", { sceneId: "unmapped-scene" })],
    } }), "utf8");
    const sourcePath = resolve(appState, "recent-activity.json");
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    const mappings = {
      workspaceDataRoot,
      usageDirectory,
      legacyRepositoryMappings: { "legacy-project": repository },
      legacyUserMappings: { "legacy-user": "owner" as const },
    };

    const report = await importLegacyRecentActivity(mappings);
    assert.equal(report.sourcePath, "app-state/recent-activity.json");
    assert.equal(report.sourceHash, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(report.sourceFiles, [{ sourcePath: "app-state/recent-activity.json", sourceHash: report.sourceHash, bytes: bytes.byteLength }]);
    assert.deepEqual(await readFile(sourcePath), bytes, "import never modifies the source workspace");
    assert.deepEqual(report.mappingRequired.map(({ projectKey, userId }) => [projectKey, userId]), [
      ["legacy-project", "unmapped-user"], ["unmapped-project", "legacy-user"],
    ]);
    const archivePath = resolve(usageDirectory, "recent-activity", "legacy", `${report.sourceHash}.json`);
    assert.deepEqual(await readFile(archivePath), bytes, "the private archive preserves the exact source bytes");
    assert.equal((await lstat(archivePath)).mode & 0o777, 0o600);
    const store = new RecentActivityStore(usageDirectory);
    assert.deepEqual(await store.list("owner", repository), [sourceItem("mobile")]);
    await store.upsert("owner", repository, { sceneId: "new-mobile", sentenceOffset: 9, pageIndex: 12, deviceType: "mobile" });

    const repeated = await importLegacyRecentActivity(mappings);
    assert.equal(repeated.preservedNewerItems, 1, "an incomplete mapping can be retried without replacing newer live state");
    assert.deepEqual(await store.list("owner", repository), [
      { sceneId: "new-mobile", sentenceOffset: 9, pageIndex: 12, deviceType: "mobile", updatedAt: (await store.list("owner", repository))[0]!.updatedAt },
    ]);
  });

  it("uses the root alias when canonical is absent and imports both archived sources by their cursor timestamps", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-recent-alias-"));
    const workspaceDataRoot = resolve(root, "workspace");
    const usageDirectory = resolve(root, "host-history");
    await mkdir(workspaceDataRoot, { mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const mappings = {
      workspaceDataRoot,
      usageDirectory,
      legacyRepositoryMappings: { project: repository },
      legacyUserMappings: { user: "owner" as const },
    };
    const aliasBytes = Buffer.from(JSON.stringify({ byKey: { "user:project": [
      sourceItem("desktop"), sourceItem("mobile", { updatedAt: "2024-01-02T03:04:05.000Z" }),
    ] } }), "utf8");
    const aliasPath = resolve(workspaceDataRoot, "recent-activity.json");
    await writeFile(aliasPath, aliasBytes, { mode: 0o600 });
    const aliasReport = await importLegacyRecentActivity(mappings);
    assert.equal(aliasReport.sourcePath, "recent-activity.json");
    assert.equal(aliasReport.adoptedItems, 2);
    assert.deepEqual(await readFile(resolve(usageDirectory, "recent-activity", "legacy", `${aliasReport.sourceHash}.json`)), aliasBytes);

    const canonicalDirectory = resolve(workspaceDataRoot, "app-state");
    await mkdir(canonicalDirectory, { mode: 0o700 });
    const canonicalBytes = Buffer.from(JSON.stringify({ byKey: { "user:project": [sourceItem("desktop", {
      sceneId: "canonical-newer", updatedAt: "2026-01-02T03:04:05.000Z",
    })] } }), "utf8");
    await writeFile(resolve(canonicalDirectory, "recent-activity.json"), canonicalBytes, { mode: 0o600 });
    const both = await importLegacyRecentActivity(mappings);
    assert.equal(both.sourcePath, "multiple");
    assert.equal(both.adoptionBlocked, undefined);
    assert.equal(both.sourceFiles?.length, 2);
    for (const source of both.sourceFiles ?? []) {
      const archived = await readFile(resolve(usageDirectory, "recent-activity", "legacy", `${source.sourceHash}.json`));
      assert.equal(archived.byteLength, source.bytes);
      assert.equal(createHash("sha256").update(archived).digest("hex"), source.sourceHash);
    }
    assert.deepEqual(await new RecentActivityStore(usageDirectory).list("owner", repository), [
      sourceItem("desktop", { sceneId: "canonical-newer", updatedAt: "2026-01-02T03:04:05.000Z" }),
      sourceItem("mobile", { updatedAt: "2024-01-02T03:04:05.000Z" }),
    ]);
  });

  it("archives equal-time conflicting aliases and blocks adoption", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-recent-conflict-"));
    const workspaceDataRoot = resolve(root, "workspace");
    const appState = resolve(workspaceDataRoot, "app-state");
    const usageDirectory = resolve(root, "host-history");
    await mkdir(appState, { recursive: true, mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const canonical = Buffer.from(JSON.stringify({ byKey: { "user:project": [sourceItem("desktop", { sceneId: "first" })] } }), "utf8");
    const alias = Buffer.from(JSON.stringify({ byKey: { "user:project": [sourceItem("desktop", { sceneId: "second" })] } }), "utf8");
    await writeFile(resolve(appState, "recent-activity.json"), canonical, { mode: 0o600 });
    await writeFile(resolve(workspaceDataRoot, "recent-activity.json"), alias, { mode: 0o600 });
    const report = await importLegacyRecentActivity({
      workspaceDataRoot,
      usageDirectory,
      legacyRepositoryMappings: { project: repository },
      legacyUserMappings: { user: "owner" },
    });
    assert.equal(report.adoptionBlocked, "invalid_record");
    assert.equal(report.adoptedItems, 0);
    assert.deepEqual(await new RecentActivityStore(usageDirectory).list("owner", repository), []);
    assert.deepEqual(await readFile(resolve(usageDirectory, "recent-activity", "legacy", `${createHash("sha256").update(canonical).digest("hex")}.json`)), canonical);
    assert.deepEqual(await readFile(resolve(usageDirectory, "recent-activity", "legacy", `${createHash("sha256").update(alias).digest("hex")}.json`)), alias);
  });
});
