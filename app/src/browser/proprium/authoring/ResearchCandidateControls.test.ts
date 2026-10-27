import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { literalCandidateRequest } from './ResearchCandidateControls.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
test('candidate literal corpus binds exact UTF-8 text and excludes no source path', async () => {
  const text = '月🌙\n星';
  const request = await literalCandidateRequest(text, '既知\n 別名 ');
  assert.deepEqual(request, { corpus: { kind: 'text', items: [{ id: 'literal', revision: createHash('sha256').update(text).digest('hex'), texts: [{ id: 'literal', text }] }] }, knownTerms: ['既知', '別名'], limit: 50 });
  await assert.rejects(literalCandidateRequest('\ud800', ''), /文章/u);
  await assert.rejects(literalCandidateRequest('あ'.repeat(30000), ''), /64 KiB/u);
});
