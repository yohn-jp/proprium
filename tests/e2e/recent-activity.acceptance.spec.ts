import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const defaultRepository = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";
const configuredBaseURL = process.env.SCRIPTORIUM_E2E_BASE_URL ?? process.env.SCRIPTORIUM_BASE_URL ??
  `http://127.0.0.1:${process.env.SCRIPTORIUM_E2E_PORT ?? "4173"}`;

function repositoryInputValue(value: string): string {
  return value.startsWith("https://") || value.startsWith("file://") ? value : pathToFileURL(value).href;
}

function normalizedRepository(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return fileURLToPath(url);
  } catch {
    // Local development repositories are stored by Core as normalized filesystem paths.
  }
  return value;
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
  await page.goto(new URL("/desktop/", configuredBaseURL).toString());
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
}

async function openProject(page: Page, repository: string): Promise<string> {
  const label = projectLabel(repositoryInputValue(repository));
  const projectButton = page.getByRole("button", { name: label, exact: true });
  if (await projectButton.isVisible().catch(() => false)) await projectButton.click();
  else {
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(repository));
    const registrationResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname === "/api/projects";
    });
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
    const response = await registrationResponse;
    expect(response.ok(), "the synthetic repository registration should complete before it is looked up").toBe(true);
  }
  const projectsResponse = await page.request.get(new URL("/api/projects", page.url()).toString());
  expect(projectsResponse.ok()).toBe(true);
  const projects = await projectsResponse.json() as Array<{ id: string; url: string }>;
  const expectedRepository = normalizedRepository(repositoryInputValue(repository));
  const project = projects.find((item) => normalizedRepository(item.url) === expectedRepository);
  if (!project) throw new Error(`The registered acceptance project is missing from the owner API (expected ${expectedRepository}; received ${projects.map((item) => normalizedRepository(item.url)).join(", ") || "no projects"}).`);
  return project.id;
}

async function cursorOffset(page: Page): Promise<{ offset: number; length: number } | null> {
  return page.locator(".cm-content").evaluate((element) => {
    const selection = window.getSelection();
    if (!selection?.anchorNode || !element.contains(selection.anchorNode)) return null;
    const lines = Array.from(element.querySelectorAll<HTMLElement>(".cm-line"));
    let base = 0;
    for (const line of lines) {
      if (line.contains(selection.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(line);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        const offset = base + range.toString().length;
        const length = lines.map((item) => item.textContent ?? "").join("\n").length;
        return { offset, length };
      }
      base += (line.textContent ?? "").length + 1;
    }
    return null;
  });
}

async function selectScene(page: Page, label = "Chapter One: Scene One"): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function makeLongReadingRepository(repetitionCount = 160): Promise<{ root: string; remote: string }> {
  const root = await mkdtemp(join(tmpdir(), "scriptorium-recent-activity-"));
  const remote = join(root, "reading.git");
  const working = join(root, "seed");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Scriptorium Recent Activity Acceptance",
      GIT_AUTHOR_EMAIL: "recent-activity@example.invalid",
      GIT_COMMITTER_NAME: "Scriptorium Recent Activity Acceptance",
      GIT_COMMITTER_EMAIL: "recent-activity@example.invalid",
    },
  });
  await mkdir(join(working, "plot/volumes/vol-1/chapters/ch-1/scenes"), { recursive: true });
  await mkdir(join(working, "manuscript/vol-1/ch-1"), { recursive: true });
  await writeFile(join(working, "plot/volumes/vol-1/volume.yaml"), "id: vol-1\ntitle: Volume One\n", "utf8");
  await writeFile(join(working, "plot/volumes/vol-1/chapters/ch-1/chapter.yaml"), "id: ch-1\nvolume: vol-1\ntitle: Chapter One\n", "utf8");
  const body = "# Scene One\n\n" + "読書位置を別の端末へ引き継ぐための文章です。\n\n".repeat(repetitionCount);
  await writeFile(join(working, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml"),
    "id: scene-1\ntitle: Scene One\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-1.md\n", "utf8");
  await writeFile(join(working, "manuscript/vol-1/ch-1/scene-1.md"), body, "utf8");
  await writeFile(join(working, "plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml"),
    "id: scene-2\ntitle: Scene Two\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-2.md\n", "utf8");
  await writeFile(join(working, "manuscript/vol-1/ch-1/scene-2.md"), "# Scene Two\n\n別の作品の再開位置。\n", "utf8");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(working, "init", "--initial-branch=main");
  git(working, "add", ".");
  git(working, "commit", "-m", "Add recent activity acceptance manuscript");
  git(working, "remote", "add", "origin", remote);
  git(working, "push", "--set-upstream", "origin", "main");
  return { root, remote };
}

async function createContext(browser: Browser, width: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, ...(width <= 640 ? { isMobile: true, hasTouch: true } : {}) });
  return { context, page: await context.newPage() };
}

async function unusedTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port for Chromium CDP");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function stopBrowserProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000))]);
}

async function createNativeHeadfulContext(width: number): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}> {
  const executable = process.env.SCRIPTORIUM_E2E_CHROMIUM;
  if (!executable) throw new Error("Native visibility coverage requires SCRIPTORIUM_E2E_CHROMIUM");
  const profile = await mkdtemp(join(tmpdir(), "scriptorium-native-chromium-"));
  const port = await unusedTcpPort();
  const child = spawn(executable, [
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    "about:blank",
  ], { env: process.env, stdio: "ignore" });
  let browser: Browser | null = null;
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });

  try {
    const deadline = Date.now() + 10_000;
    let endpointReady = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Native Chromium exited before CDP was ready (code ${child.exitCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          endpointReady = true;
          break;
        }
      } catch { /* Wait briefly for the local CDP endpoint. */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!endpointReady) throw new Error("Native Chromium CDP endpoint did not start within 10 seconds");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Native Chromium did not expose its default browser context");
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    return {
      browser,
      context,
      page,
      close: async () => {
        await browser?.close().catch(() => undefined);
        await stopBrowserProcess(child);
        await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stopBrowserProcess(child);
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    throw error;
  }
}

function requireNativeVisibilityCoverage(): void {
  const missing = [
    process.env.SCRIPTORIUM_E2E_NATIVE_VISIBILITY === "1" ? "" : "SCRIPTORIUM_E2E_NATIVE_VISIBILITY=1",
    process.env.DISPLAY ? "" : "DISPLAY",
    process.env.SCRIPTORIUM_E2E_CHROMIUM ? "" : "SCRIPTORIUM_E2E_CHROMIUM",
  ].filter(Boolean);
  if (missing.length === 0) return;
  test.info().annotations.push({
    type: "c39-natural-visibility",
    description: `NOT_CHECKED: native headful coverage requires ${missing.join(", ")}.`,
  });
  test.skip(true, "NOT_CHECKED: native headful visibility environment is not configured.");
}

test("recent activity hands off only numeric positions across devices, projects, and API restart", async ({ browser }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This acceptance creates a disposable local Git repository for paged reader coverage.");
  const fixture = await makeLongReadingRepository();
  const secondFixture = await makeLongReadingRepository();
  const ownerDesktop = await createContext(browser, 1280);
  const ownerMobile = await createContext(browser, 390);
  const readerMobile = await createContext(browser, 390);
  const anonymous = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const positionWrites: unknown[] = [];
  const manuscriptMutationPaths: string[] = [];
  const capture = (page: Page) => {
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/recent-activity") && request.method() === "PUT") {
        try { positionWrites.push(request.postDataJSON()); } catch { positionWrites.push(request.postData()); }
      }
      if (/\/api\/projects\/[^/]+\/(?:proposals|approvals|checkpoints|publish)(?:\/|$)/u.test(url.pathname) && request.method() !== "GET") {
        manuscriptMutationPaths.push(`${request.method()} ${url.pathname}`);
      }
    });
  };
  capture(ownerDesktop.page);
  capture(ownerMobile.page);
  capture(readerMobile.page);
  let primaryProjectId: string | null = null;
  let secondProjectId: string | null = null;
  let postRestartReader: { context: BrowserContext; page: Page } | null = null;
  let contextsClosed = false;
  try {
    await signIn(ownerDesktop.page);
    primaryProjectId = await openProject(ownerDesktop.page, fixture.remote);
    await selectScene(ownerDesktop.page);
    await ownerDesktop.page.locator(".cm-content").focus();
    await ownerDesktop.page.locator(".cm-content").press("Control+End");
    const firstActivity = ownerDesktop.page.waitForResponse((response) =>
      response.url().includes(`/api/projects/${encodeURIComponent(primaryProjectId!)}/recent-activity`) && response.request().method() === "PUT");
    const desktopWrite = await firstActivity;
    expect(desktopWrite.ok()).toBe(true);
    const desktopActivity = await desktopWrite.json() as { items: Array<{ sceneId: string; sentenceOffset: number | null; deviceType: string; pageIndex?: number | null }> };
    const desktopCursor = desktopActivity.items.find((item) => item.sceneId === "scene-1" && item.deviceType === "desktop")?.sentenceOffset;
    expect(Number.isSafeInteger(desktopCursor) && (desktopCursor ?? 0) > 1).toBe(true);

    // Local resume must restore the real CodeMirror scroll DOM together with its cursor.
    const scrollStyleInjected = await ownerDesktop.page.evaluate(() => {
      const nonce = document.querySelector<HTMLMetaElement>('meta[name="scriptorium-style-nonce"]')?.content;
      if (!nonce || nonce === "__SCRIPTORIUM_STYLE_NONCE__") return false;
      const style = document.createElement("style");
      style.nonce = nonce;
      style.textContent = ".cm-editor .cm-scroller { height: 400px !important; overflow-y: auto !important; }";
      document.head.append(style);
      return true;
    });
    expect(scrollStyleInjected).toBe(true);
    const desktopScroller = ownerDesktop.page.locator(".cm-editor .cm-scroller").first();
    const requestedScrollTop = await desktopScroller.evaluate((element) => {
      const maximum = element.scrollHeight - element.clientHeight;
      if (maximum <= 0) return { maximum, actual: element.scrollTop };
      element.scrollTop = Math.max(1, maximum - Math.min(120, maximum / 2));
      return {
        maximum,
        actual: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        lineCount: element.querySelectorAll(".cm-line").length,
      };
    });
    expect(requestedScrollTop.maximum, `CodeMirror scroller did not overflow: ${JSON.stringify(requestedScrollTop)}`).toBeGreaterThan(0);
    expect(requestedScrollTop.actual).toBeGreaterThan(0);
    await expect.poll(async () => ownerDesktop.page.evaluate(() => {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key?.startsWith("scriptorium:writing-resume:")) continue;
        try {
          const record = JSON.parse(localStorage.getItem(key) ?? "null") as { sceneId?: string; scrollTop?: number } | null;
          if (record?.sceneId === "scene-1") return record.scrollTop ?? null;
        } catch { /* Ignore unrelated malformed local state. */ }
      }
      return null;
    })).toBe(requestedScrollTop.actual);
    await ownerDesktop.page.getByRole("button", { name: "続きを書く", exact: true }).click();
    await expect(ownerDesktop.page.locator(".cm-content")).toBeVisible();
    await expect.poll(() => desktopScroller.evaluate((element) => element.scrollTop)).toBe(requestedScrollTop.actual);
    const localRestoreCursor = await cursorOffset(ownerDesktop.page);
    expect(localRestoreCursor).not.toBeNull();
    expect(localRestoreCursor?.offset).toBe(localRestoreCursor?.length);

    await signIn(ownerMobile.page);
    const mobilePrimary = ownerMobile.page.getByRole("button", { name: projectLabel(fixture.remote), exact: true });
    await mobilePrimary.click();
    await expect(ownerMobile.page.getByRole("navigation", { name: "作品構成" }).getByRole("heading", { name: "Volume One" })).toBeVisible();
    await expect(ownerMobile.page.getByText(/PCで.*編集していました/u)).toBeVisible();
    await ownerMobile.page.getByRole("button", { name: "続きを書く", exact: true }).click();
    await expect(ownerMobile.page.locator(".cm-content")).toBeVisible();
    const firstText = await cursorOffset(ownerMobile.page);
    expect(firstText).not.toBeNull();
    expect(firstText?.offset).toBe(firstText?.length);

    // This mobile cursor is newer remotely; this browser's local desktop position remains preferred.
    await ownerMobile.page.locator(".cm-content").focus();
    await ownerMobile.page.locator(".cm-content").press("Control+Home");
    await expect.poll(async () => {
      const response = await ownerMobile.page.request.get(new URL(`/api/projects/${encodeURIComponent(primaryProjectId!)}/recent-activity`, ownerMobile.page.url()).toString());
      if (!response.ok()) return null;
      const data = await response.json() as { items: Array<{ sceneId: string; sentenceOffset: number | null; deviceType: string }> };
      return data.items.find((item) => item.deviceType === "mobile")?.sentenceOffset;
    }).toBe(1);
    await ownerDesktop.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await ownerDesktop.page.getByRole("button", { name: "続きを書く", exact: true }).click();
    const desktopRestored = await cursorOffset(ownerDesktop.page);
    expect(desktopRestored).not.toBeNull();
    expect(desktopRestored?.offset).toBe(desktopRestored?.length);

    await ownerMobile.page.getByRole("button", { name: "読書モード" }).click();
    const mobilePager = ownerMobile.page.locator(".reading-pager");
    await expect.poll(async () => Number(await mobilePager.getAttribute("data-page-count"))).toBeGreaterThan(1);
    await ownerMobile.page.getByRole("button", { name: "次のページ" }).click();
    await expect(mobilePager).toHaveAttribute("data-page-index", "1");
    await expect.poll(async () => {
      const response = await ownerMobile.page.request.get(new URL(`/api/projects/${encodeURIComponent(primaryProjectId!)}/recent-activity`, ownerMobile.page.url()).toString());
      if (!response.ok()) return null;
      const data = await response.json() as { items: Array<{ deviceType: string; pageIndex?: number | null }> };
      return data.items.find((item) => item.deviceType === "mobile")?.pageIndex;
    }).toBe(1);

    await ownerMobile.page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(secondFixture.remote));
    await ownerMobile.page.getByRole("button", { name: "リポジトリを登録" }).click();
    await expect(ownerMobile.page.getByRole("navigation", { name: "作品構成" }).getByRole("heading", { name: "Volume One" })).toBeVisible();
    await expect.poll(async () => {
      const response = await ownerMobile.page.request.get(new URL("/api/projects", ownerMobile.page.url()).toString());
      if (!response.ok()) return false;
      const projects = await response.json() as Array<{ id: string; url: string }>;
      return projects.some((item) => item.url.includes(secondFixture.root));
    }).toBe(true);
    const listedProjects = await ownerMobile.page.request.get(new URL("/api/projects", ownerMobile.page.url()).toString());
    const projects = await listedProjects.json() as Array<{ id: string; url: string }>;
    secondProjectId = projects.find((item) => item.url.includes(secondFixture.root))?.id ?? null;
    if (!secondProjectId) throw new Error("The second acceptance project was not registered.");
    await expect(ownerMobile.page.getByRole("region", { name: "選択中のリポジトリ" }).getByText(secondFixture.remote, { exact: true })).toBeVisible();
    await selectScene(ownerMobile.page);
    await ownerMobile.page.locator(".cm-content").focus();
    await ownerMobile.page.locator(".cm-content").press("Control+End");
    await expect.poll(async () => {
      const response = await ownerMobile.page.request.get(new URL(`/api/projects/${encodeURIComponent(secondProjectId!)}/recent-activity`, ownerMobile.page.url()).toString());
      if (!response.ok()) return null;
      const data = await response.json() as { items: Array<{ sceneId: string; deviceType: string; sentenceOffset: number | null }> };
      return data.items.find((item) => item.deviceType === "mobile")?.sceneId;
    }).toBe("scene-1");

    const primaryActivityResponse = await ownerDesktop.page.request.get(new URL(`/api/projects/${encodeURIComponent(primaryProjectId)}/recent-activity`, ownerDesktop.page.url()).toString());
    expect(primaryActivityResponse.ok()).toBe(true);
    const primaryActivity = await primaryActivityResponse.json() as { items: Array<{ sceneId: string; deviceType: string; pageIndex?: number | null }> };
    expect(primaryActivity.items).toHaveLength(2);
    expect(primaryActivity.items.some((item) => item.sceneId === "scene-1" && item.deviceType === "desktop")).toBe(true);
    expect(primaryActivity.items.some((item) => item.sceneId === "scene-1" && item.deviceType === "mobile")).toBe(true);

    await signIn(readerMobile.page);
    await readerMobile.page.getByRole("button", { name: projectLabel(fixture.remote), exact: true }).click();
    await expect(readerMobile.page.getByRole("heading", { name: "Volume One" })).toBeVisible();
    await readerMobile.page.getByRole("button", { name: "読書位置を開く", exact: true }).click();
    await expect(readerMobile.page.getByRole("document", { name: "読書モード" })).toBeVisible();
    const pager = readerMobile.page.locator(".reading-pager");
    await expect.poll(async () => Number(await pager.getAttribute("data-page-count"))).toBeGreaterThan(1);
    await expect(readerMobile.page.locator(".reading-page-count")).toHaveText(/2 \/ [2-9]\d*/u);

    const anonymousResponse = await anonymous.request.get(new URL(`/api/projects/${encodeURIComponent(primaryProjectId)}/recent-activity`, ownerDesktop.page.url()).toString());
    expect(anonymousResponse.status()).toBe(401);
    const primaryActivityKeys = primaryActivity.items.map((item) => `${item.deviceType}:${item.sceneId}`).sort();
    const otherActivityResponse = await ownerMobile.page.request.get(new URL(`/api/projects/${encodeURIComponent(secondProjectId)}/recent-activity`, ownerMobile.page.url()).toString());
    expect(otherActivityResponse.ok()).toBe(true);
    const otherActivity = await otherActivityResponse.json() as { items: Array<{ sceneId: string; deviceType: string; pageIndex?: number | null }> };
    expect(otherActivity.items).toHaveLength(1);
    expect(otherActivity.items[0]).toMatchObject({ sceneId: "scene-1", deviceType: "mobile" });
    expect(otherActivity.items[0]?.pageIndex ?? null).toBeNull();
    expect(otherActivity.items.map((item) => `${item.deviceType}:${item.sceneId}`).sort()).not.toEqual(primaryActivityKeys);

    const origin = new URL(readerMobile.page.url()).origin;
    await Promise.all([ownerDesktop, ownerMobile, readerMobile].map(({ page }) => page.goto("about:blank")));
    await Promise.all([ownerDesktop, ownerMobile, readerMobile].map(({ context }) => context.close()));
    contextsClosed = true;
    const controlPort = Number.parseInt(process.env.SCRIPTORIUM_E2E_PORT ?? "4173", 10) + 1;
    const restart = await fetch(`http://127.0.0.1:${controlPort}/__e2e/restart-api`, { method: "POST" });
    expect(restart.status).toBe(204);
    postRestartReader = await createContext(browser, 390);
    await signIn(postRestartReader.page);
    const afterRestart = await postRestartReader.page.request.get(new URL(`/api/projects/${encodeURIComponent(primaryProjectId)}/recent-activity`, postRestartReader.page.url()).toString());
    expect(afterRestart.ok()).toBe(true);
    const restartedActivity = await afterRestart.json() as { items: Array<{ sceneId: string; deviceType: string; pageIndex?: number | null }> };
    expect(restartedActivity.items.some((item) => item.sceneId === "scene-1" && item.deviceType === "mobile" && item.pageIndex === 1)).toBe(true);

    expect(positionWrites.length).toBeGreaterThanOrEqual(3);
    for (const input of positionWrites) {
      expect(input).toEqual(expect.objectContaining({ sceneId: expect.any(String), deviceType: expect.stringMatching(/^(desktop|mobile)$/u) }));
      const sentenceOffset = (input as { sentenceOffset?: unknown }).sentenceOffset;
      expect(sentenceOffset === null || (typeof sentenceOffset === "number" && Number.isSafeInteger(sentenceOffset))).toBe(true);
      expect(Object.keys(input as object).every((key) => ["sceneId", "sentenceOffset", "pageIndex", "deviceType"].includes(key))).toBe(true);
      expect(JSON.stringify(input)).not.toMatch(/読書位置|物語|本文|原稿|Scene One/u);
    }
    expect(manuscriptMutationPaths).toEqual([]);

    const detach = await postRestartReader.page.request.delete(new URL(`/api/projects/${encodeURIComponent(secondProjectId)}`, origin).toString(), {
      headers: { origin },
    });
    expect(detach.status()).toBe(204);
    const removePrimary = await postRestartReader.page.request.delete(new URL(`/api/projects/${encodeURIComponent(primaryProjectId)}`, origin).toString(), {
      headers: { origin },
    });
    expect(removePrimary.status()).toBe(204);
  } finally {
    const configuredBase = process.env.SCRIPTORIUM_E2E_BASE_URL ?? process.env.SCRIPTORIUM_BASE_URL ??
      `http://127.0.0.1:${process.env.SCRIPTORIUM_E2E_PORT ?? "4173"}`;
    const cleanupOrigin = new URL(configuredBase).origin;
    for (const projectId of [secondProjectId, primaryProjectId]) {
      if (!projectId) continue;
      await (postRestartReader?.page ?? ownerDesktop.page).request.delete(new URL(`/api/projects/${encodeURIComponent(projectId)}`, cleanupOrigin).toString(), {
        headers: { origin: cleanupOrigin },
      }).catch(() => undefined);
    }
    if (!contextsClosed) {
      await ownerDesktop.context.close();
      await ownerMobile.context.close();
      await readerMobile.context.close();
    }
    await postRestartReader?.context.close();
    await anonymous.close();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(secondFixture.root, { recursive: true, force: true });
  }
});

test("recent activity polling pauses while naturally hidden and resumes when visible", async () => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This visibility acceptance uses a disposable local Git fixture.");
  requireNativeVisibilityCoverage();
  const fixture = await makeLongReadingRepository();
  const native = await createNativeHeadfulContext(1280);
  const { context, page } = native;
  let projectId: string | null = null;
  let background: Page | undefined;
  let recentActivityGets = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/recent-activity")) recentActivityGets += 1;
  });

  try {
    await signIn(page);
    projectId = await openProject(page, fixture.remote);
    await selectScene(page);
    await expect.poll(() => recentActivityGets).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const initialVisibleCount = recentActivityGets;

    await page.waitForTimeout(15_500);
    expect(recentActivityGets).toBe(initialVisibleCount + 1, "visible recent-activity polling should retain its 15-second refresh");
    const visiblePollCountBeforeHide = recentActivityGets - initialVisibleCount;
    test.info().annotations.push({
      type: "c39-visible-poll-count",
      description: `visible before hide: ${visiblePollCountBeforeHide} GET(s) in 15.5 seconds.`,
    });

    background = await context.newPage();
    await background.goto("about:blank");
    await background.bringToFront();
    let naturallyHidden = false;
    try {
      await page.waitForFunction(() => document.visibilityState === "hidden", null, { timeout: 3_000 });
      naturallyHidden = true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    }
    if (!naturallyHidden) {
      test.info().annotations.push({
        type: "c39-natural-visibility",
        description: "NOT_CHECKED: Chromium did not naturally report the original page as hidden.",
      });
      test.skip(true, "NOT_CHECKED: Chromium did not naturally report the original page as hidden.");
      return;
    }

    const hiddenCount = recentActivityGets;
    await page.waitForTimeout(15_500);
    const hiddenPollCount = recentActivityGets - hiddenCount;
    test.info().annotations.push({
      type: "c39-hidden-poll-count",
      description: `${hiddenPollCount} GET(s) in 15.5 seconds after Chromium naturally reported hidden.`,
    });
    if (process.env.SCRIPTORIUM_E2E_EXPECT_C39_PAUSED === "1") {
      expect(recentActivityGets).toBe(hiddenCount, "hidden pages should issue no recent-activity poll");
    }

    const remoteUpdate = await page.request.put(
      new URL(`/api/projects/${encodeURIComponent(projectId!)}/recent-activity`, page.url()).toString(),
      {
        data: { sceneId: "scene-2", sentenceOffset: 2, deviceType: "mobile" },
        headers: { origin: new URL(page.url()).origin },
      },
    );
    expect(remoteUpdate.ok()).toBe(true, "the other-device cursor should be stored while this page is hidden");

    const expectsPause = process.env.SCRIPTORIUM_E2E_EXPECT_C39_PAUSED === "1";
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    const handoff = page.getByText(/スマホでたった今まで編集していました/u);
    await expect.poll(() => recentActivityGets, { timeout: 5_000 }).toBeGreaterThan(hiddenCount);
    await expect(handoff).toBeVisible();
    const visibleCountAfterImmediateRefresh = recentActivityGets;
    await page.waitForTimeout(15_500);
    if (expectsPause) {
      expect(recentActivityGets).toBe(visibleCountAfterImmediateRefresh + 1,
        "the restarted visible interval should add one refresh after the immediate focus refresh");
    }
    const visiblePollsAfterReturn = recentActivityGets - hiddenCount;
    test.info().annotations.push({
      type: "c39-visibility-poll-counts",
      description: `visible before hide: ${visiblePollCountBeforeHide}; hidden: ${hiddenPollCount}; visible after return: ${visiblePollsAfterReturn} GET(s), including immediate focus refresh; post-refresh 15.5-second delta: ${recentActivityGets - visibleCountAfterImmediateRefresh}.`,
    });
  } finally {
    if (projectId) {
      const origin = new URL(page.url()).origin;
      await page.request.delete(new URL(`/api/projects/${encodeURIComponent(projectId)}`, origin).toString(), {
        headers: { origin },
      }).catch(() => undefined);
    }
    await background?.close().catch(() => undefined);
    await native.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recent activity ignores a refresh response invalidated by natural hide", async () => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This visibility acceptance uses a disposable local Git fixture.");
  requireNativeVisibilityCoverage();
  const fixture = await makeLongReadingRepository();
  const native = await createNativeHeadfulContext(1280);
  const { context, page } = native;
  let projectId: string | null = null;
  let recentActivityGets = 0;
  let interceptedGet = false;
  let signalIntercepted: (() => void) | null = null;
  let signalReleased: (() => void) | null = null;
  let signalCompleted: (() => void) | null = null;
  const heldGet = new Promise<void>((resolveHeld) => { signalIntercepted = resolveHeld; });
  const heldResponseReleased = new Promise<void>((resolveReleased) => { signalReleased = resolveReleased; });
  const heldResponseCompleted = new Promise<void>((resolveCompleted) => { signalCompleted = resolveCompleted; });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/recent-activity")) recentActivityGets += 1;
  });
  await page.route("**/api/projects/*/recent-activity", async (route) => {
    if (route.request().method() !== "GET" || interceptedGet) {
      await route.continue();
      return;
    }
    interceptedGet = true;
    signalIntercepted?.();
    await heldResponseReleased;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [{
        sceneId: "scene-2",
        sentenceOffset: 2,
        deviceType: "mobile",
        updatedAt: "2000-01-01T00:00:00.000Z",
      }] }),
    });
    signalCompleted?.();
  });

  try {
    await signIn(page);
    projectId = await openProject(page, fixture.remote);
    await expect(page.getByRole("navigation", { name: "作品構成" })).toBeVisible();
    await heldGet;

    const background = await context.newPage();
    await background.goto("about:blank");
    await background.bringToFront();
    let naturallyHidden = false;
    try {
      await page.waitForFunction(() => document.visibilityState === "hidden", null, { timeout: 3_000 });
      naturallyHidden = true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    }
    if (!naturallyHidden) {
      test.info().annotations.push({
        type: "c39-inflight-visibility",
        description: "NOT_CHECKED: Chromium did not naturally report the original page as hidden while its refresh was held.",
      });
      test.skip(true, "NOT_CHECKED: Chromium did not naturally report the original page as hidden.");
      return;
    }

    signalReleased?.();
    await heldResponseCompleted;
    await page.waitForTimeout(200);
    const staleHandoff = page.getByText(/スマホで.*編集していました/u);
    const expectsInvalidation = process.env.SCRIPTORIUM_E2E_EXPECT_C39_PAUSED === "1";
    if (expectsInvalidation) await expect(staleHandoff).toHaveCount(0);
    else await expect(staleHandoff).toBeVisible();
    test.info().annotations.push({
      type: "c39-inflight-refresh",
      description: expectsInvalidation
        ? "The delayed response started while visible was discarded after natural hide."
        : "The baseline applied the delayed response after natural hide; the response completed while hidden.",
    });

    const hiddenGets = recentActivityGets;
    await page.waitForTimeout(15_500);
    expect(recentActivityGets).toBe(hiddenGets + (expectsInvalidation ? 0 : 1));
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe("visible");
    await expect.poll(() => recentActivityGets).toBe(hiddenGets + (expectsInvalidation ? 1 : 2));
    await expect(staleHandoff).toHaveCount(0);
  } finally {
    // If natural visibility was unavailable, unblock the intercepted request before teardown.
    signalReleased?.();
    if (projectId) {
      const origin = new URL(page.url()).origin;
      await page.request.delete(new URL(`/api/projects/${encodeURIComponent(projectId)}`, origin).toString(), {
        headers: { origin },
      }).catch(() => undefined);
    }
    await native.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("recent activity coalesces repeated positions and records 50 input reports", async ({ browser }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This debounce acceptance uses a disposable local Git fixture.");
  const fixture = await makeLongReadingRepository(5);
  const { context, page } = await createContext(browser, 1280);
  let projectId: string | null = null;
  const positionWrites: unknown[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "PUT" || !url.pathname.endsWith("/recent-activity")) return;
    try { positionWrites.push(request.postDataJSON()); } catch { positionWrites.push(request.postData()); }
  });

  try {
    await signIn(page);
    projectId = await openProject(page, fixture.remote);
    const matchesPositionWrite = (response: import("@playwright/test").Response) =>
      response.url().includes(`/api/projects/${encodeURIComponent(projectId!)}/recent-activity`) &&
      response.request().method() === "PUT";
    const initialWrite = page.waitForResponse(matchesPositionWrite);
    await selectScene(page);
    const editor = page.locator(".cm-content");
    await editor.focus();
    await editor.press("Control+End");
    const initialResponse = await initialWrite;
    expect(initialResponse.ok()).toBe(true);
    const initialActivity = await initialResponse.json() as {
      items: Array<{ sceneId: string; sentenceOffset: number | null; deviceType: string; updatedAt: string }>;
    };
    const initialCursor = initialActivity.items.find((item) => item.sceneId === "scene-1" && item.deviceType === "desktop");
    expect(initialCursor).toBeDefined();
    expect(typeof initialCursor?.sentenceOffset).toBe("number");
    const initialWriteCount = positionWrites.length;
    expect(initialWriteCount).toBeGreaterThan(0);

    const repeatedPositionWrite = page.waitForResponse(matchesPositionWrite);
    const reportsStartedAt = Date.now();
    await page.locator(".cm-scroller").evaluate((scroller) => {
      for (let index = 0; index < 50; index += 1) scroller.dispatchEvent(new Event("scroll"));
    });
    const repeatedReportDurationMs = Date.now() - reportsStartedAt;
    const repeatedResponse = await repeatedPositionWrite;
    expect(repeatedResponse.ok()).toBe(true);
    const repeatedActivity = await repeatedResponse.json() as {
      items: Array<{ sceneId: string; sentenceOffset: number | null; deviceType: string; updatedAt: string }>;
    };
    const repeatedCursor = repeatedActivity.items.find((item) => item.sceneId === "scene-1" && item.deviceType === "desktop");
    expect(repeatedCursor).toBeDefined();
    expect(repeatedCursor?.sentenceOffset).toBe(initialCursor?.sentenceOffset);
    expect(Date.parse(repeatedCursor?.updatedAt ?? "")).toBeGreaterThan(Date.parse(initialCursor?.updatedAt ?? ""));
    expect(positionWrites).toHaveLength(initialWriteCount + 1);
    expect(positionWrites[initialWriteCount]).toEqual(positionWrites[initialWriteCount - 1]);

    await page.waitForTimeout(2_100);
    expect(positionWrites).toHaveLength(initialWriteCount + 1, "unchanged position reports should settle after their debounced PUT");

    const inputStartCount = positionWrites.length;
    const inputStartedAt = Date.now();
    await editor.focus();
    await page.keyboard.type("x".repeat(50), { delay: 0 });
    const inputBurstDurationMs = Date.now() - inputStartedAt;
    await page.waitForTimeout(2_100);
    const inputPutCount = positionWrites.length - inputStartCount;
    expect(inputPutCount).toBeGreaterThan(0);
    if (inputBurstDurationMs < 2_000) {
      expect(inputPutCount).toBe(1, "a 50-character burst completed within the server debounce window should make one PUT");
    }
    test.info().annotations.push(
      { type: "c40-identical-position", description: `50 repeated reports in ${repeatedReportDurationMs} ms; 1 PUT; identical cursor input refreshed updatedAt.` },
      { type: "c40-50-inputs", description: `50 characters in ${inputBurstDurationMs} ms; ${inputPutCount} PUT(s)${inputBurstDurationMs < 2_000 ? " within debounce window" : "; workload exceeded debounce window"}.` },
    );
  } finally {
    if (projectId) {
      const origin = new URL(page.url()).origin;
      await page.request.delete(new URL(`/api/projects/${encodeURIComponent(projectId)}`, origin).toString(), {
        headers: { origin },
      }).catch(() => undefined);
    }
    await context.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
