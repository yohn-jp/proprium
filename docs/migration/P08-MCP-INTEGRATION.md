# P08 production MCP acceptance

This acceptance test runs the shipped MCP transports against the production API, module runtime, and CoreStore. It creates a temporary bare Git repository containing synthetic story files, registers it through the owner API, and starts the compiled MCP CLI as a child process alongside a real Streamable HTTP MCP client. No external repository or private project content is used.

Run it after building the workspace:

```sh
pnpm install --frozen-lockfile
pnpm build
node --test tests/integration/mcp-acceptance.test.mjs
```

The default composition enables `story`, `nlp`, `diagnostics`, `semantic`, `speaker`, `publishing`, and `mcp`; it uses local workers and does not require a model provider. Both transports discover all 27 pinned source tool names. The test exercises project/action discovery, status/history, entity and saved-scene reads, bounded writing context and its text-free manifest, manuscript analysis, consistency/continuity checks, semantic search with the real lexical fallback when no vector index exists, speaker dialogue and voice/style checks, and plaintext export.

When Diagnostics and Speaker are enabled, `get_diagnostics` invokes the canonical `diagnostics.scene` aggregate and returns the source full-tier DTO: text hash, analysis, speaker attribution and clustering, voice/style/plot results, prose balance, synonym suggestions, and normalized issues. The acceptance compares its analysis with `analyze_manuscript`, checks issue identities and fields, and compares HTTP/stdio results at the same Core snapshot. If the full speaker composition is absent, the tool returns a typed component-unavailable error instead of a partial DTO.

`format_manuscript` uses the local source-compatible formatter. It returns a stable source `NarrativeChangeSet` without registering a Core proposal or changing the repository. The test submits that exact object through `submit_change_set`, replays and reads it back, then has the owner approve and checkpoint it. Publication applies the reviewed formatter operation; later formatting calls return a stable no-op with no proposal. These steps run over both real MCP transports and use the real Story/Core proposal path.

The test also cancels real in-flight NLP work over stdio and HTTP and waits for worker jobs to drain. It submits a two-operation NarrativeChangeSet, confirms the remote is unchanged before owner review, and proves a bearer cannot approve, checkpoint, or publish. The owner accepts and checkpoints one operation, then publishes only that operation. The unapproved operation body is absent from reachable Git history.

After publication, the test reconstructs the same Core project from the remote into a fresh data directory without the private proposal journal. MCP returns `PROPOSAL_PAYLOAD_UNAVAILABLE` with the safe digest, ordered operation identities, and actual review/checkpoint/publication IDs instead of synthesizing the original source record. The test restores the exact original Core proposal from a retained private browser record through the owner API, then verifies source-level partial status resumes without duplicating the accepted operation or checkpoint.

The Assistant-backed `suggest_rewrite` tool remains unavailable until its source-equivalent action is published. When the Assistant module is enabled without that action, it returns a typed action-unavailable result. `reload` also remains unavailable pending a source-equivalent derived-refresh action. Both remain registered among the 27 source tools. The local formatter and full Diagnostics aggregate are available without an external model provider.

The module set can be changed for composition checks, for example:

```sh
SCRIPTORIUM_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
  node --test tests/integration/mcp-acceptance.test.mjs
```

Each selected module must have a compiled package manifest and server entry. The acceptance uses synthetic story content and local worker implementations only; it does not certify external model quality or downloaded model behavior.
