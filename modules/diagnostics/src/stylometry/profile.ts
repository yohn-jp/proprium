import type { Token } from "@scriptorium/module-nlp";
import { computeDialogueMetrics } from "./metrics.js";
import type { StylometricMetrics, StylometricProfile } from "./types.js";

/** プロファイル生成に必要な最低セリフ数。styleFingerprint.ts の MIN_DIALOGUE_FOR_PROFILE と同基準。 */
const MIN_DIALOGUE_FOR_STYLOMETRIC_PROFILE = 3;

const METRIC_KEYS: (keyof StylometricMetrics)[] = [
  "typeTokenRatio",
  "morphemeCount",
  "commaFrequency",
  "adjectiveRatio",
  "verbRatio",
];

function meanOfMetrics(vectors: StylometricMetrics[]): StylometricMetrics {
  const sum: StylometricMetrics = {
    typeTokenRatio: 0,
    morphemeCount: 0,
    commaFrequency: 0,
    adjectiveRatio: 0,
    verbRatio: 0,
  };
  for (const v of vectors) {
    for (const key of METRIC_KEYS) sum[key] += v[key];
  }
  const mean = { ...sum };
  for (const key of METRIC_KEYS) mean[key] = sum[key] / vectors.length;
  return mean;
}

function stdDevOfMetrics(
  vectors: StylometricMetrics[],
  mean: StylometricMetrics,
): StylometricMetrics {
  const variance: StylometricMetrics = {
    typeTokenRatio: 0,
    morphemeCount: 0,
    commaFrequency: 0,
    adjectiveRatio: 0,
    verbRatio: 0,
  };
  for (const v of vectors) {
    for (const key of METRIC_KEYS) {
      const diff = v[key] - mean[key];
      variance[key] += diff * diff;
    }
  }
  const stdDev = { ...variance };
  for (const key of METRIC_KEYS) stdDev[key] = Math.sqrt(variance[key] / vectors.length);
  return stdDev;
}

/**
 * 帰属済みセリフ（キャラ別）から、キャラごとのスタイロメトリック・プロファイル
 * （TTR・文構造複雑さ・品詞偏向の平均と標準偏差）を学習する。
 * dialogueCount < 3 のキャラは統計不十分としてプロファイルを生成しない
 * （既存 computeStyleFingerprints と同じ最低件数基準）。
 */
export function computeStylometricProfiles(
  dialoguesByCharacter: Map<string, Token[][]>,
): StylometricProfile[] {
  const profiles: StylometricProfile[] = [];

  for (const [entityId, dialogues] of dialoguesByCharacter) {
    if (dialogues.length < MIN_DIALOGUE_FOR_STYLOMETRIC_PROFILE) continue;

    const vectors = dialogues.map((tokens) => computeDialogueMetrics(tokens));
    const mean = meanOfMetrics(vectors);
    const stdDev = stdDevOfMetrics(vectors, mean);

    profiles.push({ entityId, dialogueCount: dialogues.length, mean, stdDev });
  }

  return profiles;
}
