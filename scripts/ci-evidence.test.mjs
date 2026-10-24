import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVerificationPlan, planDigest } from './ci-impact.mjs';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
import { assertPlanEvidence } from './ci-evidence.mjs';

const sha = 'a'.repeat(40);
const fixture = event => {
  const plan = createVerificationPlan({ files: ['modules/search/src/browser.ts'], event, sha });
  return {
    plan,
    jobs: ['plan', ...plan.groups].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success' })),
    reports: plan.groups.map(group => ({ group, sha, planDigest: planDigest(plan), results: VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task)).map(task => ({ task, status: 'passed' })) })),
  };
};
test('affected PR and complete main plans both require exact execution evidence', () => {
  for (const event of ['pull_request', 'push']) {
    const { plan, jobs, reports } = fixture(event);
    assert.doesNotThrow(() => assertPlanEvidence(plan, jobs, reports));
  }
});
test('missing, stale, failed, skipped and duplicate evidence cannot certify selected work', () => {
  for (const mutate of [
    data => data.jobs.pop(),
    data => { data.jobs[1].conclusion = 'skipped'; },
    data => { data.jobs[1].status = 'in_progress'; },
    data => { data.jobs[1].head_sha = 'b'.repeat(40); },
    data => data.reports.pop(),
    data => { data.reports[0].sha = 'b'.repeat(40); },
    data => { data.reports[0].planDigest = 'stale'; },
    data => data.reports[0].results.pop(),
    data => { data.reports[0].results[0].status = 'skipped'; },
    data => { data.reports[0].results[0].status = 'blocked'; },
    data => { data.reports[0].results[0].status = 'failed'; },
    data => { data.reports[1] = data.reports[0]; },
    data => data.plan.tasks.pop(),
    data => data.plan.excluded.pop(),
  ]) {
    const data = fixture('pull_request');
    mutate(data);
    assert.throws(() => assertPlanEvidence(data.plan, data.jobs, data.reports));
  }
});
test('only unselected matrix placeholders may be skipped; executed extras fail', () => {
  const { plan, jobs, reports } = fixture('pull_request');
  jobs.push({ name: 'hosted-native-${{ matrix.selection }}', head_sha: sha, status: 'completed', conclusion: 'skipped' });
  assert.doesNotThrow(() => assertPlanEvidence(plan, jobs, reports));
  jobs.at(-1).conclusion = 'success';
  assert.throws(() => assertPlanEvidence(plan, jobs, reports));
});
