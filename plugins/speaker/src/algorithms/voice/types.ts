/**
 * スキーマ駆動型コンテキスト口調プロファイルの型定義。
 * `profile.yaml` の `voice_profiles` フィールドで、状況（シーンメタデータ・地の文構造）に応じて
 * 切り替わる複数の口調プロファイルをキャラごとに定義できるようにする。
 */

/** シーンメタデータ（例: raw.situation）の値と一致するかで判定するトリガー。 */
export interface MatchMetadataTrigger {
  type: "match_metadata";
  /** 照合対象のメタデータキー（例: シーンentityの raw フィールド名）。 */
  key: string;
  /** 期待値（文字列化して比較する）。 */
  value: string;
}

/** 地の文構造（カッコの種類など）から判定するトリガー。
 *  現状 "monologue" のみサポート: 判定対象テキスト全体が丸カッコ（全角/半角）で
 *  囲まれている場合に一致する（モノローグ・心の声の慣習的表記）。 */
export interface TextStructureTrigger {
  type: "text_structure";
  value: "monologue";
}

export type ContextTrigger = MatchMetadataTrigger | TextStructureTrigger;

/** キャラ1名分の状況別口調プロファイル。 */
export interface VoiceProfile {
  id: string;
  /** 未指定ならデフォルトプロファイル（他のどのプロファイルのトリガーにも一致しない場合のフォールバック）。 */
  contextTrigger?: ContextTrigger;
  firstPerson?: string[];
  sentenceEndings?: string[];
}

/** コンテキスト・ルーターがプロファイル選択に使う実行時コンテキスト。 */
export interface VoiceRoutingContext {
  /** 判定対象のセリフ／文本文（鉤括弧・丸カッコ等の記号を含む）。 */
  text: string;
  /** シーン側のメタデータ（例: シーンentityの raw）。match_metadata トリガーの照合に使う。 */
  sceneMetadata?: Record<string, unknown>;
}
