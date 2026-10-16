import { expect, test, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";
const branch = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main";

interface JournalSummary {
  documentPath: string;
  state: string;
  operationId: string;
  generation: number;
  text: string;
}

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

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
}

async function openFixtureProject(page: Page): Promise<void> {
  const existing = page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true });
  if (await existing.isVisible()) {
    await existing.click();
  } else {
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(repositoryUrl));
    await page.getByLabel("ブランチ（任意）").fill(branch);
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
  }
  await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible();
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function readJournal(page: Page): Promise<JournalSummary[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      const records = await new Promise<Array<{
        documentPath: string;
        state: string;
        operation: { id: string; generation: number };
        text: string;
      }>>((resolve, reject) => {
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
      return records.map((entry) => ({
        documentPath: entry.documentPath,
        state: entry.state,
        operationId: entry.operation.id,
        generation: entry.operation.generation,
        text: entry.text,
      }));
    } finally {
      database.close();
    }
  });
}

async function waitForJournalCount(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await readJournal(page)).length).toBe(count);
}

test("writing UI recovers multi-document drafts and separates Draft, Checkpoint, and GitHub publication", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to|violat(?:e|ion)/iu.test(message.text())) {
      cspErrors.push(message.text());
    }
  });

  await signIn(page);
  await openFixtureProject(page);
  const nonce = await page.locator('meta[name="scriptorium-style-nonce"]').getAttribute("content");
  expect(nonce).toBeTruthy();
  expect(nonce).not.toBe("__SCRIPTORIUM_STYLE_NONCE__");

  const editor = page.locator(".cm-content");
  await editor.fill("彼は|東京《とうきょう》へ行く。");
  await expect(page.locator(".manuscript-preview ruby")).toContainText("東京");
  await expect(page.locator(".manuscript-preview rt")).toHaveText("とうきょう");
  await page.getByRole("button", { name: "縦書き" }).click();
  await expect(page.locator(".manuscript-preview.is-vertical")).toBeVisible();
  await page.getByRole("button", { name: "読書モード" }).click();
  await expect(page.getByRole("region", { name: "縦書き読書モード" })).toBeVisible();
  await page.getByRole("button", { name: "編集に戻る" }).click();
  await page.getByRole("button", { name: "集中" }).click();
  await expect(page.locator(".editor.is-zen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".editor.is-zen")).toHaveCount(0);

  await page.getByRole("button", { name: "文字を大きく" }).click();
  await expect(page.locator('output[aria-label="文字サイズ"]')).toHaveText("18px");
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.fill("物語");
  await editor.press("Control+a");
  await page.getByRole("button", { name: "鉤括弧を挿入" }).click();
  await expect(editor).toHaveText("「物語」");

  await page.locator(".scratch-panel summary").click();
  await page.getByLabel("本文に含まれないメモ").fill("本文に入れない台詞候補");
  await editor.click();
  await expect(page.locator(".scratch-panel summary")).toContainText("保存済み");

  const sceneOneDraft = "Scene One draft restored from IndexedDB.";
  await editor.fill(sceneOneDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.state === "draft" && entry.text === sceneOneDraft)).toBe(true);
  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  const sceneTwoDraft = "A separate Scene Two browser draft.";
  await page.locator(".cm-content").fill(sceneTwoDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.state === "draft" && entry.text === sceneTwoDraft)).toBe(true);
  await waitForJournalCount(page, 2);
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneOneDraft);

  await page.reload();
  await openFixtureProject(page);
  await expect(page.locator('output[aria-label="文字サイズ"]')).toHaveText("18px");
  await expect(page.locator(".cm-content")).toHaveText(sceneOneDraft);
  await page.locator(".scratch-panel summary").click();
  await expect(page.getByLabel("本文に含まれないメモ")).toHaveValue("本文に入れない台詞候補");
  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneTwoDraft);
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();

  await page.getByRole("button", { name: "Checkpoint" }).click();
  await expect(page.locator(".durability-message")).toContainText("ローカルチェックポイント");
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toBeEnabled();
  const checkpointed = await readJournal(page);
  expect(checkpointed).toHaveLength(2);
  expect(checkpointed.find((entry) => entry.text === sceneOneDraft)?.state).toBe("checkpointed");
  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expect(page.locator(".topbar-status")).toContainText("GitHub への保存を確認しました。");
  await expect(page.getByText("Saved to GitHub", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).map((entry) => `${entry.documentPath}:${entry.state}`)).toEqual([
    "manuscript/vol-1/ch-1/scene-2.md:draft",
  ]);
  await page.getByRole("button", { name: "履歴" }).click();
  await expect(page.getByRole("heading", { name: "Git 履歴" })).toBeVisible();
  expect(cspErrors).toEqual([]);
});

test("new typing survives an older in-flight checkpoint and exact publication acknowledgement", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await signIn(page);
  await openFixtureProject(page);

  const firstGeneration = "Checkpoint generation one.";
  await page.locator(".cm-content").fill(firstGeneration);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.state === "draft" && entry.text === firstGeneration)).toBe(true);

  let releaseCheckpoint!: () => void;
  let signalCheckpoint!: () => void;
  const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
  const checkpointStarted = new Promise<void>((resolve) => { signalCheckpoint = resolve; });
  await page.route(/\/api\/projects\/[^/]+\/checkpoints$/u, async (route) => {
    if (route.request().method() === "POST") {
      signalCheckpoint();
      await checkpointGate;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Checkpoint" }).click();
  await checkpointStarted;
  const newerGeneration = "New typing while generation one checkpoints.";
  await page.locator(".cm-content").fill(newerGeneration);
  await expect.poll(async () => (await readJournal(page)).length).toBe(2);
  const duringCheckpoint = await readJournal(page);
  const pendingCheckpoint = duringCheckpoint.find((entry) => entry.state === "checkpointing");
  const newerDraft = duringCheckpoint.find((entry) => entry.state === "draft");
  expect(pendingCheckpoint?.text).toBe(firstGeneration);
  expect(newerDraft?.text).toBe(newerGeneration);
  expect(newerDraft?.operationId).not.toBe(pendingCheckpoint?.operationId);

  releaseCheckpoint();
  await expect(page.locator(".durability-message")).toContainText("ローカルチェックポイント");
  await expect(page.locator(".cm-content")).toHaveText(newerGeneration);
  await expect(page.locator(".conflict")).toHaveCount(0);
  const afterCheckpoint = await readJournal(page);
  expect(afterCheckpoint.find((entry) => entry.text === firstGeneration)?.state).toBe("checkpointed");
  expect(afterCheckpoint.find((entry) => entry.text === newerGeneration)?.state).toBe("draft");

  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expect(page.locator(".topbar-status")).toContainText("GitHub への保存を確認しました。");
  const afterPublication = await readJournal(page);
  expect(afterPublication).toHaveLength(1);
  expect(afterPublication[0]?.text).toBe(newerGeneration);
  expect(afterPublication[0]?.state).toBe("draft");
});

test("IndexedDB quota failures remain visible and block checkpointing", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      if (this.name === "operations") throw new DOMException("Synthetic quota limit", "QuotaExceededError");
      return originalPut.call(this, value, key);
    };
  });
  await signIn(page);
  await openFixtureProject(page);

  const canonicalBefore = await page.locator(".cm-content").textContent();
  await page.locator(".cm-content").fill("This edit cannot be journaled because the browser is full.");
  await expect(page.getByRole("alert")).toContainText("Browser storage is full");
  await expect(page.getByRole("button", { name: "Checkpoint" })).toBeDisabled();

  const unloadDialog = page.waitForEvent("dialog");
  const reloading = page.reload();
  const dialog = await unloadDialog;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await reloading;
  await openFixtureProject(page);
  await expect(page.locator(".cm-content")).toHaveText(canonicalBefore ?? "");
});
