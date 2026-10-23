import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";

test.use({ hasTouch: true });

interface JournalDraft {
  sceneId: string;
  state: string;
  text: string;
}

interface JournalEntryRecord extends JournalDraft {
  key: string;
  publicationBatchId?: string;
  operation: { id: string; generation: number };
}

interface ConfirmedPublicationReceipt {
  batchId: string;
  state: "confirmed";
  acknowledged: Array<{ operationId: string; generation: number }>;
}

interface ModuleStatus {
  id: string;
  availability: string;
}

interface UiContribution {
  id: string;
  module: string;
  slot: "editor" | "dock" | "inspection" | "review" | "settings";
  title: string;
  kind?: "panel" | "editor-adornment" | "context-action";
  contexts?: Array<"workspace" | "editor" | "reading">;
}

function isWorkspacePanelContribution(item: UiContribution): boolean {
  return (item.kind ?? "panel") === "panel" && (!item.contexts || item.contexts.includes("workspace"));
}

function repositoryInputValue(value: string): string {
  return value.startsWith("https://") || value.startsWith("file://") ? value : pathToFileURL(value).href;
}

function projectLabel(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname + url.pathname.replace(".git", "").replace(/\/$/u, "");
  } catch {
    return value;
  }
}

async function signIn(page: Page, mode: "desktop" | "mobile"): Promise<void> {
  await page.goto("/" + mode + "/");
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  if (mode === "mobile") {
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "作品", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
}

async function openFixtureScene(page: Page, mode: "desktop" | "mobile", sceneId = "scene-1"): Promise<string> {
  if (mode === "mobile") {
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "作品", exact: true }).click();
  }

  const existing = page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true });
  if (await existing.isVisible().catch(() => false)) {
    await existing.click();
  } else {
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(repositoryUrl));
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
  }

  await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible();
  const sceneTitle = sceneId === "scene-1" ? "Chapter One: Scene One" : "Chapter One: Scene Two";
  await page.getByRole("button", { name: sceneTitle, exact: true }).click();
  if (mode === "mobile") {
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  }
  await expect(page.getByRole("heading", { name: sceneId === "scene-1" ? "Scene One" : "Scene Two" })).toBeVisible();
  await expect(page.locator(".cm-content")).toBeVisible();

  const response = await page.request.get(new URL("/api/projects", page.url()).toString());
  expect(response.ok()).toBe(true);
  const projects = await response.json() as Array<{ id: string; url: string }>;
  const project = projects.find((item) => item.url === repositoryUrl || item.url === repositoryInputValue(repositoryUrl));
  expect(project, "the synthetic Git repository should be registered in Core").toBeTruthy();
  return project!.id;
}

async function readJournal(page: Page): Promise<JournalDraft[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      const records = await new Promise<Array<{ sceneId: string; state: string; text: string }>>((resolve, reject) => {
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
      return records.map(({ sceneId, state, text }) => ({ sceneId, state, text }));
    } finally {
      database.close();
    }
  });
}

async function expectJournalDraft(page: Page, sceneId: string, text: string): Promise<void> {
  await expect.poll(async () => (await readJournal(page)).some((draft) =>
    draft.sceneId === sceneId && draft.text === text && draft.state === "draft",
  ), { timeout: 20_000 }).toBe(true);
}

async function expectJournalState(page: Page, sceneId: string, text: string, state: string): Promise<void> {
  await expect.poll(async () => (await readJournal(page)).some((draft) =>
    draft.sceneId === sceneId && draft.text === text && draft.state === state,
  ), { timeout: 30_000 }).toBe(true);
}

async function readJournalEntry(page: Page, sceneId: string, text: string): Promise<JournalEntryRecord> {
  return page.evaluate(async ({ sceneId, text }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      const records = await new Promise<JournalEntryRecord[]>((resolve, reject) => {
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => resolve(request.result as JournalEntryRecord[]);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
      const entry = records.find((record) => record.sceneId === sceneId && record.text === text);
      if (!entry) throw new Error("Expected recovery journal entry was not present");
      return entry;
    } finally {
      database.close();
    }
  }, { sceneId, text });
}

async function readConfirmedPublicationReceipt(page: Page, entry: JournalEntryRecord): Promise<ConfirmedPublicationReceipt> {
  return page.evaluate(async ({ operationId, generation }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("publicationReceipts", "readonly");
      const records = await new Promise<Array<{ receipt: ConfirmedPublicationReceipt }>>((resolve, reject) => {
        const request = transaction.objectStore("publicationReceipts").getAll();
        request.onsuccess = () => resolve(request.result as Array<{ receipt: ConfirmedPublicationReceipt }>);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB receipt read failed"));
      });
      const matched = records.map((record) => record.receipt).find((receipt) => receipt.state === "confirmed" &&
        receipt.acknowledged.some((item) => item.operationId === operationId && item.generation === generation));
      if (!matched) throw new Error("Confirmed receipt for the exact operation was not present");
      return matched;
    } finally {
      database.close();
    }
  }, { operationId: entry.operation.id, generation: entry.operation.generation });
}

async function restorePublicationUnknownEntry(page: Page, entry: JournalEntryRecord, receipt: ConfirmedPublicationReceipt): Promise<void> {
  await page.evaluate(async ({ entry, batchId }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readwrite");
      const done = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB recovery seed failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB recovery seed aborted"));
      });
      transaction.objectStore("operations").put({ ...entry, state: "publication_unknown", publicationBatchId: batchId, updatedAt: Date.now() });
      await done;
    } finally {
      database.close();
    }
  }, { entry, batchId: receipt.batchId });
}

async function hasJournalEntryForOperation(page: Page, operationId: string, generation: number): Promise<boolean> {
  return page.evaluate(async ({ operationId, generation }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      const records = await new Promise<JournalEntryRecord[]>((resolve, reject) => {
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => resolve(request.result as JournalEntryRecord[]);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
      return records.some((entry) => entry.operation.id === operationId && entry.operation.generation === generation);
    } finally {
      database.close();
    }
  }, { operationId, generation });
}

function readLocalRemoteDocument(path: string): string | null {
  if (repositoryUrl.startsWith("https://") || repositoryUrl.startsWith("http://")) return null;
  const repositoryPath = repositoryUrl.startsWith("file://") ? fileURLToPath(repositoryUrl) : repositoryUrl;
  const branch = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main";
  return execFileSync("git", ["--git-dir", repositoryPath, "show", `refs/heads/${branch}:${path}`], { encoding: "utf8" });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document, "document overflowed at " + widths.viewport + "px").toBeLessThanOrEqual(widths.viewport + 1);
  expect(widths.body, "body overflowed at " + widths.viewport + "px").toBeLessThanOrEqual(widths.viewport + 1);
}

test("the launcher remembers an explicit choice while direct Shell links keep the preference", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "執筆画面を選ぶ" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Desktop/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mobile/u })).toBeVisible();

  await page.getByRole("button", { name: /Mobile/u }).click();
  await expect(page).toHaveURL(new RegExp("/mobile/"));
  await expect.poll(() => page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("mobile");
  await page.reload();
  await expect(page).toHaveURL(new RegExp("/mobile/"));

  await page.goto("/desktop/");
  await expect(page).toHaveURL(new RegExp("/desktop/"));
  await expect.poll(() => page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("mobile");
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp("/mobile/"));
});

test("both production Shells preserve recoverable Japanese drafts and the Mobile writing and reading flow", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const pageErrors: string[] = [];
  const cspErrors: string[] = [];
  const failedAssets: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to|violat(?:e|ion)/iu.test(message.text())) {
      cspErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith(".js") || pathname.endsWith(".css")) failedAssets.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  await signIn(page, "mobile");
  const projectId = await openFixtureScene(page, "mobile");
  const mobileAppearance = page.getByLabel("外観");
  await expect(mobileAppearance).toBeVisible();
  for (const mode of ["dark", "paper", "light"] as const) {
    await mobileAppearance.selectOption(mode);
    await expect(page.locator("html")).toHaveAttribute("data-zp-theme", mode);
  }
  await expect(page).toHaveURL(new RegExp("/mobile/projects/" + encodeURIComponent(projectId) + "/scenes/scene-1"));
  const mobileScriptPaths = await page.locator("script[src]").evaluateAll((scripts) =>
    scripts.map((script) => {
      const url = new URL((script as HTMLScriptElement).src);
      return url.origin === location.origin ? url.pathname : "";
    }));
  expect(mobileScriptPaths.some((path) => /^\/mobile\/assets\/index-[A-Za-z0-9_-]{8}\.js$/u.test(path))).toBe(true);
  const mobileStylePaths = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.map((link) => {
      const url = new URL((link as HTMLLinkElement).href);
      return url.origin === location.origin ? url.pathname : "";
    }));
  expect(mobileStylePaths.some((path) => /^\/mobile\/assets\/styles-[A-Za-z0-9_-]{8}\.css$/u.test(path))).toBe(true);

  const mobileDraft = "彼は|東京《とうきょう》へ行く。\n\nMobile draft survives the Shell change.";
  const mobileEditor = page.locator(".cm-content");
  await mobileEditor.fill(mobileDraft);
  await expect(page.locator(".manuscript-preview ruby")).toContainText("東京");
  await expect(page.locator(".manuscript-preview rt")).toHaveText("とうきょう");
  await expectJournalDraft(page, "scene-1", mobileDraft);

  await mobileEditor.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" 日本語入力");
  const composedDraft = mobileDraft + " 日本語入力";
  await expect(mobileEditor).toContainText("日本語入力");
  await expectJournalDraft(page, "scene-1", composedDraft);

  await page.getByRole("button", { name: "縦書き", exact: true }).click();
  await expect(page.locator(".manuscript-preview.is-vertical")).toBeVisible();
  await page.getByRole("button", { name: "読書モード", exact: true }).tap();
  await expect(page.getByRole("document", { name: "縦書き読書モード" })).toBeVisible();
  await page.getByRole("button", { name: "編集に戻る", exact: true }).click();

  const longReadingDraft = mobileDraft + "\n\n" + Array.from({ length: 150 }, () => "読書ページを移動しても日本語の原稿を保ちます。").join("");
  await mobileEditor.fill(longReadingDraft);
  await expectJournalDraft(page, "scene-1", longReadingDraft);
  await page.getByRole("button", { name: "読書モード", exact: true }).click();
  const pager = page.locator(".reading-pager");
  await expect.poll(async () => Number(await pager.getAttribute("data-page-count"))).toBeGreaterThan(1);
  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(pager).toHaveAttribute("data-page-index", "1");
  const pagerBox = await pager.boundingBox();
  expect(pagerBox).toBeTruthy();
  const startX = pagerBox!.x + pagerBox!.width * 0.8;
  const endX = pagerBox!.x + pagerBox!.width * 0.2;
  const swipeY = pagerBox!.y + pagerBox!.height / 2;
  if (testInfo.project.name === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y: swipeY }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: startX - (startX - endX) / 2, y: swipeY }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: endX, y: swipeY }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  } else {
    await pager.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: startX, clientY: swipeY });
    await pager.dispatchEvent("pointermove", { pointerId: 1, pointerType: "touch", isPrimary: true, buttons: 1, clientX: endX, clientY: swipeY });
    await pager.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: endX, clientY: swipeY });
  }
  await expect(pager).toHaveAttribute("data-page-index", "2");
  await page.getByRole("button", { name: "編集に戻る", exact: true }).click();

  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "作品", exact: true }).click();
  await expect(page).toHaveURL(/view=library/u);
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  await expect(page).toHaveURL(/view=writing/u);
  await page.getByRole("button", { name: "前の画面に戻る" }).click();
  await expect(page).toHaveURL(/view=library/u);
  await page.goForward();
  await expect(page).toHaveURL(/view=writing/u);

  await page.setViewportSize({ width: 390, height: 400 });
  await mobileEditor.scrollIntoViewIfNeeded();
  await expect(mobileEditor).toBeInViewport();
  await mobileEditor.focus();
  await page.keyboard.press("Control+End");
  await expect(mobileEditor).toContainText("読書ページを移動しても日本語の原稿を保ちます。");
  const keyboardHeightCheckpoint = page.getByRole("button", { name: "Checkpoint", exact: true });
  await keyboardHeightCheckpoint.scrollIntoViewIfNeeded();
  await expect(keyboardHeightCheckpoint).toBeInViewport();

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await assertNoHorizontalOverflow(page);
    await expect(page.getByRole("navigation", { name: "モバイル画面" })).toBeVisible();
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await mobileEditor.scrollIntoViewIfNeeded();
  await expect(mobileEditor).toBeInViewport();
  await mobileEditor.focus();
  await expect(mobileEditor).toContainText("読書ページを移動しても日本語の原稿を保ちます。");
  await assertNoHorizontalOverflow(page);
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("button", { name: "Desktop版へ切り替え" }).click();
  await expect(page).toHaveURL(new RegExp("/desktop/projects/.+/scenes/scene-1"));
  const desktopEditor = page.locator(".cm-content");
  await expect(desktopEditor).toBeVisible();
  await expect(page.locator(".manuscript-preview")).toContainText("読書ページを移動しても日本語の原稿を保ちます。");
  await expectJournalDraft(page, "scene-1", longReadingDraft);
  const desktopAppearance = page.getByLabel("外観");
  for (const mode of ["dark", "paper", "light"] as const) {
    await desktopAppearance.selectOption(mode);
    await expect(page.locator("html")).toHaveAttribute("data-zp-theme", mode);
  }
  await expectJournalDraft(page, "scene-1", longReadingDraft);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("desktop");
  const desktopScriptPaths = await page.locator("script[src]").evaluateAll((scripts) =>
    scripts.map((script) => {
      const url = new URL((script as HTMLScriptElement).src);
      return url.origin === location.origin ? url.pathname : "";
    }));
  expect(desktopScriptPaths.some((path) => /^\/desktop\/assets\/index-[A-Za-z0-9_-]{8}\.js$/u.test(path))).toBe(true);
  const desktopStylePaths = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    links.map((link) => {
      const url = new URL((link as HTMLLinkElement).href);
      return url.origin === location.origin ? url.pathname : "";
    }));
  expect(desktopStylePaths.some((path) => /^\/desktop\/assets\/styles-[A-Za-z0-9_-]{8}\.css$/u.test(path))).toBe(true);

  const resizeHandle = page.getByRole("separator", { name: "Resize horizontal workspace panels" });
  await expect(resizeHandle).toBeVisible();
  const editorPanel = page.locator('[data-workspace-panel="editor"]');
  const beforeResize = (await editorPanel.boundingBox())?.width;
  await resizeHandle.focus();
  await page.keyboard.press("ArrowRight");
  expect(beforeResize).toBeTruthy();
  await expect.poll(async () => (await editorPanel.boundingBox())?.width).not.toBe(beforeResize);
  expect((await editorPanel.boundingBox())?.width).toBeTruthy();

  await page.getByRole("button", { name: "Chapter One: Scene Two", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  const desktopOriginalLines = await desktopEditor.locator(".cm-line").allTextContents();
  const desktopDraft = "Desktop draft with 日本語 and ruby |風《かぜ》。";
  await desktopEditor.fill(desktopDraft);
  await expectJournalDraft(page, "scene-2", desktopDraft);
  await expect(desktopEditor).toHaveText(desktopDraft);
  await desktopEditor.press("Control+z");
  await expect(desktopEditor.locator(".cm-line")).toHaveText(desktopOriginalLines);
  await desktopEditor.press("Control+Shift+z");
  await expect(desktopEditor).toHaveText(desktopDraft);
  await expect(page.locator(".manuscript-preview rt")).toContainText("かぜ");

  await page.evaluate(() => {
    (window as Window & { __failRecoveryJournalWrites?: boolean }).__failRecoveryJournalWrites = true;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const draftText = value && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text : "";
      if (this.transaction.db.name === "scriptorium-recovery" && this.name === "operations" && draftText.includes("回復記録の障害") && (window as Window & { __failRecoveryJournalWrites?: boolean }).__failRecoveryJournalWrites) {
        const testWindow = window as Window & { __failedRecoveryJournalPuts?: number };
        testWindow.__failedRecoveryJournalPuts = (testWindow.__failedRecoveryJournalPuts ?? 0) + 1;
        const transaction = this.transaction;
        const request = originalPut.call(this, value, key);
        Object.defineProperty(transaction, "error", {
          configurable: true,
          get: () => new DOMException("Synthetic quota limit", "QuotaExceededError"),
        });
        queueMicrotask(() => transaction.abort());
        return request;
      }
      return originalPut.call(this, value, key);
    };
  });
  const protectedDraft = desktopDraft + " 回復記録の障害";
  await desktopEditor.fill(protectedDraft);
  await expect(desktopEditor).toContainText("回復記録の障害");
  await page.waitForFunction(() => ((window as Window & { __failedRecoveryJournalPuts?: number }).__failedRecoveryJournalPuts ?? 0) > 0);
  await page.getByRole("button", { name: "モバイルUIへ" }).click();
  await expect(page.getByText("モバイル画面へ切り替えられませんでした。保存状態を確認してから再試行してください。", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "原稿エディター" }).getByRole("alert").filter({ hasText: "Browser storage is full" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp("/desktop/projects/.+/scenes/scene-2"));
  await expectJournalDraft(page, "scene-2", desktopDraft);
  await page.evaluate(() => { (window as Window & { __failRecoveryJournalWrites?: boolean }).__failRecoveryJournalWrites = false; });
  await page.getByRole("button", { name: "モバイルUIへ" }).click();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-2"));
  await expect(page.locator(".cm-content")).toHaveText(protectedDraft);
  await expectJournalDraft(page, "scene-2", protectedDraft);
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("button", { name: "Desktop版へ切り替え" }).click();
  await expect(page).toHaveURL(new RegExp("/desktop/projects/.+/scenes/scene-2"));
  await expectJournalDraft(page, "scene-2", protectedDraft);
  await expect(desktopEditor).toHaveText(protectedDraft);

  const desktopWorkspaceTop = await page.locator(".st-workspace-desktop, .st-desktop-workbench").first()
    .evaluate((node) => node.getBoundingClientRect().top);
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect(page.locator(".st-desktop-status")).toHaveCSS("position", "fixed");
  expect(await page.locator(".st-workspace-desktop, .st-desktop-workbench").first()
    .evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(desktopWorkspaceTop, 1);
  await expect(page.locator(".durability-message")).toContainText("ローカルチェックポイント");
  await expectJournalState(page, "scene-2", protectedDraft, "checkpointed");
  const desktopCheckpoint = await readJournalEntry(page, "scene-2", protectedDraft);
  const remoteBeforeDesktopPublish = readLocalRemoteDocument("manuscript/vol-1/ch-1/scene-2.md");
  await page.getByRole("button", { name: "Save to GitHub", exact: true }).click();
  await expect(page.locator(".durability-message")).toContainText("確認済みの GitHub 版");
  expect(await page.locator(".st-workspace-desktop, .st-desktop-workbench").first()
    .evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(desktopWorkspaceTop, 1);
  if (remoteBeforeDesktopPublish !== null) {
    expect(readLocalRemoteDocument("manuscript/vol-1/ch-1/scene-2.md")).toContain(protectedDraft);
  }
  const desktopReceipt = await readConfirmedPublicationReceipt(page, desktopCheckpoint);
  await restorePublicationUnknownEntry(page, desktopCheckpoint, desktopReceipt);
  await page.reload();
  await expect(page).toHaveURL(new RegExp("/desktop/projects/.+/scenes/scene-2"));
  await expect(page.locator(".cm-content")).toHaveText(protectedDraft);
  await expect(page.locator(".durability-message")).toContainText("確認済みの GitHub 版");
  await expect.poll(() => hasJournalEntryForOperation(page, desktopCheckpoint.operation.id, desktopCheckpoint.operation.generation)).toBe(false);
  await page.getByRole("button", { name: "履歴", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="history"]')).toBeVisible();
  const desktopHistory = page.locator(".manuscript-history");
  await expect(desktopHistory.getByRole("heading", { name: "改稿の履歴" })).toBeVisible();
  const desktopHistorySource = desktopHistory.locator("details summary");
  await expect(desktopHistorySource).toBeVisible();
  await desktopHistorySource.click();
  await expect(desktopHistory.locator("details pre")).toContainText(protectedDraft);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();

  await page.getByRole("button", { name: "モバイルUIへ" }).click();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-2"));
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  await expect(page.locator(".cm-content")).toHaveText(protectedDraft);
  await expect(page.locator(".durability-message")).toContainText("確認済みの GitHub 版");
  await page.reload();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-2"));
  await expect(page.locator(".cm-content")).toHaveText(protectedDraft);
  await expect(page.getByLabel("外観")).toHaveValue("light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("mobile");

  const mobileCompositionBase = "Mobile editor composition keeps ";
  await mobileEditor.fill(mobileCompositionBase);
  await expectJournalDraft(page, "scene-2", mobileCompositionBase);
  await mobileEditor.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true }));
    element.dispatchEvent(new CompositionEvent("compositionupdate", { data: "日本語", bubbles: true }));
  });
  await page.keyboard.insertText("日本語");
  const mobileCompositionDraft = mobileCompositionBase + "日本語";
  await expect(mobileEditor).toHaveText(mobileCompositionDraft);
  await expectJournalDraft(page, "scene-2", mobileCompositionDraft);
  const mobileWritingUrl = page.url();
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "設定", exact: true }).click();
  await expect(page).toHaveURL(mobileWritingUrl);
  await expect(page.getByRole("alert").filter({ hasText: "変換が完了していません" })).toBeVisible();
  await expect(mobileEditor).toHaveText(mobileCompositionDraft);
  await expectJournalDraft(page, "scene-2", mobileCompositionDraft);
  await mobileEditor.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true })));
  await expect(mobileEditor).toHaveText(mobileCompositionDraft);
  await expectJournalDraft(page, "scene-2", mobileCompositionDraft);

  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "設定", exact: true }).click();
  await expect(page.getByRole("button", { name: "Desktop版へ切り替え" })).toBeVisible();
  await page.getByRole("button", { name: "Desktop版へ切り替え" }).click();
  await expect(page).toHaveURL(new RegExp("/desktop/projects/.+/scenes/scene-2"));
  await expect(desktopEditor).toHaveText(mobileCompositionDraft);
  await expectJournalDraft(page, "scene-2", mobileCompositionDraft);
  await page.getByRole("button", { name: "モバイルUIへ" }).click();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-2"));
  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  await expect(mobileEditor).toHaveText(mobileCompositionDraft);
  await expectJournalDraft(page, "scene-2", mobileCompositionDraft);

  const mobilePublishedDraft = "Mobile checkpoint, history, and explicit publication.";
  await mobileEditor.fill(mobilePublishedDraft);
  await expectJournalDraft(page, "scene-2", mobilePublishedDraft);
  const mobileHeaderHeight = await page.locator(".mobile-shell-ion-header")
    .evaluate((node) => node.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect(page.locator(".mobile-shell-status")).toHaveCSS("position", "fixed");
  expect(await page.locator(".mobile-shell-ion-header")
    .evaluate((node) => node.getBoundingClientRect().height)).toBeCloseTo(mobileHeaderHeight, 1);
  await expect(page.locator(".durability-message")).toContainText("ローカルチェックポイント");
  await expectJournalState(page, "scene-2", mobilePublishedDraft, "checkpointed");
  await page.getByRole("button", { name: "Save to GitHub", exact: true }).click();
  await expect(page.locator(".durability-message")).toContainText("確認済みの GitHub 版");
  expect(await page.locator(".mobile-shell-ion-header")
    .evaluate((node) => node.getBoundingClientRect().height)).toBeCloseTo(mobileHeaderHeight, 1);
  if (remoteBeforeDesktopPublish !== null) {
    expect(readLocalRemoteDocument("manuscript/vol-1/ch-1/scene-2.md")).toContain(mobilePublishedDraft);
  }
  await page.reload();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-2"));
  await page.getByRole("button", { name: "履歴", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="history"]')).toBeVisible();
  const mobileHistory = page.locator(".manuscript-history");
  await expect(mobileHistory.getByRole("heading", { name: "改稿の履歴" })).toBeVisible();
  const mobileHistorySource = mobileHistory.locator("details summary");
  await expect(mobileHistorySource).toBeVisible();
  await mobileHistorySource.click();
  await expect(mobileHistory.locator("details pre")).toContainText(mobilePublishedDraft);
  await page.getByRole("button", { name: "閉じる", exact: true }).click();

  const health = await page.request.get(new URL("/api/health", page.url()).toString());
  expect(health.status()).toBe(200);
  const unknownApi = await page.request.get(new URL("/api/ui-v1-not-found", page.url()).toString());
  expect(unknownApi.status()).toBe(404);
  expect(unknownApi.headers()["content-type"]).toContain("application/json");
  expect(pageErrors, testInfo.project.name + " runtime errors").toEqual([]);
  expect(cspErrors, testInfo.project.name + " CSP errors").toEqual([]);
  expect(failedAssets, testInfo.project.name + " failed JS/CSS requests").toEqual([]);
});

test("profile-selected workspace panels match contribution kinds and mount one at a time in both Shells", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The catalog is exercised once in Chromium; WebKit covers both production Shells above.");
  test.setTimeout(240_000);
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  await signIn(page, "desktop");
  const projectId = await openFixtureScene(page, "desktop");
  const origin = new URL(page.url()).origin;
  const [moduleResponse, contributionResponse] = await Promise.all([
    page.request.get(origin + "/api/projects/" + encodeURIComponent(projectId) + "/modules"),
    page.request.get(origin + "/api/projects/" + encodeURIComponent(projectId) + "/contributions"),
  ]);
  expect(moduleResponse.ok()).toBe(true);
  expect(contributionResponse.ok()).toBe(true);
  const modules = await moduleResponse.json() as ModuleStatus[];
  const contributions = await contributionResponse.json() as UiContribution[];
  const enabled = modules.filter((module) => module.availability === "enabled-idle" || module.availability === "active");
  const enabledIds = enabled.map((module) => module.id).sort();
  const expectedModules = process.env.SCRIPTORIUM_E2E_EXPECTED_MODULES?.split(",").filter(Boolean).sort();
  if (expectedModules) expect(enabledIds).toEqual(expectedModules);
  if ((process.env.SCRIPTORIUM_PROFILE ?? "core") === "core") expect(enabledIds).toEqual([]);
  if ((process.env.SCRIPTORIUM_PROFILE ?? "core") === "full") {
    expect(enabledIds).toEqual(["assistant", "diagnostics", "mcp", "nlp", "publishing", "search", "semantic", "speaker", "story"]);
  }

  const enabledSet = new Set(enabledIds);
  const enabledContributions = contributions.filter((item) => enabledSet.has(item.module));
  const expectedPanels = enabledContributions.filter(isWorkspacePanelContribution);
  const editorAdornments = enabledContributions.filter((item) => item.kind === "editor-adornment");
  expect(contributions.some((item) => item.module === "mcp")).toBe(false);
  expect(new Set(enabledContributions.map((item) => item.id)).size).toBe(enabledContributions.length);

  const mountedByShell: Record<string, string[]> = {};
  for (const mode of ["desktop", "mobile"] as const) {
    if (mode === "mobile") {
      await page.getByRole("button", { name: "モバイルUIへ" }).click();
      await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-1"));
    }
    const toolbar = page.getByRole("toolbar", { name: "Workspace layout controls" });
    await expect(toolbar).toBeVisible();
    const panelMenu = page.locator(".st-workspace-panel-menu");
    await panelMenu.locator("summary").click();
    for (const item of expectedPanels) {
      const show = panelMenu.getByRole("button", { name: "Show " + item.title, exact: true });
      const hide = panelMenu.getByRole("button", { name: "Hide " + item.title, exact: true });
      await expect.poll(async () => (await show.count()) + (await hide.count())).toBe(1);
    }
    for (const item of editorAdornments) {
      await expect(page.locator('[data-workspace-panel="module:' + item.id + '"]')).toHaveCount(0);
      await expect(panelMenu.getByRole("button", { name: "Show " + item.title, exact: true })).toHaveCount(0);
      await expect(panelMenu.getByRole("button", { name: "Hide " + item.title, exact: true })).toHaveCount(0);
    }
    await panelMenu.locator("summary").click();

    await toolbar.getByRole("button", { name: "Research", exact: true }).click();
    await expect(page.locator(".st-workspace-message")).toContainText("調査 preset applied");
    await panelMenu.locator("summary").click();
    for (const item of expectedPanels) {
      await expect(panelMenu.getByRole("button", { name: "Hide " + item.title, exact: true })).toHaveCount(1);
    }
    for (const item of editorAdornments) {
      await expect(panelMenu.getByRole("button", { name: "Show " + item.title, exact: true })).toHaveCount(0);
      await expect(panelMenu.getByRole("button", { name: "Hide " + item.title, exact: true })).toHaveCount(0);
    }
    await panelMenu.locator("summary").click();

    const mounted: string[] = [];
    const workspaceTabs = mode === "mobile"
      ? page.getByRole("tablist", { name: "Workspace panels" })
      : page.getByRole("tablist", { name: "Panel tabs" });
    for (const item of expectedPanels) {
      const tab = workspaceTabs.getByRole("tab", { name: item.title, exact: true });
      await expect(tab).toHaveCount(1);
      await tab.click();
      const panel = page.locator('[data-workspace-panel="module:' + item.id + '"]');
      await expect(panel).toBeVisible();
      await expect(panel.locator('[data-contribution="' + item.id + '"]')).toBeVisible();
      await expect(page.locator("[data-contribution]")).toHaveCount(1);
      mounted.push(item.id);
    }
    expect(mounted.sort()).toEqual(expectedPanels.map((item) => item.id).sort());

    await toolbar.getByRole("button", { name: "Writing", exact: true }).click();
    await expect(page.locator("[data-contribution]")).toHaveCount(0);
    mountedByShell[mode] = mounted;
  }
  expect(mountedByShell.mobile.sort()).toEqual(mountedByShell.desktop.sort());

  if (expectedPanels.length === 0) await expect(page.locator(".st-workspace-panel-menu-item")).toHaveCount(5);
});
