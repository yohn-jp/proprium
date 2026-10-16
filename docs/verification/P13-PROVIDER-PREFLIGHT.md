# P13 local provider preflight

Recorded 2026-10-17 JST. This validates whether the existing OpenAI-compatible source adapter can use a disposable CPU model endpoint. It does not certify P11 flows, application output quality, model semantics, or the final image.

## Source contract inspected

The read-only source snapshot was `edc033c2c9466274a334299dadfa426661d957d9`. Its `packages/core/src/nlp/llm/llmProviderFactory.ts` selects the existing OpenAI-compatible adapter from `ARCADIA_LLM_PROVIDER`; the adapter reads `ARCADIA_LLM_BASE_URL` and `ARCADIA_LLM_MODEL`, and requires `ARCADIA_LLM_API_KEY` or the Cloudflare auth configuration. `resolveFeatureModel.ts` resolves the environment model ID. `packages/api/src/routes/llmHealth.ts` reads the same environment and its `GET /api/llm/health` implementation sends a one-token `POST` to `${ARCADIA_LLM_BASE_URL}/chat/completions`; the base URL therefore includes `/v1`.

The preflight exercised `createLlmProvider()` from the source Core build with `ARCADIA_LLM_PROVIDER=openai-compatible`, rather than calling a substitute SDK. API health route execution is **NOT_CHECKED**.

## Candidate and host

| Item | Observed value |
| --- | --- |
| Model repository | [Qwen/Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF) |
| Pinned repository revision | `1208e45d782fe18602c5eaf10e5758d5b0f24c03` |
| Artifact | `Qwen3-0.6B-Q4_K_M.gguf`, 396,704,416 bytes |
| Artifact SHA-256 | `b0638f08417a2d3c8652760462eb5407c6e30173cf9608ad0820757a281eea0e` |
| License | Apache-2.0, confirmed in the pinned repository metadata and its [LICENSE file](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/blob/1208e45d782fe18602c5eaf10e5758d5b0f24c03/LICENSE) |
| Model cache | `/tmp/Qwen3-0.6B-Q4_K_M.gguf` (outside the repository) |
| Host | NixOS `26.05.10304.6d663c0533ff`, Linux `6.18.52`, x86_64, 16 CPUs |
| Host resources at run | 47 GiB RAM total, about 38 GiB available; 15 GiB free on `/tmp` filesystem |
| Server | `llama.cpp` `llama-server` 0.6.0, build 11429, commit `d812350`; Nix package from nixpkgs revision `95b2dd0e78e6642fa7fd8fe5bb673daf4cebb924` |

The artifact was fetched directly from the pinned official repository revision and its local SHA-256 matched the repository LFS SHA-256. No model files were added to this worktree.

## Result

The endpoint is bound to loopback at `http://127.0.0.1:18088/v1`; `/health` returned HTTP 200. With the source provider selector and model/base URL set to that endpoint, `createLlmProvider().complete()` returned nonempty Japanese text for a synthetic, bounded request about a red umbrella and a bakery after rain. Calls used at most 48 output tokens. The local llama-server process is PID `1889773`; a post-request RSS sample was `918712` KiB.

The first attempt with llama.cpp's default reasoning parser returned no text to the source adapter, which correctly raised its empty-completion error. Starting the same server with reasoning disabled allowed the adapter to return text. The resulting content included empty `<think>` delimiters before Japanese text. This is an observed serving-format detail for later P11 flow checks; no model reasoning trace or output transcript is retained here.

## Reproduction

The server was launched with the Nix `llama-cpp` package. The registry resolved to the nixpkgs revision above; use that revision explicitly for a repeat run:

```sh
nix shell 'github:NixOS/nixpkgs/95b2dd0e78e6642fa7fd8fe5bb673daf4cebb924#llama-cpp' \
  --command llama-server \
  --model /tmp/Qwen3-0.6B-Q4_K_M.gguf \
  --host 127.0.0.1 --port 18088 \
  --ctx-size 2048 --threads 4 --n-gpu-layers 0 \
  --alias Qwen3-0.6B-Q4_K_M \
  --reasoning off --reasoning-format none --reasoning-budget 0
```

For the source adapter, build the exact source snapshot with its pinned workspace dependencies, then run a synthetic request. The placeholder API key is local test input only; llama.cpp does not require upstream credentials. Do not use a real provider key.

```sh
corepack pnpm install --frozen-lockfile --filter @yohn-jp/arcadia-loom-core...
corepack pnpm --filter @yohn-jp/arcadia-loom-core... build

ARCADIA_LLM_PROVIDER=openai-compatible \
ARCADIA_LLM_BASE_URL=http://127.0.0.1:18088/v1 \
ARCADIA_LLM_MODEL=Qwen3-0.6B-Q4_K_M \
ARCADIA_LLM_API_KEY=local-only-placeholder \
node --input-type=module -e '
  import { createLlmProvider } from "./packages/core/dist/nlp/llm/llmProviderFactory.js";
  const provider = createLlmProvider();
  const text = await provider.complete(
    "日本語で、雨上がりの駅前を舞台にした短い一文（40字以内）を創作してください。設定は赤い傘とパン屋です。",
    { maxTokens: 48, abortSignal: AbortSignal.timeout(120000), sampling: { temperature: 0.2 } },
  );
  if (!text.trim()) throw new Error("empty completion");
  console.log("local source-provider completion received");
'
```

`corepack pnpm` resolved the source's declared pnpm `11.16.0`. The source snapshot was archived into `/tmp/arcadia-provider-preflight` for this run; the Arcadia source checkout remained unchanged. The endpoint was kept alive on the verification host for a later P11 reference-flow run. Stop it with Ctrl-C in its server session when that run is complete.
