export {
  computeDialogueMetrics,
  computeDialogueMetricsFromText,
} from "./stylometry/metrics.js";
export {
  computeStyleDistance,
  DEVIATION_DISTANCE_THRESHOLD,
  MIN_DIALOGUE_FOR_DEVIATION_CHECK,
} from "./stylometry/deviationDetector.js";
export type { StylometricMetrics, StylometricProfile } from "./stylometry/types.js";
