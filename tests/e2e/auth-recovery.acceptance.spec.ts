import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";

test("an unknown hosted grant requests refresh and retries the initial session check", async ({ page }) => {
  let sessionRequests = 0;
  let refreshRequests = 0;
  let reauthRequests = 0;
  let grantFresh = false;

  await page.route("**/api/version", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ name: "scriptorium", version: "test", hosted: true, profile: "hosted" }),
  }));
  await page.route("**/api/session", (route) => {
    sessionRequests += 1;
    if (!grantFresh) {
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Authentication required", code: "UNAUTHORIZED" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true, authorScope: "hosted:synthetic-author", permissions: ["read", "write"] }),
    });
  });
  await page.route("**/api/projects", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.route("**/api/jobs", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await page.route("**/api/jobs/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" }));
  await page.route("**/api/inbox", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], unreadCount: 0 }),
  }));
  await page.route("**/_platform/refresh", async (route) => {
    refreshRequests += 1;
    grantFresh = true;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/_platform/reauth", async (route) => {
    reauthRequests += 1;
    await route.fulfill({ status: 200, contentType: "text/html", body: "reauth fixture" });
  });

  await page.goto("/desktop/");
  await expect(page.getByText("登録された作品はありません")).toBeVisible();
  expect(sessionRequests).toBe(3);
  expect(refreshRequests).toBe(1);
  expect(reauthRequests).toBe(0);
});

test("concurrent tabs serialize a rotated hosted grant through the browser lock", async ({ page }) => {
  const context = page.context();
  const secondPage = await context.newPage();
  let initialSessionRequests = 0;
  let totalSessionRequests = 0;
  let refreshRequests = 0;
  let reauthRequests = 0;
  let grantFresh = false;
  let releaseInitialRequests!: () => void;
  const bothInitialRequests = new Promise<void>((resolve) => { releaseInitialRequests = resolve; });

  await context.route("**/api/version", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ name: "scriptorium", version: "test", hosted: true, profile: "hosted" }),
  }));
  await context.route("**/api/session", async (route) => {
    totalSessionRequests += 1;
    if (grantFresh) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true, authorScope: "hosted:synthetic-author", permissions: ["read", "write"] }),
      });
    }
    initialSessionRequests += 1;
    if (initialSessionRequests === 2) releaseInitialRequests();
    await bothInitialRequests;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Authentication required", code: "UNAUTHORIZED" }),
    });
  });
  await context.route("**/api/projects", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await context.route("**/api/jobs", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "[]",
  }));
  await context.route("**/api/jobs/events", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "" }));
  await context.route("**/api/inbox", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], unreadCount: 0 }),
  }));
  await context.route("**/_platform/refresh", async (route) => {
    refreshRequests += 1;
    grantFresh = true;
    await route.fulfill({ status: 204 });
  });
  await context.route("**/_platform/reauth", async (route) => {
    reauthRequests += 1;
    await route.fulfill({ status: 200, contentType: "text/html", body: "reauth fixture" });
  });

  await Promise.all([page.goto("/desktop/?tab=first"), secondPage.goto("/desktop/?tab=second")]);
  await expect(page.getByText("登録された作品はありません")).toBeVisible();
  await expect(secondPage.getByText("登録された作品はありません")).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(secondPage.url()).origin);
  expect(await page.evaluate(() => Boolean(navigator.locks)), "Chromium must expose Web Locks for this cross-tab acceptance").toBe(true);
  expect(initialSessionRequests).toBeGreaterThanOrEqual(2);
  expect(totalSessionRequests).toBeGreaterThanOrEqual(4);
  expect(refreshRequests).toBe(1);
  expect(reauthRequests).toBe(0);
  await secondPage.close();
});

test("an interrupted initial project bootstrap resumes after persisted pageshow", async ({ page }) => {
  test.skip(Boolean(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1" || process.env.SCRIPTORIUM_E2E_BASE_URL || process.env.SCRIPTORIUM_BASE_URL),
    "The bootstrap lifecycle regression requires the generated local owner repository fixture.");
  expect(authToken).not.toBe("");
  expect(repositoryUrl).not.toBe("");

  const repositoryInput = repositoryUrl.startsWith("https://") || repositoryUrl.startsWith("file://")
    ? repositoryUrl
    : pathToFileURL(repositoryUrl).href;
  const projectName = new URL(repositoryInput).pathname.split("/").filter(Boolean).at(-1)!.replace(/\.git$/u, "");
  const projectButton = (target: typeof page) => target.locator(".project-button").filter({ hasText: projectName });

  await page.goto("/desktop/");
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
  if (await projectButton(page).count() === 0) {
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInput);
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
    await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(projectButton(page)).toBeVisible();
  }
  await page.close();

  for (const releaseOrder of ["before-pageshow", "after-pageshow"] as const) {
    const resumedPage = await page.context().newPage();
    let projectRequests = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let firstReleased!: () => void;
    const heldFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const released = new Promise<void>((resolve) => { firstReleased = resolve; });

    await resumedPage.route("**/api/projects", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      projectRequests += 1;
      if (projectRequests > 1) return route.continue();

      const response = await route.fetch();
      const body = await response.text();
      expect(response.status()).toBe(200);
      expect(JSON.parse(body)).toEqual(expect.arrayContaining([expect.objectContaining({ branch: "main" })]));
      firstStarted();
      await heldFirst;
      await route.fulfill({ response, body }).catch(() => undefined);
      firstReleased();
    });

    await resumedPage.goto("/desktop/");
    await started;
    await resumedPage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    if (releaseOrder === "before-pageshow") {
      releaseFirst();
      await released;
      await resumedPage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    } else {
      await resumedPage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      releaseFirst();
      await released;
    }

    await expect(projectButton(resumedPage), `project list should recover when the response is released ${releaseOrder}`).toBeVisible({ timeout: 15_000 });
    await expect(resumedPage.getByRole("alert")).toHaveCount(0);
    expect(projectRequests, `${releaseOrder} should restart the interrupted project bootstrap`).toBeGreaterThanOrEqual(2);
    await resumedPage.close();
  }
});
