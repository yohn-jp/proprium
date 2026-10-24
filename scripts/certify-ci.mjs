#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { collectGitHubPages } from './release-policy.mjs';
import { validateVerificationPlan } from './ci-impact.mjs';
import { assertPlanEvidence } from './ci-evidence.mjs';

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, SCRIPTORIUM_EXPECTED_SHA, SCRIPTORIUM_REQUIRED_RESULTS } = process.env;
assert.match(GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
assert.match(GITHUB_RUN_ID ?? '', /^\d+$/);
assert.match(SCRIPTORIUM_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(GH_TOKEN, 'Read token is required');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), SCRIPTORIUM_EXPECTED_SHA);
const outcomes = JSON.parse(SCRIPTORIUM_REQUIRED_RESULTS ?? 'null');
assert.ok(outcomes && Object.keys(outcomes).length === 7, 'All required DAG groups must be present');
assert.equal(outcomes.plan?.result, 'success', 'Impact planning did not succeed');
assert.ok(Object.values(outcomes).every(value => ['success', 'skipped'].includes(value.result)), 'A required DAG group failed, was cancelled or unexecuted');
const plan = validateVerificationPlan(JSON.parse(await readFile('ci-plan.json', 'utf8')));
assert.equal(plan.sha, SCRIPTORIUM_EXPECTED_SHA);
const request = async endpoint => {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${endpoint}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  assert.ok(response.ok, `GitHub evidence unavailable: HTTP ${response.status}`);
  return response.json();
};
const run = await request(`actions/runs/${GITHUB_RUN_ID}`);
assert.equal(run.head_sha, SCRIPTORIUM_EXPECTED_SHA, 'Workflow run must bind exact source');
assert.equal(run.event, plan.event, 'Impact plan event mismatch');
if (run.event !== 'pull_request') assert.equal(plan.mode, 'full', 'Main/manual verification must execute all validations');
const jobs = await collectGitHubPages(page => request(`actions/runs/${GITHUB_RUN_ID}/jobs?filter=latest&per_page=100&page=${page}`), 'jobs');
const directory = process.env.SCRIPTORIUM_CI_EVIDENCE_DIR;
assert.ok(directory, 'Execution evidence directory is required');
const reports = [];
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) throw new Error('Unexpected execution evidence entry');
  reports.push(JSON.parse(await readFile(path.join(directory, entry.name, 'report.json'), 'utf8')));
}
assertPlanEvidence(plan, jobs, reports);
const message = `Verified ${plan.mode} plan: ${plan.tasks.length} validations at ${SCRIPTORIUM_EXPECTED_SHA}; run ${GITHUB_RUN_ID}. ${plan.excluded.length} explicitly NOT_SELECTED.\n`;
console.log(message.trim());
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
