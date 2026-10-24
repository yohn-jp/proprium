import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS, VERIFICATION_LEAF_JOBS, UNIT_TARGETS, TYPECHECK_TARGETS, TEST_TYPECHECK_SCOPES, BROWSER_SHARDS, PROFILES, NATIVE_SELECTIONS, VERIFICATION_GROUPS, VERIFICATION_TASKS } from './ci-contract.mjs';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
test('twenty execution jobs retain all forty-nine validation obligations exactly once', () => {
  assert.equal(REQUIRED_VERIFICATION_JOBS.length, 20);
  assert.equal(VERIFICATION_LEAF_JOBS.length, 19);
  assert.equal(VERIFICATION_TASKS.length, 49);
  const tasks = Object.values(VERIFICATION_GROUPS).flat();
  assert.equal(new Set(tasks).size, tasks.length);
  assert.deepEqual(tasks.toSorted(), VERIFICATION_TASKS.toSorted());
  assert.deepEqual(REQUIRED_VERIFICATION_JOBS, ['plan', ...Object.keys(VERIFICATION_GROUPS), 'certification']);
  for (const [family, axis] of [['unit', 'group'], ['types', 'group'], ['build', 'profile'], ['oci', 'profile'], ['hosted', 'selection']]) {
    assert.equal(workflow.jobs[family].strategy.matrix[axis], '${{ fromJSON(needs.plan.outputs.' + family + ') }}');
  }
  assert.equal(workflow.jobs.browser.strategy.matrix.include, '${{ fromJSON(needs.plan.outputs.browser) }}');
});
test('selected groups depend only on planning and failed groups cannot cancel other evidence', () => {
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.plan.name, 'plan');
  for (const [id, job] of Object.entries(workflow.jobs).filter(([id]) => !['plan', 'certification'].includes(id))) {
    assert.deepEqual(job.needs, ['plan'], id);
    assert.match(job.if, /needs\.plan\.result == 'success'/);
    assert.equal(job['continue-on-error'], undefined, id);
    assert.equal(job.strategy['fail-fast'], false, id);
    assert.ok(job.steps.some(step => step.run?.includes('ci-group.mjs')));
    assert.ok(job.steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.if === 'always()'));
  }
  const gate = workflow.jobs.certification;
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs.toSorted(), ['plan', 'unit', 'types', 'build', 'oci', 'browser', 'hosted'].toSorted());
  assert.ok(gate.steps.some(step => step.uses === 'actions/download-artifact@v4' && step.with.pattern === 'ci-evidence-*'));
});
test('browser groups retain immutable runtime and build once before running selected shards', () => {
  const browser = workflow.jobs.browser;
  assert.match(browser.container.image, /^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/);
  assert.equal(browser.container.options, '--ipc=host');
  const runner = readFileSync(new URL('./ci-group.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runner, /(?:apt(?:-get)?\s|playwright install|--with-deps)/);
  assert.ok(runner.indexOf("node('scripts/verify-browser-runtime.mjs')") < runner.indexOf("run('pnpm', ['build']"));
  assert.match(runner, /run-browser-shard\.mjs.*--prebuilt/);
});
test('all source checkouts bind exact PR head/main source without persisted credentials', () => {
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(step => step.uses === 'actions/checkout@v4');
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
    const execution = job.steps.find(step => /node scripts\/(?:ci-impact|ci-group|certify-ci)\.mjs/.test(step.run ?? ''));
    assert.equal(execution.env.SCRIPTORIUM_CI_PLAN_PATH, '${{ runner.temp }}/ci-plan/ci-plan.json');
    for (const step of job.steps.filter(step => step.uses === 'actions/download-artifact@v4' && step.with.name === 'ci-plan')) {
      assert.equal(step.with.path, '${{ runner.temp }}/ci-plan');
    }
  }
});

test('every default browser spec is assigned a Chromium shard and WebKit UI is preserved', () => {
  const directory = fileURLToPath(new URL('../tests/e2e/', import.meta.url));
  const discover = current => readdirSync(current, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(current, entry.name);
    return entry.isDirectory() && entry.name !== 'test-results'
      ? discover(full)
      : entry.isFile() && /\.spec\.tsx?$/.test(entry.name) ? [path.relative(directory, full)] : [];
  });
  // This pre-existing host acceptance requires a separate external lifecycle environment.
  const hostOnly = 'core64-lifecycle.host.acceptance.spec.ts';
  const specs = discover(directory).filter(file => file !== hostOnly);
  assert.deepEqual(specs.toSorted(), BROWSER_SHARDS.filter(shard => shard.project === 'chromium').map(shard => shard.file).toSorted());
  assert.deepEqual(BROWSER_SHARDS.filter(shard => shard.project === 'webkit').map(shard => shard.file), ['ui-v1.acceptance.spec.ts']);
  const config = readFileSync(new URL('../tests/e2e/playwright.config.ts', import.meta.url), 'utf8');
  assert.match(config, /testIgnore: "\*\*\/core64-lifecycle\.host\.acceptance\.spec\.ts"/);
  assert.match(config, /fullyParallel: false/);
  assert.match(config, /workers: 1/);
});
