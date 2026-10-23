#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { assertVerificationLeafJobs, collectGitHubPages } from './release-policy.mjs';

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, SCRIPTORIUM_EXPECTED_SHA, SCRIPTORIUM_REQUIRED_RESULTS } = process.env;
assert.match(GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
assert.match(GITHUB_RUN_ID ?? '', /^\d+$/);
assert.match(SCRIPTORIUM_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(GH_TOKEN, 'Read token is required');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), SCRIPTORIUM_EXPECTED_SHA);
const outcomes = JSON.parse(SCRIPTORIUM_REQUIRED_RESULTS ?? 'null');
assert.ok(outcomes && Object.keys(outcomes).length === 10, 'All required DAG groups must be present');
assert.ok(Object.values(outcomes).every(value => value.result === 'success'), 'A required DAG group failed, was cancelled, skipped or unexecuted');
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
const jobs = await collectGitHubPages(page => request(`actions/runs/${GITHUB_RUN_ID}/jobs?filter=latest&per_page=100&page=${page}`), 'jobs');
assert.ok(jobs.every(job => job.head_sha === SCRIPTORIUM_EXPECTED_SHA), 'Job source SHA mismatch');
assertVerificationLeafJobs(jobs.filter(job => job.name !== 'certification'));
const message = `Certified all required verification leaves at ${SCRIPTORIUM_EXPECTED_SHA}; run ${GITHUB_RUN_ID}.\n`;
console.log(message.trim());
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
