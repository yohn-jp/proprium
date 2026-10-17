import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_PERSISTENCE_FORMATS } from '../packages/module-runtime/dist/index.js';
import { persistenceForModules } from './hosted-build.mjs';

test('composition persistence declares base and selected module readers/writers only', () => {
  const persistence = persistenceForModules(['publishing', 'story'], MODULE_PERSISTENCE_FORMATS);
  const readable = new Map(persistence.readable.map(({ formatId, versions }) => [formatId, versions]));
  const writable = new Set(persistence.writable.map(({ formatId, version }) => `${formatId}@${version}`));

  assert.deepEqual(readable.get('scriptorium.git-operations'), [1]);
  assert.deepEqual(readable.get('scriptorium.git-proposal-legacy'), [1]);
  assert.deepEqual(readable.get('scriptorium.browser-recovery-indexeddb'), [3]);
  assert.deepEqual(readable.get('scriptorium.module-story.series'), [1]);
  assert.deepEqual(readable.get('scriptorium.module-publishing.cover'), [1]);
  assert.equal(readable.has('scriptorium.module-story.change-sets'), false);
  assert.equal(readable.has('scriptorium.module-assistant.model-settings'), false);
  assert.equal(writable.has('scriptorium.module-publishing.cover@1'), false);
  assert.equal(writable.has('scriptorium.module-story.series@1'), true);
  assert.equal(persistence.contractVersion, 'scriptorium-persistence/v1');
});

test('composition persistence rejects duplicate module selections', () => {
  assert.throws(() => persistenceForModules(['story', 'story'], MODULE_PERSISTENCE_FORMATS), /unique/u);
});
