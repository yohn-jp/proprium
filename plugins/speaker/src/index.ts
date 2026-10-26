export { runSpeakerPipeline } from "./algorithms/pipeline.js";
export type { SpeakerPipelineInput, SpeakerPipelineResult } from "./algorithms/pipeline.js";
export {
  applySpeakerOverridesDetailed,
  attributeSpeakers,
  hashDialogueText,
  type SpeakerAttribution,
  type SpeakerOverride,
} from "./algorithms/speakerAttribution.js";
export { buildMentionDictionary } from "./algorithms/mentionIndex.js";
export { splitIntoSentenceOffsets } from "./nlp/sentenceSplit.js";
export {
  applyGatesToAttributions,
  computeSpeakerRuleGates,
  SPEAKER_RULE_GATE_THRESHOLDS,
} from "./algorithms/speakerRuleStats.js";
export type { Entity } from "./algorithms/types.js";
export type { Token, Tokenizer } from "./nlp/types.js";
