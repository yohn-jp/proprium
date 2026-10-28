import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    diagnosticsMarginBrowserTest?: {
      select: string[];
      decisions: Array<{ fingerprint: string; decision: "intentional" | "false_positive"; trusted: boolean }>;
      view: { state: { doc: { toString(): string }; selection: { main: { from: number; to: number } } } };
      clear(): void;
    };
  }
}

test("CodeMirror margin markers select exact evidence and emit only explicit reviewed decisions", async ({ page }) => {
  await page.goto("/editor-diagnostic-margin-test.html");
  await expect(page.locator("#result")).toHaveText("ready");
  const harness = page.locator("#editor");
  const jump = harness.getByRole("button", { name: /診断箇所を選択/ });
  await expect(jump).toBeVisible();
  await expect(harness.getByRole("button", { name: /意図した警告としてレビュー/ })).toBeVisible();
  await expect(harness.getByRole("button", { name: /誤検出としてレビュー/ })).toBeVisible();

  await jump.click();
  expect(await page.evaluate(() => window.diagnosticsMarginBrowserTest!.select)).toEqual(["a".repeat(64)]);
  expect(await page.evaluate(() => window.diagnosticsMarginBrowserTest!.view.state.selection.main)).toMatchObject({ from: 1, to: 5 });

  await harness.getByRole("button", { name: /意図した警告としてレビュー/ }).click();
  await harness.getByRole("button", { name: /誤検出としてレビュー/ }).click();
  expect(await page.evaluate(() => window.diagnosticsMarginBrowserTest!.decisions)).toEqual([
    { fingerprint: "a".repeat(64), decision: "intentional", trusted: true },
    { fingerprint: "a".repeat(64), decision: "false_positive", trusted: true },
  ]);
  expect(await page.evaluate(() => window.diagnosticsMarginBrowserTest!.view.state.doc.toString())).toBe("前🌸です後");

  await page.evaluate(() => window.diagnosticsMarginBrowserTest!.view.dispatch({ changes: { from: 0, to: 0, insert: "改" } }));
  await expect(harness.getByRole("button", { name: /診断箇所を選択/ })).toHaveCount(0);
  await expect(harness.locator(".cm-content")).toContainText("改前🌸です後");

  await page.evaluate(() => window.diagnosticsMarginBrowserTest!.clear());
  await expect(harness.locator(".cm-diagnostic-margin-marker")).toHaveCount(0);
  await expect(harness.locator(".cm-gutters")).toHaveAttribute("aria-hidden", "true");
});
