import { expect, type Page } from "@playwright/test";
export async function showPanel(page: Page, panel: "outline" | "editor" | "inspector" | "history" | "review"): Promise<void> {
  const names = { outline: "作品と構成", editor: "ワークスペース", inspector: "文書と保存状態", history: "履歴", review: "レビューとツール" };
  const desktop = page.getByRole("button", { name: `パネル：${names[panel]}`, exact: true });
  if (await desktop.isVisible()) { await desktop.click(); return; }
  if (await page.locator(".mobile-shell").count()) {
    if (panel === "history") {
      await showPanel(page, "inspector");
      await page.getByRole("button", { name: "履歴", exact: true }).click();
      await expect(page.locator("#git-history-heading")).toBeVisible();
      return;
    }
    const panelNames = { outline: "作品と構成", editor: "原稿", inspector: "文書と保存状態", review: "レビューとツール" };
    const labels = { outline: "作品", editor: "書く", inspector: "変更", review: "ツール" };
    const navigation = page.getByRole("navigation", { name: "モバイルの主要画面" });
    if (!(await navigation.isVisible())) {
      const reveal = page.getByRole("button", { name: "画面の切替を表示" });
      if (await reveal.isVisible()) await reveal.click();
    }
    await expect(navigation).toBeVisible();
    const target = navigation.getByRole("button", { name: labels[panel], exact: true });
    await target.click();
    await expect(page.getByRole("tabpanel", { name: panelNames[panel], exact: true })).toBeVisible();
    return;
  }
  if (panel === "history") {
    await showPanel(page, "inspector");
    await page.getByRole("button", { name: "履歴", exact: true }).click();
    await expect(page.locator("#git-history-heading")).toBeVisible();
    return;
  }
  throw new Error(`Could not find the ${panel} navigation in the current shell.`);
}
/** Open the Host's workspace picker from either shell without bypassing route guards. */
export async function openWorkspacePicker(page: Page): Promise<void> {
  if (await page.locator(".mobile-shell").count()) {
    await page.getByRole("button", { name: "設定を開く" }).click();
  }
  await page.getByRole("button", { name: "作品一覧", exact: true }).first().click();
}
export async function expectEditorText(page: Page, text: string): Promise<void> {
  await showPanel(page, "editor");
  // The DOM line projection is not the CodeMirror document: a final empty line
  // can be omitted by WebKit rendering even when the document ends in a newline.
  // Assert real editor-state bytes, including the trailing LF, instead.
  await expect.poll(async () => page.evaluate(() => {
    if (window.propriumHostEditorText) return window.propriumHostEditorText();
    // Production static builds omit test APIs. The pinned CM version stores its
    // document tile here; inspect its real state rather than rendered line text.
    const content = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } }) | null;
    return content?.cmTile?.root?.view?.state.doc.toString() ?? null;
  })).toBe(text);
}
export async function chooseFile(page: Page, path: string): Promise<void> {
  await showPanel(page, "outline");
  await page.getByRole("list", { name: "Repository files" }).getByRole("button", { name: path }).click();
  await showPanel(page, "editor");
}

export async function configureGateway(page: Page, url: string): Promise<void> {
  const settings = page.locator("details.gateway-settings");
  if (await settings.getAttribute("open") === null) await settings.locator("summary").click();
  await page.getByLabel("Proprium Gateway URL").fill(url);
}

/** Exercise each rendered changed-file tab, inspect its real diff, and mark it reviewed. */
export async function reviewChangedFiles(page: Page): Promise<void> {
  await showPanel(page, "inspector");
  const changedFiles = page.locator(".git-review-files button");
  await expect(changedFiles.first()).toBeVisible();
  const count = await changedFiles.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const fileButton = changedFiles.nth(index);
    const path = (await fileButton.locator("code").innerText()).trim();
    await fileButton.click();

    const detail = page.locator(".git-review-detail");
    await expect(detail).toBeVisible();
    await expect(detail.locator("h4")).toHaveText(path);
    const binaryNotice = detail.locator(".git-review-binary");
    if (await binaryNotice.isVisible().catch(() => false)) {
      await expect(binaryNotice).not.toBeEmpty();
    } else {
      const textDiff = detail.locator(".text-diff");
      await expect(textDiff).toBeVisible();
      const rows = textDiff.locator(".text-diff-lines .text-diff-line");
      const columns = textDiff.locator(".text-diff-columns");
      // The diff is computed asynchronously after the file tab is selected.
      // A synchronous count() can observe zero rows before the projection
      // renders, incorrectly assuming that this is a two-column diff.
      await expect.poll(async () =>
        (await rows.first().isVisible()) || (await columns.isVisible()),
      ).toBe(true);
      if (await rows.first().isVisible()) {
        const displayedLines = (await rows.allTextContents()).join("").trim();
        expect(displayedLines.length).toBeGreaterThan(0);
      } else {
        await expect(columns).toBeVisible();
        await expect(columns.locator("section")).toHaveCount(2);
        await expect(columns.locator("pre")).toHaveCount(2);
      }
    }

    const markReviewed = detail.locator(".git-review-mark");
    await markReviewed.click();
    await expect(fileButton.locator(".git-review-checked")).toBeVisible();
  }
}
