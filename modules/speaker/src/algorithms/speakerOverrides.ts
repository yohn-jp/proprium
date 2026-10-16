import type { SpeakerAttribution } from "./speakerAttribution.js";
import { hashDialogueText } from "./textHash.js";

/** 上書き対象セリフの、上書き前の自動判定。 */
export interface SpeakerCorrectionInput {
  sentenceIndex: number;
  textHash: string;
  /** 上書き時点のセリフ本文。未保存バッファ由来のグループ一括アサインで正本にする。 */
  dialogueText: string;
  predictedSpeakerEntityId: string | null;
  predictedReason: SpeakerAttribution["reason"];
  speakerGroupId: string | null;
  /** direct: 直接確認 / propagated: グループ一括アサインによる弱ラベル */
  label: "direct" | "propagated";
}

export interface SpeakerOverride {
  /** セリフの文番号（1始まり、splitIntoSentencesと同じ基準）。旧形式データには無い */
  sentenceIndex?: number;
  /** セリフ本文の正規化ハッシュ（FNV-1a 32bitの16進文字列）。旧形式データには無い */
  textHash?: string;
  /** セリフ本文（YAML上の可読性と旧形式互換のため保持） */
  dialogueText: string;
  /** 手動確定した話者。null は「不明」として自動推定を抑止する */
  speakerEntityId: string | null;
  /** グループ一括アサイン時のクラスタID。再伝播のために保持する（任意） */
  speakerGroupId?: string | null;
  /**
   * direct: ユーザーがそのセリフを直接選んだ（他操作で上書きしない）。
   * propagated: グループ一括アサインの弱ラベル（未確定行への初回伝播のみ）。
   * 欠落は後方互換で direct 扱い（保護側に倒す）。
   */
  source?: "direct" | "propagated";
}

/** override の source。未設定は direct（明示指定として保護する）。 */
export function speakerOverrideSource(override: SpeakerOverride): "direct" | "propagated" {
  return override.source ?? "direct";
}

const isNewFormatOverride = (o: SpeakerOverride): boolean =>
  o.sentenceIndex !== undefined && o.textHash !== undefined;

/**
 * 新形式 override を現在の attributions へ紐付ける（sentenceIndex → override）。
 * 1. まず sentenceIndex 完全一致かつハッシュ一致（本文未変更）を確定させる。
 * 2. 残った override は、本文編集で行番号がずれただけ（テキスト自体は不変）の
 *    可能性があるため、textHash が一意に一致する未確定行へ再アンカーする。
 *    一致が 0 件（本当に編集された）または複数件（あいまい）なら救済せず stale 扱いにする —
 *    手動データを保護するため、同じ行に留まっている限りは決して自動判定へフォールバックさせない。
 */
function matchNewFormatOverrides(
  attributions: SpeakerAttribution[],
  newFormatOverrides: SpeakerOverride[],
): { bySentenceIndex: Map<number, SpeakerOverride>; stale: SpeakerOverride[] } {
  const bySentenceIndex = new Map<number, SpeakerOverride>();
  const used = new Set<SpeakerOverride>();

  for (const attribution of attributions) {
    const match = newFormatOverrides.find((o) => o.sentenceIndex === attribution.sentenceIndex);
    if (match && match.textHash === hashDialogueText(attribution.text)) {
      bySentenceIndex.set(attribution.sentenceIndex, match);
      used.add(match);
    }
  }

  const stale: SpeakerOverride[] = [];
  for (const override of newFormatOverrides) {
    if (used.has(override)) continue;
    const candidates = attributions.filter(
      (a) =>
        !bySentenceIndex.has(a.sentenceIndex) && hashDialogueText(a.text) === override.textHash,
    );
    if (candidates.length === 1) {
      bySentenceIndex.set(candidates[0].sentenceIndex, override);
      used.add(override);
    } else {
      stale.push(override);
    }
  }

  return { bySentenceIndex, stale };
}

/** ルールベース推定結果に、ユーザーによる手動確定を適用する。元配列は変更しない。
 *  新形式（sentenceIndex + textHash あり）のoverrideはsentenceIndexとハッシュの両方が一致する場合に適用する。
 *  sentenceIndexだけがずれている（本文編集で他行が増減した）場合は、textHashが一意に一致する行へ
 *  再アンカーして適用する（手動確定を自動判定へフォールバックさせないためのガードレール）。
 *  本文自体が編集されて一致する行が見つからない場合のみ、そのoverrideを無効として推定結果のまま扱い、
 *  staleOverridesとして呼び出し側に返す。
 *  旧形式（sentenceIndex/textHash無し）のoverrideは従来通りdialogueText完全一致で適用する（後方互換）。 */
export function applySpeakerOverridesDetailed(
  attributions: SpeakerAttribution[],
  overrides: SpeakerOverride[],
): { attributions: SpeakerAttribution[]; staleOverrides: SpeakerOverride[] } {
  const newFormatOverrides = overrides.filter(isNewFormatOverride);
  const { bySentenceIndex, stale: staleOverrides } = matchNewFormatOverrides(
    attributions,
    newFormatOverrides,
  );

  const resultAttributions = attributions.map((attribution) => {
    const newFormatMatch = bySentenceIndex.get(attribution.sentenceIndex);
    if (newFormatMatch) {
      return {
        ...attribution,
        speakerEntityId: newFormatMatch.speakerEntityId,
        // override に有効な groupId があるときだけ上書き。null は「なし」ではなく未指定扱い。
        speakerGroupId:
          typeof newFormatMatch.speakerGroupId === "string" &&
          newFormatMatch.speakerGroupId.length > 0
            ? newFormatMatch.speakerGroupId
            : attribution.speakerGroupId,
        confidence: newFormatMatch.speakerEntityId === null ? ("none" as const) : ("high" as const),
        reason: "manual-override" as const,
      };
    }

    // 旧形式: dialogueText完全一致（後方互換）
    const legacyMatch = overrides.find(
      (o) => !isNewFormatOverride(o) && o.dialogueText === attribution.text,
    );
    if (!legacyMatch) return attribution;
    return {
      ...attribution,
      speakerEntityId: legacyMatch.speakerEntityId,
      speakerGroupId:
        typeof legacyMatch.speakerGroupId === "string" && legacyMatch.speakerGroupId.length > 0
          ? legacyMatch.speakerGroupId
          : attribution.speakerGroupId,
      confidence: legacyMatch.speakerEntityId === null ? ("none" as const) : ("high" as const),
      reason: "manual-override" as const,
    };
  });

  return { attributions: resultAttributions, staleOverrides };
}

/** ルールベース推定結果に、ユーザーによる手動確定を適用する。元配列は変更しない。
 *  詳細（無効化されたoverrideの情報）が不要な既存呼び出し向けの薄いラッパ。 */
export function applySpeakerOverrides(
  attributions: SpeakerAttribution[],
  overrides: SpeakerOverride[],
): SpeakerAttribution[] {
  return applySpeakerOverridesDetailed(attributions, overrides).attributions;
}

/**
 * 最終 override 適用後、同じ speakerEntityId の行が同じ speakerGroupId を共有するよう揃える。
 * override に speakerGroupId があればそれを優先し、無ければ同キャラの他行から継承する。
 */
export function alignOverrideClusters(
  attributions: SpeakerAttribution[],
  overrides: SpeakerOverride[],
): SpeakerAttribution[] {
  const result = attributions.map((attribution) => ({ ...attribution }));
  const groupByEntity = new Map<string, string>();

  for (const override of overrides) {
    if (override.speakerEntityId === null) continue;
    if (typeof override.speakerGroupId === "string" && override.speakerGroupId.length > 0) {
      groupByEntity.set(override.speakerEntityId, override.speakerGroupId);
    }
  }
  for (const attribution of result) {
    if (attribution.speakerEntityId === null || attribution.speakerGroupId === null) continue;
    if (!groupByEntity.has(attribution.speakerEntityId)) {
      groupByEntity.set(attribution.speakerEntityId, attribution.speakerGroupId);
    }
  }

  for (const attribution of result) {
    if (attribution.speakerEntityId === null) continue;
    const groupId = groupByEntity.get(attribution.speakerEntityId);
    if (groupId) attribution.speakerGroupId = groupId;
  }

  for (const override of overrides) {
    if (override.speakerGroupId === undefined || override.speakerGroupId === null) continue;
    const target = result.find((attribution) => {
      if (
        override.sentenceIndex !== undefined &&
        override.textHash !== undefined &&
        attribution.sentenceIndex === override.sentenceIndex &&
        hashDialogueText(attribution.text) === override.textHash
      ) {
        return true;
      }
      return (
        override.sentenceIndex === undefined &&
        override.textHash === undefined &&
        attribution.text === override.dialogueText
      );
    });
    if (target) {
      // groupId はキャラ単位で揃える（行ごとに違う group を書き戻して割らない）
      if (override.speakerEntityId) {
        groupByEntity.set(override.speakerEntityId, override.speakerGroupId);
      }
    }
  }

  for (const attribution of result) {
    if (attribution.speakerEntityId === null) continue;
    const groupId = groupByEntity.get(attribution.speakerEntityId);
    if (groupId) attribution.speakerGroupId = groupId;
  }

  return result;
}
