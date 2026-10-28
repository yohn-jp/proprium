import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFeatureAudits } from './authoring-feature-audit.mjs';

const requirements = [{ feature_id: 'SEM-01', plugin_id: 'proprium.semantic' }, { feature_id: 'PW-01', plugin_id: 'proprium.paired-writing' }];
const row = (requirement, status) => ({ ...requirement, status, requirement: 'Visible author behavior', implementation_files: ['plugins/example/guest.ts'],
  host_path: 'typed action broker', ui_path: 'declared panel', existing_tests: [], gaps: ['browser proof pending'],
  required_fixes: ['run signed browser scenario'], dependencies: [], priority: 'P1', verification: [] });
const fixture = () => [{ schema: 'proprium.authoring.feature-audit/v1', base_sha: 'a'.repeat(40),
  features: [row(requirements[0], 'UNVERIFIED'), row(requirements[1], 'FROZEN')] }];

test('keeps frozen and unverified features distinct from implemented behavior', () => {
  const result = validateFeatureAudits(fixture(), requirements);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.features.map(row => row.status), ['FROZEN', 'UNVERIFIED']);
});
test('rejects missing, duplicated and reassigned feature coverage', () => {
  const audits = fixture();
  audits[0].features[1] = { ...audits[0].features[0], plugin_id: 'proprium.research' };
  const { errors } = validateFeatureAudits(audits, requirements);
  assert.ok(errors.some(error => error.includes('missing assessment')));
  assert.ok(errors.some(error => error.includes('duplicate assessment')));
  assert.ok(errors.some(error => error.includes('incorrect plugin owner')));
});
test('cannot freeze active shared work or claim implemented with only source presence', () => {
  const audits = fixture();
  audits[0].features[0].status = 'FROZEN';
  assert.ok(validateFeatureAudits(audits, requirements).errors.some(error => error.includes('cannot be frozen')));
  audits[0].features[0].status = 'IMPLEMENTED';
  assert.ok(validateFeatureAudits(audits, requirements).errors.some(error => error.includes('behavior verification')));
});
test('unfinished work must name its gaps and required repairs', () => {
  const audits = fixture();
  audits[0].features[0].gaps = [];
  assert.ok(validateFeatureAudits(audits, requirements).errors.some(error => error.includes('remaining work')));
});
