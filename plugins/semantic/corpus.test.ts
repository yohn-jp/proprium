import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceTextDecoder } from '../../app/src/browser/proprium/authoring/source-text.ts';
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
test('corpus reads BOM sources with Host UTF-16 offsets and exact original quotes', () => {
  const manuscript = '\uFEFF---\r\ntitle: 🌸 Station\r\n---\r\n\r\n🧭 星が見える。次の場面。\r\n';
  const source = '\uFEFFid: scene-a\r\ntype: scene\r\nmanuscript: manuscript/custom.md\r\ndescription: "🌙 opening."\r\n';
  const decodedManuscript = sourceTextDecoder().decode(new TextEncoder().encode(manuscript));
  const decodedSource = sourceTextDecoder().decode(new TextEncoder().encode(source));
  const corpus = run({
    'plot/scenes/a.yaml': source,
    'manuscript/custom.md': manuscript,
  });
  const passages = corpus.passages.filter((passage: any) => passage.sourcePath === 'manuscript/custom.md');

  assert.deepEqual(passages.map((passage: any) => passage.text), ['🧭 星が見える。', '次の場面。']);
  for (const passage of passages) {
    assert.equal(passage.evidence.quote, decodedManuscript.slice(passage.evidence.start, passage.evidence.end));
    assert.equal(passage.evidence.start, decodedManuscript.indexOf(passage.evidence.quote));
  }
  const yamlPassage = corpus.passages.find((passage: any) => passage.sourcePath === 'plot/scenes/a.yaml')!;
  assert.equal(yamlPassage.evidence.quote, decodedSource.slice(yamlPassage.evidence.start, yamlPassage.evidence.end));
  assert.equal(yamlPassage.evidence.start, decodedSource.indexOf(yamlPassage.evidence.quote));
  assert.equal(decodedSource.charCodeAt(0), 0xfeff);
  assert.equal(corpus.entities.find((entity: any) => entity.path === 'plot/scenes/a.yaml')?.id, 'scene-a');
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
