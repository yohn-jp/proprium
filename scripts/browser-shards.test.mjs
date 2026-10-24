import test from "node:test";
import assert from "node:assert/strict";
import { BROWSER_SHARDS, PROFILES } from "./ci-contract.mjs";
import { buildBrowserTestArguments, resolveBrowserShard, summarizeBrowserCoverage } from "./browser-shards.mjs";

test("the browser matrix resolves all seven Chromium specs and the WebKit UI spec for both profiles", () => {
  assert.deepEqual(PROFILES, ["core", "full"]);
  assert.deepEqual(BROWSER_SHARDS, [
    { id: "auth-recovery", project: "chromium", file: "auth-recovery.acceptance.spec.ts" },
    { id: "core", project: "chromium", file: "core.acceptance.spec.ts" },
    { id: "job-inbox", project: "chromium", file: "job-inbox.acceptance.spec.ts" },
    { id: "modular-workspace", project: "chromium", file: "modular-workspace.acceptance.spec.ts" },
    { id: "recent-activity", project: "chromium", file: "recent-activity.acceptance.spec.ts" },
    { id: "review-contributions", project: "chromium", file: "review-contributions.acceptance.spec.ts" },
    { id: "ui-v1", project: "chromium", file: "ui-v1.acceptance.spec.ts" },
    { id: "webkit", project: "webkit", file: "ui-v1.acceptance.spec.ts" },
  ]);
  assert.deepEqual(resolveBrowserShard("full", "webkit"), {
    profile: "full",
    id: "webkit",
    project: "webkit",
    file: "ui-v1.acceptance.spec.ts",
  });
  assert.equal(resolveBrowserShard("core", "recent-activity").project, "chromium");
  assert.equal(resolveBrowserShard("core", "recent-activity").file, "recent-activity.acceptance.spec.ts");
});

test("unknown profiles and shards are rejected before a runner starts", () => {
  assert.throws(() => resolveBrowserShard("preview", "core"), /Unknown browser profile/u);
  assert.throws(() => resolveBrowserShard("core", "empty"), /Unknown browser shard/u);
});

test("Playwright receives one named project and the selected spec as a test filter", () => {
  const shard = resolveBrowserShard("core", "job-inbox");
  assert.deepEqual(buildBrowserTestArguments(shard), [
    "exec",
    "playwright",
    "test",
    "--config",
    "tests/e2e/playwright.config.ts",
    "tests/e2e/job-inbox.acceptance.spec.ts",
    "--project=chromium",
  ]);
});

test("browser coverage counts discovered, executed, skipped and failed cases", () => {
  assert.deepEqual(summarizeBrowserCoverage({
    expected: 6,
    outcomes: ["expected", "expected", "skipped", "unexpected", "flaky", "notRun"],
  }), {
    expected: 6,
    executed: 4,
    passed: 2,
    skipped: 1,
    failed: 3,
    notRun: 1,
  });
});

test("coverage rejects an empty shard and incomplete reporter output", () => {
  assert.throws(() => summarizeBrowserCoverage({ expected: 0, outcomes: [] }), /empty browser shard/u);
  assert.throws(() => summarizeBrowserCoverage({ expected: 2, outcomes: ["expected"] }), /did not report every discovered test/u);
});

test("coverage rejects statuses it does not understand", () => {
  assert.throws(() => summarizeBrowserCoverage({ expected: 1, outcomes: ["interrupted"] }), /Unknown Playwright outcome/u);
});
