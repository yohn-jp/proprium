import { REQUIRED_VERIFICATION_JOBS, VERIFICATION_LEAF_JOBS } from './ci-contract.mjs';

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
/** @param {unknown} jobs @param {readonly string[]} expectedNames */
function assertNamedJobs(jobs, expectedNames) {
  if (!Array.isArray(jobs)) throw new Error('Invalid release verification jobs response');
  const required = new Set(expectedNames);
  if (required.size !== expectedNames.length) throw new Error('Canonical release verification job set contains duplicates');
  const seen = new Set();
  for (const job of jobs) {
    if (!record(job) || typeof job.name !== 'string' || job.name.length === 0) {
      throw new Error('Invalid release verification job');
    }
    if (seen.has(job.name)) throw new Error(`Duplicate release verification job: ${job.name}`);
    seen.add(job.name);
    if (!required.has(job.name)) throw new Error(`Unexpected release verification job: ${job.name}`);
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      throw new Error(`Release verification job did not succeed: ${job.name}`);
    }
  }
  if (seen.size !== required.size || [...required].some(name => !seen.has(name))) {
    throw new Error('Release verification does not contain the exact required job set');
  }
}

/** @param {unknown} jobs */
export function assertVerificationLeafJobs(jobs) {
  assertNamedJobs(jobs, VERIFICATION_LEAF_JOBS);
}

/** @param {unknown} jobs */
export function assertVerificationJobs(jobs) {
  assertNamedJobs(jobs, REQUIRED_VERIFICATION_JOBS);
}

/**
 * Fetches every page of a GitHub Actions list response, failing closed if GitHub
 * returns an incomplete or inconsistent page set.
 * @param {(page: number, perPage: number) => Promise<unknown>} fetchPage
 * @param {string} itemsKey
 */
export async function collectGitHubPages(fetchPage, itemsKey) {
  if (typeof fetchPage !== 'function' || typeof itemsKey !== 'string' || itemsKey.length === 0) {
    throw new Error('Invalid GitHub pagination request');
  }
  const perPage = 100;
  /** @type {unknown[]} */
  const items = [];
  /** @type {number | undefined} */
  let expectedCount;
  for (let page = 1; ; page++) {
    const result = await fetchPage(page, perPage);
    const pageItems = record(result) ? result[itemsKey] : undefined;
    const totalCount = record(result) ? result.total_count : undefined;
    if (typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0 || !Array.isArray(pageItems)) {
      throw new Error(`Invalid GitHub pagination response for ${itemsKey}`);
    }
    if (expectedCount === undefined) expectedCount = totalCount;
    if (totalCount !== expectedCount) throw new Error(`GitHub pagination count changed for ${itemsKey}`);
    const expectedPageLength = Math.min(perPage, expectedCount - items.length);
    if (pageItems.length !== expectedPageLength) throw new Error(`Incomplete GitHub pagination response for ${itemsKey}`);
    items.push(...pageItems);
    if (items.length === expectedCount) return items;
  }
}
/** @param {string} tag @param {string} expectedSha @param {string} actualSha */
export function assertReleaseIdentity(tag, expectedSha, actualSha) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag) || !/^[a-f0-9]{40}$/.test(expectedSha) || actualSha !== expectedSha) {
    throw new Error('Release tag does not bind the verified immutable source');
  }
}

/** @param {Response} response */
export async function assertImageTagAbsent(response) {
  if (response.status === 200) throw new Error('Existing OCI version tag is immutable; use a new version');
  if (response.status !== 404) throw new Error(`Cannot establish OCI tag absence (HTTP ${response.status})`);
  /** @type {unknown} */
  const body = await response.json();
  if (!record(body) || !Array.isArray(body.errors) || body.errors.length === 0 ||
      !body.errors.every(error => record(error) && (error.code === 'MANIFEST_UNKNOWN' || error.code === 'NAME_UNKNOWN'))) {
    throw new Error('Registry did not confirm an absent OCI version tag');
  }
}
