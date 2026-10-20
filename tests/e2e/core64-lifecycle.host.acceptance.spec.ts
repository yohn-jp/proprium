import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hostSourcePath = resolve(repositoryRoot, "app/src/contributions/ContributionHost.tsx");
const fixturePath = "/tests/e2e/core64-lifecycle/host-fixture.html";

type Metrics = {
  loaderCalls: number;
  mountCalls: number;
  mountAuthors: string[];
  signalAborts: number;
  disposeCalls: number;
  activeTimers: number;
  timerTicks: number;
  activeRequests: number;
  activeWorkers: number;
  workersReady: number;
  lateCallbackAttempts: number;
  lateCallbackOutcomes: string[];
  journalWrites: Array<{ authorScope: string; proposalId: string }>;
  proposalStoredEvents: number;
};

async function metrics(page: Page): Promise<Metrics> {
  return page.evaluate(() => (window as unknown as {
    __core64HostLifecycle: { metrics: Metrics };
  }).__core64HostLifecycle.metrics);
}

async function attachHostSourceBinding(info: TestInfo): Promise<void> {
  const source = await readFile(hostSourcePath);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  await info.attach("ContributionHost.tsx", { body: source, contentType: "text/plain" });
  await info.attach("host-source-binding.txt", {
    body: `commit=${commit}\npath=${hostSourcePath}\nsha256=${sourceHash}\n`,
    contentType: "text/plain",
  });
}

async function installProposalRoute(page: Page): Promise<void> {
  await page.route("**/api/projects/project-1/proposals", async (route) => {
    const proposal = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(proposal),
    });
  });
}

async function openHost(page: Page, query = ""): Promise<void> {
  const hostModule = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/app/src/contributions/ContributionHost.tsx") && response.ok());
  await page.goto(`${fixturePath}${query}`);
  expect((await hostModule).status()).toBe(200);
}

async function selectContribution(page: Page): Promise<void> {
  const selector = page.getByLabel("機能を選択");
  await expect(selector).toBeVisible({ timeout: 5_000 });
  await selector.selectOption("publishing.lifecycle-fixture");
  await expect(page.locator('[data-contribution="publishing.lifecycle-fixture"]')).toBeAttached();
}

async function expectActiveResources(page: Page, expected: number): Promise<void> {
  await expect.poll(async () => {
    const current = await metrics(page);
    return [
      current.activeTimers,
      current.activeRequests,
      current.activeWorkers,
      current.workersReady - current.mountCalls,
    ];
  }).toEqual([expected, expected, expected, 0]);
}

async function waitForMounts(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await metrics(page)).mountCalls).toBe(count);
}

test.beforeEach(async ({ page }, info) => {
  await attachHostSourceBinding(info);
  await installProposalRoute(page);
});

test("actual ContributionHost keeps disabled module unloaded, then cleans it up on disable", async ({ page }) => {
  await openHost(page, "?start-disabled");
  await expect(page.getByLabel("機能を選択")).toHaveCount(0);
  const whileDisabled = await metrics(page);
  expect(whileDisabled.loaderCalls).toBe(0);
  expect(whileDisabled.mountCalls).toBe(0);
  expect([whileDisabled.activeTimers, whileDisabled.activeRequests, whileDisabled.activeWorkers]).toEqual([0, 0, 0]);

  await page.getByRole("button", { name: "Enable fixture module" }).click();
  await selectContribution(page);
  await expectActiveResources(page, 1);
  expect((await metrics(page)).loaderCalls).toBe(1);

  await page.getByRole("button", { name: "Disable fixture module" }).click();
  await expect(page.getByLabel("機能を選択")).toHaveCount(0);
  await expectActiveResources(page, 0);
  await expect.poll(async () => (await metrics(page)).signalAborts).toBe(1);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  const afterDisable = await metrics(page);
  expect(afterDisable.loaderCalls).toBe(1);
  expect(afterDisable.mountCalls).toBe(1);
});

test("actual ContributionHost lazily mounts and aborts/disposes timer, request, and worker on unmount", async ({ page }) => {
  const hostModule = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/app/src/contributions/ContributionHost.tsx") && response.ok());
  await page.goto(fixturePath);
  expect((await hostModule).status()).toBe(200);
  const beforeSelection = await metrics(page);
  expect(beforeSelection.loaderCalls).toBe(0);
  expect(beforeSelection.mountCalls).toBe(0);
  expect([beforeSelection.activeTimers, beforeSelection.activeRequests, beforeSelection.activeWorkers]).toEqual([0, 0, 0]);

  await selectContribution(page);
  await expectActiveResources(page, 1);
  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  const afterUnmount = await metrics(page);
  expect(afterUnmount.signalAborts).toBe(1);
  expect(afterUnmount.disposeCalls).toBe(1);
});

test("actual ContributionHost aborts/disposes the old contribution when the scene snapshot changes", async ({ page }) => {
  await openHost(page);
  await selectContribution(page);
  await expectActiveResources(page, 1);

  await page.getByRole("button", { name: "Change scene snapshot" }).click();
  await waitForMounts(page, 2);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  await expect.poll(async () => (await metrics(page)).signalAborts).toBe(1);
  await expectActiveResources(page, 1);

  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  const afterUnmount = await metrics(page);
  expect(afterUnmount.signalAborts).toBe(2);
  expect(afterUnmount.disposeCalls).toBe(2);
});

test("late mount cleanup after author change cannot journal a proposal into the old author scope", async ({ page }, info) => {
  await openHost(page, "?defer-first-mount&late-proposal");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).mountCalls).toBe(1);
  await expectActiveResources(page, 1);

  await page.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByLabel("Current author")).toHaveText("author-new");
  await waitForMounts(page, 2);
  await expect.poll(async () => (await metrics(page)).signalAborts).toBe(1);
  await expectActiveResources(page, 1);

  const afterAuthorChange = await metrics(page);
  expect(afterAuthorChange.mountAuthors).toEqual(["author-old", "author-new"]);
  expect(afterAuthorChange.disposeCalls).toBe(0);

  await page.getByRole("button", { name: "Resolve deferred mount" }).click();
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes.length).toBe(1);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  const afterLateCallback = await metrics(page);
  expect(afterLateCallback.lateCallbackAttempts).toBe(1);
  await info.attach("late-callback-metrics.json", {
    body: JSON.stringify(afterLateCallback, null, 2),
    contentType: "application/json",
  });
  expect(afterLateCallback.journalWrites).toEqual([]);
  expect(afterLateCallback.lateCallbackOutcomes).toEqual(["rejected"]);

  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  const finalMetrics = await metrics(page);
  expect(finalMetrics.signalAborts).toBe(2);
  expect(finalMetrics.disposeCalls).toBe(2);
});
