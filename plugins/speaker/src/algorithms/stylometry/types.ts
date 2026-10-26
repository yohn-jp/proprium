/**
 * 統計的スタイロメトリ（文体計量）の型定義。
 * 既存の StyleFingerprint（一人称・語尾bigram・助詞分布などの語彙統計）を補完し、
 * 語彙の豊富さ・文構造の複雑さ・品詞の選択偏向という発話単位の量的特徴量を扱う。
 */

/** 1発話（またはコーパス平均）分のスタイロメトリック特徴量。 */
export interface StylometricMetrics {
  /** 語彙の豊富さ（Type-Token Ratio）: 異なり語数（basic_form） / 総形態素数（記号除く） */
  typeTokenRatio: number;
  /** 文構造の複雑さの指標その1: 1発話あたりの形態素数（記号含む） */
  morphemeCount: number;
  /** 文構造の複雑さの指標その2: 読点（、）の頻度 = 読点数 / 総形態素数 */
  commaFrequency: number;
  /** 内容語（名詞・動詞・形容詞・副詞）に占める形容詞の割合 */
  adjectiveRatio: number;
  /** 内容語に占める動詞の割合 */
  verbRatio: number;
}

/** 品詞選択偏向の分類。形容詞主体・動詞主体・どちらでもない、の3値。 */
export type PosBias = "adjective-dominant" | "verb-dominant" | "neutral";

/** キャラクター1名分のスタイロメトリック・プロファイル。
 *  発話ごとの StylometricMetrics ベクトル群から平均（スタイル中心）と標準偏差（分布の広がり）を学習する。 */
export interface StylometricProfile {
  entityId: string;
  /** 学習に使ったセリフ数 */
  dialogueCount: number;
  /** 発話ごとのメトリクスの平均値（キャラのスタイル中心） */
  mean: StylometricMetrics;
  /** 発話ごとのメトリクスの母集団標準偏差（分散を n で割る。zスコア床は deviationDetector 側） */
  stdDev: StylometricMetrics;
}

/** 確率モデルに基づくスタイル逸脱（統計分布からの外れ値）警告。
 *  distance はプロファイルの平均からの正規化距離（各次元のzスコアの二乗平均平方根）。
 *  値が大きいほど、そのキャラの通常の文体分布から統計的に外れていることを意味する
 *  （＝他キャラの文体が混入している可能性）。 */
export interface StylometricDeviationWarning {
  sentenceIndex: number;
  text: string;
  speakerEntityId: string;
  /** 統計的乖離スコア（zスコアのRMS）。各次元が平均的に何標準偏差ずれているかの目安。 */
  distance: number;
  /** 警告を出した閾値（distance がこれを超えると警告） */
  threshold: number;
  /** 判定対象セリフ自身のスタイロメトリック特徴量（デバッグ・UI表示用） */
  metrics: StylometricMetrics;
  message: string;
}
