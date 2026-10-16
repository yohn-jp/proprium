import type { Tokenizer } from "@scriptorium/module-nlp";
import { isNoun, isPronoun } from "@scriptorium/module-nlp";
import type { SpeakerAttribution } from "../speakerAttribution.js";
import { computeEndingCategory, removeDialogueBrackets } from "../styleFingerprint.js";
import type { Entity } from "../types.js";
import { COMMON_FIRST_PERSON, POLITE_FORM_RE } from "../voice/constants.js";
import type { VoiceProfile } from "../voice/index.js";
import type { DialogueRecord, VoiceFeatures } from "./types.js";
import {
  LITERARY_IMPERATIVE_RE,
  MONOLOGUE_RE,
  STRICT_DIALOGUE_RE,
  WRITTEN_INTRO_RE,
} from "./types.js";

export function buildRecords(
  attributions: SpeakerAttribution[],
  sentences: string[],
  tokenizer: Tokenizer,
): DialogueRecord[] {
  return attributions.map((attribution, attributionIndex) => {
    const sentenceIndex = attribution.sentenceIndex - 1;
    const text = sentences[sentenceIndex] ?? attribution.text;
    const narrationBefore = narrationBetween(
      sentences,
      previousDialogueIndex(sentences, sentenceIndex),
      sentenceIndex,
    );
    const narrationAfter = narrationBetween(
      sentences,
      sentenceIndex,
      nextDialogueIndex(sentences, sentenceIndex),
    );
    const eligible =
      STRICT_DIALOGUE_RE.test(text) &&
      !MONOLOGUE_RE.test(text) &&
      !WRITTEN_INTRO_RE.test(narrationBefore) &&
      !LITERARY_IMPERATIVE_RE.test(removeDialogueBrackets(text));
    return {
      attributionIndex,
      sentenceIndex,
      text,
      eligible,
      key: null,
      strongEntityId: null,
      provisional: false,
      narrationBefore,
      narrationAfter,
      features: extractFeatures(text, tokenizer),
    };
  });
}

export function narrationBetween(sentences: string[], from: number, to: number): string {
  const start = Math.max(0, from + 1);
  const end = to < 0 ? sentences.length : to;
  return sentences
    .slice(start, end)
    .filter((sentence) => !STRICT_DIALOGUE_RE.test(sentence))
    .join("");
}

export function previousDialogueIndex(sentences: string[], index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (STRICT_DIALOGUE_RE.test(sentences[i])) return i;
  }
  return -1;
}

export function nextDialogueIndex(sentences: string[], index: number): number {
  for (let i = index + 1; i < sentences.length; i++) {
    if (STRICT_DIALOGUE_RE.test(sentences[i])) return i;
  }
  return sentences.length;
}

export function extractFeatures(text: string, tokenizer: Tokenizer): VoiceFeatures {
  const content = removeDialogueBrackets(text);
  const tokens = tokenizer.tokenize(content);
  let firstPerson: string | null = null;
  for (const token of tokens) {
    if ((isNoun(token) || isPronoun(token)) && COMMON_FIRST_PERSON.includes(token.surface)) {
      firstPerson = token.surface;
      break;
    }
  }
  return {
    firstPerson,
    ending: computeEndingCategory(tokens),
    polite: POLITE_FORM_RE.test(content),
    openingMark: /^[…‥―—]/.test(content),
  };
}

function sameCharacterFirstPersons(left: string, right: string, profiles: VoiceProfile[]): boolean {
  return profiles.some(
    (profile) => profile.firstPerson?.includes(left) && profile.firstPerson.includes(right),
  );
}

export function voiceMismatch(
  left: VoiceFeatures,
  right: VoiceFeatures,
  profiles: VoiceProfile[],
): boolean {
  if (
    left.firstPerson &&
    right.firstPerson &&
    left.firstPerson !== right.firstPerson &&
    !sameCharacterFirstPersons(left.firstPerson, right.firstPerson, profiles)
  ) {
    return true;
  }
  if (left.polite !== right.polite) return true;
  return left.ending !== null && right.ending !== null && left.ending !== right.ending;
}

export function applySceneLocalFingerprint(
  records: DialogueRecord[],
  candidates: Entity[],
  profiles: VoiceProfile[],
  n: number = candidates.length === 2 ? 2 : 3,
): void {
  const strong = records.filter((record) => record.strongEntityId !== null && record.key !== null);
  // 話者枠が3以上、または候補が広いと局所指紋は過統合しやすいので抑止
  if (strong.length < 2 || n > 2 || candidates.length > 2) return;

  for (const record of records) {
    if (!record.provisional || record.narrationBefore.length > 0) continue;
    const matching = strong.filter(
      (anchor) => !voiceMismatch(anchor.features, record.features, profiles),
    );
    const keys = new Set(matching.map((anchor) => anchor.key));
    if (keys.size !== 1) continue;
    // 一度だけ、本文上で最も近い確定アンカーへ割り当てる。
    matching.sort(
      (left, right) =>
        Math.abs(left.sentenceIndex - record.sentenceIndex) -
        Math.abs(right.sentenceIndex - record.sentenceIndex),
    );
    record.key = matching[0].key;
    record.provisional = false;
  }
}
