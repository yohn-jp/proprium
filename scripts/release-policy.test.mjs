import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReleaseIdentity, verifiedSourceRun } from './release-policy.mjs';

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

test('release gate requires every source, native, OCI and browser job', async () => {
  const { assertVerificationJobs } = await import('./release-policy.mjs');
  const jobs = ['source-checks', 'hosted-native', 'oci-core', 'oci-full', 'browser-core', 'browser-full'].map(name => ({ name, status: 'completed', conclusion: 'success' }));
  assert.doesNotThrow(() => assertVerificationJobs(jobs));
  assert.throws(() => assertVerificationJobs(jobs.slice(1)));
  assert.throws(() => assertVerificationJobs(jobs.map((job, index) => index === 1 ? { ...job, conclusion: 'skipped' } : job)));
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
