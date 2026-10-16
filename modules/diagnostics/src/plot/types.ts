/**
 * 意味論的プロット・バインディングの型定義。
 * scene.yaml の goal/conflict（raw.goal, raw.conflict。専用スキーマの無い汎用フィールド）と
 * 本文の叙述を比較し、シーンの目的が本文で達成されているかを
 * ベクトル類似度・キーワードセマンティクスの両面から評価する。
 */

/** アーキタイプ1件分の特徴語（基本形）→重みのマップ。 */
export type PlotWordWeights = Record<string, number>;

/**
 * プロットの目的アーキタイプ（例: concealment=隠す・秘匿）1件分の定義。
 * - goalKeywords: goal/conflict文をこのアーキタイプに分類するための特徴語。
 * - violationKeywords: このアーキタイプの目的に矛盾する語彙（例: 秘匿目的に対する暴露・解説語彙）。
 *   未指定のアーキタイプは矛盾検知の対象外（分類のみ行われる）。
 * - violationThreshold: violationKeywords密度がこの値以上のとき矛盾警告を出す（未指定時は既定値）。
 */
export interface PlotArchetype {
  goalKeywords: PlotWordWeights;
  violationKeywords?: PlotWordWeights;
  violationThreshold?: number;
}

/** `meta/plot-lexicon.yaml` のパース結果。アーキタイプ名は固定の列挙ではなく、
 *  設定ファイル側で定義された名前をそのままキーとして扱う（汎用アーキタイプ）。 */
export interface PlotLexiconConfig {
  archetypes: Record<string, PlotArchetype>;
}

/** goal/conflict文の形態素解析結果から算出した、各アーキタイプの特徴語出現密度。 */
export type PlotVector = Record<string, number>;

/** 警告種別。
 *  "contradiction": goal/conflictがアーキタイプに分類でき、かつそのアーキタイプの矛盾語彙
 *  （violationKeywords）が本文中に高密度で検出された（例: 隠す目的なのに暴露語彙が高密度）。
 *  "divergence": goal/conflictの内容語彙が本文の内容語彙とほぼ重ならない（目的が本文で
 *  扱われていない疑いを示す弱いシグナル）。 */
export type PlotWarningKind = "contradiction" | "divergence";

export interface PlotSemanticWarning {
  kind: PlotWarningKind;
  /** "contradiction" の場合のみ設定。分類されたgoalのアーキタイプ名。 */
  archetype?: string;
  /** "contradiction" の場合のみ設定。本文中の矛盾語彙密度。 */
  violationDensity?: number;
  /** "divergence" の場合のみ設定。goal/conflict語彙と本文語彙のコサイン類似度。 */
  similarity?: number;
  message: string;
}

/**
 * 組み込みの既定プロット語彙。
 *
 * `meta/plot-lexicon.yaml` が存在しない環境でのフォールバックとして使う。
 * 特定作品に依存しない汎用語のみを収録する。
 */
export const DEFAULT_PLOT_LEXICON: PlotLexiconConfig = {
  archetypes: {
    concealment: {
      goalKeywords: {
        隠す: 1.0,
        秘密: 1.0,
        秘匿: 1.2,
        隠匿: 1.2,
        伏せる: 1.0,
        黙る: 0.8,
        隠蔽: 1.2,
      },
      violationKeywords: {
        正体: 1.0,
        真相: 1.0,
        種明かし: 1.2,
        白状: 1.0,
        暴露: 1.2,
        実は: 0.6,
        本当は: 0.6,
      },
      violationThreshold: 0.03,
    },
  },
};
