import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSemanticCorpus } from './corpus.ts';
const snapshot = { id: 's', local_commit: null, worktree_generation: 'w', draft_generation: null };
const context: any = { snapshot };
const revision = 'a'.repeat(64);
function* request(operation: string, payload: any): Generator<any, any, any> { return yield { operation, payload }; }
const host: any = { request };
function run(files: Record<string, string>) {
  const generator = collectSemanticCorpus(host, context); let state = generator.next();
  while (!state.done) {
    const { operation, payload } = state.value; let value: any;
    if (operation === 'workspace.file.list') value = { entries: Object.entries(files).map(([path, text]) => ({ path, revision, byte_length: new TextEncoder().encode(text).length, media_type: 'text/plain' })), next_cursor: null };
    else if (operation === 'workspace.file.read') { const bytes = [...new TextEncoder().encode(files[payload.path]!)]; value = { revision, total_bytes: bytes.length, offset: 0, bytes, next_offset: null }; }
    else throw new Error(operation);
    state = generator.next(value);
  }
  return state.value;
}
test('corpus resolves manuscript identity from explicit scene link and ignores unlinked files', () => {
  const corpus = run({ 'plot/scenes/a.yaml': 'id: scene-a\ntype: scene\nmanuscript: manuscript/custom.md\n', 'manuscript/custom.md': '星が見える。', 'manuscript/unlinked.md': '非公開。' });
  assert.equal(corpus.passages.length, 1);
  assert.equal(corpus.passages[0].entityId, 'scene-a');
  assert.equal(corpus.passages[0].evidence.quote, '星が見える。');
});
test('corpus rejects two scenes that claim the same manuscript', () => {
  assert.throws(() => run({ 'plot/scenes/a.yaml': 'id: a\ntype: scene\nmanuscript: manuscript/shared.md\n', 'plot/scenes/b.yaml': 'id: b\ntype: scene\nmanuscript: manuscript/shared.md\n', 'manuscript/shared.md': '本文。' }), /ambiguous/i);
});
test('malformed recognized YAML cannot become a falsely complete corpus', () => {
  assert.throws(() => run({ 'bible/characters/a.yaml': 'id: [\n' }), (error: any) => error.code === 'unsupported_format');
});
test('corpus can consume component sentence boundaries without browser Intl', async () => {
  const { setInferenceBindings } = await import('./inference.ts');
  setInferenceBindings({ beginAsset() {}, appendAsset() {}, finishAsset() {}, loadEmbedding() {}, embedPassages() { return []; }, release() {}, splitSentenceEnds(text: string) { return [text.length]; } });
  const original = globalThis.Intl;
  try {
    Object.defineProperty(globalThis, 'Intl', { value: undefined, configurable: true });
    const corpus = run({ 'plot/scenes/a.yaml': 'id: scene-a\ntype: scene\nmanuscript: manuscript/custom.md\n', 'manuscript/custom.md': '星が見える。' });
    assert.equal(corpus.passages[0]?.evidence.quote, '星が見える。');
  } finally { Object.defineProperty(globalThis, 'Intl', { value: original, configurable: true, writable: true }); }
});
test('a missing explicitly linked manuscript reports its path', () => {
  assert.throws(() => run({ 'plot/scenes/a.yaml': 'id: scene-a\ntype: scene\nmanuscript: manuscript/missing.md\n' }), (error: any) => error.code === 'file_not_found' && error.message.includes('manuscript/missing.md'));
});
