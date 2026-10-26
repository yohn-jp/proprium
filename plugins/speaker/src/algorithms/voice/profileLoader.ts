import type { Entity } from "../types.js";
import type { ContextTrigger, VoiceProfile } from "./types.js";

function parseContextTrigger(value: unknown): ContextTrigger | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;

  if (
    obj.type === "match_metadata" &&
    typeof obj.key === "string" &&
    typeof obj.value === "string"
  ) {
    return { type: "match_metadata", key: obj.key, value: obj.value };
  }
  if (obj.type === "text_structure" && obj.value === "monologue") {
    return { type: "text_structure", value: "monologue" };
  }
  return undefined;
}

function parseProfile(value: unknown): VoiceProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;

  const profile: VoiceProfile = { id: obj.id };

  const trigger = parseContextTrigger(obj.context_trigger);
  if (trigger) profile.contextTrigger = trigger;

  if (Array.isArray(obj.firstPerson)) {
    const firstPerson = obj.firstPerson.filter((v): v is string => typeof v === "string");
    if (firstPerson.length > 0) profile.firstPerson = firstPerson;
  }
  if (Array.isArray(obj.sentenceEndings)) {
    const sentenceEndings = obj.sentenceEndings.filter((v): v is string => typeof v === "string");
    if (sentenceEndings.length > 0) profile.sentenceEndings = sentenceEndings;
  }

  return profile.firstPerson || profile.sentenceEndings ? profile : null;
}

/**
 * entity.raw.voice_profiles（配列）から有効な口調プロファイル群を抽出する。
 * フィールド未定義・不正な形式・有効なプロファイルが1件も無い場合は null を返す
 * （＝この機能は未使用。呼び出し側は既存の extractVoicePatterns にフォールバックすることが期待される）。
 */
export function extractVoiceProfiles(entity: Entity): VoiceProfile[] | null {
  const raw = entity.raw.voice_profiles;
  if (!Array.isArray(raw)) return null;

  const profiles = raw.map(parseProfile).filter((p): p is VoiceProfile => p !== null);
  return profiles.length > 0 ? profiles : null;
}
