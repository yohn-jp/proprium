import type { SpeakerCorrectionRecord } from "./algorithms/speakerCorrectionLog.js";
import type { SpeakerModel } from "./algorithms/speakerReranker.js";
import type { SpeakerPipelineInput } from "./algorithms/pipeline.js";

/** Shared speaker worker identity and protocol types. This module is safe to import in the host. */
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
