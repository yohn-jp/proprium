/** @typedef {{id: number, head_sha: string, head_branch: string, event: string, status: string, conclusion: string | null}} VerificationRun */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is VerificationRun} */
function runRecord(value) {
  return record(value) && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0 &&
    typeof value.head_sha === 'string' && typeof value.head_branch === 'string' && typeof value.event === 'string' &&
    typeof value.status === 'string' && (typeof value.conclusion === 'string' || value.conclusion === null);
}
/** @param {unknown} runs @param {string} sha @returns {VerificationRun} */
export function verifiedSourceRun(runs, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(runs)) throw new Error('Invalid release source or verification response');
  for (const run of runs) {
    if (runRecord(run) && run.head_sha === sha && run.head_branch === 'main' && run.event === 'push' &&
        run.status === 'completed' && run.conclusion === 'success') return run;
  }
  throw new Error('Release source has no successful main verification');
}
/** @param {unknown} jobs */
export function assertVerificationJobs(jobs) {
  const required = ['source-checks', 'hosted-native', 'oci-core', 'oci-full', 'browser-core', 'browser-full'];
  if (!Array.isArray(jobs) || required.some(name => jobs.filter(job => record(job) && job.name === name && job.status === 'completed' && job.conclusion === 'success').length !== 1)) {
    throw new Error('Release verification is missing a required successful job');
  }
}
/** @param {string} tag @param {string} expectedSha @param {string} actualSha */
export function assertReleaseIdentity(tag, expectedSha, actualSha) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || !/^[a-f0-9]{40}$/.test(expectedSha) || actualSha !== expectedSha) {
    throw new Error('Release tag does not bind the verified immutable source');
  }
}
