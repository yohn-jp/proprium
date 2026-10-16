import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  resolveAssistantModel,
  streamAssistantModel,
  type AssistantModelPreferences,
} from "./provider.js";

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const noProviderEnv = {
  ARCADIA_LLM_PROVIDER: undefined,
  ARCADIA_LLM_MODEL: undefined,
  ARCADIA_LLM_BASE_URL: undefined,
  ARCADIA_LLM_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  ARCADIA_ANTHROPIC_MODEL_QUALITY: undefined,
  ARCADIA_ANTHROPIC_MODEL: undefined,
  ARCADIA_ANTHROPIC_MODEL_BULK: undefined,
  CF_AIG_TOKEN: undefined,
  CF_AIG_BYOK_ALIAS: undefined,
};

test("provider selection defaults to NONE and does not perform a network request", async () => {
  await withEnv({ ...noProviderEnv, ANTHROPIC_API_KEY: "must-not-auto-select" }, async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch should not run");
    }) as typeof fetch;
    try {
      assert.equal(resolveAssistantModel("rewrite"), undefined);
      await assert.rejects(
        streamAssistantModel({
          featureId: "rewrite",
          prompt: "hello",
          maxOutputTokens: 128,
          onText: () => undefined,
        }),
        /no model provider is configured/,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("source feature presets resolve model purpose and sampling without exposing secrets", async () => {
  await withEnv(
    {
      ...noProviderEnv,
      ARCADIA_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "private-test-key",
    },
    () => {
      const rewrite = resolveAssistantModel("rewrite");
      assert.deepEqual(rewrite, {
        provider: "anthropic",
        model: "deepseek-ai/DeepSeek-V4-Pro",
        purpose: "quality",
        sampling: { temperature: 0.35, topP: 0.8, repetitionPenalty: 1.05 },
      });
      assert.equal(JSON.stringify(rewrite).includes("private-test-key"), false);

      const summary = resolveAssistantModel("scene-summary");
      assert.deepEqual(summary, {
        provider: "anthropic",
        model: "Qwen/Qwen3-4B-Instruct-2507",
        purpose: "bulk",
        sampling: { temperature: 0, topP: 0.1, presencePenalty: 0, frequencyPenalty: 0 },
      });
    },
  );
});

test("project preset settings select a model while provider credentials remain environment-only", async () => {
  await withEnv(
    {
      ...noProviderEnv,
      ARCADIA_LLM_PROVIDER: "openai-compatible",
      ARCADIA_LLM_MODEL: "environment-model",
      ARCADIA_LLM_BASE_URL: "http://127.0.0.1:9999/v1",
      ARCADIA_LLM_API_KEY: undefined,
      CF_AIG_TOKEN: undefined,
    },
    async () => {
      const preferences = {
        defaultPresetId: "project",
        presets: [
          {
            id: "project",
            label: "Project preset",
            model: "project/model",
            sampling: { temperature: 0.25, topP: 0.7 },
          },
        ],
        featurePresetIds: { rewrite: "project" },
        apiKey: "must-not-be-used",
        baseURL: "http://example.invalid/v1",
      } as AssistantModelPreferences;
      const identity = resolveAssistantModel("rewrite", preferences);
      assert.deepEqual(identity, {
        provider: "openai-compatible",
        model: "project/model",
        purpose: "quality",
        sampling: { temperature: 0.25, topP: 0.7 },
      });

      await assert.rejects(
        streamAssistantModel({
          featureId: "rewrite",
          preferences,
          model: identity,
          prompt: "hello",
          maxOutputTokens: 128,
          onText: () => undefined,
        }),
        /ARCADIA_LLM_API_KEY or CF_AIG_TOKEN/,
      );
    },
  );
});

test("OpenAI-compatible SDK streams deltas with environment auth and observes cancellation", async () => {
  await withEnv(
    {
      ...noProviderEnv,
      ARCADIA_LLM_PROVIDER: "openai-compatible",
      ARCADIA_LLM_MODEL: "environment-model",
      ARCADIA_LLM_BASE_URL: undefined,
      ARCADIA_LLM_API_KEY: "env-api-key",
      CF_AIG_TOKEN: "env-gateway-token",
      CF_AIG_BYOK_ALIAS: "env-alias",
    },
    async () => {
      let capturedHeaders: Record<string, string | string[] | undefined> | undefined;
      let capturedBody: Record<string, unknown> | undefined;
      let resolveRequest!: () => void;
      const requestSeen = new Promise<void>((resolve) => {
        resolveRequest = resolve;
      });
      let resolveResponseClosed!: () => void;
      const responseClosed = new Promise<void>((resolve) => {
        resolveResponseClosed = resolve;
      });
      const server = createServer((request, response) => {
        capturedHeaders = request.headers;
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          resolveRequest();
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: 1,
              model: "environment-model",
              choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
            })}\n\n`,
          );
        });
        response.on("close", resolveResponseClosed);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const serverAddress = server.address();
      assert.ok(serverAddress && typeof serverAddress !== "string");
      process.env.ARCADIA_LLM_BASE_URL = `http://127.0.0.1:${serverAddress.port}/v1`;
      const aborter = new AbortController();
      const deltas: string[] = [];
      const environmentPreset: AssistantModelPreferences = {
        defaultPresetId: "env-default",
        presets: [{ id: "env-default", model: "" }],
        featurePresetIds: { rewrite: "env-default" },
      };
      try {
        const streaming = streamAssistantModel({
          featureId: "rewrite",
          preferences: environmentPreset,
          prompt: "Write a short answer.",
          system: "Stay concise.",
          maxOutputTokens: 40_000,
          signal: aborter.signal,
          onText: (delta) => {
            deltas.push(delta);
            aborter.abort(new Error("test client cancelled"));
          },
        });
        await assert.rejects(streaming, /test client cancelled/);
        await requestSeen;
        assert.deepEqual(deltas, ["hello"]);
        assert.equal(capturedHeaders?.authorization, "Bearer env-api-key");
        assert.equal(capturedHeaders?.["cf-aig-authorization"], "Bearer env-gateway-token");
        assert.equal(capturedHeaders?.["cf-aig-byok-alias"], "env-alias");
        assert.ok(capturedBody);
        const body = capturedBody as Record<string, unknown>;
        const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
        assert.equal(maxTokens, 32_768);
        assert.equal(body.model, "environment-model");
        const didClose = await Promise.race([
          responseClosed.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
        ]);
        assert.equal(didClose, true);
      } finally {
        aborter.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
