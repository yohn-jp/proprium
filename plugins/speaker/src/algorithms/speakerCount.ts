import type { ClusterAssignmentTrail } from "./clusterAssignmentTrail.js";
import { buildMentionDictionary, findMentions } from "./mentionIndex.js";
import type { ResolveSpeakerCountInput, SpeakerAttribution } from "./speakerAttribution.js";
import type { PartitionContext } from "./speakerClustering.js";
import { removeDialogueBrackets } from "./styleFingerprint.js";
import { isDialogue, splitIntoSentences } from "./textAnalysis.js";
import type { Entity } from "./types.js";

/** セリフ冒頭の呼びかけ（speakerAttribution と同系。こちらは census 専用で複製）。 */
const VOCATIVE_RE =
  /^[「『][―…‥、\s]*([^、。！？」』\s]{1,15}?)(?:さん|くん|君|様|殿|ちゃん|よ|ね)?、/;

/** 名乗り・自己紹介パターン。 */
const SELF_INTRO_RE = /(?:と申します|といいます|と名乗|私の名は|我が名は|名付け|名乗るがよい)/;

/**
 * 場面転換・時間経過を示すフレーズ（speakerClustering の SCENE_BREAK_RE と整合し、
 * 空行以外の time/place ヒント用にやや広げたもの）。
 */
const TIME_PLACE_BREAK_RE =
  /(名も知らない|名前も知らない|見覚えのない|見知らぬ|扉が.{0,8}(?:叩かれ|開い|開かれ)|場面が変わ|翌朝|その夜|数日後|翌日|翌晩|しばらくして|その頃|一方その頃|別の場所|別室)/;

/**
 * 話者数 N の推定結果。
 * `resolveSpeakerCount` より appears キャラ数ベースの推定と、根拠を返す。
 */
export interface SpeakerCountEstimate {
  /** パイプラインが実際に使うクラスタ数 N */
  n: number;
  /** UI 表示用の推定 N */
  estimatedN: number;
  /** speakerCount が明示されていたか */
  fromManual: boolean;
  /** 推定根拠（UI 表示・訂正ログ用） */
  evidence: {
    knownFloor: number;
    vocativeCensus: number;
    /** @deprecated G1 以降は N 推定に使わず、常に未設定 */
    clusterQualityN?: number;
  };
}

/**
 * `attributeSpeakersInScene` の戻り値。
 * 帰属行に加え、N 推定（estimatedN / fromManual / evidence）とクラスタ証跡を返す。
 */
export interface AttributeSpeakersResult {
  attributions: SpeakerAttribution[];
  estimatedN: number;
  fromManual: boolean;
  evidence: SpeakerCountEstimate["evidence"];
  /** 行ごとのクラスタ割当証跡（SpeakerAttribution とは並列） */
  clusterTrails: ClusterAssignmentTrail[];
}

/**
 * 場面転換ヒント。クラスタ境界ヒントとして PartitionContext へ渡せる形。
 * 消費（境界リセット）は S5 統合側。ここでは検出のみ。
 */
export interface SceneBreakHint {
  /** splitIntoSentences 基準の文番号（1始まり） */
  sentenceIndex: number;
  kind: "blank-line" | "time-place";
  /** time-place のときマッチした表層（任意） */
  matchedText?: string;
}

/**
 * モブ話者は entity 未解決クラスタとして正当な最終結果。
 * `reason: "mob"` は手動確定時のみ付与する（自動パイプラインでは付与しない）。
 * 評価では gold/predicted の null と同クラスタ判定を正解として扱う（speakerEval）。
 */
export type MobSpeakerReason = Extract<SpeakerAttribution["reason"], "mob">;

/** モブ手動確定時に付与する reason。自動帰属では使わない。 */
export const MOB_SPEAKER_REASON: MobSpeakerReason = "mob";

/**
 * 未解決（entity なし）だがクラスタ ID がある行＝モブ一級市民のクラスタ表現。
 * 自動では reason を `"none"` のまま維持し、手動確定時のみ {@link confirmMobAttribution}。
 */
export function isUnresolvedSpeakerCluster(attribution: SpeakerAttribution): boolean {
  return attribution.speakerEntityId === null && attribution.speakerGroupId !== null;
}

/**
 * モブとして手動確定する。自動パイプラインからは呼ばない。
 */
export function confirmMobAttribution(attribution: SpeakerAttribution): SpeakerAttribution {
  return {
    ...attribution,
    speakerEntityId: null,
    reason: MOB_SPEAKER_REASON,
    confidence: "none",
  };
}

export type EstimateSpeakerCountInput = ResolveSpeakerCountInput & {
  /**
   * 互換のため受け付けるが、G1 の自動 N では未使用（クラスタ品質探索は行わない）。
   */
  partitionContext?: PartitionContext;
  /**
   * 互換のため受け付けるが、G1 の自動 N では未使用。
   */
  attributions?: SpeakerAttribution[];
};

function clampSpeakerCount(value: number, dialogueCount: number): number {
  if (dialogueCount <= 0) return 0;
  return Math.min(dialogueCount, Math.max(1, Math.floor(value)));
}

function entityTerms(entity: Entity): string[] {
  const rawTitles = Array.isArray(entity.raw.titles)
    ? entity.raw.titles.filter((value): value is string => typeof value === "string")
    : [];
  return [entity.name, ...(entity.aliases ?? []), ...rawTitles].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function matchEntityBySurface(surface: string, candidates: readonly Entity[]): string | null {
  const trimmed = surface.trim();
  if (trimmed.length === 0) return null;
  let best: { id: string; len: number } | null = null;
  for (const entity of candidates) {
    for (const term of entityTerms(entity)) {
      if (
        trimmed === term ||
        trimmed === `${term}さん` ||
        trimmed === `${term}様` ||
        trimmed === `${term}殿` ||
        trimmed === `${term}くん` ||
        trimmed === `${term}君` ||
        trimmed === `${term}ちゃん`
      ) {
        if (!best || term.length > best.len) best = { id: entity.id, len: term.length };
      }
    }
  }
  return best?.id ?? null;
}

/**
 * 呼びかけ・名乗り・alias の相互排他センサス。
 * 同一セリフ内で「呼びかけ先 ≠ 話者」「名乗り主体」として現れる entity を数え、
 * シーンに必要な話者下限を強化する。
 */
export function countVocativeMutualExclusionCensus(
  text: string,
  appearsEntities: readonly Entity[],
): number {
  const candidates = appearsEntities.filter((entity) => entity.type === "character");
  if (candidates.length === 0 || text.length === 0) return 0;

  const entityMap = new Map(candidates.map((entity) => [entity.id, entity]));
  const mentionDict = buildMentionDictionary(entityMap);
  const candidateIds = new Set(candidates.map((entity) => entity.id));
  const present = new Set<string>();

  for (const sentence of splitIntoSentences(text)) {
    if (!isDialogue(sentence)) continue;
    const content = removeDialogueBrackets(sentence).trim();

    const vocativeMatch = sentence.trim().match(VOCATIVE_RE);
    if (vocativeMatch?.[1]) {
      const addressed = findMentions(mentionDict, vocativeMatch[1]).filter((id) =>
        candidateIds.has(id),
      );
      const soleAddressed = addressed.length === 1 ? addressed[0] : undefined;
      if (soleAddressed) {
        present.add(soleAddressed);
      } else {
        const bySurface = matchEntityBySurface(vocativeMatch[1], candidates);
        if (bySurface) present.add(bySurface);
      }
    }

    if (SELF_INTRO_RE.test(content)) {
      const introMentions = findMentions(mentionDict, content).filter((id) => candidateIds.has(id));
      for (const id of introMentions) present.add(id);
      // alias / 名のみの自己紹介（「私の名は〇〇」）
      for (const entity of candidates) {
        for (const term of entityTerms(entity)) {
          if (content.includes(term)) present.add(entity.id);
        }
      }
    }
  }

  // 相互排他: 呼びかけ先が居るセリフでは、同一セリフ内の別候補言及は別話者側の下限に寄与
  for (const sentence of splitIntoSentences(text)) {
    if (!isDialogue(sentence)) continue;
    const vocativeMatch = sentence.trim().match(VOCATIVE_RE);
    if (!vocativeMatch?.[1]) continue;
    const addressed =
      findMentions(mentionDict, vocativeMatch[1]).filter((id) => candidateIds.has(id))[0] ??
      matchEntityBySurface(vocativeMatch[1], candidates);
    if (!addressed) continue;
    const others = findMentions(mentionDict, removeDialogueBrackets(sentence)).filter(
      (id) => candidateIds.has(id) && id !== addressed,
    );
    for (const id of others) present.add(id);
    present.add(addressed);
  }

  return present.size;
}

/**
 * 空行区切り・時間/場所フレーズの場面転換ヒントを検出する。
 * `sentenceIndex` は splitIntoSentences の 1 始まり。
 */
export function detectSceneBreakHints(text: string): SceneBreakHint[] {
  const sentences = splitIntoSentences(text);
  const hints: SceneBreakHint[] = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    if (sentence === undefined) continue;
    const sentenceIndex = i + 1;

    if (sentence.trim().length === 0) {
      hints.push({ sentenceIndex, kind: "blank-line" });
      continue;
    }

    if (isDialogue(sentence)) continue;

    const match = sentence.match(TIME_PLACE_BREAK_RE);
    if (match) {
      hints.push({
        sentenceIndex,
        kind: "time-place",
        matchedText: match[0],
      });
    }
  }

  return hints;
}

/**
 * シーンの話者数 N を推定する（G1: appears-character-count based）。
 *
 * 自動 N は次のみで決める（sim hit N±1 ≈ 0.86）:
 * - `appearsCharacterCount` = appears のうち `type === "character"` の件数
 * - `appearsBased = clamp(max(knownFloor, appearsCharacterCount, dialogueCount>=2 ? 2 : 1), dialogueCount)`
 *
 * strongHintU / vocativeCensus / clusterQualityN は N 選択に使わない。
 * vocativeCensus は UI 用に evidence へ残す。クラスタ品質探索は呼ばない。
 * 手動 speakerCount があるときは n に採用し、estimatedN は自動推定を返す。
 */
export function estimateSpeakerCount(input: EstimateSpeakerCountInput): SpeakerCountEstimate {
  const dialogueCount = Math.max(0, Math.floor(input.dialogueCount));
  const knownFloor = Math.max(0, Math.floor(input.knownSpeakerCount ?? 0));
  const appears = input.appearsEntities ?? [];
  const text = input.text ?? "";

  if (dialogueCount === 0) {
    return {
      n: 0,
      estimatedN: 0,
      fromManual: false,
      evidence: { knownFloor, vocativeCensus: 0 },
    };
  }

  const appearsCharacterCount = appears.filter((entity) => entity.type === "character").length;
  const vocativeCensus = countVocativeMutualExclusionCensus(text, appears);
  const appearsBased = clampSpeakerCount(
    Math.max(knownFloor, appearsCharacterCount, dialogueCount >= 2 ? 2 : 1),
    dialogueCount,
  );
  const estimatedN = appearsBased;

  const evidence: SpeakerCountEstimate["evidence"] = {
    knownFloor,
    vocativeCensus,
  };

  const raw = input.speakerCount;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const manual = clampSpeakerCount(raw, dialogueCount);
    return {
      n: clampSpeakerCount(Math.max(manual, knownFloor), dialogueCount),
      estimatedN: clampSpeakerCount(Math.max(estimatedN, knownFloor), dialogueCount),
      fromManual: true,
      evidence,
    };
  }

  const n = clampSpeakerCount(Math.max(estimatedN, knownFloor), dialogueCount);
  return { n, estimatedN: n, fromManual: false, evidence };
}
