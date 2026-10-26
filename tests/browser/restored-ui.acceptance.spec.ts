import { test, expect } from "@playwright/test";
import { chooseFile, expectEditorText, showPanel } from "./restored-ui.helpers.js";
const identity = () => ({ origin: "https://github.com", repositoryId: 923456789, owner: "proprium-test", repository: "ui-restoration", branch: "main", localWorkspaceId: `restored-${crypto.randomUUID()}` });
test("recovered shells retain CodeMirror, typography, reading, theme and unsaved text across panels", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.waitForFunction(() => !!window.propriumHostTest);
  await page.evaluate(async workspace => window.propriumHostTest!.openWorkspace(workspace, { "chapter.md": "元の原稿です。|漢字《かんじ》\n" }), identity());
  await chooseFile(page, "chapter.md");
  await expect(page.locator(".cm-editor")).toBeVisible();
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await editor.fill("未保存の原稿。|漢字《かんじ》\n");
  await page.getByText("プレビュー・集中・印刷", { exact: true }).click();
  await page.getByRole("button", { name: "プレビュー", exact: true }).click();
  await expect(page.getByRole("document", { name: "ルビ付き読み取り専用プレビュー" }).locator("ruby")).toHaveCount(1);
  await page.getByRole("button", { name: "読書・プレビューを縦書きに", exact: true }).click();
  await page.getByRole("button", { name: "読書モード", exact: true }).click();
  await expect(page.getByRole("document", { name: "縦書き読書モード" })).toBeVisible();
  await page.getByRole("button", { name: "編集に戻る", exact: true }).click();
  await page.getByLabel("外観", { exact: true }).selectOption("paper");
  await expect(page.locator("html")).toHaveAttribute("data-zp-theme", "paper");
  await showPanel(page, "inspector");
  await expectEditorText(page, "未保存の原稿。|漢字《かんじ》\n");
  const floating = page.getByRole("button", { name: "Float 原稿", exact: true });
  if (await floating.isVisible()) {
    await floating.click();
    await expect(page.locator('[data-floating-panel="editor"]')).toBeVisible();
    await page.getByRole("button", { name: "パネルをドックへ戻す" }).click();
    await expect(page.locator('[data-floating-panel="editor"]')).toHaveCount(0);
  }
  await editor.press("Control+z");
  await expectEditorText(page, "元の原稿です。|漢字《かんじ》\n");
  const mobileFooter = page.locator(".mobile-shell-footer");
  if (await mobileFooter.isVisible()) {
    const shelf = await page.locator(".mobile-shell-status").boundingBox();
    const footer = await mobileFooter.boundingBox();
    expect(shelf).not.toBeNull(); expect(footer).not.toBeNull();
    expect(Math.abs(shelf!.y + shelf!.height - footer!.y)).toBeLessThan(2);
  }
  await page.screenshot({ path: testInfo.outputPath("restored-ui.png"), fullPage: true });
  await testInfo.attach("restored-ui", { path: testInfo.outputPath("restored-ui.png"), contentType: "image/png" });
});
test("storage_unknown offers non-destructive verification and preserves workspace bytes", async ({ page }) => {
  const workspace = identity();
  await page.goto("/");
  await page.waitForFunction(() => !!window.propriumHostTest);
  await page.evaluate(async workspace => window.propriumHostTest!.openWorkspace(workspace, { "chapter.md": "消さない原稿\n" }), workspace);
  await page.getByRole("button", { name: "作品一覧", exact: true }).first().click();
  await page.evaluate(workspace => localStorage.setItem(`proprium.git.storage-unknown.${workspace.localWorkspaceId}`, "1"), workspace);
  await page.getByRole("button", { name: /proprium-test\/ui-restoration/u }).click();
  await expect(page.getByRole("dialog", { name: "ブラウザー内Gitの整合性確認" }).getByRole("alert")).toBeVisible();
  const recovery = page.getByRole("dialog", { name: "ブラウザー内Gitの整合性確認" });
  await expect(recovery).toBeVisible();
  expect(await recovery.evaluate(element => element.matches(":modal"))).toBe(true);
  const verify = recovery.getByRole("button", { name: "保存データの整合性を確認" });
  const bounds = await verify.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await recovery.getByRole("button", { name: "後で確認" }).click();
  await expect(recovery).not.toBeVisible();
  await page.getByRole("button", { name: "Git保存状態を確認", exact: true }).click();
  await expect(recovery).toBeVisible();
  await verify.click();
  await chooseFile(page, "chapter.md");
  await expectEditorText(page, "消さない原稿\n");
  expect(await page.evaluate(workspace => localStorage.getItem(`proprium.git.storage-unknown.${workspace.localWorkspaceId}`), workspace)).toBeNull();
});
test("a protected uncommitted draft can be recovered explicitly without replacing the worktree", async ({ page }) => {
  const workspace = identity();
  await page.goto("/");
  await page.waitForFunction(() => !!window.propriumHostTest);
  await page.evaluate(async workspace => window.propriumHostTest!.openWorkspace(workspace, { "chapter.md": "保存済みの本文\n" }), workspace);
  await chooseFile(page, "chapter.md");
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill("回復する未保存の本文\n");
  await expect(page.getByLabel("原稿の保護範囲を確認")).toContainText("自動回復記録 · 保存済み");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "作品一覧", exact: true }).click();
  await page.getByRole("button", { name: /proprium-test\/ui-restoration/u }).click();
  await chooseFile(page, "chapter.md");
  await expectEditorText(page, "保存済みの本文\n");
  await page.getByRole("button", { name: "この下書きをエディターで開く" }).click();
  await expectEditorText(page, "回復する未保存の本文\n");
  await expect(page.locator(".save-state")).toHaveText("編集中・端末のファイル未保存");
});
test("verification of an active uncertain workspace keeps unsaved editor text", async ({ page }) => {
  const workspace = identity();
  await page.goto("/");
  await page.waitForFunction(() => !!window.propriumHostTest);
  await page.evaluate(async workspace => window.propriumHostTest!.openWorkspace(workspace, { "chapter.md": "元の本文\n" }), workspace);
  await chooseFile(page, "chapter.md");
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill("入力中の本文を保持\n");
  await page.evaluate(workspace => localStorage.setItem(`proprium.git.storage-unknown.${workspace.localWorkspaceId}`, "1"), workspace);
  await page.getByRole("button", { name: "端末に保存", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "ブラウザー内Gitの整合性確認" }).getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "保存データの整合性を確認" }).click();
  await expectEditorText(page, "入力中の本文を保持\n");
  await page.getByRole("button", { name: "端末に保存", exact: true }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("saved to this browser's local Git worktree");
});
test("failed storage verification remains visible and retryable without clearing the guard", async ({ page }) => {
  const workspace = identity();
  await page.goto("/");
  await page.waitForFunction(() => !!window.propriumHostTest);
  await page.evaluate(async workspace => window.propriumHostTest!.openWorkspace(workspace, { "chapter.md": "保持する本文\n" }), workspace);
  await chooseFile(page, "chapter.md");
  await page.getByRole("textbox", { name: "原稿 Markdown" }).fill("保持する入力\n");
  await page.evaluate(async workspace => {
    const moduleUrl = new URL("/src/browser/proprium/git/index.ts", location.origin).href;
    const { BrowserLocalGit, BrowserLocalGitError } = await import(/* @vite-ignore */ moduleUrl);
    const original = BrowserLocalGit.prototype.verifyStorage;
    let first = true;
    BrowserLocalGit.prototype.verifyStorage = function () {
      if (first) { first = false; return Promise.reject(new BrowserLocalGitError("storage_unknown", "Verification could not confirm browser storage. Retry is available.")); }
      return original.call(this);
    };
    localStorage.setItem(`proprium.git.storage-unknown.${workspace.localWorkspaceId}`, "1");
  }, workspace);
  await page.getByRole("button", { name: "端末に保存", exact: true }).click();
  const recovery = page.getByRole("dialog", { name: "ブラウザー内Gitの整合性確認" });
  await recovery.getByRole("button", { name: "保存データの整合性を確認" }).click();
  await expect(recovery.getByRole("alert")).toContainText("Verification could not confirm browser storage");
  expect(await page.evaluate(workspace => localStorage.getItem(`proprium.git.storage-unknown.${workspace.localWorkspaceId}`), workspace)).toBe("1");
  await recovery.getByRole("button", { name: "保存データの整合性を確認" }).click();
  await expect(recovery).not.toBeVisible();
  await expectEditorText(page, "保持する入力\n");
});
