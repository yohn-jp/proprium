# P08 production MCP acceptance

This acceptance test runs the shipped MCP transports against the production API, module runtime, and CoreStore. It creates a temporary bare Git repository containing synthetic story files, registers it through the owner API, and starts the compiled MCP CLI as a child process alongside a real Streamable HTTP MCP client. No external repository or private project content is used.

Run it after building the workspace:

```sh
pnpm install --frozen-lockfile
SCRIPTORIUM_PROFILE=full pnpm build
node --test tests/integration/mcp-acceptance.test.mjs
```

The default composition enables `story`, `nlp`, `diagnostics`, `semantic`, `speaker`, `publishing`, and `mcp`; it uses local workers and does not require a model provider. Both transports discover all 27 pinned source tool names. The test exercises project/action discovery, status/history, entity and saved-scene reads, bounded writing context and its text-free manifest, manuscript analysis, consistency/continuity checks, semantic search with the real lexical fallback when no vector index exists, speaker dialogue and voice/style checks, and plaintext export. `reload` is also exercised through both transports and must return the exact materialized entity/link counts from the selected Core snapshot.

When Diagnostics and Speaker are enabled, `get_diagnostics` invokes the canonical `diagnostics.scene` aggregate and returns the source full-tier DTO: text hash, analysis, speaker attribution and clustering, voice/style/plot results, prose balance, synonym suggestions, and normalized issues. The acceptance compares its analysis with `analyze_manuscript`, checks issue identities and fields, and compares HTTP/stdio results at the same Core snapshot. If the full speaker composition is absent, the tool returns a typed component-unavailable error instead of a partial DTO.

`format_manuscript` uses the local source-compatible formatter. It returns a stable source `NarrativeChangeSet` without registering a Core proposal or changing the repository. The test submits that exact object through `submit_change_set`, replays and reads it back, then has the owner approve and checkpoint it. Publication applies the reviewed formatter operation; later formatting calls return a stable no-op with no proposal. These steps run over both real MCP transports and use the real Story/Core proposal path.

The test also cancels real in-flight NLP work over stdio and HTTP and waits for worker jobs to drain. It submits a two-operation NarrativeChangeSet, confirms the remote is unchanged before owner review, and proves a bearer cannot approve, checkpoint, or publish. The owner accepts and checkpoints one operation, then publishes only that operation. The unapproved operation body is absent from reachable Git history.

After publication, the test reconstructs the same Core project from the remote into a fresh data directory without the private proposal journal. MCP returns `PROPOSAL_PAYLOAD_UNAVAILABLE` with the safe digest, ordered operation identities, and actual review/checkpoint/publication IDs instead of synthesizing the original source record. The test restores the exact original Core proposal from a retained private browser record through the owner API, then verifies source-level partial status resumes without duplicating the accepted operation or checkpoint.

`assistant.rewrite` is now available in the full composition. `suggest_rewrite` maps the source zero-based index through the pinned `nlp.analyze` sentence spans, verifies their UTF-16 offsets against the saved scene body, and invokes the compute-only rewrite action at that same snapshot. It forwards the action's actual composed prompt, context, three candidates, citations, and provenance; it does not propose, approve, or write. Without the Assistant action, it returns a typed action/module availability error. With the test fixture's explicit external-model consent enabled, an absent provider returns the Assistant's typed provider-unavailable error.

`reload` invokes the read-only `story.snapshot.materialize` action, which re-reads and parses canonical files from the invocation's pinned `SnapshotReader` and returns actual `{entities, links}` counts. The production test verifies both transports return 7 entities and 2 links for the synthetic fixture at the same selected snapshot. Unlike the source, the target has no persistent ProjectStore cache or FTS SQLite projection to invalidate or rebuild; this read does not force a newer upstream observation or claim an index refresh.

The module set can be changed for composition checks, for example:

```sh
SCRIPTORIUM_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
  node --test tests/integration/mcp-acceptance.test.mjs
```

Each selected module must have a compiled package manifest and server entry. The acceptance uses synthetic story content and local worker implementations only; it does not certify external model quality or downloaded model behavior.

The local provider path has a separate opt-in acceptance against the P13-pinned Qwen model and production Assistant action. Start the local llama.cpp endpoint as documented in `docs/verification/P13-PROVIDER-PREFLIGHT.md`, then run:

```sh
SCRIPTORIUM_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
SCRIPTORIUM_MCP_ACCEPTANCE_REWRITE_PROVIDER=qwen-local \
ARCADIA_LLM_PROVIDER=openai-compatible \
ARCADIA_LLM_BASE_URL=http://127.0.0.1:18088/v1 \
ARCADIA_LLM_MODEL=Qwen3-0.6B-Q4_K_M \
ARCADIA_LLM_API_KEY=local-only-placeholder \
node --test tests/integration/mcp-acceptance.test.mjs
```

That mode requires loopback Qwen configuration and explicit synthetic-fixture consent. The full-profile production acceptance passes through both spawned stdio and SDK Streamable HTTP transports using the P13-pinned Qwen3-0.6B-Q4_K_M model. It checks the source response fields and three candidates, including the source index fallback for unsupported strategy labels, and verifies that computation creates no proposal or repository write. The separate provider-NONE run passes independently and returns the real Assistant action's typed provider-unavailable error.
