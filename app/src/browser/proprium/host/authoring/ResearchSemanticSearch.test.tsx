import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { applySemanticRanks, ResearchSemanticSearch, validSearchHits, validSourceSpan } from './ResearchSemanticSearch.js';

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

test('reranking reorders grounded semantic rows while leaving lexical-only result slots fixed', () => {
  const [vectorA, lexical, vectorB] = validSearchHits([
    { path: 'semantic/a.md', title: 'a', fileRevision: 'r1', snippet: '灯台の光', score: 10, source: 'semantic', scoreFactors: [],
      navigationSpan: { path: 'semantic/a.md', revision: 'r1', start: 0, end: 4, quote: '灯台の光' },
      semanticCandidate: { candidateId: 'candidate-a', entityId: 'a', sourcePath: 'semantic/a.md', sourceRevision: 'r1', sentenceIndex: 0,
        text: '灯台の光', evidence: [{ path: 'semantic/a.md', revision: 'r1', start: 0, end: 4, quote: '灯台の光' }] } },
    { kind: 'document', path: 'lexical/only.md', title: 'lexical', fileRevision: 'r2', snippet: '語句一致', score: 9, scoreFactors: ['body-contains'],
      navigationSpan: { path: 'lexical/only.md', revision: 'r2', start: 0, end: 4, quote: '語句一致' } },
    { path: 'semantic/b.md', title: 'b', fileRevision: 'r3', snippet: '航路を照らす', score: 8, source: 'semantic', scoreFactors: [],
      navigationSpan: { path: 'semantic/b.md', revision: 'r3', start: 0, end: 6, quote: '航路を照らす' },
      semanticCandidate: { candidateId: 'candidate-b', entityId: 'b', sourcePath: 'semantic/b.md', sourceRevision: 'r3', sentenceIndex: 0,
        text: '航路を照らす', evidence: [{ path: 'semantic/b.md', revision: 'r3', start: 0, end: 6, quote: '航路を照らす' }] } },
  ]);
  const reordered = applySemanticRanks([vectorA!, lexical!, vectorB!], [
    { candidateId: 'candidate-b', score: 0.9, rank: 1 }, { candidateId: 'candidate-a', score: 0.2, rank: 2 },
  ]);
  assert.deepEqual(reordered?.map(hit => hit.path), ['semantic/b.md', 'lexical/only.md', 'semantic/a.md']);
});

test('reranking rejects duplicate, missing, out-of-range ranks and invalid scores without changing order', () => {
  const [a, b] = validSearchHits([
    { path: 'semantic/a.md', title: 'a', fileRevision: 'r1', snippet: '灯台', score: 10, scoreFactors: [],
      navigationSpan: { path: 'semantic/a.md', revision: 'r1', start: 0, end: 2, quote: '灯台' },
      semanticCandidate: { candidateId: 'candidate-a', entityId: 'a', sourcePath: 'semantic/a.md', sourceRevision: 'r1', sentenceIndex: 0,
        text: '灯台', evidence: [{ path: 'semantic/a.md', revision: 'r1', start: 0, end: 2, quote: '灯台' }] } },
    { path: 'semantic/b.md', title: 'b', fileRevision: 'r2', snippet: '航路', score: 9, scoreFactors: [],
      navigationSpan: { path: 'semantic/b.md', revision: 'r2', start: 0, end: 2, quote: '航路' },
      semanticCandidate: { candidateId: 'candidate-b', entityId: 'b', sourcePath: 'semantic/b.md', sourceRevision: 'r2', sentenceIndex: 0,
        text: '航路', evidence: [{ path: 'semantic/b.md', revision: 'r2', start: 0, end: 2, quote: '航路' }] } },
  ]);
  const original = [a!, b!];
  assert.equal(applySemanticRanks(original, [
    { candidateId: 'candidate-a', score: 0.8, rank: 1 }, { candidateId: 'candidate-b', score: 0.7, rank: 1 },
  ]), null);
  assert.equal(applySemanticRanks(original, [
    { candidateId: 'candidate-a', score: 0.8, rank: 1 }, { candidateId: 'candidate-b', score: 0.7, rank: 3 },
  ]), null);
  assert.equal(applySemanticRanks(original, [
    { candidateId: 'candidate-a', score: 0.8, rank: 1 }, { candidateId: 'candidate-b', score: 0.7 },
  ]), null);
  assert.equal(applySemanticRanks(original, [
    { candidateId: 'candidate-a', score: 0.8, rank: 1 },
  ]), null);
  assert.equal(applySemanticRanks(original, [
    { candidateId: 'candidate-a', score: -0.1, rank: 1 }, { candidateId: 'candidate-b', score: 0.7, rank: 2 },
  ]), null);
  assert.equal(applySemanticRanks(original, [
    { candidateId: 'candidate-a', score: 0.8, rank: 1 }, { candidateId: 'unknown', score: 0.7, rank: 2 },
  ]), null);
  assert.deepEqual(original.map(hit => hit.path), ['semantic/a.md', 'semantic/b.md']);
});
