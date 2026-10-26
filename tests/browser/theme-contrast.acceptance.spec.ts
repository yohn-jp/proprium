import { expect, test } from "@playwright/test";
import { chooseFile } from "./restored-ui.helpers.js";

type ContrastResult = {
  foreground: string;
  background: string;
  ratio: number;
  opacity: number;
};

async function measureContrast(locator: import("@playwright/test").Locator, pseudo?: string): Promise<ContrastResult> {
  return locator.evaluate((element, pseudoElement) => {
    const parseColor = (value: string): [number, number, number, number] | null => {
      const hex = value.trim().match(/^#([\da-f]{3,8})$/iu);
      if (hex) {
        let digits = hex[1]!;
        if (digits.length === 3 || digits.length === 4) digits = [...digits].map(char => char + char).join("");
        if (digits.length === 6 || digits.length === 8) {
          return [
            Number.parseInt(digits.slice(0, 2), 16),
            Number.parseInt(digits.slice(2, 4), 16),
            Number.parseInt(digits.slice(4, 6), 16),
            digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1
          ];
        }
      }
      const values = value.match(/[\d.]+/gu)?.map(Number);
      return values && values.length >= 3
        ? [values[0]!, values[1]!, values[2]!, values[3] ?? 1]
        : null;
    };
    const blend = (foreground: [number, number, number, number], background: [number, number, number, number]) => {
      const alpha = foreground[3];
      return [
        foreground[0] * alpha + background[0] * (1 - alpha),
        foreground[1] * alpha + background[1] * (1 - alpha),
        foreground[2] * alpha + background[2] * (1 - alpha),
        1
      ] as [number, number, number, number];
    };
    const luminance = (color: [number, number, number, number]) => color.slice(0, 3).map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
    const cssColor = (color: [number, number, number, number]) => `rgb(${color.slice(0, 3).map(value => Math.round(value)).join(", ")})`;

    const style = getComputedStyle(element, pseudoElement ?? null);
    const isIonButton = element.tagName.toLowerCase() === "ion-button";
    const rawForeground = isIonButton ? style.getPropertyValue("--color").trim() : style.color;
    const rawBackground = isIonButton ? style.getPropertyValue("--background").trim() : "";
    const foreground = parseColor(rawForeground) ?? parseColor(style.color) ?? [0, 0, 0, 1];
    let background = parseColor(rawBackground);
    if (!background) {
      const ancestors: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.push(current);
      let composite: [number, number, number, number] = [255, 255, 255, 1];
      for (const ancestor of ancestors.reverse()) {
        const layer = parseColor(getComputedStyle(ancestor).backgroundColor);
        if (layer && layer[3] > 0) composite = blend(layer, composite);
      }
      background = composite;
    }
    let opacity = 1;
    for (let current: Element | null = element; current; current = current.parentElement) {
      opacity *= Number.parseFloat(getComputedStyle(current).opacity || "1");
    }
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return {
      foreground: parseColor(rawForeground) ? rawForeground : cssColor(foreground),
      background: parseColor(rawBackground) ? rawBackground : cssColor(background),
      ratio: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05),
      opacity
    };
  }, pseudo ?? null);
}

async function expectReadable(locator: import("@playwright/test").Locator, label: string, pseudo?: string) {
  await expect(locator, label).toBeVisible();
  const result = await measureContrast(locator, pseudo);
  expect(result.opacity, `${label} opacity; foreground=${result.foreground}`).toBeGreaterThanOrEqual(.99);
  expect(result.ratio, `${label} contrast; foreground=${result.foreground}, background=${result.background}`).toBeGreaterThanOrEqual(4.5);
}

test("selection, supporting copy and disabled editor controls remain readable in every theme", async ({ page }, testInfo) => {
  const isMobile = testInfo.project.name === "mobile-webkit";
  for (const theme of ["light", "dark", "paper"] as const) {
    await page.goto("/");
    await page.getByLabel("外観", { exact: true }).selectOption(theme);

    const selected = isMobile
      ? page.locator(".mobile-shell-navigation ion-button[fill='solid']")
      : page.locator(".st-desktop-panel-tab[role='tab'][aria-selected='true']");
    if (isMobile) {
      const selectedBackground = await selected.evaluate(element => getComputedStyle(element).getPropertyValue("--background").trim());
      expect(selectedBackground, `${testInfo.project.name} ${theme} selected navigation surface`).not.toBe("transparent");
    }
    await expectReadable(selected, `${testInfo.project.name} ${theme} selected navigation`);

    const supportingCopy = page.locator(".recent-card .field-help").filter({ hasText: "Available offline after" });
    await expectReadable(supportingCopy, `${testInfo.project.name} ${theme} supporting copy`);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-picker.png`), fullPage: true });

    const workspace = {
      origin: "https://github.com",
      repositoryId: 923457001,
      owner: "proprium-test",
      repository: "theme-contrast",
      branch: "main",
      localWorkspaceId: `theme-contrast-${testInfo.project.name}-${theme}`
    };
    await page.waitForFunction(() => !!window.propriumHostTest);
    await page.evaluate(async identity => {
      await window.propriumHostTest!.openWorkspace(identity, { "chapter.md": "コントラスト確認用の原稿\n" });
    }, workspace);
    await chooseFile(page, "chapter.md");
    const saveDraft = page.getByRole("button", { name: "Save draft", exact: true });
    await expect(saveDraft).toBeDisabled();
    await expectReadable(saveDraft, `${testInfo.project.name} ${theme} disabled Save draft`);
    const workspaces = page.getByRole("button", { name: "Workspaces", exact: true });
    await workspaces.hover();
    await expectReadable(workspaces, `${testInfo.project.name} ${theme} hovered Workspaces`);
    await page.mouse.move(0, 0);
    if (!isMobile) {
      await expectReadable(page.locator(".st-studio-footer > span").first(), `${testInfo.project.name} ${theme} footer text`);
      await expectReadable(page.locator(".st-workspace-toolbar"), `${testInfo.project.name} ${theme} VIEW label`, "::before");
      await expectReadable(page.locator(".st-workspace-presets button:not([aria-pressed='true'])").first(), `${testInfo.project.name} ${theme} inactive workspace preset`);
      const publish = page.getByRole("button", { name: "GitHubへ公開", exact: true });
      await expect(publish).toBeDisabled();
      await expectReadable(publish, `${testInfo.project.name} ${theme} disabled Publish`);
    }
    await page.screenshot({ path: testInfo.outputPath(`${theme}-workspace.png`), fullPage: true });
  }
});
