#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_SHARDS, PROFILES, TYPECHECK_TARGETS, VERIFICATION_GROUPS, VERIFICATION_TASKS, WORKSPACES } from './ci-contract.mjs';

export function createVerificationPlan({ files, event, sha, base = null }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || (base !== null && !/^[a-f0-9]{40}$/.test(base))) throw new Error('Invalid verification source identity');
  const selected = new Set(['coverage']);
  let full = event !== 'pull_request' || !Array.isArray(files);
  const add = (...tasks) => tasks.forEach(task => selected.add(task));
  const browser = profiles => profiles.forEach(profile => BROWSER_SHARDS.forEach(({ id }) => add(`browser-${profile}-${id}`)));
  for (const file of files ?? []) {
    if (typeof file !== 'string' || !file || file.startsWith('/') || file.split('/').includes('..')) { full = true; break; }
    if (file === 'AGENTS.md' || file === 'CONTRIBUTING.md' || file === 'LICENSE' || /^docs\/.*\.md$/u.test(file) || /^README(?:\.[a-z-]+)?\.md$/iu.test(file)) continue;
    // Workspace manifests/configuration, shared contracts and unknown files are global inputs.
    const owner = WORKSPACES.find(item => file.startsWith(`${item.path}/src/`));
    if (!owner || ['contracts', 'module-runtime', 'migration', 'core', 'api'].includes(owner.id)) {
      const spec = BROWSER_SHARDS.find(item => file === `tests/e2e/${item.file}`);
      if (spec) {
        add('test-types-app-e2e');
        for (const profile of PROFILES) {
          add(`build-${profile}`, `browser-${profile}-${spec.id}`);
          if (spec.id === 'ui-v1') add(`browser-${profile}-webkit`);
        }
        continue;
      }
      full = true;
      continue;
    }
    const testOnly = /\.(?:test|spec)\.tsx?$/u.test(file);
    add(`unit-${owner.id}`, `typecheck-${TYPECHECK_TARGETS.find(item => item.workspaces.includes(owner.id)).id}`,
      owner.id === 'app' ? 'test-types-app-e2e' : 'test-types-modules');
    if (testOnly) continue;
    if (owner.id === 'app') {
      add('build-core', 'audit-core', 'build-full', 'safety');
      browser(PROFILES);
    } else if (/\/browser(?:\/|\.|$)/u.test(file)) {
      add('build-full');
      browser(['full']);
    } else {
      // Server modules can participate in runtime composition and other module capabilities.
      full = true;
    }
  }
  const tasks = VERIFICATION_TASKS.filter(task => full || selected.has(task));
  return {
    version: 1, sha, base, event, mode: full ? 'full' : 'affected', files: files ?? null,
    tasks,
    groups: Object.keys(VERIFICATION_GROUPS).filter(group => VERIFICATION_GROUPS[group].some(task => tasks.includes(task))),
    excluded: VERIFICATION_TASKS.filter(task => !tasks.includes(task)).map(task => ({ task, reason: 'Outside the affected source/profile boundaries of this PR' })),
  };
}

export function validateVerificationPlan(plan) {
  if (!plan || JSON.stringify(plan) !== JSON.stringify(createVerificationPlan(plan))) throw new Error('Verification plan does not match canonical impact rules');
  return plan;
}

export function planDigest(plan) { return createHash('sha256').update(JSON.stringify(validateVerificationPlan(plan))).digest('hex'); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sha = process.env.SCRIPTORIUM_EXPECTED_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const event = process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch';
  const payload = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const base = payload.pull_request?.base?.sha ?? null;
  let files = null;
  if (event === 'pull_request' && /^[a-f0-9]{40}$/.test(base ?? '')) {
    try {
      files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${sha}`, '--'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
    } catch { /* Missing history must run full verification, never an empty selection. */ }
  }
  const plan = createVerificationPlan({ files, event, sha, base });
  const planPath = process.env.SCRIPTORIUM_CI_PLAN_PATH ?? 'ci-plan.json';
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      plan: JSON.stringify(plan),
      unit: JSON.stringify(['core', 'modules'].filter(id => plan.groups.includes(`unit-${id}`))),
      types: JSON.stringify(['sources', 'tests'].filter(id => plan.groups.includes(`types-${id}`))),
      build: JSON.stringify(PROFILES.filter(id => plan.groups.includes(`build-${id}`))),
      oci: JSON.stringify(PROFILES.filter(id => plan.groups.includes(`oci-${id}`))),
      browser: JSON.stringify(PROFILES.flatMap(profile => ['writing', 'reference', 'webkit'].filter(id => plan.groups.includes(`browser-${profile}-${id}`)).map(id => ({ group: `${profile}-${id}`, profile })))),
      hosted: JSON.stringify(['catalog', 'core', 'selected', 'full'].filter(id => plan.groups.includes(`hosted-native-${id}`))),
    };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Verification plan: **${plan.mode}**, ${plan.tasks.length}/${VERIFICATION_TASKS.length} validations in ${plan.groups.length} execution groups at ${sha}.\n\n` +
    plan.excluded.map(item => `- NOT_SELECTED: ${item.task}: ${item.reason}\n`).join(''));
  console.log(JSON.stringify(plan));
}
