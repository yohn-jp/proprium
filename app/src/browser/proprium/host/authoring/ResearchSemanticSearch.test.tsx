import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResearchSemanticSearch, validSearchHits, validSourceSpan } from './ResearchSemanticSearch.js';

test('search panel retains lexical/exact/prefix controls and explicit optional modes', () => {
  const html = renderToStaticMarkup(<ResearchSemanticSearch scopeKey="repo:main" semanticAvailable={false}
    invokeRead={async () => { throw new Error('unexpected invocation'); }}
    navigate={async () => { throw new Error('unexpected navigation'); }} />);
  assert.match(html, /value="lexical"/u);
  assert.match(html, /value="exact"/u);
  assert.match(html, /value="prefix"/u);
  assert.match(html, /value="hybrid"/u);
  assert.match(html, /value="semantic"/u);
  assert.match(html, /value="expression"/u);
});

test('source navigation requires a bounded safe relative path and valid UTF-16 range', () => {
  assert.equal(validSourceSpan({ path: 'manuscript/a.md', revision: 'r1', start: 4, end: 6, quote: '文。' }), true);
  assert.equal(validSourceSpan({ path: 'manuscript/a.md', revision: 'r1', start: 4, end: 7 }), true);
  assert.equal(validSourceSpan({ path: '../secrets.md', revision: 'r1', start: 4, end: 7, quote: '文。' }), false);
  assert.equal(validSourceSpan({ path: 'manuscript/a.md', revision: 'r1', start: 7, end: 4, quote: '文。' }), false);
  assert.equal(validSourceSpan({ path: 'manuscript/a.md', revision: 'r1', start: 0, end: 1, quote: '' }), false);
  assert.equal(validSourceSpan({ path: 'manuscript/a.md', revision: 'r1', start: 4, end: 7, quote: '文。' }), false);
  assert.throws(() => validSearchHits([{ path: 'manuscript/a.md', title: 'a', fileRevision: 'r1', snippet: 'abc', score: 1,
    source: 'vector', scoreFactors: [], navigationSpan: { path: '../x', revision: 'r1', start: 0, end: 1, quote: 'x' } }]));
  assert.throws(() => validSearchHits([{ path: '../secrets.md', title: 'a', fileRevision: 'r1', snippet: 'abc', score: 1, scoreFactors: [] }]));
});

test('lexical results keep their source span and receive a truthful lexical label', () => {
  const [hit] = validSearchHits([{ kind: 'document', path: 'manuscript/a.md', title: 'a', fileRevision: 'r1', snippet: 'abc', score: 2,
    scoreFactors: ['body-contains'], navigationSpan: { path: 'manuscript/a.md', revision: 'r1', start: 4, end: 7 } }]);
  assert.equal(hit?.source, 'lexical');
  assert.equal(hit?.navigationSpan?.quote, undefined);
});
