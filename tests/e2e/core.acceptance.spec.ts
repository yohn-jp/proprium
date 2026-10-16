import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";
const branch = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main";

function repositoryInputValue(value: string): string {
  return value.startsWith("https://") || value.startsWith("file://")
    ? value
    : pathToFileURL(value).href;
}

function projectLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname.replace(/\.git$/u, "").replace(/\/$/u, "")}`;
  } catch {
    return value;
  }
}

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
}

test("authenticated writing, protected drafts, conflict safety, history, and Git sync", async ({ page, browser }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  await signIn(page);
  await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(repositoryUrl));
  await page.getByLabel("ブランチ（任意）").fill(branch);
  await page.getByRole("button", { name: "リポジトリを登録" }).click();

  await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible();
  await expect(page.getByText("Chapter One", { exact: true })).toBeVisible();
  const firstSceneButton = page.getByRole("button", { name: "Chapter One: Scene One" });
  await expect(firstSceneButton).toBeVisible();
  const editor = page.getByLabel("原稿 Markdown");
  if (process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY !== "1") {
    await expect(editor).toHaveValue(/The first line of the story\./);
  }
  const canonicalText = await editor.inputValue();
  expect(canonicalText.trim()).not.toBe("");
  if (process.env.SCRIPTORIUM_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.SCRIPTORIUM_E2E_SCREENSHOT, fullPage: true });
  }

  const sceneTwo = page.getByRole("button", { name: "Chapter One: Scene Two" });
  await expect(sceneTwo).toBeVisible();
  const navigationDraft = "A draft that survives scene navigation.";
  await editor.fill(navigationDraft);
  await sceneTwo.click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await expect(editor).toHaveValue(/The second line of the story\./);
  await firstSceneButton.click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await expect(editor).toHaveValue(navigationDraft);

  const protectedDraft = "A protected draft after a browser reload.";
  await editor.fill(protectedDraft);
  const unloadDialogPromise = page.waitForEvent("dialog");
  const reload = page.reload();
  const unloadDialog = await unloadDialogPromise;
  expect(unloadDialog.type()).toBe("beforeunload");
  await unloadDialog.accept();
  await reload;
  await expect(page.getByLabel("原稿 Markdown")).toHaveValue(protectedDraft);

  const conflictDraft = "The first writer's protected conflicting draft.";
  await page.getByLabel("原稿 Markdown").fill(conflictDraft);
  await page.getByRole("button", { name: "履歴を表示" }).click();
  const historyItems = page.locator("#history-list li");
  await expect(historyItems.first()).toBeVisible();
  const historyCountBeforeSave = await historyItems.count();
  await page.getByRole("button", { name: "履歴を表示" }).click();

  const secondContext = await browser.newContext();
  try {
    const secondPage = await secondContext.newPage();
    await signIn(secondPage);
    await secondPage.getByRole("button", { name: projectLabel(repositoryUrl), exact: true }).click();
    const secondEditor = secondPage.getByLabel("原稿 Markdown");
    await expect(secondPage.getByRole("heading", { name: "Scene One" })).toBeVisible();
    await expect(secondEditor).toHaveValue(canonicalText);
    const newerSavedText = `The other writer's committed version (${new Date().toISOString()}).`;
    await secondEditor.fill(newerSavedText);
    await secondPage.getByRole("button", { name: "保存", exact: true }).click();
    await expect(secondPage.getByRole("status")).toContainText("保存しました。");
    await secondPage.reload();
    await expect(secondPage.getByLabel("原稿 Markdown")).toHaveValue(newerSavedText);

    let stalePutReceived409 = false;
    let releaseStaleReread!: () => void;
    let signalStaleRereadStarted!: () => void;
    const staleRereadGate = new Promise<void>((resolve) => {
      releaseStaleReread = resolve;
    });
    const staleRereadStarted = new Promise<void>((resolve) => {
      signalStaleRereadStarted = resolve;
    });
    const sceneOneApiPath = /\/api\/projects\/[^/]+\/scenes\/scene-1$/u;
    page.on("response", (response) => {
      if (response.request().method() === "PUT" && sceneOneApiPath.test(response.url())) {
        stalePutReceived409 = response.status() === 409;
      }
    });
    await page.route(sceneOneApiPath, async (route) => {
      if (stalePutReceived409 && route.request().method() === "GET") {
        stalePutReceived409 = false;
        signalStaleRereadStarted();
        await staleRereadGate;
      }
      await route.continue();
    });

    const staleSaveResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PUT" && sceneOneApiPath.test(response.url()),
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await staleSaveResponsePromise).status()).toBe(409);
    await staleRereadStarted;

    await sceneTwo.click();
    await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
    await expect(page.locator("#conflict")).toBeHidden();
    await expect(page.getByLabel("原稿 Markdown")).toHaveValue(/The second line of the story\./);

    const staleRereadResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "GET" && sceneOneApiPath.test(response.url()),
    );
    releaseStaleReread();
    expect((await staleRereadResponsePromise).status()).toBe(200);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
    await expect(page.locator("#conflict")).toBeHidden();
    await expect(page.getByLabel("原稿 Markdown")).toHaveValue(/The second line of the story\./);

    await firstSceneButton.click();
    await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
    await expect(page.getByLabel("原稿 Markdown")).toHaveValue(conflictDraft);
    await expect(page.getByRole("heading", { name: "保存内容が更新されています" })).toBeVisible();
    await expect(page.locator("#conflict-text")).toContainText(newerSavedText);

    const conflictReloadDialogPromise = page.waitForEvent("dialog");
    const conflictReload = page.reload();
    const conflictReloadDialog = await conflictReloadDialogPromise;
    expect(conflictReloadDialog.type()).toBe("beforeunload");
    await conflictReloadDialog.accept();
    await conflictReload;
    await expect(page.getByLabel("原稿 Markdown")).toHaveValue(conflictDraft);
    await expect(page.getByRole("heading", { name: "保存内容が更新されています" })).toBeVisible();
    await expect(page.locator("#conflict-text")).toContainText(newerSavedText);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("競合を検出しました。");
    await expect(page.getByLabel("原稿 Markdown")).toHaveValue(conflictDraft);

    await page.getByRole("button", { name: "履歴を表示" }).click();
    await expect(page.getByRole("heading", { name: "Git 履歴" })).toBeVisible();
    await expect(page.locator("#history-list li")).toHaveCount(historyCountBeforeSave + 1);

    await page.getByRole("button", { name: "GitHub と同期" }).click();
    await expect(page.getByRole("status")).toContainText("GitHub と同期しました。");
    await expect(page.locator("#sync-status")).toContainText("ahead 0 / behind 0");
  } finally {
    await secondContext.close();
  }
});
