import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";

interface JournalSummary {
  documentPath: string;
  sceneId: string;
  state: string;
  operationId: string;
  generation: number;
  text: string;
  authorScope: string | null;
  attachmentWrites: number;
  writes: Array<{ path: string; content: string | null }>;
}

interface RestoreGate {
  targetOperationId: string | null;
  armed: boolean;
  started: boolean;
  release?: () => void;
}

interface PublicationReceiptSummary {
  batchId: string;
  state: string;
  acknowledged: Array<{ operationId: string; generation: number }>;
  authorScope: string;
}

interface ProposalJournalSummary {
  authorScope: string | null;
  proposal: {
    id: string;
    source: string;
    operations: Array<{ id: string; generation: number; writes: Array<{ path: string; content: string | null }> }>;
    evidence?: Array<{ id: string; module: string }>;
  };
  status?: { state: string; payloadComplete?: boolean; originalDigest?: string; operationIds?: string[]; approvedOperationIds: string[]; checkpoints: Array<{ operationId: string }>; publishedOperationIds?: string[] };
}

interface ProjectListEntry {
  id: string;
  url: string;
  branch: string;
}

function isProjectListEntry(value: unknown): value is ProjectListEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.url === "string" && typeof record.branch === "string";
}

function isProjectList(value: unknown): value is ProjectListEntry[] {
  return Array.isArray(value) && value.every(isProjectListEntry);
}

async function waitForProjectList(page: Page): Promise<ProjectListEntry[]> {
  const response = await page.waitForResponse((candidate) => {
    const requestUrl = new URL(candidate.url());
    return candidate.request().method() === "GET" && requestUrl.pathname === "/api/projects";
  });
  if (!response.ok()) throw new Error(`Project list request failed with HTTP ${response.status()}`);
  const payload: unknown = await response.json();
  if (!isProjectList(payload)) throw new Error("Project list response does not match the API contract");
  return payload;
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

async function signIn(page: Page): Promise<ProjectListEntry[]> {
  await page.goto("/desktop/");
  await page.getByLabel("アクセストークン").fill(authToken);
  const projectsLoaded = waitForProjectList(page);
  await page.getByRole("button", { name: "ログイン" }).click();
  const projects = await projectsLoaded;
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
  return projects;
}

async function openFixtureProject(page: Page, projects: ProjectListEntry[]): Promise<void> {
  const existing = page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true });
  const fixtureIsRegistered = projects.some((project) => projectLabel(project.url) === projectLabel(repositoryUrl));
  if (fixtureIsRegistered) {
    await expect(existing).toBeVisible();
    await existing.click();
  } else {
    await expect(page.locator(".project-list-section .project-button")).toHaveCount(projects.length);
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(repositoryUrl));
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
  }
  await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function openWorkspaceReviewPanel(page: Page): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Workspace layout controls" });
  await toolbar.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab", { name: "Review", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="review"]')).toBeVisible();
}

async function openWorkspaceContributionPanel(page: Page, id: string, title: string): Promise<ReturnType<Page["locator"]>> {
  const toolbar = page.getByRole("toolbar", { name: "Workspace layout controls" });
  await toolbar.getByRole("button", { name: "Research", exact: true }).click();
  await page.getByRole("tablist", { name: "Panel tabs" }).getByRole("tab", { name: title, exact: true }).click();
  const panel = page.locator('[data-workspace-panel="module:' + id + '"]');
  await expect(panel).toBeVisible();
  return panel;
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
        sceneId: string;
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
        sceneId: entry.sceneId,
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

async function resetLocalCore(): Promise<void> {
  const e2ePort = Number.parseInt(process.env.SCRIPTORIUM_E2E_PORT ?? "4173", 10);
  const response = await fetch(`http://127.0.0.1:${e2ePort + 1}/__e2e/reset-core`, { method: "POST" });
  expect(response.status).toBe(204);
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

async function readRemoteSceneContent(page: Page, sceneId: string): Promise<string | null> {
  const projectId = await page.evaluate(() => localStorage.getItem("scriptorium:active-project"));
  if (!projectId) return null;
  const origin = new URL(page.url()).origin;
  const projectPath = "/api/projects/" + encodeURIComponent(projectId);
  const observationResponse = await page.request.get(new URL(projectPath + "/observation", origin).toString());
  if (!observationResponse.ok()) return null;
  const observation = await observationResponse.json() as { snapshot?: { remoteCommit?: string } };
  const remoteCommit = observation.snapshot?.remoteCommit;
  if (!remoteCommit) return null;
  const sceneResponse = await page.request.get(new URL(
    projectPath + "/scenes/" + encodeURIComponent(sceneId) + "?view=remote&snapshot=" + encodeURIComponent(remoteCommit),
    origin,
  ).toString());
  if (!sceneResponse.ok()) return null;
  const sceneRead = await sceneResponse.json() as { document?: { content?: string } };
  return typeof sceneRead.document?.content === "string" ? sceneRead.document.content : null;
}

async function expectPublishedOperation(
  page: Page,
  operationId: string,
  generation: number,
  sceneId: string,
  expectedRemoteText: string,
): Promise<void> {
  await expect.poll(async () => (await readPublicationReceipts(page)).some((receipt) =>
    receipt.state === "confirmed" && receipt.acknowledged.some((item) => item.operationId === operationId && item.generation === generation),
  ), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await readJournal(page)).some((entry) =>
    entry.operationId === operationId && entry.generation === generation,
  ), { timeout: 30_000 }).toBe(false);
  await expect.poll(async () => (await readRemoteSceneContent(page, sceneId))?.includes(expectedRemoteText) ?? false,
    { timeout: 30_000 }).toBe(true);
}

async function readProposalJournal(page: Page): Promise<ProposalJournalSummary[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("proposals", "readonly");
      return await new Promise<ProposalJournalSummary[]>((resolve, reject) => {
        const request = transaction.objectStore("proposals").getAll();
        request.onsuccess = () => resolve(request.result.map((record: ProposalJournalSummary) => ({
          authorScope: record.authorScope ?? null,
          proposal: record.proposal,
          status: record.status,
        })));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB proposal journal read failed"));
      });
    } finally {
      database.close();
    }
  });
}

async function waitForJournalCount(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await readJournal(page)).length).toBe(count);
}

test("appearance modes follow system preference initially and persist explicit light, dark, and paper choices", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signIn(page);
  await expect(page.locator("html")).toHaveAttribute("data-zp-theme", "light");
  const appearance = page.getByLabel("外観");
  await expect(appearance).toBeVisible();
  await appearance.selectOption("dark");
  await expect.poll(() => page.locator("html").getAttribute("data-zp-theme")).toBe("dark");
  await expect.poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(18, 22, 28)");
  expect(await page.evaluate(() => localStorage.getItem("arcadia-theme-mode"))).toBe("dark");

  await page.reload();
  await expect(page.getByLabel("外観")).toHaveValue("dark");
  await page.getByLabel("外観").selectOption("paper");
  await expect.poll(() => page.locator("html").getAttribute("data-zp-theme")).toBe("paper");
  await expect.poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(242, 235, 217)");
  expect(await page.evaluate(() => localStorage.getItem("arcadia-theme-mode"))).toBe("paper");

  await page.getByLabel("外観").selectOption("light");
  await expect.poll(() => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(242, 238, 231)");
});

test("history keeps its pinned response through a foreground observation without rereading the unchanged tree", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await openFixtureProject(page, await signIn(page));

  let releaseHistory!: () => void;
  let signalHistory!: () => void;
  const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
  const historyStarted = new Promise<void>((resolve) => { signalHistory = resolve; });
  let historyListRequests = 0;
  let actualHistoryStatus = 0;
  let foregroundObservationRequests = 0;
  let remoteTreeRequests = 0;
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const url = new URL(request.url());
    if (url.pathname.endsWith("/observation")) foregroundObservationRequests++;
    if (url.pathname.endsWith("/tree") && url.searchParams.get("view") === "remote") remoteTreeRequests++;
  });
  await page.route((url) => url.pathname.endsWith("/manuscripts/scene-1/snapshots") && url.searchParams.get("sceneId") === "scene-1", async (route) => {
    historyListRequests++;
    if (historyListRequests === 1) {
      const response = await route.fetch();
      actualHistoryStatus = response.status();
      signalHistory();
      await historyGate;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  try {
    await page.getByRole("button", { name: "履歴", exact: true }).click();
    await expect(page.locator('[data-workspace-panel="history"]')).toBeVisible();
    await historyStarted;
    const observationRequestsBeforeForeground = foregroundObservationRequests;
    const treeRequestsBeforeForeground = remoteTreeRequests;
    const observationResponse = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/observation"),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const observed = await observationResponse;
    expect(observed.ok()).toBe(true);
    expect(foregroundObservationRequests).toBe(observationRequestsBeforeForeground + 1);
    expect(remoteTreeRequests).toBe(treeRequestsBeforeForeground);
    const remote = await observed.json() as { state: string; observedAt: string; snapshot: { remoteCommit: string } };
    const expectedStatus = remote.state === "fresh"
      ? `リモート ${remote.snapshot.remoteCommit.slice(0, 12)} · ${new Date(remote.observedAt).toLocaleTimeString("ja-JP")} に確認`
      : `リモート確認状態: ${remote.state}`;
    await expect(page.locator(".topbar-status")).toContainText(expectedStatus);
  } finally {
    releaseHistory();
  }

  const history = page.locator(".manuscript-history");
  await expect(history.getByRole("heading", { name: "改稿の履歴" })).toBeVisible();
  await expect(history.locator('[role="status"]')).toHaveCount(0);
  await expect(history.getByRole("alert")).toHaveCount(0);
  expect(actualHistoryStatus).toBe(200);
  expect(historyListRequests).toBe(1);
});

test("same-origin stale tabs cannot replace an equal-generation journal draft", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "The journal acceptance uses only the disposable local browser and Git fixtures.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await resetLocalCore();

  const secondTab = await page.context().newPage();
  try {
    await openFixtureProject(page, await signIn(page));
    const secondTabProjectsLoaded = waitForProjectList(secondTab);
    await secondTab.goto("/desktop/");
    const secondTabProjects = await secondTabProjectsLoaded;
    await expect(secondTab.getByRole("heading", { name: "作品を追加" })).toBeVisible();
    await openFixtureProject(secondTab, secondTabProjects);

    const firstEditor = page.locator(".cm-content");
    const secondEditor = secondTab.locator(".cm-content");
    const firstTabText = "The first tab's durable manuscript bytes.";
    const staleTabText = "The stale tab's conflicting manuscript bytes.";

    // Both tabs opened the empty journal first, so each first edit is generation 1 with its own operation ID.
    await firstEditor.fill(firstTabText);
    await expect.poll(async () => (await readJournal(page)).some((entry) =>
      entry.documentPath === "manuscript/vol-1/ch-1/scene-1.md" && entry.state === "draft" && entry.text === firstTabText,
    )).toBe(true);
    const firstSaved = (await readJournal(page)).find((entry) =>
      entry.documentPath === "manuscript/vol-1/ch-1/scene-1.md" && entry.state === "draft" && entry.text === firstTabText,
    );
    expect(firstSaved).toBeTruthy();
    expect(firstSaved?.generation).toBe(1);

    await secondEditor.fill(staleTabText);
    await expect(secondEditor).toHaveText(staleTabText);
    await expect(secondTab.locator(".durability-message")).toContainText("保存を確認できていません");
    await expect(secondTab.locator(".topbar-status")).toContainText("新しい世代");
    await expect(secondTab.getByRole("button", { name: "Checkpoint", exact: true })).toBeDisabled();

    const sharedJournal = (await readJournal(secondTab)).filter((entry) =>
      entry.documentPath === "manuscript/vol-1/ch-1/scene-1.md" && entry.authorScope === firstSaved!.authorScope,
    );
    expect(sharedJournal).toHaveLength(1);
    expect(sharedJournal[0]).toMatchObject({
      state: "draft",
      operationId: firstSaved!.operationId,
      generation: firstSaved!.generation,
      text: firstTabText,
    });
    expect((await readJournal(secondTab)).some((entry) => entry.text === staleTabText)).toBe(false);
  } finally {
    await secondTab.close();
  }
});

test("coalesced editor state is current for immediate print and history actions", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "The history acceptance writes only to the disposable local Git fixture.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  const fixtureRoot = await mkdtemp(join(tmpdir(), "scriptorium-e2e-history-"));
  const workingCopy = join(fixtureRoot, "work");
  const fixtureBranch = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main";
  let initialRemoteCommit: string | null = null;
  try {
    execFileSync("git", ["clone", "--quiet", repositoryUrl, workingCopy], { stdio: "ignore" });
    initialRemoteCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workingCopy, encoding: "utf8" }).trim();
    const manuscriptPath = "manuscript/vol-1/ch-1/scene-1.md";
    const historyBody = "# Scene One\n\nA committed version for the editor history comparison.\n";
    await writeFile(join(workingCopy, manuscriptPath), historyBody, "utf8");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Scriptorium Acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Scriptorium Acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
    };
    execFileSync("git", ["add", manuscriptPath], { cwd: workingCopy, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "loom(scene): scene-1", "-m", "Loom-Manuscript: scene-1", "-m", `Loom-File: ${manuscriptPath}`], {
      cwd: workingCopy,
      env: gitEnv,
      stdio: "ignore",
    });
    execFileSync("git", ["push", "origin", `HEAD:${fixtureBranch}`], { cwd: workingCopy, stdio: "ignore" });
    await resetLocalCore();

    await page.addInitScript(() => {
      window.print = () => {
        document.documentElement.dataset.printedManuscript = document.querySelector(".print-manuscript")?.textContent ?? "";
      };
    });
    await openFixtureProject(page, await signIn(page));

    const editor = page.locator(".cm-content");
    const printDraft = "Printed from the newest editor input.";
    await editor.fill(printDraft);
    await expect(page.locator(".durability-message")).toContainText("保存を確認できていません");
    await page.getByRole("button", { name: "印刷" }).click();
    await expect.poll(() => page.locator("html").getAttribute("data-printed-manuscript")).toBe(printDraft);

    const historyDraft = "Compared against the newest editor input.";
    await editor.fill(historyDraft);
    await page.getByRole("button", { name: "履歴", exact: true }).click();
    const history = page.locator(".manuscript-history");
    await expect(history.getByRole("heading", { name: "改稿の履歴" })).toBeVisible();
    await expect(history.locator('pre[aria-label="原稿の差分"]')).toContainText(historyDraft);
  } finally {
    try {
      if (initialRemoteCommit) {
        const currentRemoteCommit = execFileSync("git", ["ls-remote", "origin", `refs/heads/${fixtureBranch}`], {
          cwd: workingCopy,
          encoding: "utf8",
        }).trim().split(/\s+/u)[0];
        if (currentRemoteCommit && currentRemoteCommit !== initialRemoteCommit) {
          execFileSync("git", [
            "push",
            `--force-with-lease=refs/heads/${fixtureBranch}:${currentRemoteCommit}`,
            "origin",
            `${initialRemoteCommit}:refs/heads/${fixtureBranch}`,
          ], { cwd: workingCopy, stdio: "ignore" });
        }
      }
    } finally {
      await resetLocalCore();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("coalesced typing restores to its unchanged React value without reviving the deleted draft", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "The recovery acceptance changes only the disposable local browser journal.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await page.addInitScript(() => {
    type GatedTransaction = IDBTransaction & { __scriptoriumHoldComplete?: boolean };
    type GatedWindow = Window & { __scriptoriumRestoreGate?: RestoreGate };
    const gate: RestoreGate = { targetOperationId: null, armed: false, started: false };
    (window as GatedWindow).__scriptoriumRestoreGate = gate;

    const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    const originalDelete = IDBObjectStore.prototype.delete;
    if (!transactionDescriptor?.get || !transactionDescriptor.set) throw new Error("IndexedDB completion hooks are unavailable in this browser.");
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      enumerable: transactionDescriptor.enumerable,
      get() { return transactionDescriptor.get!.call(this); },
      set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (!handler) {
          transactionDescriptor.set!.call(this, handler);
          return;
        }
        const transaction = this as GatedTransaction;
        transactionDescriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          const currentGate = (window as GatedWindow).__scriptoriumRestoreGate;
          if (currentGate?.armed && transaction.__scriptoriumHoldComplete) {
            currentGate.started = true;
            currentGate.release = () => {
              currentGate.armed = false;
              handler.call(transaction, event);
            };
            return;
          }
          return handler.call(this, event);
        });
      },
    });
    IDBObjectStore.prototype.delete = function (this: IDBObjectStore, key: IDBValidKey): IDBRequest<undefined> {
      const currentGate = (window as GatedWindow).__scriptoriumRestoreGate;
      if (this.name === "operations" && currentGate?.armed && currentGate.targetOperationId && String(key).includes(currentGate.targetOperationId)) {
        (this.transaction as GatedTransaction).__scriptoriumHoldComplete = true;
      }
      return originalDelete.call(this, key);
    };
  });
  await openFixtureProject(page, await signIn(page));

  const editor = page.locator(".cm-content");
  const originalText = (await editor.textContent()) ?? "";
  const stagingText = "Temporary browser journal seed.";
  await editor.fill(stagingText);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === stagingText && entry.state === "draft")).toBe(true);
  await page.evaluate(({ originalText, stagingText }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("scriptorium-recovery", 3);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("operations", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("operations");
      const request = store.getAll();
      request.onerror = () => reject(request.error ?? new Error("Journal read failed"));
      request.onsuccess = () => {
        const records = request.result as Array<{
          state: string;
          text: string;
          baseText: string;
          documentPath: string;
          operation: {
            reads: Array<{ path: string; revision: string | null }>;
            writes: Array<{ path: string; revision: string | null; content: string | null }>;
          };
        }>;
        const entry = records.find((candidate) => candidate.state === "draft" && candidate.text === stagingText);
        if (!entry) {
          reject(new Error("Journal seed is missing"));
          return;
        }
        entry.text = originalText;
        entry.baseText = originalText;
        const read = entry.operation.reads.find((item) => item.path === entry.documentPath);
        const write = entry.operation.writes.find((item) => item.path === entry.documentPath);
        if (!read || !write) {
          reject(new Error("Journal seed has no manuscript operation"));
          return;
        }
        read.revision = "f".repeat(64);
        write.revision = "f".repeat(64);
        write.content = originalText;
        store.put(entry);
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error ?? new Error("Journal seed update failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Journal seed update aborted"));
    };
  }), { originalText, stagingText });

  const projectsLoaded = waitForProjectList(page);
  await page.reload();
  await openFixtureProject(page, await projectsLoaded);
  await expect(page.locator(".conflict")).toBeVisible();
  await expect(editor).toHaveText(originalText);
  const prior = (await readJournal(page)).find((entry) => entry.state === "draft" && entry.text === originalText);
  expect(prior).toBeTruthy();

  await page.clock.install();
  const pendingText = "Typing held before React publication.";
  await editor.fill(pendingText);
  await expect(page.locator(".durability-message")).toContainText("保存を確認できていません");
  expect((await readJournal(page)).find((entry) => entry.operationId === prior!.operationId)?.text).toBe(originalText);
  await page.evaluate((operationId) => {
    const gate = (window as Window & { __scriptoriumRestoreGate?: RestoreGate }).__scriptoriumRestoreGate;
    if (!gate) throw new Error("Restore gate was not installed.");
    gate.targetOperationId = operationId;
    gate.armed = true;
  }, prior!.operationId);
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("button", { name: "この文書の未チェックポイント下書きを削除して GitHub 版に戻す" }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __scriptoriumRestoreGate?: RestoreGate }).__scriptoriumRestoreGate?.started))).toBe(true);
  await expect(editor).toHaveAttribute("contenteditable", "false");
  await editor.press("End");
  expect(await editor.textContent()).toBe(pendingText);
  await page.evaluate(() => {
    const gate = (window as Window & { __scriptoriumRestoreGate?: RestoreGate }).__scriptoriumRestoreGate;
    if (!gate?.release) throw new Error("Draft removal transaction was not held.");
    gate.release();
  });
  await expect(editor).toHaveText(originalText);
  await page.clock.runFor(350);
  expect(await readJournal(page)).toHaveLength(0);
});

test("writing UI recovers multi-document drafts and separates Draft, Checkpoint, and GitHub publication", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to|violat(?:e|ion)/iu.test(message.text())) {
      cspErrors.push(message.text());
    }
  });

  await openFixtureProject(page, await signIn(page));
  const nonce = await page.locator('meta[name="scriptorium-style-nonce"]').getAttribute("content");
  expect(nonce).toBeTruthy();
  expect(nonce).not.toBe("__SCRIPTORIUM_STYLE_NONCE__");

  const editor = page.locator(".cm-content");
  await editor.fill("彼は|東京《とうきょう》へ行く。");
  await page.getByRole("button", { name: "プレビュー", exact: true }).click();
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

  await page.locator(".typography-settings > summary").click();
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

  const projectsLoaded = waitForProjectList(page);
  await page.reload();
  await openFixtureProject(page, await projectsLoaded);
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

  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect(page.locator(".durability-message")).toContainText("ローカルチェックポイント");
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toBeEnabled();
  const checkpointed = await readJournal(page);
  expect(checkpointed).toHaveLength(3);
  expect(checkpointed.find((entry) => entry.text === sceneOneDraft)?.state).toBe("checkpointed");
  const checkpointedScene = checkpointed.find((entry) => entry.text === sceneOneDraft);
  const checkpointedScratch = checkpointed.find((entry) => entry.documentPath.startsWith("meta/scratch/"));
  expect(checkpointedScene).toBeTruthy();
  expect(checkpointedScratch).toBeTruthy();
  await page.getByRole("button", { name: "履歴", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="history"]')).toBeVisible();
  const checkpointHistory = page.locator(".manuscript-history");
  await expect(checkpointHistory.getByRole("heading", { name: "改稿の履歴" })).toBeVisible();
  await expect(checkpointHistory.getByRole("alert")).toHaveCount(0);
  await expect(checkpointHistory).toContainText("確認済みリモート版");
  await checkpointHistory.getByRole("button", { name: "閉じる" }).click();
  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expectPublishedOperation(page, checkpointedScene!.operationId, checkpointedScene!.generation, "scene-1", sceneOneDraft);
  await expect.poll(async () => (await readPublicationReceipts(page)).some((receipt) =>
    receipt.state === "confirmed" && receipt.acknowledged.some((item) =>
      item.operationId === checkpointedScratch!.operationId && item.generation === checkpointedScratch!.generation,
    ),
  ), { timeout: 30_000 }).toBe(true);
  await expect(page.getByText("Saved to GitHub", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).map((entry) => `${entry.documentPath}:${entry.state}`)).toEqual([
    "manuscript/vol-1/ch-1/scene-2.md:draft",
  ]);
  expect((await readPublicationReceipts(page)).some((receipt) => receipt.state === "confirmed" &&
    receipt.acknowledged.some((item) => item.operationId === checkpointedScene!.operationId && item.generation === checkpointedScene!.generation))).toBe(true);
  const laterDraft = "A later draft compared with the published version.";
  await editor.fill(laterDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === laterDraft && entry.state === "draft")).toBe(true);
  await page.getByRole("button", { name: "履歴", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="history"]')).toBeVisible();
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
  await openFixtureProject(page, await signIn(page));

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

  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
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
  const publishedGeneration = afterCheckpoint.find((entry) => entry.text === firstGeneration);
  expect(publishedGeneration).toBeTruthy();

  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expectPublishedOperation(page, publishedGeneration!.operationId, publishedGeneration!.generation, "scene-1", firstGeneration);
  const afterPublication = await readJournal(page);
  expect(afterPublication).toHaveLength(1);
  expect(afterPublication[0]?.text).toBe(newerGeneration);
  expect(afterPublication[0]?.state).toBe("draft");
});

test("new typing survives a gated browser-draft rebase during checkpoint recovery", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await page.addInitScript(() => {
    type DraftGate = {
      targetOperationId: string | null;
      armed: boolean;
      started: boolean;
      release?: () => void;
      matchedTransactions: string[];
      heldOnce: boolean;
    };
    type GatedTransaction = IDBTransaction & { __scriptoriumHoldComplete?: boolean };
    type GatedWindow = Window & { __scriptoriumDraftGate?: DraftGate };
    const gate: DraftGate = { targetOperationId: null, armed: false, started: false, matchedTransactions: [], heldOnce: false };
    (window as GatedWindow).__scriptoriumDraftGate = gate;

    const requestDescriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess");
    const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    if (!requestDescriptor?.get || !requestDescriptor.set || !transactionDescriptor?.get || !transactionDescriptor.set) {
      throw new Error("IndexedDB completion hooks are unavailable in this browser.");
    }
    Object.defineProperty(IDBRequest.prototype, "onsuccess", {
      configurable: true,
      enumerable: requestDescriptor.enumerable,
      get() {
        return requestDescriptor.get!.call(this);
      },
      set(handler: ((this: IDBRequest, event: Event) => unknown) | null) {
        if (!handler) {
          requestDescriptor.set!.call(this, handler);
          return;
        }
        const request = this;
        requestDescriptor.set!.call(this, function (this: IDBRequest, event: Event) {
          const currentGate = (window as GatedWindow).__scriptoriumDraftGate;
          const source = request.source;
          const transaction = source instanceof IDBIndex
            ? source.objectStore.transaction
            : source instanceof IDBObjectStore ? source.transaction : null;
          const records = request.result as Array<{ operation?: { id?: string } }> | undefined;
          if (currentGate?.armed && !currentGate.heldOnce && Array.isArray(records) &&
              records.some((record) => record.operation?.id === currentGate.targetOperationId)) {
            currentGate.matchedTransactions.push(transaction?.mode ?? "unknown");
            if (transaction?.mode === "readwrite") {
              currentGate.heldOnce = true;
              (transaction as GatedTransaction).__scriptoriumHoldComplete = true;
            }
          }
          return handler.call(this, event);
        });
      },
    });
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      enumerable: transactionDescriptor.enumerable,
      get() {
        return transactionDescriptor.get!.call(this);
      },
      set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (!handler) {
          transactionDescriptor.set!.call(this, handler);
          return;
        }
        const transaction = this as GatedTransaction;
        transactionDescriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          const currentGate = (window as GatedWindow).__scriptoriumDraftGate;
          if (currentGate?.armed && transaction.__scriptoriumHoldComplete) {
            currentGate.started = true;
            currentGate.release = () => {
              currentGate.armed = false;
              handler.call(transaction, event);
            };
            return;
          }
          return handler.call(this, event);
        });
      },
    });
  });
  await openFixtureProject(page, await signIn(page));

  const checkpointedText = "Checkpoint recovery baseline.";
  const staleDraftText = "Draft written against the prior snapshot.";
  const newestText = "Newest typing while recovery waits for IndexedDB.";
  await page.locator(".cm-content").fill(checkpointedText);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === checkpointedText && entry.state === "draft")).toBe(true);

  let releaseCheckpointRead!: () => void;
  let signalCheckpointRead!: () => void;
  const checkpointReadGate = new Promise<void>((resolve) => { releaseCheckpointRead = resolve; });
  const checkpointReadStarted = new Promise<void>((resolve) => { signalCheckpointRead = resolve; });
  await page.route((url) => url.pathname.endsWith("/scenes/scene-1/views") && url.searchParams.has("snapshot"), async (route) => {
    signalCheckpointRead();
    await checkpointReadGate;
    await route.continue();
  });

  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await checkpointReadStarted;
  await page.locator(".cm-content").fill(staleDraftText);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === staleDraftText && entry.state === "draft")).toBe(true);
  const staleDraft = (await readJournal(page)).find((entry) => entry.text === staleDraftText);
  expect(staleDraft).toBeTruthy();
  await page.evaluate((operationId) => {
    const gate = (window as Window & { __scriptoriumDraftGate?: { targetOperationId: string | null; armed: boolean; started: boolean } }).__scriptoriumDraftGate;
    if (!gate) throw new Error("Draft gate was not installed.");
    gate.targetOperationId = operationId;
    gate.armed = true;
  }, staleDraft!.operationId);
  releaseCheckpointRead();

  await expect.poll(() => page.evaluate(() => JSON.stringify((window as Window & { __scriptoriumDraftGate?: { started: boolean; matchedTransactions: string[] } }).__scriptoriumDraftGate)))
    .toContain('"started":true');
  await page.locator(".cm-content").fill(newestText);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === newestText && entry.state === "draft")).toBe(true);
  await page.evaluate(() => {
    const gate = (window as Window & { __scriptoriumDraftGate?: { release?: () => void } }).__scriptoriumDraftGate;
    if (!gate?.release) throw new Error("Draft rebase transaction was not held.");
    gate.release();
  });

  await expect(page.locator(".cm-content")).toHaveText(newestText);
  await expect(page.locator(".conflict")).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === newestText && entry.state === "draft")).toBe(true);
  const newest = (await readJournal(page)).find((entry) => entry.text === newestText);
  expect(newest?.operationId).toBe(staleDraft?.operationId);
  expect(newest?.generation).toBeGreaterThan(staleDraft?.generation ?? 0);
  releaseCheckpointRead();

  const ownedCheckpoint = (await readJournal(page)).find((entry) => entry.text === checkpointedText && entry.state === "checkpointed");
  expect(ownedCheckpoint).toBeTruthy();
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toBeEnabled();
  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expectPublishedOperation(page, ownedCheckpoint!.operationId, ownedCheckpoint!.generation, "scene-1", checkpointedText);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === newestText)).toBe(true);
});

test("browser recovery is author-scoped and foreign records remain untouched", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await openFixtureProject(page, await signIn(page));
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
  await openFixtureProject(page, await signIn(page));
  await expect(page.getByRole("heading", { name: "旧ブラウザー下書き" })).toBeVisible();
  await expect(page.getByText("シーン removed-scene-id")).toBeVisible();
});

test("external MCP proposals enter owner review before approval, then checkpoint and publish", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await openFixtureProject(page, await signIn(page));

  const projectResponse = await page.request.get(new URL("/api/projects", page.url()).toString());
  expect(projectResponse.ok()).toBe(true);
  const projects = await projectResponse.json() as Array<{ id: string }>;
  const projectId = projects[0]?.id;
  expect(projectId).toBeTruthy();
  const projectPath = "/api/projects/" + encodeURIComponent(projectId!);
  const observationResponse = await page.request.get(new URL(projectPath + "/observation", page.url()).toString());
  expect(observationResponse.ok()).toBe(true);
  const observation = await observationResponse.json() as {
    snapshot: { repository: { provider: "github" | "local"; repositoryId: string; defaultBranch: string; ownerScope: string; url: string }; remoteCommit: string };
  };
  const sceneResponse = await page.request.get(new URL(
    projectPath + "/scenes/scene-1?view=remote&snapshot=" + encodeURIComponent(observation.snapshot.remoteCommit),
    page.url(),
  ).toString());
  expect(sceneResponse.ok()).toBe(true);
  const sceneRead = await sceneResponse.json() as {
    snapshot: typeof observation.snapshot;
    scene: { id: string };
    document: { path: string; content: string; revision: string | null };
  };
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const proposalId = "mcp-e2e-" + suffix;
  const operationId = "mcp-e2e-op-" + suffix;
  const generatedText = "MCP text requiring owner approval.";
  const content = sceneRead.document.content + "\n" + generatedText + "\n";
  const operation = {
    id: operationId,
    generation: 1,
    repository: observation.snapshot.repository,
    baseRemoteCommit: observation.snapshot.remoteCommit,
    effect: "manuscript",
    reads: [{ path: sceneRead.document.path, revision: sceneRead.document.revision }],
    writes: [{ path: sceneRead.document.path, revision: sceneRead.document.revision, content }],
    message: "loom(scene): scene-1 MCP acceptance\n\nLoom-Manuscript: scene-1\nLoom-File: " + sceneRead.document.path + "\nLoom-Char-Count: " + generatedText.length,
  };
  const evidence = {
    id: "mcp-evidence-" + suffix,
    snapshot: observation.snapshot,
    module: "mcp",
    kind: "external-proposal",
    paths: [{ path: sceneRead.document.path, revision: sceneRead.document.revision }],
    details: { intent: "e2e author review acceptance" },
  };
  const origin = new URL(page.url()).origin;
  const proposed = await fetch(origin + projectPath + "/proposals", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + authToken },
    body: JSON.stringify({
      id: proposalId,
      snapshot: observation.snapshot,
      operations: [operation],
      evidence: [evidence],
    }),
  });
  expect(proposed.status).toBe(201);
  const storedProposal = await proposed.json() as { id: string; source: string };
  expect(storedProposal).toMatchObject({ id: proposalId, source: "mcp" });
  await openWorkspaceReviewPanel(page);
  const foregroundReads: Array<{ path: string; at: number }> = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    const path = new URL(request.url()).pathname;
    if (path === `${projectPath}/observation` || path === `${projectPath}/proposals`) {
      foregroundReads.push({ path, at: Date.now() });
    }
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => new Set(foregroundReads.map((read) => read.path)).size).toBe(2);
  const observationStart = foregroundReads.find((read) => read.path === `${projectPath}/observation`)?.at;
  const proposalStart = foregroundReads.find((read) => read.path === `${projectPath}/proposals`)?.at;
  expect(observationStart).toBeDefined();
  expect(proposalStart).toBeDefined();
  expect(Math.abs(observationStart! - proposalStart!)).toBeLessThan(1_000);
  await expect.poll(() => page.getByText(proposalId, { exact: false }).isVisible().catch(() => false)).toBe(true);
  const journaledBeforeApproval = (await readProposalJournal(page)).find((record) => record.proposal.id === proposalId);
  expect(journaledBeforeApproval).toMatchObject({
    authorScope: "owner",
    proposal: { id: proposalId, source: "mcp", evidence: [{ id: evidence.id, module: "mcp" }] },
    status: { state: "proposed", approvedOperationIds: [], checkpoints: [] },
  });
  expect(journaledBeforeApproval?.proposal.operations[0]?.writes[0]?.content).toContain(generatedText);
  const remoteBeforeApproval = await page.request.get(new URL(projectPath + "/proposals/" + encodeURIComponent(proposalId), page.url()).toString());
  expect(remoteBeforeApproval.ok()).toBe(true);
  expect(await remoteBeforeApproval.json()).toMatchObject({ state: "proposed", approvedOperationIds: [], checkpoints: [] });

  const proposalCard = page.locator(".proposal-card").filter({ hasText: proposalId });
  await expect(proposalCard).toHaveCount(1);
  await proposalCard.getByRole("button", { name: "承認して Checkpoint" }).click();
  await expect(proposalCard.getByText(/ローカル Checkpoint 済み/u)).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).some((record) =>
    record.operationId === operationId && record.generation === 1 && record.state === "checkpointed" && record.authorScope === "owner",
  )).toBe(true);
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toBeEnabled();
  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expect.poll(async () => (await readJournal(page)).some((record) => record.operationId === operationId)).toBe(false);
  expect((await readPublicationReceipts(page)).some((receipt) => receipt.state === "confirmed" &&
    receipt.acknowledged.some((item) => item.operationId === operationId && item.generation === 1))).toBe(true);

  const afterPublishObservation = await page.request.get(new URL(projectPath + "/observation", page.url()).toString());
  const afterPublish = await afterPublishObservation.json() as { snapshot: { remoteCommit: string } };
  const publishedStatusResponse = await page.request.get(new URL(projectPath + "/proposals/" + encodeURIComponent(proposalId), page.url()).toString());
  expect(publishedStatusResponse.ok()).toBe(true);
  const publishedStatus = await publishedStatusResponse.json() as { publishedOperationIds: string[] };
  expect(publishedStatus.publishedOperationIds).toContain(operationId);
  const publishedSceneResponse = await page.request.get(new URL(
    projectPath + "/scenes/scene-1?view=remote&snapshot=" + encodeURIComponent(afterPublish.snapshot.remoteCommit),
    page.url(),
  ).toString());
  const publishedScene = await publishedSceneResponse.json() as { document: { content: string } };
  expect(publishedScene.document.content).toContain(generatedText);
  expect((await readProposalJournal(page)).some((record) => record.proposal.id === proposalId)).toBe(false);
});


test("full browser MCP proposal payload is restored after Core data loss before review", async ({ page }) => {
  test.skip(Boolean(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1" || process.env.SCRIPTORIUM_E2E_BASE_URL || process.env.SCRIPTORIUM_BASE_URL),
    "This recovery acceptance resets only the disposable local Core data directory.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await openFixtureProject(page, await signIn(page));

  const origin = new URL(page.url()).origin;
  const projectsResponse = await page.request.get(new URL("/api/projects", origin).toString());
  const projects = await projectsResponse.json() as Array<{ id: string }>;
  const projectId = projects[0]?.id;
  expect(projectId).toBeTruthy();
  const projectPath = "/api/projects/" + encodeURIComponent(projectId!);
  const observationResponse = await page.request.get(new URL(projectPath + "/observation", origin).toString());
  const observation = await observationResponse.json() as {
    snapshot: { repository: { provider: "github" | "local"; repositoryId: string; defaultBranch: string; ownerScope: string; url: string }; remoteCommit: string };
  };
  const [firstSceneResponse, secondSceneResponse] = await Promise.all([
    page.request.get(new URL(projectPath + "/scenes/scene-1?view=remote&snapshot=" + encodeURIComponent(observation.snapshot.remoteCommit), origin).toString()),
    page.request.get(new URL(projectPath + "/scenes/scene-2?view=remote&snapshot=" + encodeURIComponent(observation.snapshot.remoteCommit), origin).toString()),
  ]);
  expect(firstSceneResponse.ok()).toBe(true);
  expect(secondSceneResponse.ok()).toBe(true);
  const firstScene = await firstSceneResponse.json() as { document: { path: string; content: string; revision: string | null } };
  const secondScene = await secondSceneResponse.json() as { document: { path: string; content: string; revision: string | null } };
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const proposalId = "mcp-recovery-" + suffix;
  const firstOperationId = "mcp-recovery-first-" + suffix;
  const remainingOperationId = "mcp-recovery-rest-" + suffix;
  const firstText = "Accepted before Core recovery.";
  const remainingText = "Unapproved content recovered from the browser.";
  const makeManuscriptOperation = (
    id: string,
    sceneId: string,
    document: { path: string; content: string; revision: string | null },
    text: string,
  ) => ({
    id,
    generation: 1,
    repository: observation.snapshot.repository,
    baseRemoteCommit: observation.snapshot.remoteCommit,
    effect: "manuscript",
    reads: [{ path: document.path, revision: document.revision }],
    writes: [{ path: document.path, revision: document.revision, content: document.content + "\n" + text + "\n" }],
    message: "loom(scene): " + sceneId + " MCP recovery\n\nLoom-Manuscript: " + sceneId + "\nLoom-File: " + document.path + "\nLoom-Char-Count: " + text.length,
  });
  const firstOperation = makeManuscriptOperation(firstOperationId, "scene-1", firstScene.document, firstText);
  const remainingOperation = makeManuscriptOperation(remainingOperationId, "scene-2", secondScene.document, remainingText);
  const evidence = {
    id: "mcp-recovery-evidence-" + suffix,
    snapshot: observation.snapshot,
    module: "mcp",
    kind: "external-proposal",
    paths: [
      { path: firstScene.document.path, revision: firstScene.document.revision },
      { path: secondScene.document.path, revision: secondScene.document.revision },
    ],
    details: { intent: "restore the complete MCP proposal before owner review" },
  };
  const proposal = {
    id: proposalId,
    snapshot: observation.snapshot,
    operations: [firstOperation, remainingOperation],
    evidence: [evidence],
  };
  const bearerProposal = await fetch(new URL(projectPath + "/proposals", origin), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + authToken },
    body: JSON.stringify(proposal),
  });
  expect(bearerProposal.status).toBe(201);
  expect(await bearerProposal.json()).toMatchObject({ id: proposalId, source: "mcp" });
  await openWorkspaceReviewPanel(page);
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    return page.getByText(proposalId, { exact: false }).isVisible().catch(() => false);
  }).toBe(true);
  const original = (await readProposalJournal(page)).find((record) => record.proposal.id === proposalId);
  expect(original).toMatchObject({
    authorScope: "owner",
    proposal: { id: proposalId, source: "mcp", evidence: [{ id: evidence.id, module: "mcp" }] },
    status: { payloadComplete: true, operationIds: [firstOperationId, remainingOperationId] },
  });
  expect(original?.proposal.operations).toHaveLength(2);
  expect(original?.proposal.operations[1]?.writes[0]?.content).toContain(remainingText);

  const ownerHeaders = { origin, "content-type": "application/json" };
  const approvalResponse = await page.request.post(new URL(projectPath + "/approvals", origin).toString(), {
    headers: ownerHeaders,
    data: { proposalId, operationIds: [firstOperationId], authorScope: "untrusted-client-value" },
  });
  expect(approvalResponse.status()).toBe(204);
  const checkpointResponse = await page.request.post(new URL(projectPath + "/checkpoints", origin).toString(), {
    headers: ownerHeaders,
    data: firstOperation,
  });
  expect(checkpointResponse.status()).toBe(201);
  const initialPublish = await page.request.post(new URL(projectPath + "/publish", origin).toString(), {
    headers: ownerHeaders,
    data: { batchId: "partial-recovery-" + suffix },
  });
  expect(initialPublish.status()).toBe(200);
  expect(await initialPublish.json()).toMatchObject({ state: "confirmed" });

  // Preserve IndexedDB and the synthetic Git remote while deleting the only Core copy of private data.
  await page.goto("about:blank");
  const e2ePort = Number.parseInt(process.env.SCRIPTORIUM_E2E_PORT ?? "4173", 10);
  const resetResponse = await fetch(`http://127.0.0.1:${e2ePort + 1}/__e2e/reset-core`, { method: "POST" });
  expect(resetResponse.status).toBe(204);
  const resetHealth = await fetch(new URL("/api/health", origin));
  expect(resetHealth.ok).toBe(true);

  // The disposable API restart clears its in-memory session along with Core; sign in again on the same origin.
  await signIn(page);
  const reRegisteredResponse = await page.request.post(new URL("/api/projects", origin).toString(), {
    headers: ownerHeaders,
    data: { url: repositoryUrl },
  });
  expect(reRegisteredResponse.status()).toBe(201);
  const reRegistered = await reRegisteredResponse.json() as { id: string };
  expect(reRegistered.id).not.toBe(projectId);
  const recoveredStatusesResponse = await page.request.get(
    new URL("/api/projects/" + encodeURIComponent(reRegistered.id) + "/proposals", origin).toString(),
  );
  expect(recoveredStatusesResponse.ok()).toBe(true);
  const recoveredStatuses = await recoveredStatusesResponse.json() as { proposals: Array<{
    proposal: { id: string; source: string; operations: Array<{ id: string }>; evidence?: unknown[] };
    payloadComplete?: boolean;
    operationIds?: string[];
  }> };
  const partial = recoveredStatuses.proposals.find((status) => status.proposal.id === proposalId);
  expect(partial).toMatchObject({
    payloadComplete: false,
    operationIds: [firstOperationId, remainingOperationId],
    proposal: { id: proposalId, source: "mcp", operations: [{ id: firstOperationId }] },
  });
  expect(partial?.proposal.evidence).toBeUndefined();

  let releaseProposalPoll!: () => void;
  let reportProposalPoll!: () => void;
  const proposalPollGate = new Promise<void>((resolve) => { releaseProposalPoll = resolve; });
  const proposalPollStarted = new Promise<void>((resolve) => { reportProposalPoll = resolve; });
  let heldProposalPoll = false;
  await page.route(`**/api/projects/${encodeURIComponent(reRegistered.id)}/proposals`, async (route) => {
    if (route.request().method() !== "GET" || heldProposalPoll) return route.continue();
    heldProposalPoll = true;
    const response = await route.fetch();
    reportProposalPoll();
    await proposalPollGate;
    await route.fulfill({ response });
  });
  await page.goto(new URL("/desktop/", origin).toString());
  try {
    await expect(page.locator(".project-button")).toHaveCount(1);
    await page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true }).click();
    await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible();
    await proposalPollStarted;
    // A second activation must share the request, then refresh the current navigation's review state.
    const secondTree = page.waitForResponse((response) => response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/projects/${reRegistered.id}/tree`);
    await page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true }).click();
    await secondTree;
    // The tree response alone precedes JSON decoding and activation completion.
    await expect(page.getByRole("button", { name: "Chapter One: Scene One", exact: true })).toBeEnabled();
  } finally { releaseProposalPoll(); }
  await expect.poll(async () => {
    const record = (await readProposalJournal(page)).find((item) => item.proposal.id === proposalId);
    return record?.status?.payloadComplete === true && record.proposal.operations.length === 2 &&
      record.status.publishedOperationIds?.includes(firstOperationId) === true &&
      record.proposal.source === "mcp" && record.proposal.evidence?.some((item) => item.id === evidence.id) === true;
  }).toBe(true);
  const recoveredRecord = (await readProposalJournal(page)).find((record) => record.proposal.id === proposalId);
  expect(recoveredRecord).toMatchObject({ authorScope: "owner", proposal: { id: proposalId, source: "mcp", evidence: [{ id: evidence.id }] } });
  expect(recoveredRecord?.status?.publishedOperationIds).toContain(firstOperationId);
  expect(recoveredRecord?.status?.operationIds).toEqual([firstOperationId, remainingOperationId]);
  expect(recoveredRecord?.status?.approvedOperationIds).toContain(firstOperationId);
  expect(recoveredRecord?.status?.approvedOperationIds).not.toContain(remainingOperationId);
  expect(recoveredRecord?.status?.checkpoints.map((receipt) => receipt.operationId)).toContain(firstOperationId);
  expect(recoveredRecord?.status?.checkpoints.map((receipt) => receipt.operationId)).not.toContain(remainingOperationId);

  const restoredStatusResponse = await page.request.get(new URL(
    "/api/projects/" + encodeURIComponent(reRegistered.id) + "/proposals/" + encodeURIComponent(proposalId), origin,
  ).toString());
  expect(restoredStatusResponse.ok()).toBe(true);
  const restoredStatus = await restoredStatusResponse.json() as {
    proposal: { id: string; source: string; operations: Array<{ id: string }>; evidence?: unknown[] };
    payloadComplete: boolean;
    stale: boolean;
    approvedOperationIds: string[];
    checkpoints: Array<{ operationId: string }>;
    publishedOperationIds: string[];
  };
  expect(restoredStatus).toMatchObject({
    payloadComplete: true,
    stale: true,
    proposal: { id: proposalId, source: "mcp", operations: [{ id: firstOperationId }, { id: remainingOperationId }], evidence: [{ id: evidence.id }] },
  });
  expect(restoredStatus.publishedOperationIds).toContain(firstOperationId);
  expect(restoredStatus.approvedOperationIds).not.toContain(remainingOperationId);

  await openWorkspaceReviewPanel(page);
  const proposalCard = page.locator(".proposal-card").filter({ hasText: proposalId });
  await expect(proposalCard).toBeVisible();
  await expect(proposalCard.getByText(/基準リモートが現在の HEAD より古くなっています/u)).toBeVisible();
  await expect(proposalCard.locator(".proposal-operation").filter({ hasText: remainingOperationId })).toContainText("承認待ち");
  await proposalCard.getByRole("button", { name: "承認して Checkpoint" }).click();
  await expect(page.locator(".proposal-review [role=alert]")).toContainText("repository changed after this proposal was created");
  const afterRejectedApprovalResponse = await page.request.get(new URL(
    "/api/projects/" + encodeURIComponent(reRegistered.id) + "/proposals/" + encodeURIComponent(proposalId), origin,
  ).toString());
  const afterRejectedApproval = await afterRejectedApprovalResponse.json() as typeof restoredStatus;
  expect(afterRejectedApproval.approvedOperationIds).not.toContain(remainingOperationId);
  expect(afterRejectedApproval.checkpoints.map((receipt) => receipt.operationId)).not.toContain(remainingOperationId);
  expect(afterRejectedApproval.publishedOperationIds).toContain(firstOperationId);
  const retainedProposal = (await readProposalJournal(page)).find((record) => record.proposal.id === proposalId);
  expect(retainedProposal?.proposal.operations.map((operation) => operation.id)).toEqual([firstOperationId, remainingOperationId]);
  expect(retainedProposal?.proposal.operations[1]?.writes[0]?.content).toContain(remainingText);
});

test("a remote update during author approval keeps the conflicting editor draft visible", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This conflict acceptance pushes only to the disposable local Git fixture.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await openFixtureProject(page, await signIn(page));

  const origin = new URL(page.url()).origin;
  const projectsResponse = await page.request.get(new URL("/api/projects", origin).toString());
  const projects = await projectsResponse.json() as Array<{ id: string }>;
  const projectId = projects[0]?.id;
  expect(projectId).toBeTruthy();
  const projectPath = "/api/projects/" + encodeURIComponent(projectId!);
  const appObservationCommits: string[] = [];
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.endsWith("/observation") || response.request().method() !== "GET") return;
    void response.json().then((body: { snapshot?: { remoteCommit?: string } }) => {
      if (body.snapshot?.remoteCommit) appObservationCommits.push(body.snapshot.remoteCommit);
    }).catch(() => undefined);
  });
  const authorText = "Protected author draft during remote update.";
  await page.locator(".cm-content").fill(authorText);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === authorText && entry.state === "draft")).toBe(true);

  let releaseApproval!: () => void;
  let signalApproval!: () => void;
  const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
  const approvalStarted = new Promise<void>((resolve) => { signalApproval = resolve; });
  let releaseFreshSceneRead!: () => void;
  let signalFreshSceneRead!: () => void;
  const freshSceneReadGate = new Promise<void>((resolve) => { releaseFreshSceneRead = resolve; });
  const freshSceneReadStarted = new Promise<void>((resolve) => { signalFreshSceneRead = resolve; });
  await page.route(/\/api\/projects\/[^/]+\/approvals$/u, async (route) => {
    if (route.request().method() === "POST") {
      signalApproval();
      await approvalGate;
    }
    await route.continue();
  });
  await page.route((url) => url.pathname.endsWith("/scenes/scene-1/views") && url.searchParams.has("snapshot"), async (route) => {
    signalFreshSceneRead();
    await freshSceneReadGate;
    await route.continue();
  });

  const checkpointClick = page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await approvalStarted;
  const repositoryRoot = await mkdtemp(join(tmpdir(), "scriptorium-e2e-conflict-"));
  const workingCopy = join(repositoryRoot, "work");
  const fixtureBranch = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main";
  let initialRemoteCommit: string | null = null;
  try {
    execFileSync("git", ["clone", "--quiet", repositoryUrl, workingCopy], { stdio: "ignore" });
    initialRemoteCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workingCopy, encoding: "utf8" }).trim();
    const manuscriptPath = join(workingCopy, "manuscript/vol-1/ch-1/scene-1.md");
    const remoteText = "External remote revision during author approval.";
    await writeFile(manuscriptPath, `# Scene One\n\nThe first line of the story.\n\n${remoteText}\n`, "utf8");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Scriptorium Acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Scriptorium Acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
    };
    execFileSync("git", ["add", "manuscript/vol-1/ch-1/scene-1.md"], { cwd: workingCopy, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "External conflict fixture update"], { cwd: workingCopy, env: gitEnv, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: workingCopy, stdio: "ignore" });
    const remoteCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workingCopy, encoding: "utf8" }).trim();

    const refreshed = await page.request.get(new URL(projectPath + "/observation", origin).toString());
    expect(refreshed.ok()).toBe(true);
    releaseApproval();
    await freshSceneReadStarted;
    const duringReadText = "New typing during the fresh conflict snapshot read.";
    await page.locator(".cm-content").fill(duringReadText);
    const freshReadResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname.endsWith("/scenes/scene-1/views") && url.searchParams.has("snapshot");
    });
    releaseFreshSceneRead();
    await freshReadResponse;
    await checkpointClick;

    await expect.poll(async () => (await readJournal(page)).find((entry) => entry.text === authorText)?.state).toBe("conflict");
    await expect.poll(() => appObservationCommits.includes(remoteCommit), { timeout: 5_000 }).toBe(true);
    await expect(page.locator(".loading")).toHaveCount(0);
    await expect(page.locator(".conflict")).toBeVisible();
    await expect(page.locator(".cm-content")).toHaveText(duringReadText);
    await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === duringReadText && entry.state === "draft")).toBe(true);
    await page.locator(".conflict summary").click();
    await expect(page.locator(".conflict")).toContainText(remoteText);
    await expect(page.getByRole("button", { name: "Checkpoint", exact: true })).toBeDisabled();
  } finally {
    releaseApproval();
    releaseFreshSceneRead();
    try {
      if (initialRemoteCommit) {
        const currentRemoteCommit = execFileSync("git", ["ls-remote", "origin", `refs/heads/${fixtureBranch}`], {
          cwd: workingCopy,
          encoding: "utf8",
        }).trim().split(/\s+/u)[0];
        if (currentRemoteCommit && currentRemoteCommit !== initialRemoteCommit) {
          // This test changes only its disposable local E2E remote. Restore its exact starting ref so
          // later browser tests continue to exercise the original synthetic manuscript.
          execFileSync("git", [
            "push",
            `--force-with-lease=refs/heads/${fixtureBranch}:${currentRemoteCommit}`,
            "origin",
            `${initialRemoteCommit}:refs/heads/${fixtureBranch}`,
          ], { cwd: workingCopy, stdio: "ignore" });
        }
      }
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
      // Core has also observed the temporary conflict commit; clear that disposable project cache
      // after restoring the bare ref so later tests start from the seed manuscript snapshot.
      if (process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY !== "1") {
        const e2ePort = Number.parseInt(process.env.SCRIPTORIUM_E2E_PORT ?? "4173", 10);
        const resetCore = await fetch(`http://127.0.0.1:${e2ePort + 1}/__e2e/reset-core`, { method: "POST" });
        expect(resetCore.status).toBe(204);
      }
    }
  }
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
  await openFixtureProject(page, await signIn(page));

  const canonicalBefore = await page.locator(".cm-content").textContent();
  await page.locator(".cm-content").fill("This edit cannot be journaled because the browser is full.");
  await expect(page.locator(".topbar-status")).toContainText("Browser storage is full");
  await expect(page.getByRole("button", { name: "Checkpoint", exact: true })).toBeDisabled();

  const unloadDialog = page.waitForEvent("dialog");
  const projectsLoaded = waitForProjectList(page);
  const reloading = page.reload();
  const dialog = await unloadDialog;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await reloading;
  await openFixtureProject(page, await projectsLoaded);
  await expect(page.locator(".cm-content")).toHaveText(canonicalBefore ?? "");
});

test("project details, reconstruction, and guarded removal preserve browser recovery", async ({ page }) => {
  test.skip(Boolean(process.env.SCRIPTORIUM_E2E_BASE_URL || process.env.SCRIPTORIUM_BASE_URL),
    "This lifecycle acceptance mutates only the local disposable Core data directory.");
  test.skip(/^(?:https?|file):/u.test(repositoryUrl),
    "The lifecycle acceptance needs a disposable local bare-repository fixture.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  const isolatedDirectory = await mkdtemp(join(tmpdir(), "scriptorium-e2e-lifecycle-"));
  const isolatedRepository = join(isolatedDirectory, "origin.git");
  const isolatedWorktree = join(isolatedDirectory, "worktree");
  execFileSync("git", ["clone", "--quiet", repositoryUrl, isolatedWorktree], { stdio: "ignore" });
  execFileSync("git", ["checkout", "--quiet", "--orphan", "lifecycle-clean"], { cwd: isolatedWorktree, stdio: "ignore" });
  await rm(join(isolatedWorktree, "meta", "scriptorium"), { recursive: true, force: true });
  execFileSync("git", ["add", "--all"], { cwd: isolatedWorktree, stdio: "ignore" });
  execFileSync("git", [
    "-c", "user.name=Scriptorium E2E", "-c", "user.email=scriptorium-e2e@example.invalid",
    "commit", "--quiet", "-m", "Create isolated lifecycle fixture",
  ], { cwd: isolatedWorktree, stdio: "ignore" });
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", isolatedRepository], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "lifecycle", isolatedRepository], { cwd: isolatedWorktree, stdio: "ignore" });
  execFileSync("git", ["push", "--quiet", "lifecycle", "lifecycle-clean:main"], { cwd: isolatedWorktree, stdio: "ignore" });
  const isolatedRepositoryUrl = pathToFileURL(isolatedRepository).href;

  try {
    await signIn(page);
    await page.getByLabel("GitHub リポジトリ URL").fill(isolatedRepositoryUrl);
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
    await expect(page.getByRole("button", { name: projectLabel(isolatedRepository), exact: true }))
      .toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible();
    await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
    await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
    await expect(page.locator(".cm-content")).toBeVisible();

    const projectsResponse = await page.request.get(new URL("/api/projects", page.url()).toString());
    expect(projectsResponse.ok()).toBe(true);
    const projects = await projectsResponse.json() as Array<{ id: string; url: string }>;
    const projectId = projects.find((project) => project.url === isolatedRepository)?.id;
    expect(projectId).toBeTruthy();
    const projectDetailsResponse = await page.request.get(new URL(`/api/projects/${encodeURIComponent(projectId!)}`, page.url()).toString());
    expect(projectDetailsResponse.ok()).toBe(true);
    const projectDetails = await projectDetailsResponse.json() as {
      project: { url: string; branch: string };
      observation: { snapshot: { repository: { provider: string; repositoryId: string; defaultBranch: string } } };
    };
    const facts = page.locator(".project-facts");
    await expect(facts).toContainText(projectDetails.project.url);
    await expect(facts).toContainText(projectDetails.observation.snapshot.repository.repositoryId);
    await expect(facts).toContainText(projectDetails.observation.snapshot.repository.defaultBranch);

    const recoverableText = "Lifecycle recovery remains in the browser journal.";
    await page.locator(".cm-content").fill(recoverableText);
    await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === recoverableText && entry.state === "draft")).toBe(true);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "ローカルクローンを再構築" }).click();
    await expect(page.locator(".topbar-status")).toContainText("に確認");
    await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === recoverableText && entry.state === "draft")).toBe(true);

    const stateDir = process.env.SCRIPTORIUM_E2E_STATE_DIR;
    expect(stateDir).toBeTruthy();
    const dirtyMarker = join(stateDir!, "store", "projects", projectId!, "e2e-dirty-guard.md");
    await writeFile(dirtyMarker, "preserve local data\n", "utf8");
    try {
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "作品の登録を解除" }).click();
      const dirtyWorkspaceError = page.locator('[role="alert"][data-code="working_tree_dirty"]');
      await expect(dirtyWorkspaceError).toBeVisible();
      await expect(dirtyWorkspaceError).toContainText("working_tree_dirty");
      await expect(page.getByRole("button", { name: projectLabel(isolatedRepository), exact: true })).toBeVisible();
      expect((await readJournal(page)).some((entry) => entry.text === recoverableText && entry.state === "draft")).toBe(true);
    } finally {
      await rm(dirtyMarker, { force: true });
    }

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "作品の登録を解除" }).click();
    await expect(page.getByRole("button", { name: projectLabel(isolatedRepository), exact: true })).toHaveCount(0);
    const recoveryPanel = page.locator(".sidebar .recovery-panel");
    await expect(recoveryPanel.getByRole("heading", { name: "ブラウザーの回復記録" })).toBeVisible();
    await expect(recoveryPanel.locator(".recovery-list")).toContainText("manuscript/vol-1/ch-1/scene-1.md");
    expect((await readJournal(page)).some((entry) => entry.text === recoverableText && entry.state === "draft")).toBe(true);
  } finally {
    await rm(isolatedDirectory, { recursive: true, force: true });
  }
});

test("unmounting a contribution aborts its in-flight action request", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_PROFILE !== "full", "The publishing contribution is selected by the full profile.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  let resolveObserved!: (request: import("@playwright/test").Request) => void;
  const observed = new Promise<import("@playwright/test").Request>((resolve) => { resolveObserved = resolve; });
  let releaseRoute!: () => void;
  const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve; });
  await page.route("**/api/projects/*/actions/publishing.project.tree", async (route) => {
    resolveObserved(route.request());
    await routeGate;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: false }) });
    } catch { /* the browser should already have canceled this intercepted fetch */ }
  });

  try {
    await openFixtureProject(page, await signIn(page));
    const publishingPanel = await openWorkspaceContributionPanel(page, "publishing.export.epub", "EPUB 書き出し");
    await expect(publishingPanel.locator('[data-contribution="publishing.export.epub"]')).toBeVisible();
    const actionRequest = await observed;
    const failedRequest = page.waitForEvent("requestfailed", (request) => request === actionRequest);
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
    const canceled = await failedRequest;
    expect(canceled.failure()?.errorText).toMatch(/ERR_ABORTED/u);
  } finally {
    releaseRoute();
    await page.unroute("**/api/projects/*/actions/publishing.project.tree");
  }
});

test("a pending scratch image read is flushed to its captured scene before navigation", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await page.addInitScript(() => {
    const originalRead = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob): void {
      const reader = this;
      window.setTimeout(() => originalRead.call(reader, blob), 1_000);
    };
  });
  await openFixtureProject(page, await signIn(page));
  await page.locator(".scratch-panel summary").click();
  await page.getByLabel("本文に含まれないメモ").fill("Attachment belongs to Scene One.");
  await page.getByLabel("スクラッチ画像を添付").setInputFiles({
    name: "delayed-capture.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).some((entry) =>
    entry.documentPath.startsWith("meta/scratch/") && entry.sceneId === "scene-1" && entry.attachmentWrites === 1,
  )).toBe(true);
  const scratch = (await readJournal(page)).find((entry) => entry.documentPath.startsWith("meta/scratch/"));
  expect(scratch?.sceneId).toBe("scene-1");
  expect(scratch?.text).toBe("Attachment belongs to Scene One.");
});

test("resuming an older scratch generation cannot replace newer unprotected input", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await openFixtureProject(page, await signIn(page));
  await page.locator(".scratch-panel summary").click();

  const scratch = page.getByLabel("本文に含まれないメモ");
  const olderText = "Protected older scratch generation.";
  await scratch.fill(olderText);
  await page.locator(".cm-content").click();
  await expect.poll(async () => (await readJournal(page)).some((entry) =>
    entry.documentPath.startsWith("meta/scratch/") && entry.text === olderText && entry.state === "draft",
  )).toBe(true);
  const olderEntry = (await readJournal(page)).find((entry) => entry.text === olderText);
  expect(olderEntry).toBeTruthy();

  await scratch.fill("Intermediate scratch input during rapid editing.");
  const newerText = "Newer scratch input still inside the write debounce.";
  await scratch.fill(newerText);
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける" }).click();

  await expect(scratch).toHaveValue(newerText);
  await expect(page.locator(".scratch-panel [role=alert]")).toContainText("新しい入力");
  await expect.poll(async () => (await readJournal(page)).some((entry) =>
    entry.operationId === olderEntry!.operationId && entry.generation > olderEntry!.generation && entry.text === newerText,
  )).toBe(true);
});

test("failed scratch protection refuses recovery selection and keeps the current error visible", async ({ page }) => {
  await page.addInitScript(() => {
    type FailureWindow = Window & { __failCurrentScratchWrite?: boolean; __failedCurrentScratchWrites?: number };
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const text = value && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text : "";
      const currentWindow = window as FailureWindow;
      if (this.transaction.db.name === "scriptorium-recovery" && this.name === "operations" &&
          currentWindow.__failCurrentScratchWrite && text.includes("forced scratch protection failure")) {
        currentWindow.__failedCurrentScratchWrites = (currentWindow.__failedCurrentScratchWrites ?? 0) + 1;
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
  await openFixtureProject(page, await signIn(page));
  await page.locator(".scratch-panel summary").click();

  const scratch = page.getByLabel("本文に含まれないメモ");
  const olderText = "Previously protected scratch remains available.";
  await scratch.fill(olderText);
  await page.locator(".cm-content").click();
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === olderText && entry.state === "draft")).toBe(true);
  const olderEntry = (await readJournal(page)).find((entry) => entry.text === olderText);
  expect(olderEntry).toBeTruthy();
  await page.evaluate(() => { (window as Window & { __failCurrentScratchWrite?: boolean }).__failCurrentScratchWrite = true; });

  const failedText = "This edit has a forced scratch protection failure.";
  await scratch.fill(failedText);
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける" }).click();
  await page.waitForFunction(() => ((window as Window & { __failedCurrentScratchWrites?: number }).__failedCurrentScratchWrites ?? 0) > 0);

  await expect(scratch).toHaveValue(failedText);
  await expect(page.locator(".scratch-panel [role=alert]")).toBeVisible();
  const journal = await readJournal(page);
  expect(journal.some((entry) => entry.operationId === olderEntry!.operationId && entry.generation === olderEntry!.generation && entry.text === olderText)).toBe(true);
  expect(journal.some((entry) => entry.text === failedText)).toBe(false);
});

test("resuming an older scratch entry waits for its pending image read and keeps the latest draft", async ({ page }) => {
  await page.addInitScript(() => {
    type ImageWindow = Window & { __pendingScratchReadStarted?: boolean };
    const originalRead = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob): void {
      const reader = this;
      (window as ImageWindow).__pendingScratchReadStarted = true;
      window.setTimeout(() => originalRead.call(reader, blob), 800);
    };
  });
  await openFixtureProject(page, await signIn(page));
  await page.locator(".scratch-panel summary").click();

  const scratch = page.getByLabel("本文に含まれないメモ");
  const olderText = "Older scratch with a protected generation.";
  await scratch.fill(olderText);
  await page.locator(".cm-content").click();
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === olderText && entry.state === "draft")).toBe(true);
  const olderEntry = (await readJournal(page)).find((entry) => entry.text === olderText);
  expect(olderEntry).toBeTruthy();

  const currentText = "Current scratch text with an image still being read.";
  await scratch.fill(currentText);
  await page.getByLabel("スクラッチ画像を添付").setInputFiles({
    name: "pending-note.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await page.waitForFunction(() => (window as Window & { __pendingScratchReadStarted?: boolean }).__pendingScratchReadStarted === true);
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける" }).click();

  await expect(scratch).toHaveValue(currentText);
  await expect.poll(async () => {
    const current = (await readJournal(page)).find((entry) => entry.text === currentText);
    return current?.attachmentWrites === 1 && current.operationId === olderEntry!.operationId && current.generation > olderEntry!.generation;
  }).toBe(true);
  await expect(page.locator(".scratch-panel [role=alert]")).toContainText("新しい入力");
});

test("scratch text and image selection pause while a recovery entry is being resumed", async ({ page }) => {
  await page.addInitScript(() => {
    type ResumeGate = { armed: boolean; started: boolean; target?: IDBTransaction; release?: () => void };
    type GateWindow = Window & { __scratchResumeGate?: ResumeGate; __scratchResumeImageReadStarted?: boolean };
    const gateWindow = window as GateWindow;
    gateWindow.__scratchResumeGate = { armed: false, started: false };

    const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    if (!transactionDescriptor?.get || !transactionDescriptor.set) throw new Error("IndexedDB completion hooks are unavailable in this browser.");
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      enumerable: transactionDescriptor.enumerable,
      get() { return transactionDescriptor.get!.call(this); },
      set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (!handler) {
          transactionDescriptor.set!.call(this, handler);
          return;
        }
        const transaction = this;
        transactionDescriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          const currentGate = (window as GateWindow).__scratchResumeGate;
          if (currentGate && currentGate.target === transaction) {
            currentGate.started = true;
            currentGate.release = () => {
              currentGate.target = undefined;
              handler.call(transaction, event);
            };
            return;
          }
          return handler.call(this, event);
        });
      },
    });

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const text = value && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text : "";
      const currentGate = (window as GateWindow).__scratchResumeGate;
      if (this.transaction.db.name === "scriptorium-recovery" && this.name === "operations" &&
          currentGate?.armed && text.includes("Current scratch write held during resume.")) {
        currentGate.armed = false;
        currentGate.target = this.transaction;
      }
      return originalPut.call(this, value, key);
    };

    const originalRead = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob): void {
      const reader = this;
      (window as GateWindow).__scratchResumeImageReadStarted = true;
      window.setTimeout(() => originalRead.call(reader, blob), 800);
    };
  });

  await openFixtureProject(page, await signIn(page));
  await page.locator(".scratch-panel summary").click();
  const scratch = page.getByLabel("本文に含まれないメモ");
  const olderText = "Saved scratch selected while another scratch is active.";
  await scratch.fill(olderText);
  await page.locator(".cm-content").click();
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === olderText && entry.state === "draft")).toBe(true);
  const olderEntry = (await readJournal(page)).find((entry) => entry.text === olderText);
  expect(olderEntry).toBeTruthy();

  const projectsLoaded = waitForProjectList(page);
  await page.reload();
  await openFixtureProject(page, await projectsLoaded);
  await page.locator(".scratch-panel summary").click();
  const currentText = "Current scratch write held during resume.";
  await scratch.fill(currentText);
  await page.evaluate(() => { (window as Window & { __scratchResumeGate?: { armed: boolean } }).__scratchResumeGate!.armed = true; });
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける" }).click();
  await page.waitForFunction(() => (window as Window & { __scratchResumeGate?: { started: boolean } }).__scratchResumeGate?.started === true);

  const imageInput = page.getByLabel("スクラッチ画像を添付");
  await expect(scratch).toBeDisabled();
  await expect(imageInput).toBeDisabled();
  expect(await page.evaluate(() => (window as Window & { __scratchResumeImageReadStarted?: boolean }).__scratchResumeImageReadStarted)).toBeUndefined();
  await page.evaluate(() => (window as Window & { __scratchResumeGate?: { release?: () => void } }).__scratchResumeGate!.release?.());

  await expect(scratch).toHaveValue(olderText);
  await expect(scratch).toBeEnabled();
  await expect(imageInput).toBeEnabled();
  await imageInput.setInputFiles({
    name: "during-resume.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await page.waitForFunction(() => (window as Window & { __scratchResumeImageReadStarted?: boolean }).__scratchResumeImageReadStarted === true);
  await expect(page.locator(".scratch-panel")).toContainText("画像 1 件");
  await scratch.click();
  await page.locator(".cm-content").click();
  await expect.poll(async () => {
    const journal = await readJournal(page);
    const latest = journal.find((entry) => entry.text === olderText);
    const retainedCurrent = journal.find((entry) => entry.text === currentText);
    return latest?.attachmentWrites === 1 && latest.operationId === olderEntry!.operationId &&
      latest.generation > olderEntry!.generation && retainedCurrent?.operationId !== olderEntry!.operationId;
  }).toBe(true);
});

test("public publishing route mounts its source reader without an owner session", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_PROFILE !== "full", "The publishing browser module is selected by the full profile.");
  const ownerSessionRequests: string[] = [];
  const publicReadRequests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/session") ownerSessionRequests.push(pathname);
    if (pathname.startsWith("/api/public/repos/")) publicReadRequests.push(pathname);
  });

  await page.goto("/r/publishing/123/e2e-invalid-token");
  await expect(page.getByRole("heading", { name: "共有された原稿" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("共有リンクは無効か、期限切れです。");
  await expect(page.getByRole("heading", { name: "ログイン" })).toHaveCount(0);
  expect(ownerSessionRequests).toEqual([]);
  expect(publicReadRequests).toEqual([
    "/api/public/repos/123/modules/publishing/share/e2e-invalid-token",
  ]);
});

test("late startup activation cannot report a false route error or replace explicit scene navigation", async ({ page }) => {
  await openFixtureProject(page, await signIn(page));
  const projectId = new URL(page.url()).pathname.match(/\/projects\/([^/]+)/u)?.[1];
  expect(projectId).toBeTruthy();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const admission = new Promise<void>((resolve) => { started = resolve; });
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  let first = true;
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (!first || route.request().method() !== "GET") return route.continue();
    first = false;
    const response = await route.fetch();
    started();
    await delayed;
    await route.fulfill({ response });
    completed();
  });
  try {
    await page.reload();
    await admission;
    await page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true }).click();
    await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible();
    await page.getByRole("button", { name: "Chapter One: Scene Two", exact: true }).click();
    const editor = page.locator(".cm-content[contenteditable=true]");
    await expect(editor).toBeVisible();
    const draft = "明示的に開いたシーンで、この続きを書いている。";
    await editor.fill(draft);
    await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === draft && entry.sceneId === "scene-2")).toBe(true);
    release();
    await completion;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".application-status")).not.toContainText("直接リンクのシーンが作品構成に見つからない");
    await expect(page).toHaveURL(/\/scenes\/scene-2/u);
    await expect(editor).toHaveText(draft);
  } finally {
    release();
  }
});

interface Issue42JournalGate {
  targetText: string | null;
  armed: boolean;
  started: boolean;
  release?: () => void;
}

interface Issue42DisposableRemote {
  root: string;
  bare: string;
  writer: string;
}

function issue42Git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function issue42GitIdentity(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Scriptorium Issue 42 Acceptance",
    GIT_AUTHOR_EMAIL: "issue-42@example.invalid",
    GIT_COMMITTER_NAME: "Scriptorium Issue 42 Acceptance",
    GIT_COMMITTER_EMAIL: "issue-42@example.invalid",
  };
}

async function issue42CreateDisposableRemote(): Promise<Issue42DisposableRemote> {
  const root = await mkdtemp(join(tmpdir(), "scriptorium-e2e-refresh-navigation-"));
  const bare = join(root, "origin.git");
  const writer = join(root, "writer");
  try {
    execFileSync("git", ["clone", "--quiet", "--bare", repositoryUrl, bare], { stdio: "ignore" });
    execFileSync("git", ["clone", "--quiet", bare, writer], { stdio: "ignore" });
    const actualBranch = issue42Git(writer, "rev-parse", "--abbrev-ref", "HEAD");
    if (actualBranch !== (process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main")) {
      throw new Error(`Unexpected disposable fixture branch ${actualBranch}`);
    }
    return { root, bare, writer };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function issue42RegisterDisposableProject(page: Page, remote: Issue42DisposableRemote): Promise<ProjectListEntry> {
  await page.getByLabel("GitHub リポジトリ URL").fill(pathToFileURL(remote.bare).href);
  const registration = page.waitForResponse((response) => response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/projects");
  await page.getByRole("button", { name: "リポジトリを登録" }).click();
  const registrationResponse = await registration;
  if (!registrationResponse.ok()) throw new Error(`Disposable project registration failed with HTTP ${registrationResponse.status()}`);
  await expect(page.getByRole("button", { name: remote.bare, exact: true })).toHaveAttribute("aria-current", "true", { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible({ timeout: 30_000 });
  const response = await page.request.get(new URL("/api/projects", page.url()).toString());
  if (!response.ok()) throw new Error(`Project list failed with HTTP ${response.status()}`);
  const projects = await response.json() as ProjectListEntry[];
  const project = projects.find((candidate) => candidate.url === remote.bare);
  if (!project) throw new Error("The disposable Git remote was not registered as a project.");
  await page.getByRole("button", { name: "Chapter One: Scene One", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await expect(page.locator(".cm-content")).toBeVisible();
  return project;
}

async function issue42InstallJournalGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type GatedTransaction = IDBTransaction & { __scriptoriumHoldComplete?: boolean };
    type GateWindow = Window & { __scriptoriumIssue42JournalGate?: Issue42JournalGate };
    const gate: Issue42JournalGate = { targetText: null, armed: false, started: false };
    (window as GateWindow).__scriptoriumIssue42JournalGate = gate;

    const transactionDescriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
    const originalPut = IDBObjectStore.prototype.put;
    if (!transactionDescriptor?.get || !transactionDescriptor.set) {
      throw new Error("IndexedDB completion hooks are unavailable in this browser.");
    }
    Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
      configurable: true,
      enumerable: transactionDescriptor.enumerable,
      get() { return transactionDescriptor.get!.call(this); },
      set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
        if (!handler) {
          transactionDescriptor.set!.call(this, handler);
          return;
        }
        const transaction = this as GatedTransaction;
        transactionDescriptor.set!.call(this, function (this: IDBTransaction, event: Event) {
          const currentGate = (window as GateWindow).__scriptoriumIssue42JournalGate;
          if (currentGate?.armed && transaction.__scriptoriumHoldComplete) {
            currentGate.started = true;
            currentGate.release = () => {
              currentGate.armed = false;
              handler.call(transaction, event);
            };
            return;
          }
          return handler.call(this, event);
        });
      },
    });
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const currentGate = (window as GateWindow).__scriptoriumIssue42JournalGate;
      if (this.name === "operations" && currentGate?.armed && currentGate.targetText &&
          typeof value === "object" && value !== null && "text" in value && value.text === currentGate.targetText) {
        (this.transaction as GatedTransaction).__scriptoriumHoldComplete = true;
      }
      return originalPut.call(this, value, key);
    };
  });
}

async function issue42PushRemoteSceneUpdate(remote: Issue42DisposableRemote, path: string, contents: string): Promise<string> {
  await writeFile(join(remote.writer, path), contents, "utf8");
  execFileSync("git", ["add", path], { cwd: remote.writer, stdio: "ignore" });
  execFileSync("git", ["commit", "--quiet", "-m", "Update disposable remote fixture"], {
    cwd: remote.writer,
    env: issue42GitIdentity(),
    stdio: "ignore",
  });
  execFileSync("git", ["push", "--quiet", "origin", `HEAD:${process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main"}`], {
    cwd: remote.writer,
    stdio: "ignore",
  });
  return issue42Git(remote.writer, "rev-parse", "HEAD");
}

function issue42Deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function issue42ReleaseJournalGate(page: Page): void {
  void page.evaluate(() => {
    const gate = (window as Window & { __scriptoriumIssue42JournalGate?: Issue42JournalGate }).__scriptoriumIssue42JournalGate;
    gate?.release?.();
  }).catch(() => undefined);
}

test("Issue 42: an updated remote cannot supersede explicit scene navigation during draft flush", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This acceptance pushes only to a generated disposable local bare remote.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await issue42InstallJournalGate(page);
  const remote = await issue42CreateDisposableRemote();
  const observationGate = issue42Deferred();
  try {
    await signIn(page);
    const project = await issue42RegisterDisposableProject(page, remote);
    const changedCommit = await issue42PushRemoteSceneUpdate(
      remote,
      "manuscript/vol-1/ch-1/scene-1.md",
      "# Scene One\n\nThe first line of the story.\n\nThe remote scene has a new revision.\n",
    );

    const observationStarted = issue42Deferred();
    let heldObservation = false;
    await page.route((url) => url.pathname === `/api/projects/${project.id}/observation`, async (route) => {
      if (route.request().method() !== "GET" || heldObservation) return route.continue();
      heldObservation = true;
      const response = await route.fetch();
      observationStarted.release();
      await observationGate.promise;
      await route.fulfill({ response });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await observationStarted.promise;

    const pendingText = "A protected draft while the remote refresh waits.";
    await page.evaluate((text) => {
      const gate = (window as Window & { __scriptoriumIssue42JournalGate?: Issue42JournalGate }).__scriptoriumIssue42JournalGate;
      if (!gate) throw new Error("The Issue 42 IndexedDB gate is missing.");
      gate.targetText = text;
      gate.armed = true;
    }, pendingText);
    await page.locator(".cm-content").fill(pendingText);
    await expect.poll(() => page.evaluate(() => Boolean(
      (window as Window & { __scriptoriumIssue42JournalGate?: Issue42JournalGate }).__scriptoriumIssue42JournalGate?.started,
    ))).toBe(true);
    await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === pendingText && entry.state === "draft")).toBe(true);

    const refreshedTree = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === `/api/projects/${project.id}/tree` &&
        url.searchParams.get("snapshot") === changedCommit;
    });
    observationGate.release();
    await refreshedTree;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.getByRole("button", { name: "Chapter One: Scene Two", exact: true }).click();
    await page.evaluate(() => {
      const gate = (window as Window & { __scriptoriumIssue42JournalGate?: Issue42JournalGate }).__scriptoriumIssue42JournalGate;
      if (!gate?.release) throw new Error("The real browser journal completion is not held.");
      gate.release();
    });

    await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".cm-content")).toContainText("The second line of the story.");
    expect((await readJournal(page)).some((entry) => entry.text === pendingText && entry.state === "draft")).toBe(true);
  } finally {
    observationGate.release();
    issue42ReleaseJournalGate(page);
    await rm(remote.root, { recursive: true, force: true });
  }
});

test("Issue 42: an unmodified remote observation leaves a newer explicit scene selection alone", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This acceptance uses a generated disposable local bare remote.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  const remote = await issue42CreateDisposableRemote();
  const observationGate = issue42Deferred();
  try {
    await signIn(page);
    const project = await issue42RegisterDisposableProject(page, remote);
    const observationStarted = issue42Deferred();
    const observationFinished = issue42Deferred();
    let heldObservation = false;
    let delayedSceneOneReads = 0;
    await page.route((url) => url.pathname === `/api/projects/${project.id}/observation`, async (route) => {
      if (route.request().method() !== "GET" || heldObservation) return route.continue();
      heldObservation = true;
      const response = await route.fetch();
      observationStarted.release();
      await observationGate.promise;
      await route.fulfill({ response });
      observationFinished.release();
    });
    await page.route((url) => url.pathname.endsWith("/scenes/scene-1/views") && url.searchParams.has("snapshot"), async (route) => {
      delayedSceneOneReads += 1;
      await route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await observationStarted.promise;
    await page.getByRole("button", { name: "Chapter One: Scene Two", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
    const sceneOneReadsAfterNavigation = delayedSceneOneReads;
    observationGate.release();
    await observationFinished.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".topbar-status")).not.toContainText("リモートの確認に失敗しました");
    await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
    expect(delayedSceneOneReads).toBe(sceneOneReadsAfterNavigation);
    const currentProject = await page.request.get(new URL(`/api/projects/${encodeURIComponent(project.id)}/observation`, page.url()).toString());
    expect(currentProject.ok()).toBe(true);
    const observed = await currentProject.json() as { snapshot: { remoteCommit: string } };
    expect(observed.snapshot.remoteCommit).toBe(issue42Git(remote.writer, "rev-parse", "HEAD"));
  } finally {
    observationGate.release();
    await rm(remote.root, { recursive: true, force: true });
  }
});

test("Issue 42: a failed hosted credential observation keeps the author session and recovers on a fresh observation", async ({ page }) => {
  test.skip(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1", "This acceptance uses a generated disposable local bare remote.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  const remote = await issue42CreateDisposableRemote();
  const observationGate = issue42Deferred();
  try {
    await signIn(page);
    const project = await issue42RegisterDisposableProject(page, remote);
    const observationStarted = issue42Deferred();
    const observationFinished = issue42Deferred();
    let heldObservation = false;
    let observationReads = 0;
    let refreshRequests = 0;
    let reauthRequests = 0;
    await page.route((url) => url.pathname === `/api/projects/${project.id}/observation`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      observationReads += 1;
      if (heldObservation) return route.continue();
      heldObservation = true;
      observationStarted.release();
      await observationGate.promise;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Repository credentials are temporarily unavailable", code: "git_credential_unavailable" }),
      });
      observationFinished.release();
    });
    await page.route("**/_platform/refresh", async (route) => {
      refreshRequests += 1;
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ code: "UNAUTHORIZED" }) });
    });
    await page.route("**/_platform/reauth", async (route) => {
      reauthRequests += 1;
      await route.fulfill({ status: 200, contentType: "text/html", body: "reauth fixture" });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await observationStarted.promise;
    await page.getByRole("button", { name: "Chapter One: Scene Two", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
    observationGate.release();
    await observationFinished.promise;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator(".topbar-status")).toContainText("リモートの確認に失敗しました");
    await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("The second line of the story.");
    expect(refreshRequests).toBe(0);
    expect(reauthRequests).toBe(0);

    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => observationReads, { message: "a fresh remote observation should run after connectivity returns" }).toBeGreaterThan(1);
    await expect(page.locator(".topbar-status")).not.toContainText("リモートの確認に失敗しました");
    await expect(page.locator(".cm-content")).toContainText("The second line of the story.");
    expect(refreshRequests).toBe(0);
    expect(reauthRequests).toBe(0);
  } finally {
    observationGate.release();
    await rm(remote.root, { recursive: true, force: true });
  }
});
