import { installWorkerHandler } from "@scriptorium/module-runtime";
import { analyze } from "./analyze/index.js";
import { NLP_MODEL_ID, NLP_MODEL_VERSION } from "./contracts.js";

installWorkerHandler<{ text: string }, Awaited<ReturnType<typeof analyze>>>(async (request, signal) => {
  if (request.model !== NLP_MODEL_ID || request.modelVersion !== NLP_MODEL_VERSION || request.task !== "nlp.analyze") {
    throw Object.assign(new Error("Unsupported NLP worker request"), { code: "unsupported_nlp_task" });
  }
  if (signal.aborted) throw Object.assign(new Error("NLP request was cancelled"), { code: "job_cancelled" });
  const text = request.input.text;
  if (typeof text !== "string") throw Object.assign(new Error("NLP text input must be a string"), { code: "invalid_nlp_input" });
  const result = await analyze(text);
  if (signal.aborted) throw Object.assign(new Error("NLP request was cancelled"), { code: "job_cancelled" });
  return result;
});
