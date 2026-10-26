import { expect, type Page } from "@playwright/test";
export async function showPanel(page: Page, panel: "outline" | "editor" | "inspector" | "history" | "review"): Promise<void> {
  const names = { outline: "作品と構成", editor: "ワークスペース", inspector: "文書と保存状態", history: "履歴", review: "レビューとツール" };
  const desktop = page.getByRole("button", { name: `パネル：${names[panel]}`, exact: true });
  if (await desktop.isVisible()) { await desktop.click(); return; }
  const mobileFooter = page.locator(".mobile-shell-footer");
  if (await mobileFooter.isVisible()) {
    if (panel === "history") {
      await showPanel(page, "inspector");
      await page.getByRole("button", { name: "履歴", exact: true }).click();
      await expect(page.locator("#git-history-heading")).toBeVisible();
      return;
    }
    const navigation = page.getByRole("navigation", { name: "モバイル画面" });
    if (!(await navigation.isVisible())) {
      await page.locator('summary[aria-label="別の画面へ移動"]').click();
    }
    const labels = { outline: "作品", editor: "書く", inspector: "確認", review: "道具" };
    await navigation.getByRole("button", { name: labels[panel], exact: true }).click();
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
export async function expectEditorText(page: Page, text: string): Promise<void> {
  await showPanel(page, "editor");
  await expect.poll(async () => page.locator(".cm-content .cm-line").evaluateAll(lines => lines.map(line => line.textContent ?? "").join("\n"))).toBe(text);
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
      if (await rows.count()) {
        await expect(rows.first()).toBeVisible();
        const displayedLines = (await rows.allTextContents()).join("").trim();
        expect(displayedLines.length).toBeGreaterThan(0);
      } else {
        const columns = textDiff.locator(".text-diff-columns");
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
