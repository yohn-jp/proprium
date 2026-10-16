/** Source-derived declared voice checks from core/voiceConsistency.ts and core-shared/voice. */
export interface VoicePatterns {
  firstPerson?: string[];
  sentenceEndings?: string[];
  tone?: string;
}

export interface VoiceProfile {
  id: string;
  contextTrigger?:
    | { type: "match_metadata"; key: string; value: string }
    | { type: "text_structure"; value: "monologue" };
  firstPerson?: string[];
  sentenceEndings?: string[];
}

export interface DeclaredVoiceAttribution {
  speakerEntityId: string | null;
  confidence: "high" | "low" | "none";
  text: string;
  sentenceIndex: number;
}

export interface VoiceConsistencyWarning {
  sentenceIndex: number;
  text: string;
  speakerEntityId: string;
  issue: "unexpected-first-person" | "unexpected-ending";
  expected: string[];
  found: string;
  basis: "profile";
}

type VoicePatternSource = VoicePatterns | VoiceProfile[];
const COMMON_FIRST_PERSON = ["俺", "俺様", "私", "わたし", "わたくし", "僕", "自分", "うち"] as const;
const MONOLOGUE_RE = /^[（(].*[）)]$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractVoiceProfiles(raw: Record<string, unknown>): VoiceProfile[] | null {
  if (!Array.isArray(raw.voice_profiles)) return null;
  const profiles: VoiceProfile[] = [];
  for (const candidate of raw.voice_profiles) {
    const item = asRecord(candidate);
    if (!item || typeof item.id !== "string" || item.id.length === 0) continue;
    const profile: VoiceProfile = { id: item.id };
    const trigger = asRecord(item.context_trigger);
    if (trigger?.type === "match_metadata" && typeof trigger.key === "string" && typeof trigger.value === "string") {
      profile.contextTrigger = { type: "match_metadata", key: trigger.key, value: trigger.value };
    } else if (trigger?.type === "text_structure" && trigger.value === "monologue") {
      profile.contextTrigger = { type: "text_structure", value: "monologue" };
    }
    if (Array.isArray(item.firstPerson)) {
      const firstPerson = item.firstPerson.filter((value): value is string => typeof value === "string");
      if (firstPerson.length) profile.firstPerson = firstPerson;
    }
    if (Array.isArray(item.sentenceEndings)) {
      const sentenceEndings = item.sentenceEndings.filter((value): value is string => typeof value === "string");
      if (sentenceEndings.length) profile.sentenceEndings = sentenceEndings;
    }
    if (profile.firstPerson || profile.sentenceEndings) profiles.push(profile);
  }
  return profiles.length ? profiles : null;
}

function extractFromDuality(voice: Record<string, unknown>): Pick<VoicePatterns, "firstPerson" | "tone"> | null {
  const duality = asRecord(voice.duality);
  const outer = duality && asRecord(duality.outer);
  if (!outer) return null;
  const result: Pick<VoicePatterns, "firstPerson" | "tone"> = {};
  const firstPerson = asRecord(outer.first_person);
  if (firstPerson) {
    const names = [firstPerson.name, firstPerson.reading].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (names.length) result.firstPerson = [...new Set(names)];
  }
  if (typeof outer.tone === "string" && outer.tone.length > 0) result.tone = outer.tone;
  return result.firstPerson || result.tone ? result : null;
}

function extractPatternsFromVoiceDefinition(raw: Record<string, unknown>): VoicePatterns | null {
  const voice = asRecord(raw.voice);
  if (!voice) return null;
  const firstPerson = voice.first_person;
  if (Array.isArray(firstPerson)) {
    const names = firstPerson.map((item) => asRecord(item)?.name).filter((name): name is string => typeof name === "string");
    if (names.length) return { firstPerson: names };
  }
  return extractFromDuality(voice);
}

function extractVoicePatterns(raw: Record<string, unknown>): VoicePatterns | null {
  if (!raw.voicePatterns) return extractPatternsFromVoiceDefinition(raw);
  const patterns = asRecord(raw.voicePatterns);
  if (!patterns) return null;
  const result: VoicePatterns = {};
  if (Array.isArray(patterns.firstPerson)) result.firstPerson = patterns.firstPerson as string[];
  if (Array.isArray(patterns.sentenceEndings)) result.sentenceEndings = patterns.sentenceEndings as string[];
  if (typeof patterns.tone === "string" && patterns.tone.length > 0) result.tone = patterns.tone;
  return result.firstPerson || result.sentenceEndings || result.tone ? result : null;
}

function resolveActiveProfile(profiles: VoiceProfile[], text: string, sceneMetadata?: Record<string, unknown>): VoiceProfile | null {
  for (const profile of profiles) {
    const trigger = profile.contextTrigger;
    if (trigger?.type === "match_metadata" && sceneMetadata?.[trigger.key] !== undefined && String(sceneMetadata[trigger.key]) === trigger.value) return profile;
    if (trigger?.type === "text_structure" && trigger.value === "monologue" && MONOLOGUE_RE.test(text.trim())) return profile;
  }
  return profiles.find((profile) => !profile.contextTrigger) ?? null;
}

function removeBrackets(text: string): string {
  return text.replace(/^[「『（(]|[」』）)]$/g, "").trim();
}

function extractEnding(sentence: string): string | null {
  const trimmed = sentence.replace(/[。！？」』）)]+$/u, "").trim();
  return trimmed.length ? trimmed : null;
}

/** Check pre-attributed utterances against source-declared voicePatterns, voice.yaml and voice_profiles. */
export function checkDeclaredVoiceConsistency(
  attributions: DeclaredVoiceAttribution[],
  speakerDefinitions: Record<string, Record<string, unknown>>,
  sceneMetadata?: Record<string, unknown>,
): VoiceConsistencyWarning[] {
  const warnings: VoiceConsistencyWarning[] = [];
  for (const attribution of attributions) {
    if (attribution.speakerEntityId === null || attribution.confidence === "none") continue;
    const raw = speakerDefinitions[attribution.speakerEntityId];
    if (!raw) continue;
    const source: VoicePatternSource | null = extractVoiceProfiles(raw) ?? extractVoicePatterns(raw);
    if (!source) continue;
    const patterns = Array.isArray(source) ? resolveActiveProfile(source, attribution.text, sceneMetadata) : source;
    if (!patterns) continue;
    const textContent = removeBrackets(attribution.text);
    if (patterns.firstPerson?.length) {
      for (const firstPerson of COMMON_FIRST_PERSON) {
        if (textContent.includes(firstPerson) && !patterns.firstPerson.includes(firstPerson)) {
          warnings.push({ sentenceIndex: attribution.sentenceIndex, text: attribution.text, speakerEntityId: attribution.speakerEntityId, issue: "unexpected-first-person", expected: patterns.firstPerson, found: firstPerson, basis: "profile" });
          break;
        }
      }
    }
    if (patterns.sentenceEndings?.length) {
      const ending = extractEnding(textContent);
      if (ending !== null && !patterns.sentenceEndings.some((pattern) => ending.endsWith(pattern))) {
        warnings.push({ sentenceIndex: attribution.sentenceIndex, text: attribution.text, speakerEntityId: attribution.speakerEntityId, issue: "unexpected-ending", expected: patterns.sentenceEndings, found: ending.slice(-3), basis: "profile" });
      }
    }
  }
  return warnings;
}
