import type { ClusterTrailCollector } from "../clusterAssignmentTrail.js";
import type { Tokenizer } from "../../nlp/types.js";
import type { Entity } from "../types.js";
import type { VoiceProfile } from "../voice/index.js";

export const ATTRIBUTION_VERB_RE =
  /(言っ|言う|言い|言った|答え|叫ん|叫ぶ|呟い|呟く|尋ね|返し|返す|問う|問い|囁い|囁く|続け|呼びかけ|告げ|名乗|言い放|たしなめ)/;
export const BACK_REFERENCE_RE =
  /(?:そう|こう|と)[^。！？]{0,16}(?:言っ|言い|答え|叫ん|呟い|返し|囁い|告げ|言い放)/;
export const PERCEPTION_RE = /(見|気づ|感じ|思|聞こえ|悟|察し)/;
export const WRITTEN_INTRO_RE = /(問(?:い|題)?|記され|書かれ|頁には|紙には|冊子|手紙|文面|設問)/;
export const LITERARY_IMPERATIVE_RE = /(求めよ|述べよ|示せ|答えよ|論ぜよ)[。！？」』]*$/;
export const SCENE_BREAK_RE =
  /(名も知らない|名前も知らない|見覚えのない|見知らぬ|扉が.{0,8}(?:叩かれ|開い|開かれ)|場面が変わ|翌朝|その夜|数日後)/;
export const UNNAMED_ANCHOR_RE = /(別の声|誰か(?:が|の声)|別の誰か)/;
export const REPETITION_RE = /(相変わらず|いつも|毎日|日々|繰り返し)/;
export const QUESTION_RE = /[？?][」』]*$/;
export const IMPERATIVE_RE =
  /(?:しろ|せよ|なさい|ください|くれ|行け|来い|待て|やめろ|黙れ|答えろ)[。！!」』]*$/;
export const STRICT_DIALOGUE_RE = /^\s*[「『][\s\S]*[」』]\s*$/;
export const MONOLOGUE_RE = /^\s*[（(][\s\S]*[）)]\s*$/;

export interface VoiceFeatures {
  firstPerson: string | null;
  ending: string | null;
  polite: boolean;
  openingMark: boolean;
}

export interface DialogueRecord {
  attributionIndex: number;
  sentenceIndex: number;
  text: string;
  eligible: boolean;
  key: string | null;
  strongEntityId: string | null;
  provisional: boolean;
  narrationBefore: string;
  narrationAfter: string;
  features: VoiceFeatures;
}

/** 公開クラスタ ID（1始まり）。 */
export function speakerClusterId(index: number): string {
  return `cluster-${index}`;
}

export type PartitionContext = {
  sentences?: string[];
  tokenizer?: Tokenizer;
  candidateEntities?: Entity[];
  voiceProfiles?: VoiceProfile[];
  /**
   * 場面転換ヒント（空行・時間/場所フレーズ）。
   * S5 で detect → context へ常時配線。`partitionDialoguesIntoN` の境界消費は deferred
   *（ソフト優先の接続はクラスタ分割ロジック変更が大きいため後続タスク）。
   */
  sceneBreakHints?: ReadonlyArray<{
    sentenceIndex: number;
    kind: "blank-line" | "time-place";
    matchedText?: string;
  }>;
  /**
   * クラスタ証跡コレクタ（任意）。指定時のみイベントを追記する。
   * 判定結果・割当には一切影響しない。
   */
  trailCollector?: ClusterTrailCollector;
};
