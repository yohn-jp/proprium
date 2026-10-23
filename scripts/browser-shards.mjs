import { BROWSER_SHARDS, PROFILES } from "./ci-contract.mjs";

const COVERAGE_OUTCOMES = new Set(["expected", "skipped", "unexpected", "flaky", "notRun"]);

export function resolveBrowserShard(profile, id) {
  if (!PROFILES.includes(profile)) throw new Error(`Unknown browser profile: ${profile}`);
  const shard = BROWSER_SHARDS.find((candidate) => candidate.id === id);
  if (!shard) throw new Error(`Unknown browser shard: ${id}`);
  return { profile, ...shard };
}

export function buildBrowserTestArguments(shard) {
  return [
    "exec",
    "playwright",
    "test",
    "--config",
    "tests/e2e/playwright.config.ts",
    `tests/e2e/${shard.file}`,
    `--project=${shard.project}`,
  ];
}

export function summarizeBrowserCoverage({ expected, outcomes }) {
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error("Expected browser test count must be a non-negative integer");
  }
  if (expected === 0) throw new Error("An empty browser shard cannot pass");
  if (!Array.isArray(outcomes) || outcomes.length !== expected) {
    throw new Error("Browser coverage did not report every discovered test");
  }

  const counts = { expected: 0, skipped: 0, unexpected: 0, flaky: 0, notRun: 0 };
  for (const outcome of outcomes) {
    if (!COVERAGE_OUTCOMES.has(outcome)) throw new Error(`Unknown Playwright outcome: ${outcome}`);
    counts[outcome] += 1;
  }
  return {
    expected,
    executed: expected - counts.skipped - counts.notRun,
    passed: counts.expected,
    skipped: counts.skipped,
    failed: counts.unexpected + counts.flaky + counts.notRun,
    notRun: counts.notRun,
  };
}
