import { z } from "zod";
import type { SpeakerAttribution } from "./speakerAttribution.js";
import type { SpeakerCorrectionRecord } from "./speakerCorrectionLog.js";
import type { SpeakerEvalReport } from "./speakerEval.js";

/**
 * 単一規則ゲートのエントリ。
 * precision 実測に基づき confidence 降格（demote）または規則無効化（disable）を指示する。
 */
export const SpeakerRuleGateEntrySchema = z.object({
  action: z.enum(["demote", "disable"]),
  measuredPrecision: z.number(),
  sampleSize: z.number(),
});

/** 単一規則ゲートのエントリ型。 */
export type SpeakerRuleGateEntry = z.infer<typeof SpeakerRuleGateEntrySchema>;

/**
 * `.arcadia/speaker-rule-gates.json` の Zod スキーマ。
 * S4 で読み書きと成績算出を実装する。
 */
export const SpeakerRuleGatesSchema = z.object({
  version: z.literal(1),
  gates: z.record(z.string(), SpeakerRuleGateEntrySchema),
});

/** `.arcadia/speaker-rule-gates.json` の型（Zod から推論）。 */
export type SpeakerRuleGates = z.infer<typeof SpeakerRuleGatesSchema>;

/** ゲート判定閾値（一箇所に集約）。 */
export const SPEAKER_RULE_GATE_THRESHOLDS = {
  /** precision がこれ未満かつ分母十分 → demote（high→low） */
  demotePrecision: 0.6,
  /** precision がこれ未満かつ分母十分 → disable（規則スキップ） */
  disablePrecision: 0.3,
  /** ゲート発動に必要な最小サンプル（byReason.fired） */
  minSampleSize: 20,
} as const;

export type SpeakerConfidence = SpeakerAttribution["confidence"];

/** 冷スタート用の空ゲート（全規則デフォルト動作）。 */
export function emptySpeakerRuleGates(): SpeakerRuleGates {
  return { version: 1, gates: {} };
}

/** Parse derived gate data; malformed cache data falls back to cold-start behavior. */
export function parseSpeakerRuleGates(value: unknown): SpeakerRuleGates {
  const result = SpeakerRuleGatesSchema.safeParse(value);
  return result.success ? result.data : emptySpeakerRuleGates();
}

/**
 * 訂正ログの誤り件数を reason 別に数える（診断・入力検証用）。
 * ゲートの precision 本体は byReason.correct / fired を使う。
 */
export function countCorrectionErrorsByReason(
  corrections: ReadonlyArray<Pick<SpeakerCorrectionRecord, "predictedReason">>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of corrections) {
    const reason = record.predictedReason;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * 規則別 precision からゲートを決定する純関数。
 *
 * - precision = byReason.correct / byReason.fired（L0 分母つき）
 * - sampleSize = byReason.fired
 * - precision < disable かつ sampleSize ≥ min → disable
 * - それ以外で precision < demote かつ sampleSize ≥ min → demote
 * - 閾値以上またはサンプル不足 → ゲートなし（デフォルト動作）
 *
 * `corrections` は誤り側の証拠（件数集計）。ゲート判定の precision には使わないが、
 * 呼び出し側が訂正ログ＋評価レポートの両方を渡す契約を固定する。
 */
export function computeSpeakerRuleGates(
  byReason: SpeakerEvalReport["byReason"],
  corrections: ReadonlyArray<Pick<SpeakerCorrectionRecord, "predictedReason">> = [],
): SpeakerRuleGates {
  const errorCounts = countCorrectionErrorsByReason(corrections);
  const reasons = new Set([...Object.keys(byReason), ...Object.keys(errorCounts)]);

  const gates: SpeakerRuleGates["gates"] = {};
  const { demotePrecision, disablePrecision, minSampleSize } = SPEAKER_RULE_GATE_THRESHOLDS;

  for (const reason of reasons) {
    const stats = byReason[reason];
    // 分母は byReason.fired。訂正ログのみの reason はゲート対象外。
    if (!stats) continue;

    const sampleSize = stats.fired;
    if (sampleSize < minSampleSize) continue;

    const measuredPrecision = sampleSize > 0 ? stats.correct / sampleSize : 0;
    if (measuredPrecision < disablePrecision) {
      gates[reason] = { action: "disable", measuredPrecision, sampleSize };
    } else if (measuredPrecision < demotePrecision) {
      gates[reason] = { action: "demote", measuredPrecision, sampleSize };
    }
  }

  return { version: 1, gates };
}

/** 該当 reason が disable ゲートなら true（S5 が attributeSpeakers 前に規則をスキップする用）。 */
export function shouldSkipReason(
  gates: SpeakerRuleGates | null | undefined,
  reason: string,
): boolean {
  return gates?.gates[reason]?.action === "disable";
}

/**
 * demote ゲートなら high → low。disable は呼び出し側で `shouldSkipReason` すること。
 * ゲート無し / 対象外は confidence をそのまま返す。
 */
export function applyGateToConfidence(
  confidence: SpeakerConfidence,
  gates: SpeakerRuleGates | null | undefined,
  reason: string,
): SpeakerConfidence {
  const gate = gates?.gates[reason];
  if (gate?.action !== "demote") return confidence;
  if (confidence === "high") return "low";
  return confidence;
}

/**
 * 自動帰属行へゲートを適用する（S5）。
 * disable → speaker をクリア、demote → confidence 降格。
 * `manual-override` / `mob` は手動確定なので触らない。
 */
export function applyGatesToAttributions(
  attributions: SpeakerAttribution[],
  gates: SpeakerRuleGates | null | undefined,
): SpeakerAttribution[] {
  if (!gates || Object.keys(gates.gates).length === 0) return attributions;
  return attributions.map((attr) => {
    // rerank はモデル由来の confidence。規則ゲートで潰さない。
    if (attr.reason === "manual-override" || attr.reason === "mob" || attr.reason === "rerank") {
      return attr;
    }
    if (shouldSkipReason(gates, attr.reason)) {
      return {
        ...attr,
        speakerEntityId: null,
        reason: "none" as const,
        confidence: "none" as const,
      };
    }
    const confidence = applyGateToConfidence(attr.confidence, gates, attr.reason);
    return confidence === attr.confidence ? attr : { ...attr, confidence };
  });
}
