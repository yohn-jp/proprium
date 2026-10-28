import { expect, test } from "@playwright/test";
import { expectEditorText, showPanel, openWorkspacePicker } from "./restored-ui.helpers.js";

const identity = () => ({
  origin: "https://github.com",
  repositoryId: 923456789,
  owner: "proprium-test",
  repository: "ui-restoration",
  branch: "main",
  localWorkspaceId: `draft-recovery-${crypto.randomUUID()}`,
});

test("a protected new-file draft can be found and reopened after the workspace closes", async ({ page }) => {
  const workspace = identity();
  const path = "chapters/untracked-second-chapter.md";
  const text = "保護されていた第二章の本文です。\n";
  await page.goto("/");
  await page.waitForFunction(() => !!window.propriumHostTest);
  await page.evaluate(async (target) => window.propriumHostTest!.openWorkspace(target, { "README.md": "Repository file\n" }), workspace);

  await showPanel(page, "outline");
  await page.getByLabel("New file path").fill(path);
  await page.getByRole("button", { name: "Create new file" }).click();
  // CodeMirror contenteditable fill does not consistently enter a final LF.
  // Insert it as a real editing keystroke, then prove the draft contains it
  // before testing storage/reopening (rather than weakening the final assertion).
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await editor.fill(text.slice(0, -1));
  await editor.press("End");
  await editor.press("Enter");
  await expectEditorText(page, text);
  await expect(page.getByLabel("原稿の保護範囲を確認")).toContainText("自動回復記録 · 保存済み");

  page.once("dialog", (dialog) => dialog.accept());
  await openWorkspacePicker(page);
  await page.getByRole("button", { name: /proprium-test\/ui-restoration/u }).click();
  await showPanel(page, "outline");

  const repositoryFiles = page.getByRole("list", { name: "Repository files" });
  await expect(repositoryFiles.getByRole("button", { name: path })).toHaveCount(0);
  const recovery = page.getByRole("list", { name: "保護された下書き" });
  const recoveredFile = recovery.getByRole("listitem").filter({ hasText: path });
  await expect(recoveredFile).toBeVisible();
  await recoveredFile.getByRole("button", { name: "下書きを開く" }).click();

  await expectEditorText(page, text);
  await showPanel(page, "outline");
  await expect(repositoryFiles.getByRole("button", { name: path })).toContainText("作成中の下書き");
});
