import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS, VERIFICATION_LEAF_JOBS } from './ci-contract.mjs';
import { assertReleaseIdentity, assertVerificationJobs, assertVerificationLeafJobs, collectGitHubPages, verifiedSourceRun } from './release-policy.mjs';

const sha = 'a'.repeat(40);
const run = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
test('release eligibility requires the exact successful main push source', () => {
  assert.equal(verifiedSourceRun([run], sha), run);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' }, { conclusion: 'cancelled' }]) {
    assert.throws(() => verifiedSourceRun([{ ...run, ...change }], sha));
  }
  assert.throws(() => verifiedSourceRun([], sha));
  assert.throws(() => verifiedSourceRun({}, sha));
});
test('release eligibility rejects moved tags and malformed version names', () => {
  assert.doesNotThrow(() => assertReleaseIdentity('v0.3.3', sha, sha));
  assert.throws(() => assertReleaseIdentity('v0.3.3', sha, 'b'.repeat(40)));
  assert.throws(() => assertReleaseIdentity('main', sha, sha));
});

test('release gate requires the exact successful job set including every matrix element and certification', () => {
  assert.deepEqual(REQUIRED_VERIFICATION_JOBS, [...VERIFICATION_LEAF_JOBS, 'certification']);
  const jobs = REQUIRED_VERIFICATION_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  assert.doesNotThrow(() => assertVerificationJobs(jobs));
  assert.doesNotThrow(() => assertVerificationLeafJobs(jobs.filter(job => job.name !== 'certification')));
  assert.throws(() => assertVerificationLeafJobs(jobs), /Unexpected release verification job/);
  assert.throws(() => assertVerificationJobs(jobs.slice(1)), /exact required job set/);
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    const rejected = jobs.map((job, index) => index === 1 ? { ...job, conclusion } : job);
    assert.throws(() => assertVerificationJobs(rejected), /did not succeed/);
  }
  assert.throws(() => assertVerificationJobs(jobs.map((job, index) => index === 1 ? { ...job, status: 'in_progress', conclusion: null } : job)), /did not succeed/);
  assert.throws(() => assertVerificationJobs(jobs.map((job, index) => index === 1 ? { ...job, conclusion: null } : job)), /did not succeed/);
  assert.throws(() => assertVerificationJobs([...jobs, { name: 'unit-future', status: 'completed', conclusion: 'success' }]), /Unexpected release verification job/);
  assert.throws(() => assertVerificationJobs([...jobs, { ...jobs[0] }]), /Duplicate release verification job/);
  assert.throws(() => assertVerificationJobs([...jobs, { name: 'unexpected', status: 'completed', conclusion: 'cancelled' }]), /Unexpected release verification job/);
});

test('GitHub Actions pagination retrieves all pages and rejects incomplete responses', async () => {
  const expected = Array.from({ length: 205 }, (_, id) => ({ id }));
  const calls = [];
  const result = await collectGitHubPages(async (page, perPage) => {
    calls.push([page, perPage]);
    const start = (page - 1) * perPage;
    return { total_count: expected.length, jobs: expected.slice(start, start + perPage) };
  }, 'jobs');
  assert.deepEqual(result, expected);
  assert.deepEqual(calls, [[1, 100], [2, 100], [3, 100]]);
  await assert.rejects(collectGitHubPages(async () => ({ total_count: 101, jobs: expected.slice(0, 99) }), 'jobs'), /Incomplete GitHub pagination/);
  let page = 0;
  await assert.rejects(collectGitHubPages(async () => {
    page++;
    return { total_count: page === 1 ? 101 : 102, jobs: expected.slice((page - 1) * 100, page * 100) };
  }, 'jobs'), /count changed/);
  await assert.rejects(collectGitHubPages(async () => { throw new Error('page request failed'); }, 'jobs'), /page request failed/);
});

test('release source selection excludes PR runs, failed runs and stale commits', () => {
  for (const change of [
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'other' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ]) {
    assert.throws(() => verifiedSourceRun([{ ...run, ...change }], sha));
  }
});

test('OCI publication refuses existing image tags and fails closed on registry uncertainty', async () => {
  const { assertImageTagAbsent } = await import('./release-policy.mjs');
  for (const code of ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN']) {
    await assert.doesNotReject(assertImageTagAbsent(Response.json({ errors: [{ code, message: 'absent' }] }, { status: 404 })));
  }
  for (const response of [
    Response.json({ schemaVersion: 2 }),
    Response.json({ errors: [{ code: 'UNAUTHORIZED' }] }, { status: 401 }),
    Response.json({ errors: [{ code: 'DENIED' }] }, { status: 403 }),
    Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status: 503 }),
    Response.json({ errors: [{ code: 'OTHER' }] }, { status: 404 }),
    Response.json({ errors: [] }, { status: 404 }),
    new Response('not registry JSON', { status: 404 }),
  ]) await assert.rejects(assertImageTagAbsent(response));
});
