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
  authorScope: string | null;
  attachmentWrites: number;
  writes: Array<{ path: string; content: string | null }>;
}

interface PublicationReceiptSummary {
  batchId: string;
  state: string;
  acknowledged: Array<{ operationId: string; generation: number }>;
  authorScope: string;
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
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      const records = await new Promise<Array<{
        documentPath: string;
        state: string;
        text: string;
        authorScope?: string | null;
        operation: { id: string; generation: number; writes: Array<{ path: string; content: string | null; encoding?: string }> };
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
        authorScope: entry.authorScope ?? null,
        attachmentWrites: entry.operation.writes.filter((write) => write.encoding === "base64").length,
        writes: entry.operation.writes.map((write) => ({ path: write.path, content: write.content })),
      }));
    } finally {
      database.close();
    }
  });
}

async function readPublicationReceipts(page: Page): Promise<PublicationReceiptSummary[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("publicationReceipts", "readonly");
      return await new Promise<PublicationReceiptSummary[]>((resolve, reject) => {
        const request = transaction.objectStore("publicationReceipts").getAll();
        request.onsuccess = () => resolve(request.result.map((record: {
          authorScope: string;
          receipt: PublicationReceiptSummary;
        }) => ({
          authorScope: record.authorScope,
          batchId: record.receipt.batchId,
          state: record.receipt.state,
          acknowledged: record.receipt.acknowledged.map((item) => ({ operationId: item.operationId, generation: item.generation })),
        })));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB receipt read failed"));
      });
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
  await expect(page.getByRole("document", { name: "縦書き読書モード" })).toBeVisible();
  await page.getByRole("button", { name: "編集に戻る" }).click();
  await page.getByRole("button", { name: "集中" }).click();
  await expect(page.locator(".editor.is-zen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".editor.is-zen")).toHaveCount(0);

  await page.getByRole("button", { name: "文字を大きく" }).click();
  await expect(page.locator('output[aria-label="文字サイズ"]')).toHaveText("18px");
  await page.getByLabel("組版プリセット").selectOption("bunko");
  await expect(page.getByLabel("組版プリセット")).toHaveValue("bunko");
  await expect.poll(() => page.locator(".manuscript-preview").evaluate((element) => getComputedStyle(element).getPropertyValue("--reader-line-height"))).toBe("1.7");
  await expect.poll(() => page.locator(".manuscript-preview").evaluate((element) => getComputedStyle(element).getPropertyValue("--reader-max-width"))).toBe("560px");
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.fill("物語");
  await editor.press("Control+a");
  await page.getByRole("button", { name: "鉤括弧を挿入" }).click();
  await expect(editor).toHaveText("「物語」");

  await page.locator(".scratch-panel summary").click();
  const scratchText = "本文に入れない台詞候補";
  await page.getByLabel("本文に含まれないメモ").fill(scratchText);
  await page.getByLabel("スクラッチ画像を添付").setInputFiles({
    name: "mood-board.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await editor.click();
  await expect(page.locator(".scratch-panel summary")).toContainText("Draft を保護済み");
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.documentPath.startsWith("meta/scratch/") && entry.text === scratchText && entry.attachmentWrites === 1)).toBe(true);

  const longReadingDraft = Array.from({ length: 240 }, () => "物語の続きを書く。読書ページを移動します。").join("");
  await editor.fill(longReadingDraft);
  await page.getByRole("button", { name: "読書モード" }).click();
  const pager = page.locator(".reading-pager");
  await expect.poll(async () => Number(await pager.getAttribute("data-page-count"))).toBeGreaterThan(1);
  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(pager).toHaveAttribute("data-page-index", "1");
  await page.getByRole("button", { name: "編集に戻る" }).click();

  const sceneTwoDraft = "A separate Scene Two browser draft.";
  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await page.locator(".cm-content").fill(sceneTwoDraft);
  await expect.poll(async () => {
    const entries = await readJournal(page);
    return entries.some((entry) => entry.state === "draft" && entry.text === longReadingDraft) &&
      entries.some((entry) => entry.state === "draft" && entry.text === sceneTwoDraft);
  }).toBe(true);
  await waitForJournalCount(page, 3);
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.locator(".cm-content")).toHaveText(longReadingDraft);

  await page.reload();
  await openFixtureProject(page);
  await expect(page.locator('output[aria-label="文字サイズ"]')).toHaveText("18px");
  await expect(page.locator(".cm-content")).toHaveText(longReadingDraft);
  await page.getByRole("button", { name: "読書モード" }).click();
  await expect(page.locator(".reading-pager")).toHaveAttribute("data-page-index", "1");
  await page.getByRole("button", { name: "編集に戻る" }).click();
  await page.locator(".scratch-panel summary").click();
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける" }).click();
  await expect(page.getByLabel("本文に含まれないメモ")).toHaveValue(scratchText);
  await page.locator(".scratch-panel").getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.documentPath.startsWith("meta/scratch/") && entry.state === "checkpointed")).toBe(true);
  const sceneOneDraft = "Scene One draft restored from IndexedDB.";
  await editor.fill(sceneOneDraft);
  // Move within the debounce window; navigation must flush Scene One before Scene Two can type.
  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneTwoDraft);
  await page.locator(".cm-content").press("Control+z");
  await expect(page.locator(".cm-content")).toHaveText(sceneTwoDraft);
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneOneDraft);

  await page.getByRole("button", { name: "Checkpoint" }).click();
  await expect(page.locator(".durability-message")).toContainText("ローカルチェックポイント");
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toBeEnabled();
  const checkpointed = await readJournal(page);
  expect(checkpointed).toHaveLength(3);
  expect(checkpointed.find((entry) => entry.text === sceneOneDraft)?.state).toBe("checkpointed");
  const checkpointBatchId = checkpointed.find((entry) => entry.text === sceneOneDraft)?.operationId;
  const scratchBatchId = checkpointed.find((entry) => entry.documentPath.startsWith("meta/scratch/"))?.operationId;
  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expect(page.locator(".topbar-status")).toContainText("GitHub への保存を確認しました。");
  await expect(page.getByText("Saved to GitHub", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).map((entry) => `${entry.documentPath}:${entry.state}`)).toEqual([
    "manuscript/vol-1/ch-1/scene-2.md:draft",
  ]);
  expect((await readPublicationReceipts(page)).some((receipt) => receipt.state === "confirmed" &&
    receipt.acknowledged.some((item) => item.operationId === checkpointBatchId) &&
    receipt.acknowledged.some((item) => item.operationId === scratchBatchId))).toBe(true);
  const laterDraft = "A later draft compared with the published version.";
  await editor.fill(laterDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === laterDraft && entry.state === "draft")).toBe(true);
  await page.getByRole("button", { name: "履歴" }).click();
  await expect(page.getByRole("heading", { name: "改稿の履歴" })).toBeVisible();
  const versions = page.getByRole("list", { name: "原稿の各バージョン" });
  await expect(versions.locator("li")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "この版を下書きとして開く" })).toBeVisible();
  await page.getByRole("button", { name: "この版を下書きとして開く" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneOneDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.documentPath === "manuscript/vol-1/ch-1/scene-1.md" && entry.text === sceneOneDraft && entry.state === "draft")).toBe(true);
  const restoredHistoryDraft = (await readJournal(page)).find((entry) => entry.documentPath === "manuscript/vol-1/ch-1/scene-1.md" && entry.text === sceneOneDraft);
  expect(restoredHistoryDraft?.state).toBe("draft");
  expect(restoredHistoryDraft?.text).toBe(sceneOneDraft);
  expect(restoredHistoryDraft?.writes.find((write) => write.path.endsWith("scene-1.md"))?.content).toContain(sceneOneDraft);
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
  await expect.poll(async () => (await readJournal(page)).find((entry) => entry.text === firstGeneration)?.state).toBe("checkpointed");
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

test("browser recovery is author-scoped and foreign records remain untouched", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await signIn(page);
  await openFixtureProject(page);
  const ownerDraft = "Owner-scoped draft.";
  await page.locator(".cm-content").fill(ownerDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === ownerDraft)).toBe(true);

  const foreignText = "FOREIGN AUTHOR RECOVERY MUST NOT OPEN";
  await page.evaluate(({ ownerText, foreignText }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("scriptorium-recovery", 3);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("operations", "readwrite");
      const store = transaction.objectStore("operations");
      const get = store.getAll();
      get.onerror = () => reject(get.error ?? new Error("IndexedDB journal read failed"));
      get.onsuccess = () => {
        const seed = get.result.find((entry: { authorScope: string | null; text: string }) => entry.authorScope === "owner" && entry.text === ownerText);
        if (!seed) {
          reject(new Error("Owner journal seed is missing"));
          return;
        }
        const repositoryKey = JSON.stringify([seed.repository.provider, seed.repository.ownerScope, seed.repository.repositoryId, seed.repository.defaultBranch]);
        const documentPath = "manuscript/vol-1/ch-1/scene-2.md";
        const documentKey = JSON.stringify([repositoryKey, documentPath]);
        const operation = structuredClone(seed.operation);
        operation.id = crypto.randomUUID();
        operation.generation = 999;
        operation.reads = operation.reads.map((item: { path: string; revision: string | null }) => ({ ...item, path: documentPath }));
        operation.writes = operation.writes.map((item: { path: string; revision: string | null; content: string | null }) => ({ ...item, path: documentPath, content: foreignText }));
        store.put({
          ...seed,
          key: JSON.stringify([documentKey, "different-author", operation.id, operation.generation]),
          repositoryKey,
          documentKey,
          documentPath,
          sceneId: "scene-2",
          authorScope: "different-author",
          operation,
          text: foreignText,
        });
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    };
  }), { ownerText: ownerDraft, foreignText });

  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText(foreignText);
  expect((await readJournal(page)).some((entry) => entry.authorScope === "different-author" && entry.text === foreignText)).toBe(true);
});

test("one malformed legacy key does not hide later recoverable drafts", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await page.addInitScript(() => {
    localStorage.setItem("scriptorium:draft:malformed", "{");
    localStorage.setItem("scriptorium:draft:recoverable", JSON.stringify({
      version: 1,
      projectId: "removed-project-id",
      sceneId: "removed-scene-id",
      text: "Legacy recovery after malformed item.",
      revision: "old-revision",
      savedAt: 1,
    }));
  });
  await signIn(page);
  await openFixtureProject(page);
  await expect(page.getByRole("heading", { name: "旧ブラウザー下書き" })).toBeVisible();
  await expect(page.getByText("シーン removed-scene-id")).toBeVisible();
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
