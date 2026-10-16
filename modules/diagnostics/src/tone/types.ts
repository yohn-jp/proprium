/**
 * 意味論的トーン・バリデーターの型定義。
 * `meta/tone-lexicon.yaml` で定義したトーンクラス（suspense, action, slice_of_life 等、
 * 作品側で自由に追加できる汎用項目）ごとの特徴語出現密度から、シーンの演出意図
 * （intended_tone）との乖離を検知する。
 */

/** トーンクラス1件分の特徴語（基本形）→重みのマップ。 */
export type ToneWordWeights = Record<string, number>;

/** `meta/tone-lexicon.yaml` のパース結果。トーンクラス名は固定の列挙ではなく、
 *  設定ファイル側で定義された名前をそのままキーとして扱う（汎用トーンクラス）。 */
export interface ToneLexiconConfig {
  tones: Record<string, ToneWordWeights>;
}

/** 本文の形態素解析結果から算出した、各トーンクラスの特徴語出現密度（トーンベクトル）。
 *  値は「そのクラスの特徴語に一致したトークンの重み合計 / 総トークン数」。 */
export type ToneVector = Record<string, number>;

/** シーンの演出意図（intended_tone）と本文トーンベクトルが乖離している場合の警告。 */
export interface ToneDeviationWarning {
  /** シーンが意図したトーンクラス。 */
  intendedTone: string;
  /** 本文トーンベクトル中で最も密度が高かったトーンクラス。 */
  dominantTone: string;
  /** 算出されたトーンベクトル全体（デバッグ・UI表示用）。 */
  toneVector: ToneVector;
  message: string;
}

/**
 * 組み込みの既定トーン語彙。
 *
 * `meta/tone-lexicon.yaml` が存在しない環境でのフォールバックとして使う。
 * 特定作品に依存しない汎用語のみを収録する。
 */
export const DEFAULT_TONE_LEXICON: ToneLexiconConfig = {
  tones: {
    suspense: {
      緊張: 1.0,
      不安: 1.0,
      恐怖: 1.0,
      静寂: 0.8,
      悲鳴: 1.0,
      戦慄: 1.2,
      闇: 0.8,
      足音: 0.8,
    },
    action: {
      疾走: 1.0,
      衝撃: 1.0,
      咆哮: 1.0,
      斬撃: 1.2,
      爆発: 1.0,
      加速: 0.8,
      激突: 1.0,
    },
    slice_of_life: {
      珈琲: 1.0,
      あくび: 1.0,
      日常: 1.0,
      洗濯: 0.8,
      昼寝: 1.0,
      掃除: 0.8,
      世間話: 1.0,
    },
  },
};
