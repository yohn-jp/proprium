import { expect, test, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";

interface JournalDraft {
  sceneId: string;
  state: string;
  text: string;
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
  await expect(page.getByRole("heading", { name: sceneId === "scene-1" ? "Scene One" : "Scene Two" })).toBeVisible();
  if (mode === "mobile") {
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
  }
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
  expect(await page.locator("script[src]").evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src)))
    .toContain(new URL("/mobile/main.js", page.url()).toString());
  expect(await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href)))
    .toContain(new URL("/mobile/styles.css", page.url()).toString());

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
  await expect(mobileEditor).toHaveText(composedDraft);
  await expectJournalDraft(page, "scene-1", composedDraft);

  await page.getByRole("button", { name: "縦書き", exact: true }).click();
  await expect(page.locator(".manuscript-preview.is-vertical")).toBeVisible();
  await page.getByRole("button", { name: "読書モード", exact: true }).click();
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
  await page.mouse.move(pagerBox!.x + pagerBox!.width * 0.8, pagerBox!.y + pagerBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(pagerBox!.x + pagerBox!.width * 0.2, pagerBox!.y + pagerBox!.height / 2, { steps: 5 });
  await page.mouse.up();
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

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await assertNoHorizontalOverflow(page);
    await expect(page.getByRole("navigation", { name: "モバイル画面" })).toBeVisible();
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await mobileEditor.scrollIntoViewIfNeeded();
  await expect(mobileEditor).toBeInViewport();
  await mobileEditor.focus();
  await page.keyboard.insertText(" 入力欄を表示");
  const beforeFailedSwitch = longReadingDraft + " 入力欄を表示";
  await expect(mobileEditor).toHaveText(beforeFailedSwitch);
  await expectJournalDraft(page, "scene-1", beforeFailedSwitch);
  await assertNoHorizontalOverflow(page);

  await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "設定", exact: true }).click();
  await page.evaluate(() => {
    localStorage.setItem("scriptorium:e2e:fail-journal", "1");
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      if (this.transaction.db.name === "scriptorium-recovery" && this.name === "operations" && localStorage.getItem("scriptorium:e2e:fail-journal") === "1") {
        throw new DOMException("Synthetic quota limit", "QuotaExceededError");
      }
      return originalPut.call(this, value, key);
    };
  });
  await page.getByRole("button", { name: "Desktop版へ切り替え" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-1"));
  await expect(mobileEditor).toHaveText(beforeFailedSwitch);
  await page.evaluate(() => localStorage.removeItem("scriptorium:e2e:fail-journal"));

  await page.getByRole("button", { name: "Desktop版へ切り替え" }).click();
  await expect(page).toHaveURL(new RegExp("/desktop/projects/.+/scenes/scene-1"));
  const desktopEditor = page.locator(".cm-content");
  await expect(desktopEditor).toHaveText(beforeFailedSwitch);
  const desktopAppearance = page.getByLabel("外観");
  for (const mode of ["dark", "paper", "light"] as const) {
    await desktopAppearance.selectOption(mode);
    await expect(page.locator("html")).toHaveAttribute("data-zp-theme", mode);
  }
  await expectJournalDraft(page, "scene-1", beforeFailedSwitch);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("desktop");
  expect(await page.locator("script[src]").evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).src)))
    .toContain(new URL("/desktop/main.js", page.url()).toString());
  expect(await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => (link as HTMLLinkElement).href)))
    .toContain(new URL("/desktop/styles.css", page.url()).toString());

  const resizeHandle = page.getByRole("separator", { name: "作品パネルと原稿パネルの幅を変更" });
  await expect(resizeHandle).toBeVisible();
  const navigationPanel = page.locator(".st-desktop-navigation-panel");
  const beforeResize = (await navigationPanel.boundingBox())?.width;
  await resizeHandle.focus();
  await page.keyboard.press("ArrowRight");
  const afterResize = (await navigationPanel.boundingBox())?.width;
  expect(beforeResize).toBeTruthy();
  expect(afterResize).toBeTruthy();
  expect(afterResize).not.toBe(beforeResize);

  const desktopDraft = "Desktop draft with 日本語 and ruby |風《かぜ》。";
  await desktopEditor.fill(desktopDraft);
  await expectJournalDraft(page, "scene-1", desktopDraft);
  await desktopEditor.press("Control+z");
  await expect(desktopEditor).toHaveText(beforeFailedSwitch);
  await desktopEditor.press("Control+Shift+z");
  await expect(desktopEditor).toHaveText(desktopDraft);
  await expect(page.locator(".manuscript-preview rt")).toContainText("かぜ");

  await page.getByRole("button", { name: "モバイルUIへ" }).click();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-1"));
  await expect(page.locator(".cm-content")).toHaveText(desktopDraft);
  await expectJournalDraft(page, "scene-1", desktopDraft);
  await page.reload();
  await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-1"));
  await expect(page.locator(".cm-content")).toHaveText(desktopDraft);
  await expect(page.getByLabel("外観")).toHaveValue("light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("scriptorium:ui-mode"))).toBe("mobile");

  const health = await page.request.get(new URL("/api/health", page.url()).toString());
  expect(health.status()).toBe(200);
  const unknownApi = await page.request.get(new URL("/api/ui-v1-not-found", page.url()).toString());
  expect(unknownApi.status()).toBe(404);
  expect(unknownApi.headers()["content-type"]).toContain("application/json");
  expect(pageErrors, testInfo.project.name + " runtime errors").toEqual([]);
  expect(cspErrors, testInfo.project.name + " CSP errors").toEqual([]);
  expect(failedAssets, testInfo.project.name + " failed JS/CSS requests").toEqual([]);
});

test("profile-selected contributions stay discoverable and mount one at a time in both Shells", async ({ page }, testInfo) => {
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
    expect(enabledIds).toEqual(["assistant", "diagnostics", "mcp", "nlp", "publishing", "semantic", "speaker", "story"]);
  }

  const enabledSet = new Set(enabledIds);
  const expectedContributions = contributions.filter((item) => enabledSet.has(item.module));
  expect(contributions.some((item) => item.module === "mcp")).toBe(false);
  expect(new Set(expectedContributions.map((item) => item.id)).size).toBe(expectedContributions.length);

  const mountedByShell: Record<string, string[]> = {};
  for (const mode of ["desktop", "mobile"] as const) {
    if (mode === "mobile") {
      await page.getByRole("button", { name: "モバイルUIへ" }).click();
      await expect(page).toHaveURL(new RegExp("/mobile/projects/.+/scenes/scene-1"));
    }
    const mounted: string[] = [];
    const editorItems = expectedContributions.filter((item) => item.slot === "editor");
    if (mode === "mobile") {
      await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "書く", exact: true }).click();
    }
    for (const item of editorItems) {
      const selector = page.locator(".contribution-host-editor").getByLabel("機能を選択");
      await expect(selector.locator('option[value="' + item.id + '"]')).toHaveCount(1);
      await selector.selectOption(item.id);
      await expect(page.locator('[data-contribution="' + item.id + '"]')).toBeVisible();
      mounted.push(item.id);
      await selector.selectOption("");
      await expect(page.locator('[data-contribution="' + item.id + '"]')).toHaveCount(0);
    }

    const otherItems = expectedContributions.filter((item) => item.slot !== "editor");
    if (mode === "mobile") {
      await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "道具", exact: true }).click();
    } else {
      await page.getByRole("tab", { name: "ツールと履歴" }).click();
    }
    for (const item of otherItems) {
      const selector = page.locator(".contribution-host-" + item.slot).getByLabel("機能を選択");
      await expect(selector.locator('option[value="' + item.id + '"]')).toHaveCount(1);
      await selector.selectOption(item.id);
      await expect(page.locator('[data-contribution="' + item.id + '"]')).toBeVisible();
      mounted.push(item.id);
      await selector.selectOption("");
      await expect(page.locator('[data-contribution="' + item.id + '"]')).toHaveCount(0);
    }
    expect(mounted.sort()).toEqual(expectedContributions.map((item) => item.id).sort());
    expect(await page.locator("[data-contribution]").count()).toBe(0);
    mountedByShell[mode] = mounted;
  }
  expect(mountedByShell.mobile.sort()).toEqual(mountedByShell.desktop.sort());

  if (enabledIds.length === 0) {
    await page.getByRole("button", { name: "モバイルUIへ" }).click();
    await page.getByRole("navigation", { name: "モバイル画面" }).getByRole("button", { name: "道具", exact: true }).click();
    await expect(page.locator(".contribution-host")).toHaveCount(0);
  }
});
