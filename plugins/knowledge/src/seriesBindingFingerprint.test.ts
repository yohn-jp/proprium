import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "./sha256.js";
import { canonicalSeriesBindingJson, seriesBindingPreferenceKey } from "./seriesBindingFingerprint.js";

test("series binding preference key hashes the full recursively sorted record", () => {
  const first = { seriesId: "north", extra: { z: [1, true], a: "kept" } };
  const reordered = { extra: { a: "kept", z: [1, true] }, seriesId: "north" };
  const canonical = '{"extra":{"a":"kept","z":[1,true]},"seriesId":"north"}';
  assert.equal(canonicalSeriesBindingJson(first), canonical);
  assert.equal(seriesBindingPreferenceKey(first), `series.binding.${sha256Hex(canonical)}`);
  assert.equal(seriesBindingPreferenceKey(first), seriesBindingPreferenceKey(reordered));
  assert.notEqual(seriesBindingPreferenceKey(first), seriesBindingPreferenceKey({ ...first, extra: { ...first.extra, z: [1, false] } }));
});

test("series binding fingerprint rejects values outside bounded JSON records", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => seriesBindingPreferenceKey(cyclic), /cycle/u);
  assert.throws(() => seriesBindingPreferenceKey({ when: new Date(0) }), /JSON values/u);
});
