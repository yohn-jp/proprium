import { expect, type Page } from "@playwright/test";
export async function showPanel(page: Page, panel: "outline" | "editor" | "inspector" | "history" | "review"): Promise<void> {
  const names = { outline: "作品と構成", editor: "ワークスペース", inspector: "文書と保存状態", history: "履歴", review: "レビューとツール" };
  const desktop = page.getByRole("button", { name: `パネル：${names[panel]}`, exact: true });
  if (await desktop.isVisible()) { await desktop.click(); return; }
  if (panel === "history") {
    await showPanel(page, "inspector");
    await page.getByRole("button", { name: "History", exact: true }).click(); return;
  }
  const labels = { outline: "作品", editor: "書く", inspector: "確認", review: "道具" };
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: labels[panel], exact: true }).click();
}
export async function expectEditorText(page: Page, text: string): Promise<void> {
  await showPanel(page, "editor");
  // The DOM line projection is not the CodeMirror document: a final empty line
  // can be omitted by WebKit rendering even when the document ends in a newline.
  // Assert real editor-state bytes, including the trailing LF, instead.
  await expect.poll(async () => page.getByRole("textbox", { name: "原稿 Markdown" }).evaluate(node => {
    for (let element: Element | null = node; element; element = element.parentElement) {
      const cm = (element as Element & { cmView?: { view?: { state?: { doc?: { toString(): string } } } } }).cmView;
      if (cm?.view?.state?.doc) return cm.view.state.doc.toString();
    }
    return null;
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
