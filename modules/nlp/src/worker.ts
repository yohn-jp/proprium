import { isAbsolute } from "node:path";
import { installWorkerHandler } from "@scriptorium/module-runtime";
import { analyze } from "./analyze/index.js";
import {
  NLP_APPROX_TOKEN_COUNTER_VERSION,
  NLP_MODEL_ID,
  NLP_MODEL_VERSION,
  NLP_TOKENIZER_ENGINE_VERSION,
  NLP_MODULE_VERSION,
  type NlpTokenCountBatch,
  type NlpTokenCounterIdentity,
} from "./contracts.js";
import { isSafeHuggingFaceModelId, sourceApproxTokenCount, validateTokenCountTexts } from "./tokenCount.js";
import type { MorphologyAnalysis } from "./tokenizer/types.js";

interface TokenCounterWorkerInput {
  texts: string[];
  backend: "auto" | "approx";
  modelId?: string;
  modelsDir: string;
  fallbackReason?: "backend_approx" | "model_unconfigured" | "tokenizer_unavailable";
}

interface LoadedCounter {
  identity: NlpTokenCounterIdentity;
  count(text: string): number;
}

const counters = new Map<string, Promise<LoadedCounter>>();

function cancelled(): Error {
  return Object.assign(new Error("NLP token-count job was cancelled"), { code: "job_cancelled" });
}

function approximateCounter(modelId: string | undefined, reason: NonNullable<TokenCounterWorkerInput["fallbackReason"]>): LoadedCounter {
  return {
    identity: {
      modelId: "approx",
      exact: false,
      engine: "source-approx",
      engineVersion: NLP_APPROX_TOKEN_COUNTER_VERSION,
      ...(modelId ? { requestedModelId: modelId } : {}),
      fallbackReason: reason,
    },
    count: sourceApproxTokenCount,
  };
}

async function loadCounter(input: TokenCounterWorkerInput): Promise<LoadedCounter> {
  const modelId = input.modelId;
  if (input.fallbackReason) return approximateCounter(modelId, input.fallbackReason);
  if (input.backend === "approx") return approximateCounter(modelId, "backend_approx");
  if (!modelId) return approximateCounter(undefined, "model_unconfigured");
  if (!isSafeHuggingFaceModelId(modelId) || !isAbsolute(input.modelsDir) || input.modelsDir.length > 4096) {
    return approximateCounter(modelId, "tokenizer_unavailable");
  }

  const key = `${input.modelsDir}\u0000${modelId}`;
  let cached = counters.get(key);
  if (!cached) {
    cached = (async () => {
      try {
        // Transformers is imported only in this supervised child. The tokenizer
        // reads only the already-cached artifact; prompts and model files are
        // never sent to a remote endpoint.
        const transformers = await import("@huggingface/transformers");
        transformers.env.cacheDir = input.modelsDir;
        transformers.env.allowLocalModels = true;
        transformers.env.allowRemoteModels = false;
        const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelId, { local_files_only: true });
        return {
          identity: {
            modelId,
            exact: true,
            engine: "huggingface-transformers",
            engineVersion: NLP_TOKENIZER_ENGINE_VERSION,
          },
          count: (text: string) => tokenizer.encode(text).length,
        } satisfies LoadedCounter;
      } catch {
        // The source caches a failed tokenizer lookup and proceeds with its
        // conservative CJK/three-character counter. Do the same without
        // exposing an OS path or loader detail in action output.
        return approximateCounter(modelId, "tokenizer_unavailable");
      }
    })();
    counters.set(key, cached);
  }
  return cached;
}

async function tokenCount(request: {
  input: TokenCounterWorkerInput;
  snapshot: NlpTokenCountBatch["snapshot"];
}, signal: AbortSignal): Promise<NlpTokenCountBatch> {
  if (signal.aborted) throw cancelled();
  const input = request.input;
  if (!input || (input.backend !== "auto" && input.backend !== "approx") || !isAbsolute(input.modelsDir)) {
    throw Object.assign(new Error("NLP token-count configuration is invalid"), { code: "invalid_nlp_input" });
  }
  const texts = validateTokenCountTexts(input.texts);
  if (input.modelId !== undefined && (typeof input.modelId !== "string" || input.modelId.length > 128)) {
    throw Object.assign(new Error("NLP tokenizer model id is invalid"), { code: "invalid_nlp_input" });
  }
  if (input.fallbackReason !== undefined && !["backend_approx", "model_unconfigured", "tokenizer_unavailable"].includes(input.fallbackReason)) {
    throw Object.assign(new Error("NLP token-count fallback mode is invalid"), { code: "invalid_nlp_input" });
  }
  const counter = await loadCounter(input);
  if (signal.aborted) throw cancelled();
  const counts: number[] = [];
  for (const text of texts) {
    if (signal.aborted) throw cancelled();
    counts.push(counter.count(text));
  }
  if (signal.aborted) throw cancelled();
  return { snapshot: request.snapshot, counts, counter: counter.identity };
}

installWorkerHandler<unknown, unknown>(async (request, signal) => {
  if (request.task === "nlp.analyze") {
    if (request.model !== NLP_MODEL_ID || request.modelVersion !== NLP_MODEL_VERSION || request.moduleVersion !== NLP_MODULE_VERSION) {
      throw Object.assign(new Error("Unsupported NLP analysis request identity"), { code: "unsupported_nlp_task" });
    }
    if (signal.aborted) throw cancelled();
    const input = request.input as { text?: unknown };
    if (typeof input?.text !== "string") throw Object.assign(new Error("NLP text input must be a string"), { code: "invalid_nlp_input" });
    const result: MorphologyAnalysis = await analyze(input.text);
    if (signal.aborted) throw cancelled();
    return result;
  }
  if (request.task === "nlp.countTokens") {
    if (request.moduleVersion !== NLP_MODULE_VERSION || request.modelVersion.length > 128 || request.model.length > 128) {
      throw Object.assign(new Error("Unsupported NLP token-count request identity"), { code: "unsupported_nlp_task" });
    }
    const input = request.input as TokenCounterWorkerInput;
    return tokenCount({ input, snapshot: request.snapshot }, signal);
  }
  throw Object.assign(new Error("Unsupported NLP worker request"), { code: "unsupported_nlp_task" });
});
