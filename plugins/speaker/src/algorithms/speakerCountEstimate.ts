import { countUniqueStrongHintEntities } from "./speakerClustering.js";
import type { Entity } from "./types.js";

export interface ResolveSpeakerCountInput {
  /** シーン raw.speakerCount。未設定なら自動推定。 */
  speakerCount?: unknown;
  dialogueCount: number;
  /** appears 候補。WT1 で強ヒント U の算出に使う。 */
  appearsEntities?: Entity[];
  text?: string;
  /**
   * 手動確定＋ confidence high で既知のユニーク話者数 L。
   * 推定・手動どちらも N の下限にする（N < L のまま分割しない）。
   */
  knownSpeakerCount?: number;
}

export interface ResolvedSpeakerCount {
  /** パイプラインが実際に使うクラスタ数 N */
  n: number;
  /** UI 表示用の推定 N（手動指定時は speakerCount のクランプ前推定と同じ扱い） */
  estimatedN: number;
  /** speakerCount が明示されていたか */
  fromManual: boolean;
}

function clampSpeakerCount(value: number, dialogueCount: number): number {
  if (dialogueCount <= 0) return 0;
  return Math.min(dialogueCount, Math.max(1, Math.floor(value)));
}

/**
 * シーンの話者クラスタ数 N を解決する。
 * speakerCount があれば [1, dialogueCount] にクランプして採用。
 * なければ自動: U = 強ヒント（名＋発話動詞）で出現する appears 内 entity のユニーク数、
 * N = clamp(max(U, dialogueCount >= 2 ? 2 : 1), 1, dialogueCount)。
 * いずれの場合も knownSpeakerCount（手動＋high の L）を下限にする。
 *
 * @deprecated 新規呼び出しは {@link estimateSpeakerCount} を使うこと（census・クラスタ品質・evidence 付き）。
 * 本関数は互換のため残す。フォールバックは strong-hint U ベースで、appears census とは異なる。
 */
export function resolveSpeakerCount(input: ResolveSpeakerCountInput): ResolvedSpeakerCount {
  const dialogueCount = Math.max(0, Math.floor(input.dialogueCount));
  if (dialogueCount === 0) {
    return { n: 0, estimatedN: 0, fromManual: false };
  }

  const uniqueStrongHintCount = countUniqueStrongHintEntities(
    input.text ?? "",
    input.appearsEntities ?? [],
  );
  const estimatedN = clampSpeakerCount(
    Math.max(uniqueStrongHintCount, dialogueCount >= 2 ? 2 : 1),
    dialogueCount,
  );

  const knownFloor = Math.max(0, Math.floor(input.knownSpeakerCount ?? 0));

  const raw = input.speakerCount;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const manual = clampSpeakerCount(raw, dialogueCount);
    return {
      n: clampSpeakerCount(Math.max(manual, knownFloor), dialogueCount),
      estimatedN: clampSpeakerCount(Math.max(estimatedN, knownFloor), dialogueCount),
      fromManual: true,
    };
  }

  const n = clampSpeakerCount(Math.max(estimatedN, knownFloor), dialogueCount);
  return { n, estimatedN: n, fromManual: false };
}
