import type { Token } from "@scriptorium/module-nlp";
import { computeDialogueMetrics } from "./metrics.js";
import type {
  StylometricDeviationWarning,
  StylometricMetrics,
  StylometricProfile,
} from "./types.js";

/** 逸脱判定に使うプロファイルの最低セリフ数。styleFingerprint.ts の
 *  MIN_DIALOGUE_FOR_DEVIATION_CHECK と同基準（学習不足での誤警告防止）。 */
export const MIN_DIALOGUE_FOR_DEVIATION_CHECK = 10;

/** 標準偏差がほぼ0（発話が均質すぎる）場合のzスコア発散を防ぐ下限値。 */
const MIN_STD_DEV_FLOOR = 0.01;

/** RMS zスコアがこの値を超えると統計的乖離として警告する（正規分布仮定で概ね95%区間に相当する目安）。 */
export const DEVIATION_DISTANCE_THRESHOLD = 2;

const METRIC_KEYS: (keyof StylometricMetrics)[] = [
  "typeTokenRatio",
  "morphemeCount",
  "commaFrequency",
  "adjectiveRatio",
  "verbRatio",
];

function zScore(value: number, mean: number, stdDev: number): number {
  const safeStdDev = Math.max(stdDev, MIN_STD_DEV_FLOOR);
  return (value - mean) / safeStdDev;
}

/**
 * 新規セリフのスタイロメトリック特徴量が、キャラのプロファイル（平均・標準偏差）から
 * 統計的にどれだけ外れているかを算出する。各次元のzスコアの二乗平均平方根（RMS）を距離とする
 * （対角共分散を仮定した簡易マハラノビス距離）。値が大きいほど分布外＝逸脱の疑いが強い。
 */
export function computeStyleDistance(
  vector: StylometricMetrics,
  profile: StylometricProfile,
): number {
  let sumSquares = 0;
  for (const key of METRIC_KEYS) {
    const z = zScore(vector[key], profile.mean[key], profile.stdDev[key]);
    sumSquares += z * z;
  }
  return Math.sqrt(sumSquares / METRIC_KEYS.length);
}

/**
 * 帰属済みセリフをキャラのスタイロメトリック・プロファイルと照合し、統計的な文体逸脱
 * （＝他キャラの文体が混入している可能性）を確率モデル（zスコア距離）で検知する。
 * 判定対象は dialogueCount >= 10 のプロファイルのみ（学習不足での誤警告防止）。
 */
export function detectStylometricDeviations(
  attributions: Array<{ speakerEntityId: string | null; confidence: string; text: string; sentenceIndex: number; tokens: Token[] }>,
  profiles: StylometricProfile[],
): StylometricDeviationWarning[] {
  const profileById = new Map(profiles.map((p) => [p.entityId, p]));
  const warnings: StylometricDeviationWarning[] = [];

  for (const attr of attributions) {
    if (attr.speakerEntityId === null) continue;
    if (attr.confidence === "none") continue;

    const profile = profileById.get(attr.speakerEntityId);
    if (!profile || profile.dialogueCount < MIN_DIALOGUE_FOR_DEVIATION_CHECK) continue;

    const metrics = computeDialogueMetrics(attr.tokens);
    const distance = computeStyleDistance(metrics, profile);

    if (distance > DEVIATION_DISTANCE_THRESHOLD) {
      warnings.push({
        sentenceIndex: attr.sentenceIndex,
        text: attr.text,
        speakerEntityId: attr.speakerEntityId,
        distance,
        threshold: DEVIATION_DISTANCE_THRESHOLD,
        metrics,
        message: `統計的スタイル乖離（距離${distance.toFixed(2)} > 閾値${DEVIATION_DISTANCE_THRESHOLD}）: 語彙の豊富さ・文構造・品詞傾向がこのキャラの通常分布から外れており、他キャラの文体が混入している可能性があります。`,
      });
    }
  }

  return warnings;
}
