#!/usr/bin/env node
// Read-only gate for the existing tag publication workflow.
import { execFileSync } from 'node:child_process';
import { assertReleaseIdentity, assertVerificationJobs, verifiedSourceRun } from './release-policy.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
const expectedSha = process.env.GITHUB_SHA;
const token = process.env.GH_TOKEN;
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !tag || !expectedSha || !token) throw new Error('Release verification requires repository, tag, source and read token');
assertReleaseIdentity(tag, expectedSha, execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
const request = async path => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Release verification read failed (HTTP ${response.status})`);
  return response.json();
};
let reference = (await request(`git/ref/tags/${encodeURIComponent(tag)}`)).object;
for (let depth = 0; reference?.type === 'tag' && depth < 8; depth++) {
  if (!/^[a-f0-9]{40}$/.test(reference.sha ?? '')) throw new Error('Invalid annotated tag object');
  reference = (await request(`git/tags/${reference.sha}`)).object;
}
if (reference?.type !== 'commit') throw new Error('Release tag does not resolve to a commit');
assertReleaseIdentity(tag, expectedSha, reference.sha);
let verified;
for (let page = 1; page <= 5; page++) {
  const result = await request(`actions/workflows/verify.yml/runs?per_page=100&page=${page}`);
  if (!Array.isArray(result.workflow_runs)) throw new Error('Invalid verification listing');
  try { verified = verifiedSourceRun(result.workflow_runs, expectedSha); break; }
  catch { if (result.workflow_runs.length < 100) break; }
}
if (!verified) throw new Error('Exact source has no successful main verification; rerun after verification completes');
const result = await request(`actions/runs/${verified.id}/jobs?filter=latest&per_page=100`);
assertVerificationJobs(result.jobs);
console.log(`Verified release ${tag} source ${expectedSha} with run ${verified.id}. No publication performed by this gate.`);
