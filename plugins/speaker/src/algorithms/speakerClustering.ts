/**
 * 話者クラスタリング公開 API。
 * 実装は `speaker/` 配下のパイプライン段へ分割済み（移動のみ・ロジック非変更）。
 * 呼び出し側・既存テストの import パス互換のため、このファイルを薄い再エクスポートとして残す。
 */
export { countUniqueStrongHintEntities } from "./speaker/anchors.js";
export {
  consolidateEntityClusters,
  ensureAllClusterIds,
  expandClustersToN,
} from "./speaker/assign.js";
export { clusterUnattributedDialogues } from "./speaker/heuristics.js";
export { partitionDialoguesIntoN } from "./speaker/partition.js";
export { type PartitionContext, speakerClusterId } from "./speaker/types.js";
