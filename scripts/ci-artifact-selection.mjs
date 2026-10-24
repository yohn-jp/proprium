import assert from 'node:assert/strict';
import { validateVerificationPlan } from './ci-impact.mjs';

/**
 * Select one artifact produced inside the latest successful job attempt window.
 * @param {string} artifactName
 * @param {string} jobName
 * @param {unknown[]} artifacts
 * @param {unknown[]} jobs
 * @param {{ runId: string | number; sourceSha: string }} identity
 */
export function selectLatestJobArtifact(artifactName, jobName, artifacts, jobs, identity) {
  assert.ok(Array.isArray(artifacts), 'Workflow artifacts must be an array');
  assert.ok(Array.isArray(jobs), 'Workflow jobs must be an array');
  assert.ok(identity && /^\d+$/.test(String(identity.runId)), 'Workflow run ID is invalid');
  assert.match(identity.sourceSha, /^[a-f0-9]{40}$/, 'Expected source SHA is invalid');

  const matchingJobs = jobs.filter(job => job && typeof job === 'object' && job.name === jobName);
  assert.equal(matchingJobs.length, 1, `Expected exactly one latest workflow job named ${jobName}`);
  const job = matchingJobs[0];
  assert.equal(job.head_sha, identity.sourceSha, `Workflow job source SHA mismatch: ${jobName}`);
  assert.equal(job.status, 'completed', `Workflow job is unfinished: ${jobName}`);
  assert.equal(job.conclusion, 'success', `Workflow job did not succeed: ${jobName}`);
  assert.equal(String(job.run_id), String(identity.runId), `Workflow job belongs to another run: ${jobName}`);
  assert.equal(typeof job.started_at, 'string', `Workflow job start time is missing: ${jobName}`);
  assert.equal(typeof job.completed_at, 'string', `Workflow job completion time is missing: ${jobName}`);
  const jobStartedAt = Date.parse(job.started_at);
  const jobCompletedAt = Date.parse(job.completed_at);
  assert.ok(Number.isFinite(jobStartedAt) && Number.isFinite(jobCompletedAt) && jobStartedAt <= jobCompletedAt,
    `Workflow job time window is invalid: ${jobName}`);

  const candidates = [];
  for (const value of artifacts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed workflow artifact metadata');
    const artifact = /** @type {Record<string, unknown>} */ (value);
    if (artifact.name !== artifactName) continue;
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0, `Invalid artifact ID for ${artifactName}`);
    assert.equal(typeof artifact.expired, 'boolean', `Artifact expiry metadata is missing for ${artifactName}`);
    assert.equal(typeof artifact.created_at, 'string', `Artifact creation time is missing for ${artifactName}`);
    const createdAt = Date.parse(artifact.created_at);
    assert.ok(Number.isFinite(createdAt), `Artifact creation time is invalid for ${artifactName}`);
    const workflowRun = artifact.workflow_run;
    assert.ok(workflowRun && typeof workflowRun === 'object' && !Array.isArray(workflowRun), `Artifact run binding is missing for ${artifactName}`);
    assert.equal(String(workflowRun.id), String(identity.runId), `Artifact belongs to a different workflow run: ${artifactName}`);
    assert.equal(workflowRun.head_sha, identity.sourceSha, `Artifact source SHA mismatch: ${artifactName}`);
    if (createdAt >= jobStartedAt && createdAt <= jobCompletedAt) candidates.push({ artifact, createdAt });
  }

  assert.ok(candidates.length > 0, `Missing fresh CI artifact ${artifactName} from latest successful job ${jobName}`);
  const latestCreatedAt = Math.max(...candidates.map(candidate => candidate.createdAt));
  const latest = candidates.filter(candidate => candidate.createdAt === latestCreatedAt);
  assert.equal(latest.length, 1, `Ambiguous latest CI artifact ${artifactName} from job ${jobName}`);
  assert.equal(latest[0].artifact.expired, false, `Latest CI artifact is expired: ${artifactName}`);
  return /** @type {{ id: number; name: string; created_at: string }} */ (latest[0].artifact);
}

/**
 * @param {unknown} planValue
 * @param {unknown[]} artifacts
 * @param {unknown[]} jobs
 * @param {{ runId: string | number; sourceSha: string }} identity
 */
export function selectLatestEvidenceArtifacts(planValue, artifacts, jobs, identity) {
  const plan = validateVerificationPlan(planValue);
  assert.equal(plan.sha, identity.sourceSha, 'Plan source SHA mismatch');
  return plan.groups.map(group => selectLatestJobArtifact(`ci-evidence-${group}`, group, artifacts, jobs, identity));
}

/**
 * @param {unknown[]} artifacts
 * @param {unknown[]} jobs
 * @param {{ runId: string | number; sourceSha: string }} identity
 */
export function selectLatestPlanArtifact(artifacts, jobs, identity) {
  return selectLatestJobArtifact('ci-plan', 'plan', artifacts, jobs, identity);
}
