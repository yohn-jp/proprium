#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrowserTestArguments, resolveBrowserShard } from "./browser-shards.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function parseArguments(args) {
  let profile;
  let suite;
  let prebuilt = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--prebuilt") {
      if (prebuilt) throw new Error("--prebuilt may only be specified once");
      prebuilt = true;
      continue;
    }
    if (flag !== "--profile" && flag !== "--suite") throw new Error(`Unknown browser shard argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--profile") {
      if (profile) throw new Error("--profile may only be specified once");
      profile = value;
    } else {
      if (suite) throw new Error("--suite may only be specified once");
      suite = value;
    }
    index += 1;
  }
  if (!profile || !suite) throw new Error("Usage: node scripts/run-browser-shard.mjs --profile <core|full> --suite <browser-shard> [--prebuilt]");
  return { profile, suite, prebuilt };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} ${args.join(" ")} terminated by ${result.signal}`);
  return result.status ?? 1;
}

async function main() {
  const { profile, suite, prebuilt } = parseArguments(process.argv.slice(2));
  const shard = resolveBrowserShard(profile, suite);
  const reportDirectory = process.env.SCRIPTORIUM_CI_REPORT_DIR
    ? path.resolve(process.env.SCRIPTORIUM_CI_REPORT_DIR)
    : path.resolve(root, "tests/e2e/test-results");
  const coverageFile = path.join(reportDirectory, "browser-coverage.json");
  await mkdir(reportDirectory, { recursive: true });
  await rm(coverageFile, { force: true });

  const env = {
    ...process.env,
    SCRIPTORIUM_PROFILE: profile,
    SCRIPTORIUM_E2E_PROFILE: profile,
    SCRIPTORIUM_E2E_SHARD: shard.id,
    SCRIPTORIUM_E2E_PROJECT: shard.project,
    SCRIPTORIUM_E2E_TEST_FILE: shard.file,
    SCRIPTORIUM_E2E_COVERAGE_FILE: coverageFile,
  };
  if (!prebuilt) {
    const buildStatus = run("pnpm", ["build"], env);
    if (buildStatus !== 0) return buildStatus;
  }

  const testStatus = run("pnpm", buildBrowserTestArguments(shard), env);
  let report;
  try {
    report = JSON.parse(await readFile(coverageFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Browser coverage artifact missing or invalid at ${coverageFile}: ${message}\n`);
    return testStatus || 1;
  }
  if (report.profile !== profile || report.shard !== shard.id || report.project !== shard.project || report.file !== shard.file) {
    process.stderr.write(`Browser coverage artifact does not match ${profile}/${shard.id}/${shard.project}/${shard.file}\n`);
    return 1;
  }
  if (!Number.isInteger(report.expected) || report.expected < 1) {
    process.stderr.write("An empty browser shard cannot pass\n");
    return 1;
  }
  if (report.expected !== report.executed + report.skipped + report.notRun
    || report.expected !== report.passed + report.skipped + report.failed
    || !Array.isArray(report.tests)
    || report.tests.length !== report.expected) {
    process.stderr.write("Browser coverage counts do not account for every discovered test\n");
    return 1;
  }
  if (report.tests.some((test) => test.file !== `tests/e2e/${shard.file}`)) {
    process.stderr.write(`Browser coverage includes tests outside the selected spec ${shard.file}\n`);
    return 1;
  }
  if (report.outcome !== "PASS" || report.failed !== 0 || report.notRun !== 0) return testStatus || 1;
  return testStatus;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
