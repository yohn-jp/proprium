# Proprium — Authoring Plugin Canon

**Status: normative recovery target, NOT an assertion that plugins already ship.** Proprium remains a general-purpose, browser-native Git editor. Novel writing, Story Knowledge and adjacent narrative workflows are first-class **official plugins**, not mandatory Git Core schemas. The loss being repaired is the missing packaged and reachable product capabilities, not the generic Git core.

## Authority

1. Explicit owner instructions and confirmed product decisions.
2. This index, [Recovery Architecture](ARCHITECTURE.md), [Host/Plugin Contract](HOST-PLUGIN-CONTRACT.md) and [Acceptance & Execution](ACCEPTANCE.md) for recovery and plugin composition.
3. Individual plugin canons under [plugins/](plugins/README.md) for feature behavior, data semantics, UI, dependencies, errors, and completion criteria.
4. Proprium's existing generic [Git/storage](../architecture/GIT-AND-STORAGE.md), [WASM ABI](../architecture/WASM-PLUGIN-ABI.md), [plugin distribution](../architecture/PLUGIN-DISTRIBUTION.md) and [Gateway/MCP](../architecture/MCP-GATEWAY.md) for platform boundaries **unless this canon explicitly identifies a missing target contract**.
5. [Scriptorium source](https://github.com/yohn-jp/scriptorium) for recovered working behavior and data meaning, then [Arcadia Loom source](https://github.com/yohn-jp/arcadia-loom) for functions absent, reduced, or not carried through Scriptorium.

No archived implementation or historical roadmap overrides today's generic-Core + independently shipped plugins decision. Do not infer that inherited code is running. Existing documentation describing a deliberate deferral of Story Knowledge is superseded for this recovery. Do not remove generic Git editing, direct file access, or zero-plugin cold start.

## Canon set

| Document | Single responsibility |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Boundaries, invariant data model, plugin partition, dependency DAG, writer and execution model |
| [Host/Plugin Contract](HOST-PLUGIN-CONTRACT.md) | Required versioned WIT/broker/UI/navigation/read/proposal extensions; actual v1 limitations |
| [Recovery Inventory](RECOVERY-INVENTORY.md) | Source-to-feature ledger, Scriptorium coverage, Loom gap backfill, no-loss policy |
| [Acceptance & Execution](ACCEPTANCE.md) | Definition of done, real author workflows, implementation order, parallel ownership, CI and releases |
| [Plugin specifications](plugins/README.md) | One canonical feature contract per independently deployable product plugin |

Every plugin document MUST name an immutable ID, scope and non-goals, source anchors, actions/read models, UI, data ownership, Host capabilities, dependencies, recovery strategy, errors and an executable acceptance gate. If a feature is missing, record it as a gap; do not erase it, substitute a placeholder or claim it was never in the product.

## Release boundary

No recovered capability is complete just because a module exists in `modules/`, a demo plugin runs, a TypeScript build passes, or a Go Gateway test is green. Completion requires a signed independently built artifact, Host admission, rendered author-oriented UI, typed actions with real data, desktop/mobile interaction, persisted/reloaded workspace, and reviewed mutation semantics. The [inventory](RECOVERY-INVENTORY.md) is the loss-prevention checklist and [acceptance contract](ACCEPTANCE.md) is the certification authority.

**Source references are pinned for reproducibility of this design review, not runtime dependencies:**

- Proprium `main@3f82b5e7b555a609cf5594aa0a55f45cd101278a`
- Scriptorium `main@1a05a0f10b33acca3fcfc544a5a6a2592f1c3865`
- Arcadia Loom `main@edc033c2c9466274a334299dadfa426661d957d9`

The architecture has no calendar-based expiry; actual test/run evidence and source revision stay in build artifacts or PRs, not retroactively marked PASS here.
