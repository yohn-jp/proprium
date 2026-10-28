import assert from 'node:assert/strict';
import test from 'node:test';
import { assetCapacityForDevice, E5_WORKING_MEMORY_BYTES, type AssetDeviceFacts } from './asset-capacity.js';
import type { AssetCapacityInput } from './assets.js';

const input = { plugin_id: 'proprium.semantic', group_id: 'proprium.semantic.embedding.e5-small', role: 'embedding',
  group_bytes: 492_423_173, storage_required_bytes: 1_000_000_000, transfer_required_bytes: 492_423_173 } as AssetCapacityInput;
const facts: AssetDeviceFacts = { wasm: true, indexedDB: true, availableStorageBytes: 10_000_000_000,
  deviceMemoryGiB: 8, hardwareConcurrency: 8, userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36', mobile: false };

test('admits only the pinned desktop E5 resource class and discloses memory limits', () => {
  const result = assetCapacityForDevice(input, facts);
  assert.equal(result.device_supported, true);
  assert.equal(result.memory_required_bytes, E5_WORKING_MEMORY_BYTES);
  assert.match(result.device_requirements.join(' '), /空きRAMは測定できず/u);
  assert.equal(assetCapacityForDevice({ ...input, group_bytes: input.group_bytes + 1 }, facts).device_supported, false);
  assert.equal(assetCapacityForDevice({ ...input, plugin_id: 'untrusted.example' }, facts).device_supported, false);
  assert.equal(assetCapacityForDevice({ ...input, role: 'reranker' }, facts).device_supported, false);
});
test('mobile, unmeasured memory, missing local primitives and other engines remain unavailable', () => {
  for (const change of [{ mobile: true }, { deviceMemoryGiB: null }, { deviceMemoryGiB: 4 }, { wasm: false },
    { indexedDB: false }, { availableStorageBytes: null }, { hardwareConcurrency: 2 }, { userAgent: 'Version/26 Safari/605.1' }]) {
    assert.equal(assetCapacityForDevice(input, { ...facts, ...change }).device_supported, false, JSON.stringify(change));
  }
});
test('dictionary processing retains independent support on non-model platforms', () => {
  const result = assetCapacityForDevice({ ...input, role: 'dictionary' }, { ...facts, deviceMemoryGiB: null, mobile: true, userAgent: 'WebKit' });
  assert.equal(result.device_supported, true);
  assert.equal(result.memory_required_bytes, null);
  assert.equal(assetCapacityForDevice({ ...input, role: 'dictionary' }, { ...facts, availableStorageBytes: NaN }).device_supported, false);
});
