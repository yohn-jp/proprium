#!/usr/bin/env node
// Read-only observed timings. Unseparated legacy phases remain NOT_CHECKED.
import { writeFile, appendFile } from 'node:fs/promises';
import { collectGitHubPages } from './release-policy.mjs';
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const repository = process.env.GITHUB_REPOSITORY;
const runId = option('--run') ?? process.env.GITHUB_RUN_ID;
const attempt = option('--attempt');
if (args.includes('--attempt') && !/^[1-9]\d*$/.test(attempt ?? '')) throw new Error('Attempt must be a positive integer');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(runId ?? '') || !process.env.GH_TOKEN) throw new Error('Repository, run and read token required');
const request = async endpoint => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Timing evidence unavailable (HTTP ${response.status})`);
  return response.json();
};
const runPath = `actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ''}`;
const run = await request(runPath);
const jobs = await collectGitHubPages(page => request(`${runPath}/jobs?${attempt ? '' : 'filter=latest&'}per_page=100&page=${page}`), 'jobs');
const seconds = (start, end) => start && end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) : null;
const observations = jobs.map(job => {
  const phase = pattern => job.steps.filter(step => pattern.test(step.name)).map(step => ({ name: step.name, seconds: seconds(step.started_at, step.completed_at), result: step.conclusion }));
  return { name: job.name, sha: job.head_sha, result: job.conclusion, queueSeconds: seconds(job.created_at, job.started_at),
    durationSeconds: seconds(job.started_at, job.completed_at),
    runnerPreparation: phase(/Set up job|Initialize containers|setup-node/),
    dependencyInstall: phase(/Install frozen|Install exact|Prepare exact/),
    build: phase(/Build required|Build production|Build Core|Build native/),
    test: phase(/Test workspace|Test isolated|Typecheck|Verify native|Verify production OCI|Audit Core/),
    externalDownload: phase(/^(?:Initialize containers|Prepare exact|Install frozen|Restore content-addressed|Run actions\/setup-node)/),
    externalDownloadNote: 'Container pull and dependency retrieval are phase timings; download-only time is not exposed separately by Actions API.',
    cache: phase(/Restore content-addressed/), cacheHit: job.steps.find(step => /^Dependency cache hit=/.test(step.name))?.name.split('=')[1] ?? 'NOT_CHECKED',
  };
});
const completed = jobs.filter(job => job.completed_at).map(job => Date.parse(job.completed_at));
const leafJobs = jobs.filter(job => job.name !== 'certification' && job.completed_at);
const latestLeaf = leafJobs.sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))[0];
// A rerun starts a new attempt; do not count the idle gap since the original run.
const attemptStartedAt = run.run_attempt > 1 ? run.run_started_at : run.created_at;
const report = { runId, createdAt: run.created_at, attemptStartedAt, url: run.html_url, sha: run.head_sha, attempt: run.run_attempt, status: run.status, result: run.conclusion,
  wallClockSeconds: run.status === 'completed' && completed.length ? (Math.max(...completed) - Date.parse(attemptStartedAt)) / 1000 : null,
  observedElapsedSeconds: completed.length ? (Math.max(...completed) - Date.parse(attemptStartedAt)) / 1000 : null,
  criticalPath: latestLeaf ? `${latestLeaf.name}${jobs.some(job => job.name === 'certification') ? ' -> certification' : ''}` : null,
  warmColdClassification: 'Use per-job cache results; a rerun is not automatically warm.',
  phaseMeasurementNote: 'Empty phase arrays mean not separately instrumented, not zero. Legacy source/browser steps combine phases; OCI combines image build and runtime checks; native verification includes Docker builds and compose. Download-related steps include other work and are not download-only stopwatch measurements.',
  jobs: observations };
const output = option('--out');
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Timing evidence: run ${runId}, last completed leaf ${latestLeaf?.name ?? 'NOT_CHECKED'}. Final wall-clock is measured after workflow completion.\n`);
