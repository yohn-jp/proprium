import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TOKEN_COUNT_BATCH_BYTES,
  MAX_TOKEN_COUNT_TEXT_BYTES,
  MAX_TOKEN_COUNT_TEXTS,
  isSafeHuggingFaceModelId,
  resolveTokenCountConfiguration,
  sourceApproxTokenCount,
  validateTokenCountTexts,
} from "./tokenCount.js";

test("source-approved approximation counts CJK code points and conservatively rounds other text", () => {
  assert.equal(sourceApproxTokenCount(""), 0);
  assert.equal(sourceApproxTokenCount("駅で別れ"), 4);
  assert.equal(sourceApproxTokenCount("abcdef"), 2);
  assert.equal(sourceApproxTokenCount("駅abc"), 2);
});

test("model selection follows explicit model, tokenizer environment, then LLM environment", () => {
  const environment = { ARCADIA_TOKENIZER_MODEL: "env/tokenizer", ARCADIA_LLM_MODEL: "env/llm" };
  assert.equal(resolveTokenCountConfiguration(environment, { modelId: " explicit/model " }).modelId, "explicit/model");
  assert.equal(resolveTokenCountConfiguration(environment).modelId, "env/tokenizer");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_LLM_MODEL: "env/llm" }).modelId, "env/llm");
  assert.equal(resolveTokenCountConfiguration({}).fallbackReason, "model_unconfigured");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_TOKENIZER_BACKEND: "approx", ARCADIA_TOKENIZER_MODEL: "env/tokenizer" }).fallbackReason, "backend_approx");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_TOKENIZER_MODEL: "https://secret.example/tokenizer" }).fallbackReason, "tokenizer_unavailable");
  assert.equal(resolveTokenCountConfiguration({ ARCADIA_TOKENIZER_MODEL: "https://secret.example/tokenizer" }).modelId, undefined);
  assert.equal(isSafeHuggingFaceModelId("Xenova/multilingual-e5-small"), true);
  assert.equal(isSafeHuggingFaceModelId("../../outside"), false);
  assert.equal(isSafeHuggingFaceModelId("https://example.test/model"), false);
});

test("token count batches enforce per-text, aggregate byte, and item bounds", () => {
  assert.deepEqual(validateTokenCountTexts(["駅abc", "abcdef"]), ["駅abc", "abcdef"]);
  assert.throws(() => validateTokenCountTexts([]), /between 1 and/);
  assert.throws(() => validateTokenCountTexts(["x".repeat(MAX_TOKEN_COUNT_TEXT_BYTES + 1)]), /UTF-8 bytes/);
  assert.throws(() => validateTokenCountTexts([
    ...Array.from({ length: MAX_TOKEN_COUNT_BATCH_BYTES / MAX_TOKEN_COUNT_TEXT_BYTES }, () => "x".repeat(MAX_TOKEN_COUNT_TEXT_BYTES)),
    "x",
  ]), /total at most/);
  assert.throws(() => validateTokenCountTexts(Array.from({ length: MAX_TOKEN_COUNT_TEXTS + 1 }, () => "x")), /between 1 and/);
});
