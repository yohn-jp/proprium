import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inspectLegacyShareMap, PublishingHostTokenRecovery } from './PublishingHostTokenRecovery.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const row = (overrides: Record<string, unknown> = {}) => ({ id: 'grant-1', ownerId: 'private-owner', projectId: 'project-a',
  scope: 'ch-1', label: '校正', tokenHash: 'A'.repeat(64), tokenPrefix: 'share_secret_prefix',
  createdAt: '2024-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', revokedAt: '2024-02-01T00:00:00.000Z',
  futureMetadata: { note: 'keep', count: 3 }, ...overrides });

test('maps only exact legacy project ID and strips owner and bearer-prefix fields while preserving safe extensions', async () => {
  const bytes = encode([row(), row({ id: 'grant-foreign', projectId: 'other' })]);
  const parsed = await inspectLegacyShareMap('app-state/share-tokens.json', bytes);
  assert.deepEqual(parsed.project_ids, ['other', 'project-a']);
  const selected = parsed.grants.filter(grant => grant.projectId === 'project-a');
  assert.equal(selected.length, 1);
  const [grant] = selected;
  if (!grant || 'invalid' in grant) throw new Error('Expected a safe grant');
  assert.equal(grant?.tokenHash, 'a'.repeat(64));
  assert.equal(grant?.revokedAt, '2024-02-01T00:00:00.000Z');
  assert.deepEqual(grant?.futureMetadata, { note: 'keep', count: 3 });
  assert.equal(grant?.futureMetadata && (grant.futureMetadata as { count: number }).count, 3);
  assert.ok(!JSON.stringify(grant).includes('private-owner'));
  assert.ok(!JSON.stringify(grant).includes('share_secret_prefix'));
  assert.equal(parsed.source_sha256.length, 64);
});

test('blocks rows with raw bearer data, nested secret scope and malformed scopes without exposing values', async () => {
  for (const bad of [
    row({ token: `share_${'a'.repeat(43)}` }),
    row({ scope: { kind: 'scene', id: 'sc-1', token: 'nested-secret' } }),
    row({ scope: { kind: 'scene', id: 'sc-1', userName: 'private' } }),
    row({ scope: 'unknown-scope' }),
    row({ futureMetadata: { opaque: `owner-link=https://old.invalid/#token=share_${'b'.repeat(43)}` } }),
  ]) {
    const parsed = await inspectLegacyShareMap('share-tokens.json', encode([bad]));
    assert.ok(parsed.grants[0] && 'invalid' in parsed.grants[0]);
    assert.equal(parsed.blocked_rows, 1);
    assert.ok(!JSON.stringify(parsed).includes('nested-secret'));
    assert.ok(!JSON.stringify(parsed).includes('private'));
    assert.ok(!JSON.stringify(parsed).includes(`share_${'a'.repeat(43)}`));
    assert.ok(!JSON.stringify(parsed).includes(`share_${'b'.repeat(43)}`));
  }
});

test('rejects malformed files, unknown source identity, invalid hashes and resource overflow', async () => {
  await assert.rejects(() => inspectLegacyShareMap('other.json' as never, encode([row()])));
  await assert.rejects(() => inspectLegacyShareMap('share-tokens.json', new TextEncoder().encode('{')));
  const invalidRows = await inspectLegacyShareMap('share-tokens.json', encode([{ id: 'bad' }]));
  assert.equal(invalidRows.blocked_rows, 1);
  await assert.rejects(() => inspectLegacyShareMap('share-tokens.json', new Uint8Array(2 * 1024 * 1024 + 1)));
});

test('blocks every row that repeats a grant ID and reports invalid project IDs without echoing them', async () => {
  const parsed = await inspectLegacyShareMap('share-tokens.json', encode([
    row({ id: 'duplicate' }), row({ id: 'duplicate', projectId: 'other' }),
    row({ id: 'private', projectId: `share_${'c'.repeat(43)}` }),
  ]));
  assert.deepEqual(parsed.grants.map(grant => 'invalid' in grant), [true, true]);
  assert.equal(parsed.blocked_rows, 3);
  assert.deepEqual(parsed.project_ids, ['other', 'project-a']);
  assert.ok(!JSON.stringify(parsed).includes(`share_${'c'.repeat(43)}`));
});

test('preserves safe nested extensions while removing nested secret-keyed fields', async () => {
  const parsed = await inspectLegacyShareMap('share-tokens.json', encode([row({
    scope: { kind: 'scene', id: 'sc-1', futureScopeData: { note: 'keep', tokenPrefix: 'share_legacy' } },
    futureMetadata: { safe: { value: 4 }, ownerId: 'private-owner' },
  })]));
  const [grant] = parsed.grants;
  if (!grant || 'invalid' in grant) throw new Error('Expected a safe grant');
  assert.deepEqual(grant.futureMetadata, { safe: { value: 4 } });
  assert.deepEqual(grant.scope, { kind: 'scene', id: 'sc-1', futureScopeData: { note: 'keep' } });
  assert.ok(!JSON.stringify(grant).includes('private-owner'));
  assert.ok(!JSON.stringify(grant).includes('share_legacy'));
});

test('renders the honest manual recovery path and unavailable local-workspace state', () => {
  const inspect = inspectLegacyShareMap;
  const propose = async () => ({ status: 'proposed' });
  const available = renderToStaticMarkup(createElement(PublishingHostTokenRecovery, { repositoryId: 123, branch: 'main', inspect, propose }));
  assert.match(available, /server-local file はブラウザーから自動では読めません/u);
  assert.match(available, /app-state\/share-tokens\.json/u);
  assert.match(available, /復旧した file を選択/u);

  const unavailable = renderToStaticMarkup(createElement(PublishingHostTokenRecovery, { repositoryId: null, branch: 'main', inspect, propose }));
  assert.match(unavailable, /この workspace では利用できません/u);
  assert.ok(!unavailable.includes('type="file"'));
});
