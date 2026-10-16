import type { JobRequest } from "@scriptorium/contracts";
import { installWorkerHandler } from "@scriptorium/module-runtime";
import { analyzeDiagnostics, analyzePlotSemantics, analyzeStylometricDeviations, analyzeVoiceDeviations, analyzeVoiceProfiles, DIAGNOSTICS_ENGINE_ID, DIAGNOSTICS_ENGINE_VERSION, DIAGNOSTICS_MODULE_VERSION, type DiagnosticsWorkerInput, type PlotSemanticWorkerInput, type StylometricDeviationWorkerInput, type VoiceDeviationWorkerInput, type VoiceWorkerInput } from "./analysis.js";

type DiagnosticsWorkerRequest = DiagnosticsWorkerInput | PlotSemanticWorkerInput | StylometricDeviationWorkerInput | VoiceDeviationWorkerInput | VoiceWorkerInput;

installWorkerHandler<DiagnosticsWorkerRequest, unknown>(async (request: JobRequest<DiagnosticsWorkerRequest>, signal) => {
  if (request.model !== DIAGNOSTICS_ENGINE_ID || request.modelVersion !== DIAGNOSTICS_ENGINE_VERSION || request.moduleVersion !== DIAGNOSTICS_MODULE_VERSION) {
    throw Object.assign(new Error("Unsupported diagnostics worker identity"), { code: "unsupported_diagnostics_version" });
  }
  if (signal.aborted) throw Object.assign(new Error("Diagnostics job was cancelled"), { code: "job_cancelled" });
  let output: unknown;
  if (request.task === "diagnostics.analyze") output = await analyzeDiagnostics(request.input as DiagnosticsWorkerInput);
  else if (request.task === "diagnostics.voiceProfiles") output = analyzeVoiceProfiles(request.input as VoiceWorkerInput);
  else if (request.task === "diagnostics.voiceDeviations") output = analyzeVoiceDeviations(request.input as VoiceDeviationWorkerInput);
  else if (request.task === "diagnostics.stylometricDeviations") output = analyzeStylometricDeviations(request.input as StylometricDeviationWorkerInput);
  else if (request.task === "diagnostics.checkPlotSemantics") output = analyzePlotSemantics(request.input as PlotSemanticWorkerInput);
  else throw Object.assign(new Error("Unsupported diagnostics task"), { code: "unsupported_diagnostics_task" });
  if (signal.aborted) throw Object.assign(new Error("Diagnostics job was cancelled"), { code: "job_cancelled" });
  return output;
});
