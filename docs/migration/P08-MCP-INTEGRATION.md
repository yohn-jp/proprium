# P08 production MCP acceptance

This acceptance test exercises the shipped MCP transports against the production API, module runtime, and CoreStore. It creates a temporary bare Git repository containing only synthetic story files, registers it through the owner API, and starts the compiled MCP CLI as a real child process alongside a real Streamable HTTP MCP client. No external repository, model service, or private project content is used.

Run it after building the workspace:

```sh
pnpm install --frozen-lockfile
pnpm build
node --test tests/integration/mcp-acceptance.test.mjs
```

The default composition enables `story`, `nlp`, `diagnostics`, `semantic`, `speaker`, `publishing`, and `mcp`. Both transports must discover all 27 source MCP tools. The test checks real project and action discovery, status/history, entity and scene reads, bounded writing context and its text-free manifest, manuscript analysis, consistency/continuity diagnostics, hybrid semantic search, speaker dialogue and voice/style checks, and a read-only plaintext export. The fixture has no semantic vector index, so search verifies the producer's lexical scene result and its missing-index fallback. Speaker checks run through the real runtime and worker against attributed synthetic dialogue.

The test also cancels real in-flight NLP work over both stdio and HTTP and waits for the worker job to drain. It submits a two-operation NarrativeChangeSet, confirms that neither proposal submission nor bearer attempts to approve, checkpoint, or publish changed the remote, then has an owner approve and checkpoint only the first operation. It publishes that accepted operation through the owner API and inspects the bare Git history to ensure the unapproved operation payload never appeared there.

After publication, the test reconstructs the same registered Core project from its remote into a fresh Core data directory, without copying the private proposal journal. MCP must return `PROPOSAL_PAYLOAD_UNAVAILABLE` with the safe proposal digest, operation identities, and actual review/checkpoint/publication IDs rather than fabricating a complete source ChangeSet. The browser-private record retains the original full Core proposal. The test restores that exact proposal through the owner proposals API, then verifies MCP resumes the source-level partial status without duplicating the already accepted Core operation or its checkpoint.

The assistant-backed `suggest_rewrite` and `format_manuscript` tools, and the fully composed `get_diagnostics` tool, still return typed unavailable results until their exact source-equivalent host actions are published. A later composition can be selected with `SCRIPTORIUM_MCP_ACCEPTANCE_MODULES`, for example:

```sh
SCRIPTORIUM_MCP_ACCEPTANCE_MODULES=story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp \
  node --test tests/integration/mcp-acceptance.test.mjs
```

Each selected module must have a compiled package manifest and server entry. The default verifies the real semantic and speaker producers; adding `assistant` to the selected modules does not make assistant tools available until their source adapter is implemented.
