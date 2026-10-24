import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
import { createVerificationPlan, planDigest } from './ci-impact.mjs';
import { assertPlanEvidence } from './ci-evidence.mjs';
import { selectLatestEvidenceArtifacts, selectLatestJobArtifact, selectLatestPlanArtifact } from './ci-artifact-selection.mjs';
import { collectGitHubPages } from './release-policy.mjs';

const sourceSha = 'a'.repeat(40);
const runId = '40127302099';
const identity = { runId, sourceSha };
const plan = createVerificationPlan({ files: null, event: 'push', sha: sourceSha });
const selectedGroups = plan.groups;

function artifact(id, name, createdAt, { expired = false, run = runId, sha = sourceSha } = {}) {
  return { id, name, created_at: createdAt, expired, workflow_run: { id: Number(run), head_sha: sha } };
}

function job(name, startedAt, completedAt, { run = runId, sha = sourceSha, conclusion = 'success' } = {}) {
  return { name, run_id: Number(run), head_sha: sha, status: 'completed', conclusion, started_at: startedAt, completed_at: completedAt };
}

function report(group, failed = false) {
  return {
    group,
    sha: sourceSha,
    planDigest: planDigest(plan),
    results: VERIFICATION_GROUPS[group]
      .filter(task => plan.tasks.includes(task))
      .map(task => ({ task, status: failed ? 'failed' : 'passed' })),
  };
}

const successfulJobs = [
  job('plan', '2026-10-24T19:40:00Z', '2026-10-24T19:45:00Z'),
  ...selectedGroups.map(group => job(group,
    group === 'oci-core' ? '2026-10-24T19:55:00Z' : '2026-10-24T19:49:00Z',
    '2026-10-24T20:05:00Z')),
];

function ordinaryArtifacts() {
  const artifacts = [artifact(1000, 'ci-plan', '2026-10-24T19:44:00Z')];
  for (const [index, group] of selectedGroups.entries()) {
    const createdAt = group === 'oci-core' ? '2026-10-24T20:00:04Z' : '2026-10-24T19:50:00Z';
    artifacts.push(artifact(2000 + index, `ci-evidence-${group}`, createdAt));
  }
  return artifacts;
}

test('selects plan and evidence by latest successful job window and artifact created_at, not ID', () => {
  const artifacts = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core' && item.name !== 'ci-plan');
  const stalePlan = artifact(12_573_768_277, 'ci-plan', '2026-10-24T19:43:00Z');
  const latestPlan = artifact(12_572_824_349, 'ci-plan', '2026-10-24T19:44:30Z');
  const staleOci = artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z');
  const latestOci = artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z');
  artifacts.push(stalePlan, latestPlan, staleOci, latestOci);

  assert.equal(selectLatestPlanArtifact(artifacts, successfulJobs, identity).id, latestPlan.id);
  const selected = selectLatestEvidenceArtifacts(plan, artifacts, successfulJobs, identity);
  const selectedOci = selected.find(item => item.name === 'ci-evidence-oci-core');
  assert.equal(selectedOci.id, latestOci.id);
  assert.equal(selectedOci.created_at, '2026-10-24T20:00:04Z');
  assert.equal(staleOci.created_at < successfulJobs.find(item => item.name === 'oci-core').started_at, true);
});

test('selection sees latest artifacts on later complete REST pages', async () => {
  const artifacts = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  artifacts.push(...Array.from({ length: 82 }, (_, index) => ({ name: `diagnostic-${index}` })));
  artifacts.push(
    artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z'),
    artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z'),
  );
  assert.equal(artifacts.length, 102);
  const paginated = await collectGitHubPages(async (page, perPage) => ({
    total_count: artifacts.length,
    artifacts: artifacts.slice((page - 1) * perPage, page * perPage),
  }), 'artifacts');
  const selected = selectLatestEvidenceArtifacts(plan, paginated, successfulJobs, identity);
  assert.equal(selected.find(item => item.name === 'ci-evidence-oci-core').id, 12_572_824_349);
});

test('a latest failed artifact remains selected and cannot certify', () => {
  const artifacts = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  const oldFailure = artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z');
  const newPass = artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z');
  artifacts.push(oldFailure, newPass);
  const selected = selectLatestEvidenceArtifacts(plan, artifacts, successfulJobs, identity);
  const reportByArtifactId = new Map([
    [oldFailure.id, report('oci-core', true)],
    [newPass.id, report('oci-core')],
  ]);
  const latestReports = selected.map(item => reportByArtifactId.get(item.id) ?? report(item.name.slice('ci-evidence-'.length)));
  assert.doesNotThrow(() => assertPlanEvidence(plan, successfulJobs, latestReports));

  reportByArtifactId.set(newPass.id, report('oci-core', true));
  const latestFailedReports = selected.map(item => reportByArtifactId.get(item.id) ?? report(item.name.slice('ci-evidence-'.length)));
  assert.throws(() => assertPlanEvidence(plan, successfulJobs, latestFailedReports), /A selected validation failed/);
});

test('missing, tied, outside-window, or unsuccessful latest evidence fails closed', () => {
  const missing = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  assert.throws(() => selectLatestEvidenceArtifacts(plan, missing, successfulJobs, identity), /Missing fresh CI artifact ci-evidence-oci-core/);

  const tied = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  tied.push(
    artifact(12_573_768_277, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z'),
    artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z'),
  );
  assert.throws(() => selectLatestEvidenceArtifacts(plan, tied, successfulJobs, identity), /Ambiguous latest CI artifact/);

  const outsideWindow = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  outsideWindow.push(artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T19:53:33Z'));
  assert.throws(() => selectLatestEvidenceArtifacts(plan, outsideWindow, successfulJobs, identity), /Missing fresh CI artifact/);

  const failedJobs = successfulJobs.map(item => item.name === 'oci-core' ? { ...item, conclusion: 'failure' } : item);
  assert.throws(() => selectLatestEvidenceArtifacts(plan, ordinaryArtifacts(), failedJobs, identity), /Workflow job did not succeed/);
});

test('artifact run, source and expiry are part of evidence selection', () => {
  const wrongRun = ordinaryArtifacts();
  const first = wrongRun.find(item => item.name === `ci-evidence-${selectedGroups[0]}`);
  wrongRun[wrongRun.indexOf(first)] = artifact(first.id, first.name, first.created_at, { run: '40127302098' });
  assert.throws(() => selectLatestEvidenceArtifacts(plan, wrongRun, successfulJobs, identity), /different workflow run/);

  const wrongSource = ordinaryArtifacts();
  const sourced = wrongSource.find(item => item.name === `ci-evidence-${selectedGroups[0]}`);
  wrongSource[wrongSource.indexOf(sourced)] = artifact(sourced.id, sourced.name, sourced.created_at, { sha: 'b'.repeat(40) });
  assert.throws(() => selectLatestEvidenceArtifacts(plan, wrongSource, successfulJobs, identity), /source SHA mismatch/);

  const expiredLatest = ordinaryArtifacts().filter(item => item.name !== 'ci-evidence-oci-core');
  expiredLatest.push(artifact(12_572_824_349, 'ci-evidence-oci-core', '2026-10-24T20:00:04Z', { expired: true }));
  assert.throws(() => selectLatestEvidenceArtifacts(plan, expiredLatest, successfulJobs, identity), /Latest CI artifact is expired/);
});

test('latest successful job attempt must belong to the exact workflow run and source', () => {
  const wrongRunJobs = successfulJobs.map(item => item.name === 'plan' ? { ...item, run_id: Number(runId) + 1 } : item);
  assert.throws(() => selectLatestPlanArtifact(ordinaryArtifacts(), wrongRunJobs, identity), /another run/);
  const wrongSourceJobs = successfulJobs.map(item => item.name === 'plan' ? { ...item, head_sha: 'b'.repeat(40) } : item);
  assert.throws(() => selectLatestPlanArtifact(ordinaryArtifacts(), wrongSourceJobs, identity), /source SHA mismatch/);
  assert.throws(() => selectLatestJobArtifact('ci-plan', 'plan', ordinaryArtifacts(), successfulJobs, { runId: 'not-a-run', sourceSha }), /run ID is invalid/);
});
