import { expect, test } from "@playwright/test";
import type { BrowserLocalGit } from "../../app/src/browser/proprium/git/index.js";
import type { AuthoringSnapshotReader } from "../../app/src/browser/proprium/authoring/snapshots.js";
import type { AuthoringScope } from "../../app/src/browser/proprium/authoring/snapshots.js";

declare global {
  interface Window {
    browserGitTest: {
      openAuthoringSession(localWorkspaceId: string): {
        git: BrowserLocalGit;
        reader: AuthoringSnapshotReader;
        scope: AuthoringScope;
      };
    };
  }
}

test("Browser Git authoring snapshots page large works, preserve UTF-8 bytes, and reject stale generations", async ({ page }) => {
  const workspaceId = `authoring-${crypto.randomUUID()}`;
  await page.goto("/browser-git-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
  const result = await page.evaluate(async workspaceId => {
    const { git, reader, scope } = window.browserGitTest.openAuthoringSession(workspaceId);
    await git.init();
    const changes: Array<{ path: string; content: Uint8Array; expectedRevision: { oid: null } }> = [];
    for (let index = 0; index < 301; index += 1) {
      const number = String(index).padStart(3, "0");
      changes.push({ path: `plot/volumes/v1/chapters/c${number}/scenes/s${number}.yaml`, content: new TextEncoder().encode(`id: s${number}\r\ntitle: Scene ${index}\r\n`), expectedRevision: { oid: null } });
      changes.push({ path: `manuscript/v1/c${number}/s${number}.md`, content: new Uint8Array(9 * 1024).fill(index & 0xff), expectedRevision: { oid: null } });
    }
    const longText = `${"漢字《かんじ》\r\n本文。".repeat(12_000)}\r\n`;
    const longBytes = new TextEncoder().encode(longText);
    changes.push({ path: "manuscript/v1/c000/long.md", content: longBytes, expectedRevision: { oid: null } });
    const totalBytes = changes.reduce((sum, change) => sum + change.content.byteLength, 0);
    for (let index = 0; index < changes.length; index += 256) await git.applyChanges(changes.slice(index, index + 256));

    const lease = await reader.pin(scope);
    const paths: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await reader.list(lease, { prefix: "plot/volumes/v1/chapters/", cursor, limit: 73 });
      pages += 1;
      paths.push(...page.items.map(item => item.path));
      cursor = page.next_cursor;
    } while (cursor);

    const selectedPath = "manuscript/v1/c000/long.md";
    const selected = await reader.read(lease, selectedPath, { offset: 65_535, length: 65_536 });
    const stored = (await git.read(selectedPath)).data!;
    const expectedRevision = new Uint8Array(await crypto.subtle.digest("SHA-256", stored));
    const expectedHash = [...expectedRevision].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const rawRangeMatches = selected.bytes.every((byte, index) => byte === stored[index + 65_535]);

    const decoder = new TextDecoder("utf-8", { fatal: true });
    let decoded = "";
    let offset = 0;
    let nextOffset: number | null;
    do {
      const chunk = await reader.read(lease, selectedPath, { offset, length: offset === 0 ? 65_537 : 65_536 });
      decoded += decoder.decode(chunk.bytes, { stream: chunk.next_offset !== null });
      nextOffset = chunk.next_offset;
      if (nextOffset !== null) offset = nextOffset;
    } while (nextOffset !== null);

    const beforeWrite = await git.read("manuscript/v1/c001/s001.md");
    await git.write("manuscript/v1/c001/s001.md", new Uint8Array(9 * 1024 + 1).fill(0xfe), beforeWrite.revision);
    let stale = "none";
    try { await reader.list(lease, { prefix: "plot/volumes/v1/chapters/" }); }
    catch (error) { stale = (error as { code?: string }).code ?? "unknown"; }
    git.close();
    return {
      totalBytes,
      longBytes: stored.byteLength,
      expectedLongBytes: longBytes.byteLength,
      sceneCount: paths.length,
      pages,
      revision: selected.revision,
      expectedHash,
      rawRangeMatches,
      decodedMatches: decoded === longText,
      stale,
    };
  }, workspaceId);

  expect(result.totalBytes).toBeGreaterThan(2 * 1024 * 1024);
  expect(result.longBytes).toBeGreaterThan(130 * 1024);
  expect(result.longBytes).toBe(result.expectedLongBytes);
  expect(result.sceneCount).toBe(301);
  expect(result.pages).toBeGreaterThan(1);
  expect(result.revision).toBe(result.expectedHash);
  expect(result.rawRangeMatches).toBe(true);
  expect(result.decodedMatches).toBe(true);
  expect(result.stale).toBe("snapshot_stale");
});
