/** styleFingerprint / voiceConsistency 双方から再利用する共通の一人称リスト。 */
export const COMMON_FIRST_PERSON = ["俺", "俺様", "私", "わたし", "わたくし", "僕", "自分", "うち"];

/** 敬体（です・ます調）を示す表層パターン。 */
export const POLITE_FORM_RE = /(です|ます|でした|ました|でしょう|ましょう|ございます)/;

/** プロファイル生成に必要な最低セリフ数。分布がノイズに支配されない下限。 */
export const DEFAULT_MIN_DIALOGUE_FOR_PROFILE = 3;

/** 統計逸脱判定に使う最低セリフ数。学習不足での誤警告を抑える。 */
export const DEFAULT_MIN_DIALOGUE_FOR_DEVIATION = 10;

/** z-score がこの絶対値を超えると統計逸脱として警告する。 */
export const DEFAULT_Z_SCORE_THRESHOLD = 2;

/** 標準偏差がほぼ0のときの z-score 発散を防ぐ下限。 */
export const MIN_STD_DEV_FLOOR = 0.01;

/**
 * 環境変数 ARCADIA_VOICE_MIN_DIALOGUES があれば逸脱判定の最低件数を上書きする。
 *
 * `process` を直接参照すると @types/node がないブラウザ向けビルドで型解決できない
 * （#327 で core-shared 移行時に発覚した browser.ts の潜在的なリーク）。
 * `globalThis` 経由でオプショナルに参照することで、Node実行時は従来どおり
 * 環境変数を読み、ブラウザでは `process` が存在しないため安全に undefined へ倒れる。
 */
export function resolveMinDialogueForDeviation(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const processRef = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const env = processRef?.env?.ARCADIA_VOICE_MIN_DIALOGUES;
  if (env !== undefined && env !== "") {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_MIN_DIALOGUE_FOR_DEVIATION;
}
