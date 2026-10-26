/**
 * S7 / L2 — 訂正ログ教師の線形再ランカー（ロジスティック + SGD、依存追加なし）。
 * モデルファイルが無ければパイプラインは identity（非破壊）。
 */
import { z } from "zod";
import type { SpeakerAttribution, SpeakerOverride } from "./speakerAttribution.js";
import { hashDialogueText } from "./speakerAttribution.js";
import type { SpeakerCorrectionRecord } from "./speakerCorrectionLog.js";

/** 固定長特徴量の名前（weights と順序一致）。 */
export const SPEAKER_RERANK_FEATURE_NAMES = [
  "is_null_candidate",
  "matches_pipeline_entity",
  "pipeline_has_entity",
  "pipeline_confidence_high",
  "pipeline_confidence_low",
  "reason_attribution_verb",
  "reason_attribution_verb_subject",
  "reason_strong_hint",
  "reason_pov_reply",
  "reason_preceding_narration",
  "reason_vocative_other",
  "reason_addressed_by_next",
  "reason_alternating_turn",
  "reason_manual_override",
  "reason_mob",
  "reason_none",
  "reason_rerank",
  "reason_precision",
  "candidate_is_pov",
  "candidate_is_prev_speaker",
  "prev_speaker_exists",
  "cluster_has_same_entity",
  "cluster_known_ratio",
] as const;

export type SpeakerRerankFeatureName = (typeof SPEAKER_RERANK_FEATURE_NAMES)[number];

export const SpeakerModelSchema = z.object({
  version: z.literal(1),
  featureNames: z.array(z.string()).min(1),
  weights: z.array(z.number()),
  bias: z.number(),
  /** held-out で決めた high 用確率閾値（p ≥ これ → high） */
  highProbabilityThreshold: z.number().min(0).max(1),
  trainedAt: z.string(),
  holdoutSceneIds: z.array(z.string()).optional(),
  metrics: z
    .object({
      trainAccuracy: z.number().optional(),
      holdoutAccuracyWithoutModel: z.number().optional(),
      holdoutAccuracyWithModel: z.number().optional(),
      adopted: z.boolean().optional(),
    })
    .optional(),
});

export type SpeakerModel = z.infer<typeof SpeakerModelSchema>;

/** Parse the adopted model from the action's pinned snapshot. Invalid data disables reranking. */
export function parseSpeakerModel(value: unknown): SpeakerModel | null {
  const result = SpeakerModelSchema.safeParse(value);
  return result.success ? result.data : null;
}

export interface SpeakerRerankContext {
  candidateIds: readonly string[];
  povEntityId?: string;
  /** reason → measured precision（無い理由は 0.5） */
  reasonPrecision?: Readonly<Record<string, number>>;
}

export interface SpeakerRerankExample {
  features: number[];
  label: 0 | 1;
  weight: number;
}

const REASON_ONE_HOT_KEY: Record<SpeakerAttribution["reason"], SpeakerRerankFeatureName> = {
  "attribution-verb": "reason_attribution_verb",
  "attribution-verb-subject": "reason_attribution_verb_subject",
  "strong-hint": "reason_strong_hint",
  "pov-reply": "reason_pov_reply",
  "preceding-narration": "reason_preceding_narration",
  "vocative-other": "reason_vocative_other",
  "addressed-by-next": "reason_addressed_by_next",
  "alternating-turn": "reason_alternating_turn",
  "manual-override": "reason_manual_override",
  mob: "reason_mob",
  none: "reason_none",
  rerank: "reason_rerank",
};

const REASON_ONE_HOT_ZERO: Record<SpeakerRerankFeatureName, number> = Object.fromEntries(
  SPEAKER_RERANK_FEATURE_NAMES.map((k) => [k, 0]),
) as Record<SpeakerRerankFeatureName, number>;

function reasonOneHot(
  reason: SpeakerAttribution["reason"],
): Record<SpeakerRerankFeatureName, number> {
  const zero = { ...REASON_ONE_HOT_ZERO };
  zero[REASON_ONE_HOT_KEY[reason]] = 1;
  return zero;
}

interface SpeakerRerankRowContext {
  prevId: string | null;
  groupMates: readonly SpeakerAttribution[];
  knownInCluster: readonly SpeakerAttribution[];
}

/** `attribution` にのみ依存する前計算（候補ループの外で1回だけ求めればよい）。 */
function computeRerankRowContext(
  attribution: SpeakerAttribution,
  allAttributions: readonly SpeakerAttribution[],
): SpeakerRerankRowContext {
  const prev = [...allAttributions]
    .filter((a) => a.sentenceIndex < attribution.sentenceIndex)
    .sort((a, b) => b.sentenceIndex - a.sentenceIndex)[0];

  const groupMates = allAttributions.filter(
    (a) =>
      a.speakerGroupId !== null &&
      a.speakerGroupId === attribution.speakerGroupId &&
      a.sentenceIndex !== attribution.sentenceIndex,
  );
  const knownInCluster = groupMates.filter((a) => a.speakerEntityId !== null);

  return { prevId: prev?.speakerEntityId ?? null, groupMates, knownInCluster };
}

/**
 * 行×候補（null 含む）の特徴量ベクトル。
 * `candidateId === null` はモブ/不明候補。
 */
export function extractSpeakerRerankFeatures(
  attribution: SpeakerAttribution,
  candidateId: string | null,
  allAttributions: readonly SpeakerAttribution[],
  context: SpeakerRerankContext,
  rowContext?: SpeakerRerankRowContext,
): number[] {
  const { prevId, groupMates, knownInCluster } =
    rowContext ?? computeRerankRowContext(attribution, allAttributions);
  const clusterHasSame =
    candidateId !== null && knownInCluster.some((a) => a.speakerEntityId === candidateId);

  const oneHot = reasonOneHot(attribution.reason);
  const precision = context.reasonPrecision?.[attribution.reason] ?? 0.5;

  const values: Record<SpeakerRerankFeatureName, number> = {
    is_null_candidate: candidateId === null ? 1 : 0,
    matches_pipeline_entity: candidateId === attribution.speakerEntityId ? 1 : 0,
    pipeline_has_entity: attribution.speakerEntityId !== null ? 1 : 0,
    pipeline_confidence_high: attribution.confidence === "high" ? 1 : 0,
    pipeline_confidence_low: attribution.confidence === "low" ? 1 : 0,
    reason_attribution_verb: oneHot.reason_attribution_verb,
    reason_attribution_verb_subject: oneHot.reason_attribution_verb_subject,
    reason_strong_hint: oneHot.reason_strong_hint,
    reason_pov_reply: oneHot.reason_pov_reply,
    reason_preceding_narration: oneHot.reason_preceding_narration,
    reason_vocative_other: oneHot.reason_vocative_other,
    reason_addressed_by_next: oneHot.reason_addressed_by_next,
    reason_alternating_turn: oneHot.reason_alternating_turn,
    reason_manual_override: oneHot.reason_manual_override,
    reason_mob: oneHot.reason_mob,
    reason_none: oneHot.reason_none,
    reason_rerank: oneHot.reason_rerank,
    reason_precision: precision,
    candidate_is_pov:
      candidateId !== null &&
      context.povEntityId !== undefined &&
      candidateId === context.povEntityId
        ? 1
        : 0,
    candidate_is_prev_speaker:
      candidateId !== null && prevId !== null && candidateId === prevId ? 1 : 0,
    prev_speaker_exists: prevId !== null ? 1 : 0,
    cluster_has_same_entity: clusterHasSame ? 1 : 0,
    cluster_known_ratio:
      groupMates.length === 0 ? 0 : knownInCluster.length / Math.max(1, groupMates.length),
  };

  return SPEAKER_RERANK_FEATURE_NAMES.map((name) => values[name]);
}

export function sigmoid(x: number): number {
  if (x >= 20) return 1;
  if (x <= -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function scoreSpeakerRerank(
  features: readonly number[],
  model: Pick<SpeakerModel, "weights" | "bias">,
): number {
  let z = model.bias;
  const n = Math.min(features.length, model.weights.length);
  for (let i = 0; i < n; i++) {
    z += features[i] * model.weights[i];
  }
  return sigmoid(z);
}

export interface TrainSpeakerRerankOptions {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  seed?: number;
}

/**
 * 重み付きロジスティック回帰（SGD）。依存追加なしの最小実装。
 */
export function trainSpeakerRerankModel(
  examples: readonly SpeakerRerankExample[],
  options?: TrainSpeakerRerankOptions,
): Pick<SpeakerModel, "featureNames" | "weights" | "bias"> {
  const dim = SPEAKER_RERANK_FEATURE_NAMES.length;
  const epochs = options?.epochs ?? 40;
  const lr = options?.learningRate ?? 0.05;
  const l2 = options?.l2 ?? 1e-4;
  let seed = options?.seed ?? 1;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const weights = Array.from({ length: dim }, () => (rand() - 0.5) * 0.01);
  let bias = 0;

  const order = examples.map((_, i) => i);
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const idx of order) {
      const ex = examples[idx];
      if (ex.features.length !== dim) continue;
      const p = scoreSpeakerRerank(ex.features, { weights, bias });
      const err = (p - ex.label) * ex.weight;
      for (let d = 0; d < dim; d++) {
        weights[d] -= lr * (err * ex.features[d] + l2 * weights[d]);
      }
      bias -= lr * err;
    }
  }

  return {
    featureNames: [...SPEAKER_RERANK_FEATURE_NAMES],
    weights,
    bias,
  };
}

/**
 * gold overrides + 訂正ログから学習例を構築。
 * 正例: override の speakerEntityId（null 含む）
 * 負例: 訂正の predictedSpeakerEntityId（direct=1.0 / propagated=0.3）
 */
export function buildSpeakerRerankExamples(input: {
  attributions: readonly SpeakerAttribution[];
  overrides: readonly SpeakerOverride[];
  corrections: readonly SpeakerCorrectionRecord[];
  context: SpeakerRerankContext;
  sceneId: string;
}): SpeakerRerankExample[] {
  const { attributions, overrides, corrections, context, sceneId } = input;
  const bySentence = new Map(attributions.map((a) => [a.sentenceIndex, a]));
  const examples: SpeakerRerankExample[] = [];

  const push = (
    attr: SpeakerAttribution,
    candidateId: string | null,
    label: 0 | 1,
    weight: number,
  ) => {
    examples.push({
      features: extractSpeakerRerankFeatures(attr, candidateId, attributions, context),
      label,
      weight,
    });
  };

  for (const override of overrides) {
    let attr: SpeakerAttribution | undefined;
    if (override.sentenceIndex !== undefined && override.textHash !== undefined) {
      attr = bySentence.get(override.sentenceIndex);
      if (!attr || override.textHash !== hashDialogueText(attr.text)) continue;
    } else {
      attr = attributions.find((a) => a.text === override.dialogueText);
    }
    if (!attr) continue;
    if (attr.reason === "manual-override" || attr.reason === "mob") continue;
    push(attr, override.speakerEntityId, 1, 1);
  }

  for (const correction of corrections) {
    if (correction.sceneId !== sceneId) continue;
    const attr = bySentence.get(correction.sentenceIndex);
    if (!attr) continue;
    if (correction.textHash !== hashDialogueText(attr.text)) continue;
    if (attr.reason === "manual-override" || attr.reason === "mob") continue;
    const weight = correction.label === "propagated" ? 0.3 : 1;
    push(attr, correction.predictedSpeakerEntityId, 0, weight);
  }

  return examples;
}

function confidenceFromProbability(
  p: number,
  highThreshold: number,
): SpeakerAttribution["confidence"] {
  if (p >= highThreshold) return "high";
  if (p >= 0.5) return "low";
  return "none";
}

/**
 * モデルで行ごとに候補＋null をスコアし、最大確率の話者を採用。
 * `manual-override` / `mob` は触らない。モデル無し呼び出しは想定しない（呼び出し側で分岐）。
 */
export function applySpeakerReranker(
  attributions: SpeakerAttribution[],
  model: SpeakerModel,
  context: SpeakerRerankContext,
): SpeakerAttribution[] {
  const candidateIds: Array<string | null> = [...context.candidateIds, null];

  return attributions.map((attr) => {
    if (attr.reason === "manual-override" || attr.reason === "mob") return attr;

    const rowContext = computeRerankRowContext(attr, attributions);
    let bestId: string | null = attr.speakerEntityId;
    let bestP = -1;
    for (const candidateId of candidateIds) {
      const features = extractSpeakerRerankFeatures(
        attr,
        candidateId,
        attributions,
        context,
        rowContext,
      );
      const p = scoreSpeakerRerank(features, model);
      if (p > bestP) {
        bestP = p;
        bestId = candidateId;
      }
    }

    const confidence = confidenceFromProbability(bestP, model.highProbabilityThreshold);
    if (bestId === attr.speakerEntityId) {
      // G1: confidence を変えるなら reason も rerank（旧 reason のまま high にしない）
      return confidence === attr.confidence ? attr : { ...attr, reason: "rerank", confidence };
    }
    return {
      ...attr,
      speakerEntityId: bestId,
      reason: "rerank",
      confidence,
    };
  });
}

/**
 * held-out 上で highPrecision ≥ target を満たす最小閾値を探す。
 * 満たせなければデフォルト 0.9。
 */
export function calibrateHighProbabilityThreshold(
  scored: ReadonlyArray<{ gold: string | null; probability: number; predicted: string | null }>,
  targetPrecision = 0.95,
  defaultThreshold = 0.9,
): number {
  const thresholds = [0.99, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5];
  for (const t of thresholds) {
    let correct = 0;
    let total = 0;
    for (const row of scored) {
      if (row.probability < t) continue;
      total += 1;
      if (row.predicted === row.gold) correct += 1;
    }
    if (total >= 5 && correct / total >= targetPrecision) return t;
  }
  return defaultThreshold;
}

/**
 * ゴールド突合行について、再ランカー適用後の正解率。
 */
export function attributionAccuracyFromPairs(
  pairs: ReadonlyArray<{ gold: string | null; predicted: string | null }>,
): number {
  if (pairs.length === 0) return 0;
  let ok = 0;
  for (const p of pairs) {
    if (p.gold === p.predicted) ok += 1;
  }
  return ok / pairs.length;
}
