# Integration verification

Build the Full workspace before integration tests. Run acceptance only against disposable synthetic data. Model caches, credentials and generated artifacts belong outside the checkout.

```sh
pnpm install --frozen-lockfile
SCRIPTORIUM_PROFILE=full pnpm build
```

## MCP and approved mutation

```sh
SCRIPTORIUM_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
  node --test tests/integration/mcp-acceptance.test.mjs
```

This runs the production stdio and SDK Streamable HTTP transports with Core and optional modules. It checks project isolation, cancellation, proposal replay, partial approval, checkpoint/publication and reconstruction. MCP may propose changes but cannot grant itself approval, checkpoint or publication authority. Provider-free checks must remain usable without external transmission.

## Import and derived-state reconstruction

```sh
node --test modules/diagnostics/tests/production.acceptance.mjs
node --test tests/integration/migration-acceptance.test.mjs
```

These checks exercise derived-state reconstruction and legacy import through Core approval and publication. Verify idempotence, authoritative corrections/settings, retained provisional records, source immutability and recovery after replacing the Core root. A local fixture round trip does not establish real GitHub credential or hosted lifecycle behavior.

## CPU model lifecycle

Provide a model cache containing the artifacts required by the acceptance sources. The tests bind model repository/revision identities; arbitrary replacement weights do not satisfy those checks. Cache preparation may require downloading public models and tokenizer artifacts. Review their licenses and reserve appropriate disk and memory capacity.

```sh
SCRIPTORIUM_P13_MODEL_CACHE=/path/to/model-cache \
  node --test tests/integration/model-lifecycle.acceptance.mjs

OCI_ENGINE=podman SCRIPTORIUM_P13_MODEL_CACHE=/path/to/model-cache \
  node --test tests/integration/model-oci-lifecycle.acceptance.mjs
```

The OCI test builds the Full production image, mounts the model cache read-only and exercises inference without network access. It checks shared model leases, cancellation, disable/release, index rebuild, launcher replacement, health and preserved author state. Confirm actual worker/process release; dropping a JavaScript reference alone does not establish native memory release. Model absence or an unsupported host is an unavailable check, not successful inference.

## Local provider reference

The provider reference accepts a loopback OpenAI-compatible endpoint serving `Qwen3-0.6B-Q4_K_M`. Prepare the model outside the repository and start a compatible `llama-server` with reasoning disabled:

```sh
llama-server --model /path/to/Qwen3-0.6B-Q4_K_M.gguf \
  --host 127.0.0.1 --port 18088 --ctx-size 2048 --threads 4 \
  --n-gpu-layers 0 --alias Qwen3-0.6B-Q4_K_M \
  --reasoning off --reasoning-format none --reasoning-budget 0
```

Then run the production Assistant/MCP reference against synthetic inputs:

```sh
SCRIPTORIUM_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
SCRIPTORIUM_MCP_ACCEPTANCE_REWRITE_PROVIDER=qwen-local \
SCRIPTORIUM_ASSISTANT_REFERENCE_PROVIDER=qwen-local \
ARCADIA_LLM_PROVIDER=openai-compatible \
ARCADIA_LLM_BASE_URL=http://127.0.0.1:18088/v1 \
ARCADIA_LLM_MODEL=Qwen3-0.6B-Q4_K_M \
ARCADIA_LLM_API_KEY=local-only-placeholder \
node --test tests/integration/mcp-acceptance.test.mjs
```

The placeholder is for the local fixture endpoint. The checks exercise streaming, cancellation, durable usage, context preview, author-selected proposals and publication/reconstruction. They do not certify model output quality. Stop the provider process after the run.

## GitHub and container replacement

```sh
SCRIPTORIUM_E2E_REPOSITORY_URL=https://github.com/<owner>/<synthetic-fixture>.git \
SCRIPTORIUM_GITHUB_TOKEN='<fixture-scoped-token>' \
  node tests/e2e/container-recovery.acceptance.mjs
```

Use a dedicated private repository with Actions disabled and only synthetic seed files. The runner validates the fixture, publishes synthetic operations and creates/replaces disposable containers and data volumes. It exercises browser restart, checkpoint replay after complete server-root replacement, remote updates, conflict preservation and operation deduplication. Keep the recovery browser on the same origin. `OCI_ENGINE` selects the local engine and `SCRIPTORIUM_E2E_CHROMIUM` may select a system browser.

Only the exact tested source/artifact and executed assertions are certified. Keep private fixture URLs, tokens, manuscript content and raw recovery records out of public reports.
