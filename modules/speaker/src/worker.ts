import type { JobRequest } from "@scriptorium/contracts";
import { installWorkerHandler } from "@scriptorium/module-runtime";
import {
  attributionAccuracyFromPairs,
  buildSpeakerRerankExamples,
  calibrateHighProbabilityThreshold,
  extractSpeakerRerankFeatures,
  scoreSpeakerRerank,
  trainSpeakerRerankModel,
  type SpeakerModel,
  type SpeakerRerankContext,
  type SpeakerRerankExample,
} from "./algorithms/speakerReranker.js";
import type { SpeakerCorrectionRecord } from "./algorithms/speakerCorrectionLog.js";
import { buildSceneEvalResult, buildSpeakerEvalReport, matchGoldToPredictions, type SceneNEvalInput, type SpeakerEvalReport } from "./algorithms/speakerEval.js";
import { runSpeakerPipeline, type SpeakerPipelineInput } from "./algorithms/pipeline.js";
import { hashDialogueText } from "./algorithms/speakerAttribution.js";

export const SPEAKER_MODULE_VERSION = "0.1.0";
export const SPEAKER_ENGINE_ID = "scriptorium-speaker-cpu";
export const SPEAKER_ENGINE_VERSION = "1.0.0";

export type SpeakerWorkerInput =
  | { kind: "attribute"; pipeline: SpeakerPipelineInput }
  | { kind: "evaluate"; pipelines: SpeakerPipelineInput[]; generatedAt?: string }
  | {
      kind: "train";
      trainPipelines: SpeakerPipelineInput[];
      holdoutPipelines: SpeakerPipelineInput[];
      corrections: SpeakerCorrectionRecord[];
      reasonPrecision: Record<string, number>;
    };

export interface SpeakerTrainingResult {
  trainExampleCount: number;
  holdoutSceneIds: string[];
  accuracyWithoutModel: number;
  accuracyWithModel: number;
  deltaPt: number;
  adopted: boolean;
  highProbabilityThreshold: number;
  trainedAt: string;
  written: boolean;
  pipelineHoldoutAccuracy: number | null;
  model: SpeakerModel;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error("Speaker job was cancelled"), { code: "job_cancelled" });
}

function runEvaluation(pipelines: SpeakerPipelineInput[], generatedAt?: string, signal?: AbortSignal): SpeakerEvalReport {
  const sceneResults = [];
  const matchedByScene = [];
  const nEvals: SceneNEvalInput[] = [];
  for (const pipeline of pipelines) {
    if (signal) assertNotAborted(signal);
    const overrides = Array.isArray(pipeline.scene.raw.speakerOverrides) ? pipeline.scene.raw.speakerOverrides as Parameters<typeof buildSceneEvalResult>[1] : [];
    if (overrides.length === 0) continue;
    const { attributions, estimatedN } = runSpeakerPipeline({ ...pipeline, ignoreOverrides: true });
    const { result, matched } = buildSceneEvalResult(pipeline.scene.id, overrides, attributions);
    if (result.textHashMatchedCount === 0 && result.textHashMismatchCount === 0) continue;
    sceneResults.push(result);
    matchedByScene.push(matched);
    const rawCount = pipeline.scene.raw.speakerCount;
    if (typeof rawCount === "number" && Number.isFinite(rawCount)) nEvals.push({ goldN: rawCount, estimatedN });
  }
  return buildSpeakerEvalReport(sceneResults, matchedByScene, nEvals, generatedAt);
}

function trainingContext(
  pipeline: SpeakerPipelineInput,
  attributions: ReturnType<typeof runSpeakerPipeline>["attributions"],
  overrides: Parameters<typeof matchGoldToPredictions>[0],
  corrections: SpeakerCorrectionRecord[],
  reasonPrecision: Record<string, number>,
): SpeakerRerankContext {
  const declared = pipeline.scene.raw.appears;
  let candidateIds: string[];
  if (Array.isArray(declared) && declared.every((id) => typeof id === "string") && declared.length > 0) {
    candidateIds = [...new Set(declared as string[])];
  } else {
    const ids = new Set<string>();
    for (const attribution of attributions) if (attribution.speakerEntityId) ids.add(attribution.speakerEntityId);
    for (const override of overrides) if (override.speakerEntityId) ids.add(override.speakerEntityId);
    for (const correction of corrections) {
      if (correction.sceneId !== pipeline.scene.id) continue;
      if (correction.predictedSpeakerEntityId) ids.add(correction.predictedSpeakerEntityId);
      if (correction.speakerEntityId) ids.add(correction.speakerEntityId);
    }
    candidateIds = [...ids];
  }
  return {
    candidateIds,
    ...(typeof pipeline.scene.raw.pov === "string" ? { povEntityId: pipeline.scene.raw.pov } : {}),
    reasonPrecision,
  };
}

function trainWithScoredHoldout(input: Extract<SpeakerWorkerInput, { kind: "train" }>, signal: AbortSignal): SpeakerTrainingResult {
  const trainExamples: SpeakerRerankExample[] = [];
  const holdoutPairsWithout: Array<{ gold: string | null; predicted: string | null }> = [];
  const preparedHoldout: Array<{ pipeline: SpeakerPipelineInput; attributions: ReturnType<typeof runSpeakerPipeline>["attributions"]; rows: Array<{ gold: string | null; attr: ReturnType<typeof runSpeakerPipeline>["attributions"][number]; context: SpeakerRerankContext }> }> = [];
  for (const pipeline of input.trainPipelines) {
    assertNotAborted(signal);
    const { attributions } = runSpeakerPipeline({ ...pipeline, ignoreOverrides: true, skipReranker: true });
    const overrides = Array.isArray(pipeline.scene.raw.speakerOverrides) ? pipeline.scene.raw.speakerOverrides as Parameters<typeof matchGoldToPredictions>[0] : [];
    trainExamples.push(...buildSpeakerRerankExamples({
      attributions,
      overrides,
      corrections: input.corrections,
      context: trainingContext(pipeline, attributions, overrides, input.corrections, input.reasonPrecision),
      sceneId: pipeline.scene.id,
    }));
  }
  if (trainExamples.length < 10) throw Object.assign(new Error(`too few training examples: ${trainExamples.length}; at least 10 are required`), { code: "insufficient_training_examples" });
  for (const pipeline of input.holdoutPipelines) {
    assertNotAborted(signal);
    const { attributions } = runSpeakerPipeline({ ...pipeline, ignoreOverrides: true, skipReranker: true });
    const overrides = Array.isArray(pipeline.scene.raw.speakerOverrides) ? pipeline.scene.raw.speakerOverrides as Parameters<typeof matchGoldToPredictions>[0] : [];
    const { matched } = matchGoldToPredictions(overrides, attributions);
    holdoutPairsWithout.push(...matched.map(({ gold, predicted }) => ({ gold, predicted })));
    const context = trainingContext(pipeline, attributions, overrides, input.corrections, input.reasonPrecision);
    const rows: typeof preparedHoldout[number]["rows"] = [];
    for (const override of overrides) {
      let attr = override.sentenceIndex !== undefined && override.textHash !== undefined
        ? attributions.find((row) => row.sentenceIndex === override.sentenceIndex)
        : attributions.find((row) => row.text === override.dialogueText);
      if (attr && override.textHash !== undefined && hashDialogueText(attr.text) !== override.textHash) attr = undefined;
      if (attr) rows.push({ gold: override.speakerEntityId, attr, context });
    }
    preparedHoldout.push({ pipeline, attributions, rows });
  }
  if (holdoutPairsWithout.length === 0) throw Object.assign(new Error("No matched holdout corrections are available"), { code: "empty_holdout" });

  const trained = trainSpeakerRerankModel(trainExamples, { epochs: 50, learningRate: 0.08 });
  const scored: Array<{ gold: string | null; predicted: string | null; probability: number }> = [];
  for (const { attributions, rows } of preparedHoldout) {
    for (const { gold, attr: oldAttr, context } of rows) {
      const attr = attributions.find((row) => row.sentenceIndex === oldAttr.sentenceIndex);
      if (!attr) continue;
      let bestId: string | null = attr.speakerEntityId;
      let bestP = -1;
      for (const candidateId of [...context.candidateIds, null]) {
        const p = scoreSpeakerRerank(extractSpeakerRerankFeatures(attr, candidateId, attributions, context), trained);
        if (p > bestP) { bestP = p; bestId = candidateId; }
      }
      scored.push({ gold, predicted: bestId, probability: bestP });
    }
  }
  const highThreshold = calibrateHighProbabilityThreshold(scored);
  const accuracyWithoutModel = attributionAccuracyFromPairs(holdoutPairsWithout);
  const accuracyWithModel = attributionAccuracyFromPairs(scored);
  const delta = accuracyWithModel - accuracyWithoutModel;
  const adopted = delta >= 0.05;
  const trainedAt = new Date().toISOString();
  const model: SpeakerModel = {
    version: 1,
    featureNames: trained.featureNames,
    weights: trained.weights,
    bias: trained.bias,
    highProbabilityThreshold: highThreshold,
    trainedAt,
    holdoutSceneIds: input.holdoutPipelines.map((pipeline) => pipeline.scene.id),
    metrics: { holdoutAccuracyWithoutModel: accuracyWithoutModel, holdoutAccuracyWithModel: accuracyWithModel, adopted },
  };
  let pipelineCorrect = 0;
  let pipelineTotal = 0;
  for (const { pipeline } of preparedHoldout) {
    assertNotAborted(signal);
    const { attributions } = runSpeakerPipeline({ ...pipeline, ignoreOverrides: true, model });
    const overrides = Array.isArray(pipeline.scene.raw.speakerOverrides) ? pipeline.scene.raw.speakerOverrides as Parameters<typeof buildSceneEvalResult>[1] : [];
    const { matched } = buildSceneEvalResult(pipeline.scene.id, overrides, attributions);
    for (const row of matched) { pipelineTotal++; if (row.gold === row.predicted) pipelineCorrect++; }
  }
  return {
    trainExampleCount: trainExamples.length,
    holdoutSceneIds: model.holdoutSceneIds ?? [],
    accuracyWithoutModel,
    accuracyWithModel,
    deltaPt: delta * 100,
    adopted,
    highProbabilityThreshold: highThreshold,
    trainedAt,
    written: false,
    pipelineHoldoutAccuracy: pipelineTotal > 0 ? pipelineCorrect / pipelineTotal : null,
    model,
  };
}

installWorkerHandler<SpeakerWorkerInput, unknown>(async (request: JobRequest<SpeakerWorkerInput>, signal) => {
  if (request.module !== "speaker" || request.model !== SPEAKER_ENGINE_ID || request.modelVersion !== SPEAKER_ENGINE_VERSION || request.moduleVersion !== SPEAKER_MODULE_VERSION) {
    throw Object.assign(new Error("Unsupported speaker worker request identity"), { code: "unsupported_speaker_task" });
  }
  assertNotAborted(signal);
  if (request.task === "speaker.attribute" && request.input.kind === "attribute") return runSpeakerPipeline(request.input.pipeline);
  if (request.task === "speaker.evaluate" && request.input.kind === "evaluate") return runEvaluation(request.input.pipelines, request.input.generatedAt, signal);
  if (request.task === "speaker.train" && request.input.kind === "train") return trainWithScoredHoldout(request.input, signal);
  throw Object.assign(new Error(`Unsupported speaker task: ${request.task}`), { code: "unsupported_speaker_task" });
});
