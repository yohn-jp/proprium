import { isDialogue } from "../textAnalysis.js";
import { splitIntoSentences } from "@scriptorium/module-nlp";
import type { Token } from "@scriptorium/module-nlp";
import { isAdjective, isAdverb, isVerb } from "@scriptorium/module-nlp";

export interface ProseBalanceWarning {
  metric: "dialogue-ratio" | "narration-ratio" | "adjective-density" | "adverb-density";
  value: number;
  threshold: number;
  message: string;
}

export interface ProseBalanceResult {
  charCount: number;
  dialogueCharCount: number;
  narrationCharCount: number;
  dialogueRatio: number;
  narrationRatio: number;
  adjectiveRatio: number;
  adverbRatio: number;
  verbRatio: number;
  warnings: ProseBalanceWarning[];
}

const DIALOGUE_RATIO_HIGH = 0.75;
const DIALOGUE_RATIO_LOW = 0.15;
const ADJECTIVE_DENSITY_HIGH = 0.18;
const ADVERB_DENSITY_HIGH = 0.12;

/** 本文全体の品詞比率とセリフ/地の文比率を算出し、バランス警告を返す。 */
export function computeProseBalance(text: string, tokens: Token[]): ProseBalanceResult {
  const sentences = splitIntoSentences(text);
  let dialogueChars = 0;
  let narrationChars = 0;
  for (const s of sentences) {
    const len = s.length;
    if (isDialogue(s)) dialogueChars += len;
    else narrationChars += len;
  }
  const charCount = text.length || 1;
  const dialogueRatio = dialogueChars / charCount;
  const narrationRatio = narrationChars / charCount;

  let adjCount = 0;
  let advCount = 0;
  let verbCount = 0;
  let totalTokenCount = 0;
  for (const token of tokens) {
    if (isAdjective(token)) adjCount++;
    else if (isAdverb(token)) advCount++;
    else if (isVerb(token)) verbCount++;
    totalTokenCount++;
  }
  const denom = totalTokenCount || 1;
  const adjectiveRatio = adjCount / denom;
  const adverbRatio = advCount / denom;
  const verbRatio = verbCount / denom;

  const warnings: ProseBalanceWarning[] = [];
  if (dialogueRatio > DIALOGUE_RATIO_HIGH) {
    warnings.push({
      metric: "dialogue-ratio",
      value: dialogueRatio,
      threshold: DIALOGUE_RATIO_HIGH,
      message: `セリフ比率が高い（${(dialogueRatio * 100).toFixed(0)}%）。地の文の描写を増やすとバランスが良くなります。`,
    });
  }
  if (dialogueRatio < DIALOGUE_RATIO_LOW && charCount > 100) {
    warnings.push({
      metric: "narration-ratio",
      value: narrationRatio,
      threshold: 1 - DIALOGUE_RATIO_LOW,
      message: `地の文が多い（${(narrationRatio * 100).toFixed(0)}%）。会話を挟むとテンポが改善します。`,
    });
  }
  if (adjectiveRatio > ADJECTIVE_DENSITY_HIGH) {
    warnings.push({
      metric: "adjective-density",
      value: adjectiveRatio,
      threshold: ADJECTIVE_DENSITY_HIGH,
      message: `形容詞密度が高い（${(adjectiveRatio * 100).toFixed(0)}%）。描写の簡潔化を検討してください。`,
    });
  }
  if (adverbRatio > ADVERB_DENSITY_HIGH) {
    warnings.push({
      metric: "adverb-density",
      value: adverbRatio,
      threshold: ADVERB_DENSITY_HIGH,
      message: `副詞密度が高い（${(adverbRatio * 100).toFixed(0)}%）。修飾語の削減を検討してください。`,
    });
  }

  return {
    charCount,
    dialogueCharCount: dialogueChars,
    narrationCharCount: narrationChars,
    dialogueRatio,
    narrationRatio,
    adjectiveRatio,
    adverbRatio,
    verbRatio,
    warnings,
  };
}
