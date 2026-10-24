#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectGitHubPages } from './release-policy.mjs';
import { selectLatestPlanArtifact } from './ci-artifact-selection.mjs';

const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_OUTPUT, RUNNER_TEMP, SCRIPTORIUM_EXPECTED_SHA } = process.env;
assert.match(GITHUB_REPOSITORY ?? '', /^[\w.-]+\/[\w.-]+$/);
assert.match(GITHUB_RUN_ID ?? '', /^\d+$/);
assert.match(SCRIPTORIUM_EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
assert.ok(GH_TOKEN, 'Read token is required');
assert.ok(GITHUB_OUTPUT, 'GitHub output path is required');
assert.ok(RUNNER_TEMP, 'Runner temporary directory is required');

const request = async endpoint => {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${endpoint}`, {
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  assert.ok(response.ok, `GitHub artifact metadata unavailable: HTTP ${response.status}`);
  return response.json();
};
const run = await request(`actions/runs/${GITHUB_RUN_ID}`);
assert.equal(String(run.id), GITHUB_RUN_ID, 'Workflow run ID mismatch');
assert.equal(run.head_sha, SCRIPTORIUM_EXPECTED_SHA, 'Workflow run source SHA mismatch');
const identity = { runId: GITHUB_RUN_ID, sourceSha: SCRIPTORIUM_EXPECTED_SHA };
const [artifacts, jobs] = await Promise.all([
  collectGitHubPages(page => request(`actions/runs/${GITHUB_RUN_ID}/artifacts?per_page=100&page=${page}`), 'artifacts'),
  collectGitHubPages(page => request(`actions/runs/${GITHUB_RUN_ID}/jobs?filter=latest&per_page=100&page=${page}`), 'jobs'),
]);
const planArtifact = selectLatestPlanArtifact(artifacts, jobs, identity);
const inventoryPath = path.join(RUNNER_TEMP, 'ci-artifact-inventory.json');
await mkdir(path.dirname(inventoryPath), { recursive: true });
await writeFile(inventoryPath, `${JSON.stringify({ identity, artifacts, jobs }, null, 2)}\n`, { mode: 0o600 });
await appendFile(GITHUB_OUTPUT, `artifact-id=${planArtifact.id}\ninventory-path=${inventoryPath}\n`);
console.log(`Selected latest exact-run ci-plan artifact ${planArtifact.id} from successful job window at ${SCRIPTORIUM_EXPECTED_SHA}.`);
