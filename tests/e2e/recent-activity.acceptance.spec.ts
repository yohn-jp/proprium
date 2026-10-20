import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const defaultRepository = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";

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
  await page.goto("/desktop/");
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

async function makeLongReadingRepository(): Promise<{ root: string; remote: string }> {
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
  const body = "# Scene One\n\n" + "読書位置を別の端末へ引き継ぐための文章です。\n\n".repeat(160);
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
    const desktopScroller = ownerDesktop.page.locator(".cm-editor .cm-scroller").first();
    const requestedScrollTop = await desktopScroller.evaluate((element) => {
      const maximum = element.scrollHeight - element.clientHeight;
      if (maximum <= 0) return { maximum, actual: element.scrollTop };
      element.scrollTop = Math.max(1, maximum - Math.min(120, maximum / 2));
      return { maximum, actual: element.scrollTop };
    });
    expect(requestedScrollTop.maximum).toBeGreaterThan(0);
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
