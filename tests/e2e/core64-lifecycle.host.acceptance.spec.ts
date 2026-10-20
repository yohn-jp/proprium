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
  journalRemovals: Array<{ authorScope: string; proposalId: string }>;
  journalRecords: Array<{ authorScope: string; proposalId: string }>;
  legacyProposalIds: string[];
  reviewStatusProposalIds: string[];
  dismissedProposalIds: string[];
  pendingJournalWrites: number;
  proposalApiRequests: number;
  proposalReinsertions: number;
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
  const apiSource = await readFile(resolve(repositoryRoot, "app/src/api.ts"));
  const journalSource = await readFile(resolve(repositoryRoot, "app/src/storage/journal.ts"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  await info.attach("ContributionHost.tsx", { body: source, contentType: "text/plain" });
  await info.attach("host-source-binding.txt", {
    body: [
      `commit=${commit}`,
      `path=${hostSourcePath}`,
      `sha256=${sourceHash}`,
      `apiSha256=${createHash("sha256").update(apiSource).digest("hex")}`,
      `journalSha256=${createHash("sha256").update(journalSource).digest("hex")}`,
      "apiPath=app/src/api.ts",
      "journalPath=app/src/storage/journal.ts",
      "",
    ].join("\n"),
    contentType: "text/plain",
  });
}

async function installProposalRoute(page: Page): Promise<void> {
  await page.route("**/api/projects/project-1/proposals", async (route) => {
    await page.evaluate(() => {
      (window as unknown as { __core64HostLifecycle: { metrics: Metrics } })
        .__core64HostLifecycle.metrics.proposalApiRequests += 1;
    });
    if (new URL(page.url()).searchParams.has("defer-proposal-api")) {
      await page.evaluate(() => new Promise<void>((resolve) => {
        const harness = (window as unknown as {
          __core64HostLifecycle: { resolveProposalApi: (() => void) | null };
        }).__core64HostLifecycle;
        harness.resolveProposalApi = () => {
          harness.resolveProposalApi = null;
          resolve();
        };
      }));
    }
    const proposal = route.request().postDataJSON();
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        // Mirror the production cookie-owner endpoint, which never accepts client source attribution.
        body: JSON.stringify({ ...proposal, source: "author" }),
      });
    } catch {
      // The actual host can abort this held request before the fixture releases it.
    }
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

test("actual ContributionHost keeps disabled module unloaded, then cleans it up on disable", async ({ page }, info) => {
  await openHost(page, "?start-disabled");
  await expect(page.getByLabel("機能を選択")).toHaveCount(0);
  const whileDisabled = await metrics(page);
  expect(whileDisabled.loaderCalls).toBe(0);
  expect(whileDisabled.mountCalls).toBe(0);
  expect([whileDisabled.activeTimers, whileDisabled.activeRequests, whileDisabled.activeWorkers]).toEqual([0, 0, 0]);
  await info.attach("disabled-module-metrics.json", {
    body: JSON.stringify(whileDisabled, null, 2),
    contentType: "application/json",
  });

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
  await info.attach("after-disable-metrics.json", {
    body: JSON.stringify(afterDisable, null, 2),
    contentType: "application/json",
  });
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
  expect(afterLateCallback.journalRemovals).toEqual([]);
  expect(afterLateCallback.journalRecords).toEqual([]);
  expect(afterLateCallback.proposalApiRequests).toBe(0);
  expect(afterLateCallback.lateCallbackOutcomes).toEqual(["rejected"]);

  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  const finalMetrics = await metrics(page);
  expect(finalMetrics.signalAborts).toBe(2);
  expect(finalMetrics.disposeCalls).toBe(2);
});

test("actual host removes an old-author journal write that completes after abort", async ({ page }, info) => {
  await openHost(page, "?defer-first-journal&proposal-on-first-mount");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).pendingJournalWrites).toBe(1);
  await expectActiveResources(page, 1);

  await page.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByLabel("Current author")).toHaveText("author-new");
  await waitForMounts(page, 2);
  await expect.poll(async () => (await metrics(page)).signalAborts).toBe(1);
  await expectActiveResources(page, 1);
  const beforeJournalResolve = await metrics(page);
  expect(beforeJournalResolve.journalWrites).toEqual([]);
  expect(beforeJournalResolve.proposalApiRequests).toBe(0);
  expect(beforeJournalResolve.disposeCalls).toBe(0);

  await page.getByRole("button", { name: "Resolve deferred journal write" }).click();
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes.length).toBe(1);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  const afterJournalResolve = await metrics(page);
  await info.attach("in-flight-journal-metrics.json", {
    body: JSON.stringify(afterJournalResolve, null, 2),
    contentType: "application/json",
  });
  expect(afterJournalResolve.lateCallbackOutcomes).toEqual(["rejected"]);
  expect(afterJournalResolve.journalWrites).toHaveLength(1);
  expect(afterJournalResolve.journalWrites[0]?.authorScope).toBe("author-old");
  expect(afterJournalResolve.journalRemovals).toEqual(afterJournalResolve.journalWrites);
  expect(afterJournalResolve.journalRecords).toEqual([]);
  expect(afterJournalResolve.proposalApiRequests).toBe(0);
  expect(afterJournalResolve.pendingJournalWrites).toBe(0);

  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  const finalMetrics = await metrics(page);
  expect(finalMetrics.signalAborts).toBe(2);
  expect(finalMetrics.disposeCalls).toBe(2);
});


test("owner module proposal reconciles the server-assigned author source without an IDB conflict", async ({ page }) => {
  await openHost(page, "?proposal-on-first-mount");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes).toEqual(["resolved"]);
  const result = await metrics(page);
  expect(result.proposalApiRequests).toBe(1);
  expect(result.journalWrites).toHaveLength(1);
  expect(result.journalRemovals).toEqual([]);
  expect(result.journalRecords).toEqual([{
    authorScope: "author-old", proposalId: result.journalWrites[0]!.proposalId,
  }]);
  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
});

test("an aborted proposal POST retains its strict journal record for Core reconciliation", async ({ page }) => {
  await openHost(page, "?defer-proposal-api&proposal-on-first-mount");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).proposalApiRequests).toBe(1);
  await expect.poll(async () => (await metrics(page)).journalWrites.length).toBe(1);
  const pending = await metrics(page);
  const proposalId = pending.journalWrites[0]!.proposalId;

  await page.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByLabel("Current author")).toHaveText("author-new");
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes).toEqual(["rejected"]);
  const afterAbort = await metrics(page);
  expect(afterAbort.journalRemovals).toEqual([]);
  expect(afterAbort.journalRecords).toEqual([{ authorScope: "author-old", proposalId }]);
  expect(afterAbort.proposalApiRequests).toBe(1);
  // Release the intercepted request after cancellation; it may already have reached Core.
  await page.getByRole("button", { name: "Resolve deferred proposal API" }).click();
  await expect.poll(async () => (await metrics(page)).journalRecords).toEqual([{ authorScope: "author-old", proposalId }]);
  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
});

test("actual host preserves a preexisting proposal when its module callback is cancelled", async ({ page }, info) => {
  await openHost(page, "?preexisting-proposal&defer-proposal-api&proposal-on-first-mount");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).proposalApiRequests).toBe(1);
  await expectActiveResources(page, 1);

  await page.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByLabel("Current author")).toHaveText("author-new");
  await waitForMounts(page, 2);
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes.length).toBe(1);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  await expect.poll(async () => (await metrics(page)).signalAborts).toBe(1);
  await expectActiveResources(page, 1);
  const afterAbort = await metrics(page);
  await info.attach("preexisting-proposal-metrics.json", {
    body: JSON.stringify(afterAbort, null, 2),
    contentType: "application/json",
  });
  expect(afterAbort.lateCallbackOutcomes).toEqual(["rejected"]);
  expect(afterAbort.journalWrites).toEqual([]);
  expect(afterAbort.journalRemovals).toEqual([]);
  expect(afterAbort.journalRecords).toEqual([{ authorScope: "author-old", proposalId: "preexisting-proposal-id" }]);
  expect(afterAbort.legacyProposalIds).toEqual(["preexisting-proposal-id"]);
  expect(afterAbort.proposalApiRequests).toBe(1);

  await page.getByRole("button", { name: "Resolve deferred proposal API" }).click();
  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  const finalMetrics = await metrics(page);
  expect(finalMetrics.signalAborts).toBe(2);
  expect(finalMetrics.disposeCalls).toBe(2);
});

test("actual host preserves a proposal with newer author review state after cancellation", async ({ page }, info) => {
  await openHost(page, "?defer-proposal-api&proposal-on-first-mount");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).proposalApiRequests).toBe(1);
  await expect.poll(async () => (await metrics(page)).journalWrites.length).toBe(1);
  await page.getByRole("button", { name: "Mark proposal reviewed" }).click();
  await expect.poll(async () => (await metrics(page)).reviewStatusProposalIds.length).toBe(1);

  await page.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByLabel("Current author")).toHaveText("author-new");
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes.length).toBe(1);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  const afterAbort = await metrics(page);
  await info.attach("reviewed-proposal-metrics.json", {
    body: JSON.stringify(afterAbort, null, 2),
    contentType: "application/json",
  });
  const proposalId = afterAbort.journalWrites[0]?.proposalId;
  expect(afterAbort.lateCallbackOutcomes).toEqual(["rejected"]);
  expect(afterAbort.journalRemovals).toEqual([]);
  expect(afterAbort.journalRecords).toEqual([{ authorScope: "author-old", proposalId }]);
  expect(afterAbort.reviewStatusProposalIds).toEqual([proposalId]);

  await page.getByRole("button", { name: "Resolve deferred proposal API" }).click();
  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  expect((await metrics(page)).disposeCalls).toBe(2);
});

test("actual host preserves a dismissed proposal after its callback is cancelled", async ({ page }, info) => {
  await openHost(page, "?defer-proposal-api&proposal-on-first-mount");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).proposalApiRequests).toBe(1);
  await expect.poll(async () => (await metrics(page)).journalWrites.length).toBe(1);
  await page.getByRole("button", { name: "Dismiss proposal" }).click();
  await expect.poll(async () => (await metrics(page)).dismissedProposalIds.length).toBe(1);

  await page.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByLabel("Current author")).toHaveText("author-new");
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes.length).toBe(1);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  const afterAbort = await metrics(page);
  await info.attach("dismissed-proposal-metrics.json", {
    body: JSON.stringify(afterAbort, null, 2),
    contentType: "application/json",
  });
  const proposalId = afterAbort.journalWrites[0]?.proposalId;
  expect(afterAbort.lateCallbackOutcomes).toEqual(["rejected"]);
  expect(afterAbort.journalRemovals).toEqual([]);
  expect(afterAbort.journalRecords).toEqual([{ authorScope: "author-old", proposalId }]);
  expect(afterAbort.dismissedProposalIds).toEqual([proposalId]);

  await page.getByRole("button", { name: "Resolve deferred proposal API" }).click();
  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  expect((await metrics(page)).disposeCalls).toBe(2);
});

test("actual host preserves a newer same-ID proposal version after cancellation", async ({ page }, info) => {
  await openHost(page, "?defer-proposal-api&proposal-on-first-mount");
  await selectContribution(page);
  await expect.poll(async () => (await metrics(page)).proposalApiRequests).toBe(1);
  await expect.poll(async () => (await metrics(page)).journalWrites.length).toBe(1);
  await page.getByRole("button", { name: "Replace proposal with same ID" }).click();
  await expect.poll(async () => (await metrics(page)).proposalReinsertions).toBe(1);

  await page.getByRole("button", { name: "Change author" }).click();
  await expect(page.getByLabel("Current author")).toHaveText("author-new");
  await expect.poll(async () => (await metrics(page)).lateCallbackOutcomes.length).toBe(1);
  await expect.poll(async () => (await metrics(page)).disposeCalls).toBe(1);
  const afterAbort = await metrics(page);
  await info.attach("reinserted-proposal-metrics.json", {
    body: JSON.stringify(afterAbort, null, 2),
    contentType: "application/json",
  });
  const proposalId = afterAbort.journalWrites[0]?.proposalId;
  expect(afterAbort.lateCallbackOutcomes).toEqual(["rejected"]);
  expect(afterAbort.journalRemovals).toEqual([]);
  expect(afterAbort.journalRecords).toEqual([{ authorScope: "author-old", proposalId }]);
  expect(afterAbort.proposalReinsertions).toBe(1);

  await page.getByRole("button", { name: "Resolve deferred proposal API" }).click();
  await page.getByRole("button", { name: "Unmount host" }).click();
  await expectActiveResources(page, 0);
  expect((await metrics(page)).disposeCalls).toBe(2);
});
