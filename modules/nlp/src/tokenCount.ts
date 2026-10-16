import { homedir } from "node:os";
import { join } from "node:path";


export const MAX_TOKEN_COUNT_TEXTS = 128;
export const MAX_TOKEN_COUNT_TEXT_BYTES = 64 * 1024;
export const MAX_TOKEN_COUNT_BATCH_BYTES = 1024 * 1024;

export interface TokenCountConfiguration {
  backend: "auto" | "approx";
  modelId?: string;
  modelsDir: string;
  fallbackReason?: "backend_approx" | "model_unconfigured" | "tokenizer_unavailable";
}

export function isSafeHuggingFaceModelId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return false;
  if (value.includes("\\") || value.startsWith("/") || value.includes(":") || /[\u0000-\u0020\u007F]/u.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= 2 && parts.every((part) => part !== "" && part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part));
}

export function sourceApproxTokenCount(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  const cjkPattern = /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u;
  for (const character of text) {
    if (cjkPattern.test(character)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 3);
}

export function resolveTokenCountConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  options: { modelId?: string; modelsDir?: string } = {},
): TokenCountConfiguration {
  const backend = (environment.ARCADIA_TOKENIZER_BACKEND ?? "").toLowerCase() === "approx" ? "approx" : "auto";
  const modelId = options.modelId?.trim() || environment.ARCADIA_TOKENIZER_MODEL?.trim() || environment.ARCADIA_LLM_MODEL?.trim();
  const modelsDir = options.modelsDir ?? join(homedir(), ".arcadia", "models");
  const safeModelId = isSafeHuggingFaceModelId(modelId) ? modelId : undefined;
  if (backend === "approx") return { backend, ...(safeModelId ? { modelId: safeModelId } : {}), modelsDir, fallbackReason: "backend_approx" };
  if (!modelId) return { backend, modelsDir, fallbackReason: "model_unconfigured" };
  if (!safeModelId) return { backend: "auto", modelsDir, fallbackReason: "tokenizer_unavailable" };
  return { backend, modelId: safeModelId, modelsDir };
}

export function validateTokenCountTexts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOKEN_COUNT_TEXTS) {
    throw new TypeError(`texts must contain between 1 and ${MAX_TOKEN_COUNT_TEXTS} strings`);
  }
  let totalBytes = 0;
  const encoder = new TextEncoder();
  const texts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new TypeError("texts must contain only strings");
    const bytes = encoder.encode(item).byteLength;
    if (bytes > MAX_TOKEN_COUNT_TEXT_BYTES) throw new TypeError(`each text must be at most ${MAX_TOKEN_COUNT_TEXT_BYTES} UTF-8 bytes`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOKEN_COUNT_BATCH_BYTES) throw new TypeError(`texts must total at most ${MAX_TOKEN_COUNT_BATCH_BYTES} UTF-8 bytes`);
    texts.push(item);
  }
  return texts;
}

