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
  operationGeneration?: number | null;
}

interface JournalEntryRecord extends JournalDraft {
  key: string;
  authorScope: string | null;
  repository: {
    provider: "github" | "local";
    repositoryId: string;
    defaultBranch: string;
    ownerScope: string;
    url: string;
  };
  snapshot: { remoteCommit: string; overlayCommit?: string };
  checkpoint?: { localCommit: string };
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

async function seedLegacyDraft(page: Page, text: string): Promise<string> {
  const key = "scriptorium:draft:issue-41";
  await page.addInitScript(({ key, text }) => {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      projectId: "legacy-project",
      sceneId: "scene-1",
      text,
      revision: "legacy-revision",
      savedAt: Date.now(),
    }));
  }, { key, text });
  return key;
}

async function failNextJournalWriteForText(page: Page, text: string): Promise<void> {
  await page.evaluate((targetText) => {
    const originalPut = IDBObjectStore.prototype.put;
    let failurePending = true;
    (window as Window & { __failedIssue41JournalPuts?: number }).__failedIssue41JournalPuts = 0;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const entryText = value && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text : "";
      if (failurePending && this.transaction.db.name === "scriptorium-recovery" && this.name === "operations" && entryText === targetText) {
        failurePending = false;
        const transaction = this.transaction;
        const request = originalPut.call(this, value, key);
        Object.defineProperty(transaction, "error", {
          configurable: true,
          get: () => new DOMException("Synthetic strict journal write failure", "QuotaExceededError"),
        });
        (window as Window & { __failedIssue41JournalPuts?: number }).__failedIssue41JournalPuts = 1;
        queueMicrotask(() => transaction.abort());
        return request;
      }
      return originalPut.call(this, value, key);
    };
  }, text);
}

async function holdCompositionFlush(page: Page, delayMs = 1_500): Promise<void> {
  await page.evaluate((delayMs) => {
    const editor = document.querySelector<HTMLElement>(".cm-content");
    if (!editor) throw new Error("The manuscript editor is not mounted");
    const originalSetTimeout = window.setTimeout.bind(window);
    const state = window as Window & {
      __issue41DelayedFlushTimers?: number;
      __issue41CompletedFlushTimers?: number;
      __issue41ReleaseComposition?: () => void;
    };
    state.__issue41DelayedFlushTimers = 0;
    state.__issue41CompletedFlushTimers = 0;
    let suppressCompositionEnd = true;
    editor.addEventListener("compositionend", (event) => {
      if (suppressCompositionEnd) event.stopImmediatePropagation();
    }, true);
    const suppressCompositionBlur = (event: Event) => {
      if (event.target === editor) event.stopImmediatePropagation();
    };
    document.addEventListener("blur", suppressCompositionBlur, true);
    document.addEventListener("focusout", suppressCompositionBlur, true);
    editor.blur = () => undefined;
    window.setTimeout = ((handler: TimerHandler, timeout = 0, ...arguments_: unknown[]) => {
      if (timeout === 0 && new Error().stack?.includes("flushComposition") && state.__issue41DelayedFlushTimers! < 2) {
        state.__issue41DelayedFlushTimers = (state.__issue41DelayedFlushTimers ?? 0) + 1;
        const delayedHandler = typeof handler === "function" ? (...callbackArguments: unknown[]) => {
          state.__issue41CompletedFlushTimers = (state.__issue41CompletedFlushTimers ?? 0) + 1;
          handler.apply(window, callbackArguments);
        } : handler;
        return originalSetTimeout(delayedHandler, delayMs, ...arguments_);
      }
      return originalSetTimeout(handler, timeout, ...arguments_);
    }) as typeof window.setTimeout;
    editor.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true }));
    state.__issue41ReleaseComposition = () => {
      suppressCompositionEnd = false;
      editor.dispatchEvent(new CompositionEvent("compositionend", { data: "日本語", bubbles: true }));
    };
  }, delayMs);
}

async function rejectNextCompositionFlush(page: Page): Promise<void> {
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".cm-content");
    if (!editor) throw new Error("The manuscript editor is not mounted");
    editor.dispatchEvent(new CompositionEvent("compositionstart", { data: "にほんご", bubbles: true }));
    const originalSetTimeout = window.setTimeout.bind(window);
    const state = window as Window & { __issue41CompositionFlushRejected?: number };
    state.__issue41CompositionFlushRejected = 0;
    let rejectionPending = true;
    window.setTimeout = ((handler: TimerHandler, timeout = 0, ...arguments_: unknown[]) => {
      if (rejectionPending && timeout === 0 && new Error().stack?.includes("flushComposition")) {
        rejectionPending = false;
        state.__issue41CompositionFlushRejected = 1;
        throw new Error("日本語入力の変換が完了していません。変換を確定してから画面を切り替えてください。");
      }
      return originalSetTimeout(handler, timeout, ...arguments_);
    }) as typeof window.setTimeout;
  });
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
      const records = await new Promise<Array<{ sceneId: string; state: string; text: string; operation?: { generation?: number } }>>((resolve, reject) => {
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
      return records.map(({ sceneId, state, text, operation }) => ({
        sceneId,
        state,
        text,
        operationGeneration: typeof operation?.generation === "number" ? operation.generation : null,
      }));
    } finally {
      database.close();
    }
  });
}

interface JournalDraftDiagnosticContext {
  beforeFill: unknown;
  afterFill: unknown;
  pageErrors: string[];
}

async function journalDraftDiagnostic(page: Page, sceneId: string, expectedText: string): Promise<unknown> {
  return page.evaluate(async ({ sceneId, expectedText }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      const records = await new Promise<Array<{ sceneId: string; state: string; text: string; operation?: { generation?: number } }>>((resolve, reject) => {
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal diagnostic read failed"));
      });
      const editor = document.querySelector<HTMLElement>(".cm-content");
      const recovery = document.querySelector<HTMLElement>("[data-recovery-status]");
      return {
        at: performance.now(),
        recoveryStatus: recovery?.dataset.recoveryStatus ?? null,
        editorWritable: recovery?.dataset.editorWritable ?? null,
        contenteditable: editor?.getAttribute("contenteditable") ?? null,
        displayedTextLength: editor?.textContent?.length ?? null,
        displayedTextMatchesDraft: editor?.textContent === expectedText,
        durabilityMessages: Array.from(document.querySelectorAll<HTMLElement>(".durability-message"), (element) => ({
          kind: element.dataset.kind ?? null,
          text: (element.textContent ?? "").trim().slice(0, 200),
        })),
        operationRows: records.filter((record) => record.sceneId === sceneId).map((record) => ({
          sceneId: record.sceneId,
          state: record.state,
          textLength: record.text.length,
          exactDraftMatch: record.text === expectedText,
          operationGeneration: typeof record.operation?.generation === "number" ? record.operation.generation : null,
        })),
      };
    } finally {
      database.close();
    }
  }, { sceneId, expectedText });
}

async function expectJournalDraft(page: Page, sceneId: string, text: string, diagnostic?: JournalDraftDiagnosticContext): Promise<void> {
  const pollSamples: Array<{ at: number; rows: Array<{ state: string; textLength: number; exactDraftMatch: boolean; operationGeneration: number | null }> }> = [];
  try {
    await expect.poll(async () => {
      const drafts = await readJournal(page);
      if (diagnostic) pollSamples.push({
        at: Date.now(),
        rows: drafts.filter((draft) => draft.sceneId === sceneId).map((draft) => ({
          state: draft.state,
          textLength: draft.text.length,
          exactDraftMatch: draft.text === text,
          operationGeneration: draft.operationGeneration ?? null,
        })),
      });
      return drafts.some((draft) => draft.sceneId === sceneId && draft.text === text && draft.state === "draft");
    }, { timeout: 20_000 }).toBe(true);
  } catch (error) {
    if (diagnostic) {
      let afterPoll: unknown;
      try {
        afterPoll = await journalDraftDiagnostic(page, sceneId, text);
      } catch (diagnosticError) {
        afterPoll = { captureError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) };
      }
      await test.info().attach("journal-draft-timeout-diagnostic.json", {
        body: Buffer.from(JSON.stringify({
          sceneId,
          expectedTextLength: text.length,
          beforeFill: diagnostic.beforeFill,
          afterFill: diagnostic.afterFill,
          pollSamples,
          afterPoll,
          pageErrors: diagnostic.pageErrors,
          assertionError: error instanceof Error ? error.message : String(error),
        }, null, 2)),
        contentType: "application/json",
      });
    }
    throw error;
  }
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

test("legacy draft import preserves active input when its journal debounce is pending", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const legacyText = "Legacy text must remain available for a deliberate import.";
  const legacyKey = await seedLegacyDraft(page, legacyText);
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");

  await page.evaluate(() => {
    const originalSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout = 0, ...arguments_: unknown[]) =>
      originalSetTimeout(handler, timeout === 350 ? 2_000 : timeout, ...arguments_)) as typeof window.setTimeout;
  });
  const activeText = "New active editor text before the legacy import.";
  const editor = page.locator(".cm-content");
  await editor.fill(activeText);
  await expect(editor).toHaveText(activeText);
  expect((await readJournal(page)).some((entry) => entry.sceneId === "scene-1" && entry.text === activeText)).toBe(false);

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true }).click();

  await expect(page.getByText(/現在の下書きがあるため、古い記録の移行を中止しました/u)).toBeVisible();
  await expect(editor).toHaveText(activeText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
  await expectJournalDraft(page, "scene-1", activeText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);

  await page.reload();
  if (await page.getByLabel("アクセストークン").isVisible().catch(() => false)) {
    await signIn(page, "desktop");
  }
  if (!await page.locator(".cm-content").isVisible().catch(() => false)) {
    await openFixtureScene(page, "desktop");
  }
  await expect(page.locator('[data-recovery-status="ready"]')).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText(activeText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
});

test("legacy draft import can be canceled, reloads its source, and removes it only after journal durability", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const legacyText = "A clean editor can safely receive this legacy draft.";
  const legacyKey = await seedLegacyDraft(page, legacyText);
  await signIn(page, "desktop");
  const projectId = await openFixtureScene(page, "desktop");
  const editor = page.locator(".cm-content");
  const originalText = await editor.innerText();

  page.on("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true }).click();
  expect(await editor.innerText()).toBe(originalText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
  expect((await readJournal(page)).some((entry) => entry.sceneId === "scene-1" && entry.text === legacyText)).toBe(false);

  await page.reload();
  if (await page.getByLabel("アクセストークン").isVisible().catch(() => false)) {
    await signIn(page, "desktop");
  }
  if (!await page.locator(".cm-content").isVisible().catch(() => false)) {
    await openFixtureScene(page, "desktop");
  }
  await expect(page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true })).toBeVisible();
  page.removeAllListeners("dialog");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true }).click();

  await expect(editor).toHaveText(legacyText);
  await expectJournalDraft(page, "scene-1", legacyText);
  const migrated = await readJournalEntry(page, "scene-1", legacyText);
  expect(migrated.operation.id).not.toBe("");
  expect(migrated.operation.generation).toBe(1);
  expect(migrated.authorScope).toBe("owner");
  const observationResponse = await page.request.get(new URL(`/api/projects/${encodeURIComponent(projectId)}/observation`, page.url()).toString());
  expect(observationResponse.ok()).toBe(true);
  const observation = await observationResponse.json() as { snapshot?: { repository?: JournalEntryRecord["repository"] } };
  expect(migrated.repository).toEqual(observation.snapshot?.repository);
  expect(await page.evaluate((key) => localStorage.getItem(key) === null, legacyKey)).toBe(true);

  await page.reload();
  if (await page.getByLabel("アクセストークン").isVisible().catch(() => false)) {
    await signIn(page, "desktop");
  }
  await expect(page.locator(".cm-content")).toHaveText(legacyText);
  await expectJournalDraft(page, "scene-1", legacyText);
});

test("legacy draft import preserves a checkpointed operation and advances its generation", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const legacyText = "This older legacy text follows a durable checkpoint.";
  const legacyKey = await seedLegacyDraft(page, legacyText);
  await signIn(page, "desktop");
  const projectId = await openFixtureScene(page, "desktop");
  const currentText = "The author's existing operation must remain checkpointed.";
  await page.locator(".cm-content").fill(currentText);
  await expectJournalDraft(page, "scene-1", currentText);
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expectJournalState(page, "scene-1", currentText, "checkpointed");
  const checkpointedBefore = await readJournalEntry(page, "scene-1", currentText);
  expect(checkpointedBefore.checkpoint?.localCommit).toBeTruthy();

  await page.reload();
  if (await page.getByLabel("アクセストークン").isVisible().catch(() => false)) {
    await signIn(page, "desktop");
  }
  if (!await page.locator(".cm-content").isVisible().catch(() => false)) {
    await openFixtureScene(page, "desktop");
  }
  await expect(page.locator(".cm-content")).toHaveText(currentText);
  await expect(page.locator('[data-recovery-status="ready"]')).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true }).click();

  await expect(page.locator(".cm-content")).toHaveText(legacyText);
  await expectJournalDraft(page, "scene-1", legacyText);
  const checkpointedAfter = await readJournalEntry(page, "scene-1", currentText);
  const migrated = await readJournalEntry(page, "scene-1", legacyText);
  expect(checkpointedAfter.state).toBe("checkpointed");
  expect(checkpointedAfter.operation.id).toBe(checkpointedBefore.operation.id);
  expect(checkpointedAfter.operation.generation).toBe(checkpointedBefore.operation.generation);
  expect(checkpointedAfter.checkpoint?.localCommit).toBe(checkpointedBefore.checkpoint?.localCommit);
  expect(migrated.operation.id).not.toBe(checkpointedBefore.operation.id);
  expect(migrated.operation.generation).toBe(checkpointedBefore.operation.generation + 1);
  expect(migrated.authorScope).toBe(checkpointedBefore.authorScope);
  expect(migrated.repository).toEqual(checkpointedBefore.repository);
  expect(await page.evaluate((key) => localStorage.getItem(key) === null, legacyKey)).toBe(true);
});

test("legacy draft import preserves input after its strict journal write fails", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const legacyText = "Legacy source must remain when active input cannot be journaled.";
  const legacyKey = await seedLegacyDraft(page, legacyText);
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");
  const activeText = "Active text survives a strict journal write failure.";
  await failNextJournalWriteForText(page, activeText);
  const editor = page.locator(".cm-content");
  await editor.fill(activeText);
  await expect(editor).toHaveText(activeText);
  await page.waitForFunction(() => (window as Window & { __failedIssue41JournalPuts?: number }).__failedIssue41JournalPuts === 1);
  await expect(page.getByRole("region", { name: "原稿エディター" }).getByRole("alert").filter({ hasText: "Browser storage is full" })).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true }).click();

  await expect(page.getByText(/現在の下書きがあるため、古い記録の移行を中止しました/u)).toBeVisible();
  await expect(editor).toHaveText(activeText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
  expect((await readJournal(page)).some((entry) => entry.sceneId === "scene-1" && entry.text === activeText)).toBe(false);

  await page.getByRole("button", { name: "ブラウザーへの記録を再試行", exact: true }).click();
  await expectJournalDraft(page, "scene-1", activeText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
  await page.reload();
  if (await page.getByLabel("アクセストークン").isVisible().catch(() => false)) {
    await signIn(page, "desktop");
  }
  if (!await page.locator(".cm-content").isVisible().catch(() => false)) {
    await openFixtureScene(page, "desktop");
  }
  await expect(page.locator('[data-recovery-status="ready"]')).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText(activeText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
});

test("legacy draft import reports a rejected composition flush and keeps its source", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const legacyText = "Keep this source if Japanese input is still composing.";
  const legacyKey = await seedLegacyDraft(page, legacyText);
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");
  const editor = page.locator(".cm-content");
  const originalText = await editor.innerText();
  await rejectNextCompositionFlush(page);

  await page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __issue41CompositionFlushRejected?: number }).__issue41CompositionFlushRejected ?? 0)).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: "日本語入力の変換が完了していません" })).toBeVisible();
  await expect.poll(() => editor.innerText()).toBe(originalText);
  expect(await page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
});

test("legacy draft composition cannot write old scene text into a newly selected scene", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const legacyKey = await seedLegacyDraft(page, "The legacy source stays with its original scene.");
  await signIn(page, "desktop");
  const projectId = await openFixtureScene(page, "desktop");
  await page.getByRole("button", { name: "Chapter One: Scene Two", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  const sceneTwoText = await page.locator(".cm-content").innerText();
  await page.getByRole("button", { name: "Chapter One: Scene One", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  const sceneOneText = await page.locator(".cm-content").innerText();
  expect(sceneOneText).not.toBe(sceneTwoText);

  await holdCompositionFlush(page);
  await page.getByRole("button", { name: "選択中のシーンに下書きとして移す", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __issue41DelayedFlushTimers?: number }).__issue41DelayedFlushTimers ?? 0)).toBe(2);
  await page.evaluate((projectId) => {
    const state = window as Window & { __issue41ReleaseComposition?: () => void };
    state.__issue41ReleaseComposition?.();
    const target = new URL(window.location.href);
    target.pathname = target.pathname.replace(/\/scenes\/scene-1\/?$/u, "/scenes/scene-2");
    target.pathname = target.pathname.replace(/\/projects\/[^/]+\/scenes/u, "/projects/" + encodeURIComponent(projectId) + "/scenes");
    window.history.pushState(window.history.state, "", target);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, projectId);
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __issue41CompletedFlushTimers?: number }).__issue41CompletedFlushTimers ?? 0)).toBe(2);
  await expect.poll(() => page.locator(".cm-content").innerText()).toBe(sceneTwoText);
  await expect(page.getByRole("alert").filter({ hasText: "移行中に作品やシーンが変わったため" })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key) !== null, legacyKey)).toBe(true);
});

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

for (const departure of ["reload", "pagehide"] as const) {
  test(`recovery reconciliation is cancelled at ${departure} and retried without losing its checkpoint`, async ({ page }, testInfo) => {
    test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1" || Boolean(process.env.SCRIPTORIUM_E2E_BASE_URL ?? process.env.SCRIPTORIUM_BASE_URL),
      "This case controls the generated local server and isolated browser journal.");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      for (const type of ["beforeunload", "pagehide", "unload"]) window.addEventListener(type, () => {
        const key = "scriptorium:e2e:reconcile-lifecycle";
        const events = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
        localStorage.setItem(key, JSON.stringify([...events, { event: type }]));
      });
      const original = window.fetch;
      window.fetch = function (input, init) {
        if (String(input).endsWith("/reconcile")) {
          const record = (event: { event: string; signal?: boolean }) => {
            const key = "scriptorium:e2e:reconcile-lifecycle";
            const events = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
            localStorage.setItem(key, JSON.stringify([...events, event]));
          };
          record({ event: "start", signal: Boolean(init?.signal) });
          init?.signal?.addEventListener("abort", () => { record({ event: "abort" }); }, { once: true });
        }
        return original.call(window, input, init);
      };
    });
    await signIn(page, "desktop");
    await openFixtureScene(page, "desktop");
    const draft = `${testInfo.project.name} ${departure}: a checkpoint must survive interrupted recovery.`;
    const editor = page.locator(".cm-content");
    const beforeFill = await journalDraftDiagnostic(page, "scene-1", draft);
    await editor.fill(draft);
    const afterFill = await journalDraftDiagnostic(page, "scene-1", draft);
    if (!(afterFill as { displayedTextMatchesDraft?: boolean }).displayedTextMatchesDraft) {
      await testInfo.attach("journal-draft-fill-diagnostic.json", {
        body: Buffer.from(JSON.stringify({ beforeFill, afterFill, expectedTextLength: draft.length, pageErrors: errors }, null, 2)),
        contentType: "application/json",
      });
    }
    expect((afterFill as { displayedTextMatchesDraft?: boolean }).displayedTextMatchesDraft).toBe(true);
    await expectJournalDraft(page, "scene-1", draft, { beforeFill, afterFill, pageErrors: errors });
    await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
    await expectJournalState(page, "scene-1", draft, "checkpointed");
    const checkpoint = await readJournalEntry(page, "scene-1", draft);
    const control = new URL(page.url());
    control.port = String(Number(control.port) + 1);
    const hold = new URL("/__e2e/hold-reconcile", control).href;
    const release = new URL("/__e2e/release-reconcile", control).href;
    expect((await page.request.post(hold)).ok()).toBe(true);
    try {
      await page.reload();
      await expect.poll(async () => (await (await page.request.get(new URL("/__e2e/reconcile-state", control).href)).json() as { started: boolean }).started).toBe(true);
      // A guard that keeps this document open must not cancel its recovery.
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        event.preventDefault();
        window.dispatchEvent(event);
      });
      expect(await page.evaluate(() => localStorage.getItem("scriptorium:e2e:reconcile-lifecycle"))).not.toContain('"event":"abort"');
      if (departure === "reload") await page.reload();
      else await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
      expect((await page.request.post(release)).ok()).toBe(true);
      if (departure === "pagehide") {
        await expect.poll(() => page.evaluate(() => localStorage.getItem("scriptorium:e2e:reconcile-lifecycle"))).toContain('"event":"abort"');
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      }
      await expect(page.locator(".cm-content[contenteditable=true]")).toHaveText(draft);
      await expectJournalState(page, "scene-1", draft, "checkpointed");
      const requests = await page.evaluate(() => JSON.parse(localStorage.getItem("scriptorium:e2e:reconcile-lifecycle") ?? "[]") as Array<{ event: string; signal?: boolean }>);
      const recovered = await readJournalEntry(page, "scene-1", draft);
      expect(recovered.operation).toEqual(checkpoint.operation);
      expect(recovered.checkpoint).toEqual(checkpoint.checkpoint);
      expect(recovered.key).toBe(checkpoint.key);
      expect(errors).toEqual([]);
      expect(requests.some((request) => request.event === "abort")).toBe(true);

      // Real errors in the active document remain visible and retain the operation.
      await page.route("**/reconcile", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic reconciliation outage" }) }));
      await page.reload();
      await expect(page.locator('[data-recovery-status="unavailable"]')).toBeVisible();
      expect((await readJournalEntry(page, "scene-1", draft)).operation).toEqual(checkpoint.operation);
      await page.unroute("**/reconcile");
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(page.locator(".cm-content[contenteditable=true]")).toHaveText(draft);
      expect((await readJournalEntry(page, "scene-1", draft)).checkpoint).toEqual(checkpoint.checkpoint);
    } finally {
      await page.request.post(release);
    }
  });
}

test("recovery approval is cancelled at pagehide and retried without losing its checkpoint", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = function (input, init) {
      if (String(input).endsWith("/approvals")) {
        init?.signal?.addEventListener("abort", () => {
          document.documentElement.dataset.approvalAborted = "true";
        }, { once: true });
      }
      return original.call(window, input, init);
    };
  });
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");
  const draft = "Retain this checkpoint when recovery approval is interrupted.";
  await page.locator(".cm-content").fill(draft);
  await expectJournalDraft(page, "scene-1", draft);
  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expectJournalState(page, "scene-1", draft, "checkpointed");
  const checkpoint = await readJournalEntry(page, "scene-1", draft);
  let releaseApproval!: () => void;
  const gate = new Promise<void>((resolve) => { releaseApproval = resolve; });
  let approvalStarted!: () => void;
  const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
  await page.route("**/approvals", async (route) => {
    approvalStarted();
    await gate;
    await route.continue().catch(() => undefined);
  });
  try {
    await page.reload();
    await started;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expect(page.locator("html")).toHaveAttribute("data-approval-aborted", "true");
  } finally {
    releaseApproval();
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator(".cm-content[contenteditable=true]")).toHaveText(draft);
  const recovered = await readJournalEntry(page, "scene-1", draft);
  expect(recovered.operation).toEqual(checkpoint.operation);
  expect(recovered.checkpoint).toEqual(checkpoint.checkpoint);
  expect(errors).toEqual([]);
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

  await page.getByRole("button", { name: "プレビュー", exact: true }).click();
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
  await expect(page.locator(".st-desktop-status")).toHaveCSS("position", "relative");
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

  // Close the persistent problem disclosure before resuming the interrupted route.
  // Dismissal does not claim that the protection problem has been resolved.
  const mobileProblems = page.locator(".mobile-shell-status .application-status");
  if (await mobileProblems.getAttribute("open") !== null) await mobileProblems.locator("summary").click();

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
  await expect(page.locator(".mobile-shell-status")).toHaveCSS("position", "relative");
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
    if (mode === "mobile") await page.locator(".st-workspace-configuration > summary").click();
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


// S-A02/05/12/14: production bundles and real journal/Core/Git, isolated generated work.
test("UX canon keeps the manuscript visible and stable through checkpoint responses", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");
  const editor = page.locator(".cm-content");
  const text = "夜明けの港で、|灯台《とうだい》を見上げた。\n「続きを、ここから書こう。」\n".repeat(2);
  await editor.fill(text);
  await expectJournalDraft(page, "scene-1", text);
  // Preserve the actual DOM node and CodeMirror history across background status updates.
  await editor.evaluate((element) => { element.setAttribute("data-ux-editor", "original"); });
  const before = await editor.boundingBox();
  expect(before).not.toBeNull();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let admitted!: () => void;
  const admission = new Promise<void>((resolve) => { admitted = resolve; });
  await page.route("**/checkpoints", async (route) => { admitted(); await delayed; await route.continue(); });
  try {
    await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
    await admission;
    await expect(page.locator(".durability-message")).toContainText("結果を確認");
    expect(await editor.getAttribute("data-ux-editor")).toBe("original");
    expect((await editor.boundingBox())!.y).toBe(before!.y);
    await editor.press("Control+End");
    await page.keyboard.insertText("後続入力を保存済みにしない。");
    await expectJournalDraft(page, "scene-1", text + "後続入力を保存済みにしない。");
    await page.screenshot({ path: testInfo.outputPath("checkpoint-delayed.png") });
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "Save to GitHub", exact: true })).toBeEnabled();
  expect(await editor.getAttribute("data-ux-editor")).toBe("original");
  expect((await editor.boundingBox())!.y).toBe(before!.y);
  await page.getByRole("button", { name: "Save to GitHub", exact: true }).click();
  await expect(page.locator(".durability-message")).toContainText("下書きはこのブラウザー");
  await expect(editor).toContainText("後続入力を保存済みにしない。");
  await editor.press("Control+z");
  await expect(editor).not.toContainText("後続入力を保存済みにしない。");
});

test("UX canon puts Japanese prose before optional chrome at every shell width", async ({ page }, testInfo) => {
  await signIn(page, "mobile");
  await openFixtureScene(page, "mobile");
  const editor = page.locator(".cm-content");
  await editor.fill("夜明けの港で、|灯台《とうだい》を見上げた。\n「物語の続きを書こう。」\n".repeat(40));
  await editor.evaluate((element) => element.setAttribute("data-ux-editor", "original"));
  for (const width of [320, 375, 390, 430, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(async () => {
      for (const element of document.querySelectorAll("*")) element.scrollTop = 0;
      const content = document.querySelector("ion-content") as HTMLElement & { getScrollElement(): Promise<HTMLElement> };
      (await content.getScrollElement()).scrollTop = 0;
    });
    const bounds = await editor.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y, `manuscript starts above fold at ${width}px`).toBeLessThan(560);
    expect(bounds!.width).toBeGreaterThan(width < 500 ? width * 0.7 : 400);
    expect(await page.locator(".mobile-shell").count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await editor.getAttribute("data-ux-editor")).toBe("original");
    await page.screenshot({ path: testInfo.outputPath(`mobile-${width}.png`) });
  }
  await page.getByRole("button", { name: "構成を参照", exact: true }).click();
  const sheet = page.locator("ion-modal.mobile-shell-reference-modal");
  await expect(sheet.getByRole("heading", { name: "原稿の参照" })).toBeVisible();
  await sheet.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(await editor.getAttribute("data-ux-editor")).toBe("original");
  await expect(page.getByRole("button", { name: "構成を参照", exact: true })).toBeFocused();
});


test("UX canon preserves focus and recovery when journal storage fails and returns", async ({ page }) => {
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    Object.assign(window, { uxDenyJournal: true });
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
      if (this.name === "operations" && value && typeof value === "object" && "text" in value && value.text === "保存先が戻るまで、この文章とUndoを失わない。" && Reflect.get(window, "uxDenyJournal")) throw new DOMException("Synthetic quota", "QuotaExceededError");
      return key === undefined ? put.call(this, value) : put.call(this, value, key);
    };
  });
  const editor = page.locator(".cm-content");
  const text = "保存先が戻るまで、この文章とUndoを失わない。";
  await editor.fill(text);
  await expect(page.locator(".application-status[data-attention]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Checkpoint", exact: true })).toBeDisabled();
  await expect(editor).toBeFocused();
  await expect(page.locator(".editor-protection > summary")).toContainText("保存要確認");
  const before = await editor.boundingBox();
  // Dismissing the notification never clears the storage failure.
  await page.locator(".st-desktop-status .application-status > summary").click();
  await expect(page.locator(".st-desktop-status .application-status > summary")).toContainText("要確認");
  await expect(page.locator(".editor-protection > summary")).toContainText("保存要確認");
  expect((await editor.boundingBox())!.y).toBe(before!.y);
  await page.evaluate(() => Reflect.set(window, "uxDenyJournal", false));
  if (await page.locator(".editor-protection").getAttribute("open") === null) await page.locator(".editor-protection > summary").click();
  await page.getByRole("button", { name: "ブラウザーへの記録を再試行" }).click();
  await expectJournalDraft(page, "scene-1", text);
  await expect(page.locator(".editor-protection > summary")).toContainText("このブラウザーに保護済み");
  await expect(page.getByRole("button", { name: "Checkpoint", exact: true })).toBeEnabled();
  await expect(editor).toHaveText(text);
});

test("UX canon keeps explicit shells usable with long Japanese titles and enlarged text", async ({ page }, testInfo) => {
  await page.route("**/scenes/scene-1/views?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.remote.scene.title = "夜明けの港と名もない旅人の長い物語".repeat(6);
    body.effective.scene.title = body.remote.scene.title;
    await route.fulfill({ response, json: body });
  });
  await signIn(page, "desktop");
  // Open directly through the outline; this fixture changes presentation only.
  const existing = page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true });
  if (await existing.isVisible().catch(() => false)) await existing.click();
  else {
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(repositoryUrl));
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
  }
  await page.getByRole("button", { name: "Chapter One: Scene One", exact: true }).click();
  const editor = page.locator(".cm-content[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.fill("彼は|東京《とうきょう》へ向かった。括弧（と句読点）、ABC 123。\n".repeat(100));
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [1440, 1920, 640]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator(".st-desktop-shell").count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole("button", { name: "Checkpoint", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`desktop-long-${width}.png`) });
  }
  // 200% text size, preserving the explicit Desktop route and recovery identity.
  await page.locator(".typography-settings > summary").click();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await page.locator(".st-desktop-shell").count()).toBe(1);
  await expect(editor).toContainText("東京");
  await expect(page.getByRole("button", { name: "文字を大きく" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-text-200.png") });
});

// Lifecycle events are synthetic; this verifies optional work ownership, not OS input.
test("optional terminology cancels work at pagehide and resumes at pageshow", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_PROFILE !== "full", "Terminology is an optional Full contribution.");
  await signIn(page, "desktop");
  await openFixtureScene(page, "desktop");
  const editor = page.locator(".cm-content[contenteditable=true]");
  await expect(editor).toBeVisible();
  await editor.evaluate((element) => element.setAttribute("data-lifecycle-editor", "retained"));
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    Object.assign(window, { uxTermStarted: 0, uxTermAborted: 0 });
    window.fetch = function(input, init) {
      if (String(input).endsWith("/actions/search.terms.resolve")) {
        Reflect.set(window, "uxTermStarted", Number(Reflect.get(window, "uxTermStarted")) + 1);
        init?.signal?.addEventListener("abort", () => {
          Reflect.set(window, "uxTermAborted", Number(Reflect.get(window, "uxTermAborted")) + 1);
        }, { once: true });
      }
      return originalFetch.call(window, input, init);
    };
  });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/actions/search.terms.resolve", async (route) => {
    await delayed;
    await route.continue().catch(() => undefined); // The old document may already have cancelled this request.
  });
  const draft = "ページを離れても、この下書きと編集状態は失わない。";
  try {
    await editor.fill(draft);
    await expect.poll(() => page.evaluate(() => Number(Reflect.get(window, "uxTermStarted")))).toBeGreaterThan(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await expect.poll(() => page.evaluate(() => Number(Reflect.get(window, "uxTermAborted")))).toBeGreaterThan(0);
    const pausedCount = await page.evaluate(() => Number(Reflect.get(window, "uxTermStarted")));
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(160); // Two existing 80ms adornment scheduling windows.
    expect(await page.evaluate(() => Number(Reflect.get(window, "uxTermStarted")))).toBe(pausedCount);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => page.evaluate(() => Number(Reflect.get(window, "uxTermStarted")))).toBeGreaterThan(pausedCount);
    await expect(editor).toHaveText(draft);
    expect(await editor.getAttribute("data-lifecycle-editor")).toBe("retained");
    await expectJournalDraft(page, "scene-1", draft);
  } finally {
    release();
  }
});
