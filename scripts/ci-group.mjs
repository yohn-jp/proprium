#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { VERIFICATION_GROUPS } from './ci-contract.mjs';
import { planDigest, validateVerificationPlan } from './ci-impact.mjs';

const group = process.argv[2];
const plan = validateVerificationPlan(JSON.parse(readFileSync(process.env.SCRIPTORIUM_CI_PLAN_PATH ?? 'ci-plan.json', 'utf8')));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== plan.sha || !plan.groups.includes(group)) throw new Error('Group is not selected for this exact source');
const tasks = VERIFICATION_GROUPS[group].filter(task => plan.tasks.includes(task));
const results = [];
const reportDirectory = process.env.SCRIPTORIUM_CI_REPORT_DIR ?? path.resolve('ci-results', group);
mkdirSync(reportDirectory, { recursive: true });
const run = (command, args, extraEnv = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.signal ?? result.status})`);
};
const node = (...args) => run(process.execPath, args);
let preparationError;
try {
  if (group.startsWith('unit-')) node('scripts/ci-workspace.mjs', 'prepare', 'unit-group', tasks.map(task => task.slice(5)).join(','));
  if (group.startsWith('browser-')) {
    node('scripts/verify-browser-runtime.mjs');
    run('pnpm', ['build'], { SCRIPTORIUM_PROFILE: group.split('-')[1] });
  }
} catch (error) { preparationError = String(error); }

for (const task of tasks) {
  const started = Date.now();
  let error = preparationError;
  const blocked = Boolean(preparationError || (task === 'audit-core' && results.some(item => item.task === 'build-core' && item.status !== 'passed')));
  if (!blocked) {
    try {
      if (task.startsWith('unit-')) node('scripts/ci-workspace.mjs', 'unit', task.slice(5));
      else if (task.startsWith('typecheck-')) {
        node('scripts/ci-workspace.mjs', 'prepare', 'typecheck', task.slice(10));
        node('scripts/ci-workspace.mjs', 'typecheck', task.slice(10));
      } else if (task.startsWith('test-types-')) {
        node('scripts/ci-workspace.mjs', 'prepare', 'test-types', task.slice(11));
        node('scripts/ci-workspace.mjs', 'test-types', task.slice(11));
      } else if (task === 'safety') {
        run('pnpm', ['--filter', '@scriptorium/api...', 'build']);
        run('pnpm', ['typecheck:safety']);
      } else if (task.startsWith('build-')) run('pnpm', ['build'], { SCRIPTORIUM_PROFILE: task.slice(6) });
      else if (task === 'audit-core') run('pnpm', ['audit:core']);
      else if (task.startsWith('oci-')) run('bash', ['scripts/verify-oci.sh'], { OCI_ENGINE: 'docker', SCRIPTORIUM_PROFILE: task.slice(4), SCRIPTORIUM_OCI_IMAGE: `scriptorium-verification:${task.slice(4)}` });
      else if (task.startsWith('browser-')) {
        const [, profile, ...suite] = task.split('-');
        run(process.execPath, ['scripts/run-browser-shard.mjs', '--profile', profile, '--suite', suite.join('-'), '--prebuilt'],
          { SCRIPTORIUM_CI_REPORT_DIR: path.join(reportDirectory, task) });
      } else if (task.startsWith('hosted-native-')) {
        const selection = task.slice(14);
        run('pnpm', selection === 'catalog' ? ['--filter', '@scriptorium/module-*...', 'build'] : ['build:workspace']);
        run(process.execPath, ['scripts/verify-hosted-native.mjs', '--selection', selection],
          { SCRIPTORIUM_NATIVE_REPORT_PATH: path.join(reportDirectory, 'native-report.json') });
      } else if (task === 'coverage') {
        node('scripts/ci-workspace.mjs', 'coverage');
        node('--test', 'scripts/ci-contract.test.mjs', 'scripts/ci-impact.test.mjs');
      } else throw new Error(`No runner for ${task}`);
    } catch (caught) { error = String(caught); }
  }
  const result = { task, status: blocked ? 'blocked' : error ? 'failed' : 'passed', seconds: (Date.now() - started) / 1000, ...(error ? { error } : {}) };
  results.push(result);
  console.log(JSON.stringify(result));
}
const report = { group, sha, planDigest: planDigest(plan), results };
writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `| Validation | Result | Seconds |\n| --- | --- | ---: |\n${results.map(item => `| ${item.task} | ${item.status} | ${item.seconds.toFixed(1)} |`).join('\n')}\n`);
if (results.some(item => item.status !== 'passed')) process.exitCode = 1;
