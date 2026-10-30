import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshCanonMetadata } from './authoring-evidence-metadata.mjs';

const fixture = () => ({ matrix: [{ id: 'R09', canon_title: 'Old title', required_proof: 'Old proof', status: 'FROZEN',
  pre_freeze_status: 'FAIL', command: 'historical-command', git_sha: 'b'.repeat(40), output: 'failure',
  source_revisions: ['c'.repeat(40)], superseded_canon_metadata: { fields: { canon_title: 'Original title' } } }], plugins: [] });
test('description refresh preserves failures, source identity, prior history and input bytes', () => {
  const actual = fixture();
  const before = structuredClone(actual);
  const required = { matrix: [{ id: 'R09', canon_title: 'Frozen title', required_proof: 'Current proof' }], plugins: [] };
  const { ledger, changed } = refreshCanonMetadata(actual, required, 'a'.repeat(40));
  assert.equal(changed, 1);
  assert.deepEqual(actual, before);
  const { canon_title, required_proof, canon_metadata_history, ...retained } = ledger.matrix[0];
  const { canon_title: oldTitle, required_proof: oldProof, ...original } = before.matrix[0];
  assert.deepEqual(retained, original);
  assert.deepEqual(canon_metadata_history[0].fields, { canon_title: oldTitle, required_proof: oldProof });
  assert.equal(canon_title, 'Frozen title');
  assert.equal(required_proof, 'Current proof');
  assert.equal(refreshCanonMetadata(ledger, required, 'a'.repeat(40)).changed, 0);
});
test('old PASS cannot silently certify a revised requirement', () => {
  const actual = fixture(); actual.matrix[0].status = 'PASS';
  assert.throws(() => refreshCanonMetadata(actual, { matrix: [{ id: 'R09', canon_title: 'Changed', required_proof: 'Old proof' }], plugins: [] }, 'a'.repeat(40)), /recertification/);
});
