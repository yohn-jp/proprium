import assert from "node:assert/strict";
import test from "node:test";
import { splitIntoSentenceOffsets } from "./sentences.ts";

test("sentence offsets preserve Japanese brackets, multiline boundaries, and UTF-16 coordinates", () => {
  const text = "「彼は言った。続けよう。」\n海岸へ向かった。🌊";
  const offsets = splitIntoSentenceOffsets(text);
  const nonEmpty = offsets.map(({ start, end }) => text.slice(start, end).trim()).filter(Boolean);
  assert.deepEqual(nonEmpty, ["「彼は言った。続けよう。」", "海岸へ向かった。", "🌊"]);
  const finalSentence = offsets.find(({ start, end }) => text.slice(start, end) === "🌊")!;
  assert.equal(finalSentence.end - finalSentence.start, 2);
});

test('missing Intl reports an explicit unavailable dependency', () => {
  const intl = globalThis.Intl;
  try {
    Object.defineProperty(globalThis, 'Intl', { value: undefined, configurable: true });
    assert.throws(() => splitIntoSentenceOffsets('文章。'), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'dependency_unavailable'));
  } finally { Object.defineProperty(globalThis, 'Intl', { value: intl, configurable: true, writable: true }); }
});

test('a component-provided sentence engine is used when Intl is absent', async () => {
  const { setInferenceBindings } = await import('./inference.ts');
  const { runInNewContext } = await import('node:vm');
  setInferenceBindings({ beginAsset() {}, appendAsset() {}, finishAsset() {}, loadEmbedding() {}, embedPassages() { return []; }, release() {}, splitSentenceEnds(text: string) { assert.equal(text, '駅。🌸海。'); return runInNewContext("new Uint32Array([2, 6])"); } });
  const intl = globalThis.Intl;
  try {
    Object.defineProperty(globalThis, 'Intl', { value: undefined, configurable: true });
    assert.deepEqual(splitIntoSentenceOffsets('駅。🌸海。').filter(span => span.end > span.start), [{ start: 0, end: 2 }, { start: 2, end: 6 }]);
  } finally { Object.defineProperty(globalThis, 'Intl', { value: intl, configurable: true, writable: true }); }
});
