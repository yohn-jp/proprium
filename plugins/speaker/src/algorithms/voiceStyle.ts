import type { Token } from "../nlp/types.js";
import { isFinalParticle, isNoun, isParticle, isPronoun, isSymbol } from "../nlp/pos.js";

export const COMMON_FIRST_PERSON = ["俺", "俺様", "私", "わたし", "わたくし", "僕", "自分", "うち"] as const;
export const POLITE_FORM_RE = /(です|ます|でした|ました|でしょう|ましょう|ございます)/;
export const DEFAULT_MIN_DIALOGUE_FOR_PROFILE = 3;
export const DEFAULT_MIN_DIALOGUE_FOR_DEVIATION = 10;
const TOO_SIMILAR_THRESHOLD = 0.9;
const ENDING_COVERAGE_THRESHOLD = 0.9;
const KATAKANA_RE = /[゠-ヿ]/g;
const EXCLAMATION_RE = /[！!]/;
const QUESTION_RE = /[？?]/;
const QUESTION_ENDING_RE = /か[。」』]*$/;

export interface DialogueTokens { text: string; tokens: Token[] }
export interface StyleFingerprint {
  entityId: string; dialogueCount: number; firstPersonDist: Record<string, number>;
  endingBigramDist: Record<string, number>; particleDist: Record<string, number>;
  exclamationRate: number; questionRate: number; avgDialogueLength: number;
  dialogueLengthVariance: number; politeRatio: number; katakanaRate: number;
}
export interface VoiceSimilarityPair { entityIdA: string; entityIdB: string; similarity: number; tooSimilar: boolean }
export interface StyleAttribution {
  speakerEntityId: string | null;
  confidence: "high" | "low" | "none";
  text: string;
  sentenceIndex: number;
  /** Tokens for `removeDialogueBrackets(text)`, from the shared NLP worker. */
  tokens: Token[];
}
export interface StyleDeviationWarning {
  sentenceIndex: number;
  text: string;
  speakerEntityId: string;
  issue: "unusual-ending" | "unusual-first-person" | "length-zscore" | "polite-zscore";
  expected: string[];
  found: string;
  basis: "statistical";
  zScore?: number;
}
export interface DetectStyleDeviationOptions {
  minDialogueForDeviation?: number;
  zScoreThreshold?: number;
}

function resolveMinDialogueForDeviation(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) return Math.floor(override);
  const processRef = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const env = processRef?.env?.ARCADIA_VOICE_MIN_DIALOGUES;
  if (env !== undefined && env !== "") {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_MIN_DIALOGUE_FOR_DEVIATION;
}

export function removeDialogueBrackets(text: string): string {
  return text.replace(/^[「『]|[」』]$/g, "").trim();
}

export function computeEndingCategory(tokens: Token[]): string | null {
  const meaningful = tokens.filter((token) => !isSymbol(token));
  if (meaningful.length === 0) return null;
  let finalParticle: string | null = null;
  for (let i = meaningful.length - 1; i >= 0; i--) {
    const token = meaningful[i];
    if (isFinalParticle(token)) finalParticle = token.surface;
    else break;
  }
  const style = POLITE_FORM_RE.test(meaningful.map((token) => token.surface).join("")) ? "敬体" : "常体";
  return `${style}・${finalParticle ?? "なし"}`;
}

function toRelativeDist(counts: Map<string, number>, total: number): Record<string, number> {
  const result: Record<string, number> = {};
  if (total === 0) return result;
  for (const [key, count] of counts) result[key] = count / total;
  return result;
}

export function computeStyleFingerprints(dialoguesByCharacter: Readonly<Record<string, DialogueTokens[]>>): StyleFingerprint[] {
  const fingerprints: StyleFingerprint[] = [];
  for (const [entityId, dialogues] of Object.entries(dialoguesByCharacter)) {
    if (dialogues.length < DEFAULT_MIN_DIALOGUE_FOR_PROFILE) continue;
    const firstPersonCounts = new Map<string, number>();
    const endingCounts = new Map<string, number>();
    const particleCounts = new Map<string, number>();
    let particleTotal = 0; let exclamationCount = 0; let questionCount = 0; let politeCount = 0;
    let totalLength = 0; let katakanaCount = 0; let totalChars = 0;
    const lengths: number[] = [];
    for (const dialogue of dialogues) {
      const content = removeDialogueBrackets(dialogue.text);
      lengths.push(content.length); totalLength += content.length; totalChars += content.length;
      katakanaCount += (content.match(KATAKANA_RE) ?? []).length;
      if (EXCLAMATION_RE.test(content)) exclamationCount++;
      if (QUESTION_RE.test(content) || QUESTION_ENDING_RE.test(content)) questionCount++;
      if (POLITE_FORM_RE.test(content)) politeCount++;
      for (const token of dialogue.tokens) {
        if (isParticle(token)) { particleCounts.set(token.surface, (particleCounts.get(token.surface) ?? 0) + 1); particleTotal++; }
        if ((isNoun(token) || isPronoun(token)) && (COMMON_FIRST_PERSON as readonly string[]).includes(token.surface)) {
          firstPersonCounts.set(token.surface, (firstPersonCounts.get(token.surface) ?? 0) + 1);
        }
      }
      const ending = computeEndingCategory(dialogue.tokens);
      if (ending !== null) endingCounts.set(ending, (endingCounts.get(ending) ?? 0) + 1);
    }
    const firstPersonTotal = [...firstPersonCounts.values()].reduce((sum, count) => sum + count, 0);
    const endingTotal = [...endingCounts.values()].reduce((sum, count) => sum + count, 0);
    const avgDialogueLength = totalLength / dialogues.length;
    let dialogueLengthVariance = 0;
    if (lengths.length >= 2) dialogueLengthVariance = lengths.reduce((sum, length) => sum + (length - avgDialogueLength) ** 2, 0) / (lengths.length - 1);
    fingerprints.push({
      entityId, dialogueCount: dialogues.length,
      firstPersonDist: toRelativeDist(firstPersonCounts, firstPersonTotal),
      endingBigramDist: toRelativeDist(endingCounts, endingTotal),
      particleDist: toRelativeDist(particleCounts, particleTotal),
      exclamationRate: exclamationCount / dialogues.length, questionRate: questionCount / dialogues.length,
      avgDialogueLength, dialogueLengthVariance, politeRatio: politeCount / dialogues.length,
      katakanaRate: totalChars > 0 ? katakanaCount / totalChars : 0,
    });
  }
  return fingerprints;
}

function normalizedAvgLength(length: number): number { return Math.min(1, length / 50); }

function toFeatureVector(fp: StyleFingerprint, vocabulary: string[]): number[] {
  const vector = vocabulary.map((key) => fp.firstPersonDist[key] ?? fp.endingBigramDist[key] ?? fp.particleDist[key] ?? 0);
  vector.push(fp.exclamationRate, fp.questionRate, normalizedAvgLength(fp.avgDialogueLength), fp.katakanaRate, fp.politeRatio);
  return vector;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0; let normA = 0; let normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] ** 2; normB += b[i] ** 2; }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeVoiceSeparationMatrix(fingerprints: StyleFingerprint[], options?: { minDialogueForDeviation?: number }): VoiceSimilarityPair[] {
  const vocabularySet = new Set<string>();
  for (const fp of fingerprints) for (const dist of [fp.firstPersonDist, fp.endingBigramDist, fp.particleDist]) for (const key of Object.keys(dist)) vocabularySet.add(key);
  const vocabulary = [...vocabularySet];
  const vectors = fingerprints.map((fp) => toFeatureVector(fp, vocabulary));
  const minForDeviation = resolveMinDialogueForDeviation(options?.minDialogueForDeviation);
  const pairs: VoiceSimilarityPair[] = [];
  for (let i = 0; i < fingerprints.length; i++) for (let j = i + 1; j < fingerprints.length; j++) {
    const a = fingerprints[i]; const b = fingerprints[j]; const similarity = cosineSimilarity(vectors[i], vectors[j]);
    pairs.push({ entityIdA: a.entityId, entityIdB: b.entityId, similarity, tooSimilar: a.dialogueCount >= minForDeviation && b.dialogueCount >= minForDeviation && similarity >= TOO_SIMILAR_THRESHOLD });
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

/** Source statistical voice-style deviation algorithm over already attributed, pretokenized dialogue. */
export function detectStyleDeviations(
  attributions: StyleAttribution[],
  fingerprints: StyleFingerprint[],
  options?: DetectStyleDeviationOptions,
): StyleDeviationWarning[] {
  const minForDeviation = resolveMinDialogueForDeviation(options?.minDialogueForDeviation);
  const zThreshold = options?.zScoreThreshold ?? 2;
  const byEntity = new Map(fingerprints.map((fingerprint) => [fingerprint.entityId, fingerprint]));
  const warnings: StyleDeviationWarning[] = [];

  for (const attribution of attributions) {
    if (attribution.speakerEntityId === null || attribution.confidence === "none") continue;
    const fingerprint = byEntity.get(attribution.speakerEntityId);
    if (!fingerprint || fingerprint.dialogueCount < minForDeviation) continue;

    const content = removeDialogueBrackets(attribution.text);
    let firstPersonWarned = false;
    for (const token of attribution.tokens) {
      if (firstPersonWarned) break;
      if (!(isNoun(token) || isPronoun(token)) || !(COMMON_FIRST_PERSON as readonly string[]).includes(token.surface)) continue;
      if (fingerprint.firstPersonDist[token.surface] === undefined) {
        warnings.push({
          sentenceIndex: attribution.sentenceIndex,
          text: attribution.text,
          speakerEntityId: attribution.speakerEntityId,
          issue: "unusual-first-person",
          expected: Object.keys(fingerprint.firstPersonDist),
          found: token.surface,
          basis: "statistical",
        });
        firstPersonWarned = true;
      }
    }

    const ending = computeEndingCategory(attribution.tokens);
    if (ending !== null) {
      const expected = [...topEndingsByCoverage(fingerprint.endingBigramDist)];
      if (!expected.includes(ending)) warnings.push({
        sentenceIndex: attribution.sentenceIndex,
        text: attribution.text,
        speakerEntityId: attribution.speakerEntityId,
        issue: "unusual-ending",
        expected,
        found: ending,
        basis: "statistical",
      });
    }

    const stdLength = Math.sqrt(Math.max(fingerprint.dialogueLengthVariance, 0.01));
    const lengthZ = (content.length - fingerprint.avgDialogueLength) / stdLength;
    if (Math.abs(lengthZ) > zThreshold) warnings.push({
      sentenceIndex: attribution.sentenceIndex,
      text: attribution.text,
      speakerEntityId: attribution.speakerEntityId,
      issue: "length-zscore",
      expected: [`平均${fingerprint.avgDialogueLength.toFixed(1)}字`],
      found: `${content.length}字`,
      basis: "statistical",
      zScore: lengthZ,
    });

    const observedPolite = POLITE_FORM_RE.test(content) ? 1 : 0;
    const probability = Math.min(0.99, Math.max(0.01, fingerprint.politeRatio));
    const politeStd = Math.sqrt(probability * (1 - probability));
    const politeZ = (observedPolite - fingerprint.politeRatio) / Math.max(politeStd, 0.01);
    if (Math.abs(politeZ) > zThreshold) warnings.push({
      sentenceIndex: attribution.sentenceIndex,
      text: attribution.text,
      speakerEntityId: attribution.speakerEntityId,
      issue: "polite-zscore",
      expected: [`敬体率${(fingerprint.politeRatio * 100).toFixed(0)}%`],
      found: observedPolite ? "敬体" : "常体",
      basis: "statistical",
      zScore: politeZ,
    });
  }
  return warnings;
}

/** Source style deviation function's learned ending-category set, exposed for later speaker composition. */
export function topEndingsByCoverage(dist: Record<string, number>): Set<string> {
  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const top = new Set<string>(); let cumulative = 0;
  for (const [key, frequency] of sorted) { if (cumulative >= ENDING_COVERAGE_THRESHOLD) break; top.add(key); cumulative += frequency; }
  return top;
}
