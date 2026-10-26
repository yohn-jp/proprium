export {
  COMMON_FIRST_PERSON,
  DEFAULT_MIN_DIALOGUE_FOR_DEVIATION,
  DEFAULT_MIN_DIALOGUE_FOR_PROFILE,
  POLITE_FORM_RE,
  computeEndingCategory,
  computeStyleFingerprints,
  computeVoiceSeparationMatrix,
  detectStyleDeviations,
  removeDialogueBrackets,
  topEndingsByCoverage,
} from "./voiceStyle.js";
export type {
  DialogueTokens,
  StyleAttribution,
  StyleDeviationWarning,
  StyleFingerprint,
  VoiceSimilarityPair,
} from "./voiceStyle.js";
