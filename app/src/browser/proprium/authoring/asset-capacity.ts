import type { AssetCapacityInput, AssetCapacityMeasurement } from './assets.js';

const GIB = 1024 ** 3;
export const E5_WORKING_MEMORY_BYTES = 3 * GIB;

export interface AssetDeviceFacts {
  readonly wasm: boolean;
  readonly indexedDB: boolean;
  readonly availableStorageBytes: number | null;
  readonly deviceMemoryGiB: number | null;
  readonly hardwareConcurrency: number;
  readonly userAgent: string;
  readonly mobile: boolean;
}

/** Capacity admission is separate from signed-asset verification and never grants a transfer. */
export function assetCapacityForDevice(input: AssetCapacityInput, facts: AssetDeviceFacts): AssetCapacityMeasurement {
  const base = { available_storage_bytes: facts.availableStorageBytes, memory_required_bytes: null };
  const storageMeasured = facts.availableStorageBytes !== null && Number.isSafeInteger(facts.availableStorageBytes) && facts.availableStorageBytes >= 0;
  const prerequisites = facts.wasm && facts.indexedDB && storageMeasured;
  if (input.role === 'dictionary') return { ...base, device_supported: prerequisites,
    device_requirements: ['辞書はプラグインのローカルWASMで処理します。原稿は送信しません。'],
    ...(!prerequisites ? { reason: 'WASM・ローカル保存機能または保存容量を確認できません。' } : {}) };

  // This support policy is specific to the pinned fp32 E5 implementation, not
  // a declaration that an arbitrary signed model fits the browser. The engine
  // and asset broker still verify the complete identity and every digest.
  const e5 = input.plugin_id === 'proprium.semantic' && input.group_id === 'proprium.semantic.embedding.e5-small'
    && input.role === 'embedding' && input.group_bytes === 492_423_173;
  const desktopChromium = /(?:Chrome|Chromium)\/\d+/u.test(facts.userAgent) && !facts.mobile;
  const memoryHint = facts.deviceMemoryGiB !== null && Number.isFinite(facts.deviceMemoryGiB) && facts.deviceMemoryGiB >= 8;
  const supported = e5 && prerequisites && desktopChromium && memoryHint && facts.hardwareConcurrency >= 4;
  return { ...base, memory_required_bytes: e5 ? E5_WORKING_MEMORY_BYTES : null,
    device_supported: supported,
    device_requirements: [
      'E5 fp32: デスクトップChromium、端末メモリー情報8 GiB以上、論理CPU 4以上が必要です。',
      'モデル実行の作業メモリー目安は3 GiBです。ブラウザーから空きRAMは測定できず、実行成功やメモリーの上限は保証しません。',
      'モバイル・WebKit・未検証モデルでは語句検索を利用できます。原稿は端末内で処理します。',
    ],
    ...(!supported ? { reason: !e5 ? 'このモデルのブラウザー実行環境は未検証です。'
      : !prerequisites ? 'WASM・ローカル保存機能または保存容量を確認できません。'
        : 'E5の対応端末条件を確認できません。語句検索を引き続き利用できます。' } : {}) };
}

/** Read browser-reported capacity; no model allocation, download or provider call. */
export async function measureBrowserAssetCapacity(input: AssetCapacityInput): Promise<AssetCapacityMeasurement> {
  const estimate = await navigator.storage?.estimate().catch(() => undefined);
  const available = estimate?.quota !== undefined && estimate.usage !== undefined
    ? Math.max(0, estimate.quota - estimate.usage) : null;
  const device = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  return assetCapacityForDevice(input, {
    wasm: typeof WebAssembly !== 'undefined' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    indexedDB: typeof indexedDB !== 'undefined', availableStorageBytes: available,
    deviceMemoryGiB: device.deviceMemory ?? null, hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    mobile: device.userAgentData?.mobile === true || /Mobi|Android|iPhone|iPad|iPod/u.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  });
}
