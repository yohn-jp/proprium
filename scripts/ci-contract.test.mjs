import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { REQUIRED_VERIFICATION_JOBS, VERIFICATION_LEAF_JOBS, UNIT_TARGETS, TYPECHECK_TARGETS, TEST_TYPECHECK_SCOPES, BROWSER_SHARDS, PROFILES, NATIVE_SELECTIONS } from './ci-contract.mjs';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = parse(readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8'));
const values = job => {
  let rows = [{}];
  for (const [key, items] of Object.entries(job.strategy?.matrix ?? {})) {
    assert.ok(Array.isArray(items) && items.length > 0, `Unsupported or empty matrix: ${key}`);
    rows = rows.flatMap(row => items.map(value => ({ ...row, [key]: value })));
  }
  return rows.map(row => job.name.replace(/\$\{\{ matrix\.(\w+) \}\}/g, (_, key) => {
    assert.ok(key in row); return row[key];
  }));
};
test('every canonical matrix element executes once with no omitted or extra required jobs', () => {
  const names = Object.values(workflow.jobs).flatMap(values);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.toSorted(), REQUIRED_VERIFICATION_JOBS.toSorted());
  assert.equal(names.length, 50);
  assert.deepEqual(workflow.jobs.unit.strategy.matrix.target, UNIT_TARGETS.map(item => item.id));
  assert.deepEqual(workflow.jobs.typecheck.strategy.matrix.target, TYPECHECK_TARGETS.map(item => item.id));
  assert.deepEqual(workflow.jobs['test-types'].strategy.matrix.scope, TEST_TYPECHECK_SCOPES);
  assert.deepEqual(workflow.jobs.browser.strategy.matrix.profile, PROFILES);
  assert.deepEqual(workflow.jobs.browser.strategy.matrix.suite, BROWSER_SHARDS.map(item => item.id));
  assert.deepEqual(workflow.jobs.hosted.strategy.matrix.selection, NATIVE_SELECTIONS);
});
test('independent leaves start immediately and no failure, skip or update cancels unrelated work', () => {
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const leaves = Object.entries(workflow.jobs).filter(([id]) => id !== 'certification');
  for (const [id, job] of leaves) {
    assert.equal(job.needs, undefined, id);
    assert.equal(job.if, undefined, id);
    assert.equal(job['continue-on-error'], undefined, id);
    if (job.strategy) {
      assert.equal(job.strategy['fail-fast'], false, id);
      assert.equal(job.strategy['max-parallel'], undefined, id);
    }
  }
  const gate = workflow.jobs.certification;
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs.toSorted(), leaves.map(([id]) => id).toSorted());
  assert.equal(VERIFICATION_LEAF_JOBS.length, 49);
});
test('browser jobs use immutable official runtime without dynamic APT/browser installation', () => {
  const browser = workflow.jobs.browser;
  assert.match(browser.container.image, /^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/);
  assert.equal(browser.container.options, '--ipc=host');
  const commands = browser.steps.map(step => step.run ?? '').join('\n');
  assert.doesNotMatch(commands, /(?:apt(?:-get)?\s|playwright install|--with-deps)/);
  assert.match(commands, /verify-browser-runtime\.mjs/);
  assert.match(commands, /run-browser-shard\.mjs.*--prebuilt/);
  assert.ok(browser.steps.findIndex(step => step.run?.includes('verify-browser-runtime')) < browser.steps.findIndex(step => step.run?.includes('pnpm build')));
});
test('all source checkouts bind exact PR head/main source without persisted credentials', () => {
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find(step => step.uses === 'actions/checkout@v4');
    assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
    assert.equal(checkout.with['persist-credentials'], false);
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
