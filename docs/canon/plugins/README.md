# Official Authoring Plugins — Canon Index

Each row is **one independently versioned, signed plugin product**, not a mandatory tab or a Scriptorium module. IDs and their domain ownership are normative. Plugin internals and auxiliary providers may be split into libraries/Workers without creating extra user-facing plugin products. P0/P1/P2 denotes critical-path order, not optional functionality or an ETA.

| Order | Immutable ID | Scope / first user result | Hard dependencies |
| --- | --- | --- | --- |
| P0 | [`proprium.narrative`](NARRATIVE.md) | Work structure, scene selection, continue writing and safe authoring | Generic Host and new typed UI/file capabilities |
| P1a | [`proprium.knowledge`](KNOWLEDGE.md) | Bible, character/entity graph, threads, timeline, world and reader state | Narrative identity and revision model |
| P1b | [`proprium.research`](RESEARCH.md) | Fast lexical search, terminology and lightweight Japanese NLP | Host paged reads; narrative for scene-aware results |
| P1c | [`proprium.paired-writing`](PAIRED-WRITING.md) | MCP context + ChangeSets + partial author approval/return-to-writing | Narrative, Host action/proposal/review bridge |
| P1d | [`proprium.diagnostics`](DIAGNOSTICS.md) | Structural and prose diagnostics with provenance and fix proposals | Narrative; optional knowledge/research enrichments |
| P2a | [`proprium.speaker`](SPEAKER.md) | Dialogue attribution, confirmation queue, voice consistency and evaluation | Narrative + Knowledge; Research/Diagnostics capabilities if available |
| P2b | [`proprium.semantic`](SEMANTIC.md) | Optional embedding similarity, reranking, term clusters and contradiction candidates | Research + optional Knowledge; never basic-search dependency |
| Early text/EPUB, P2 advanced | [`proprium.publishing`](PUBLISHING.md) | EPUB, plain text, vertical print, episode map and safe shared publication | Narrative; service-only features optional |

Install does not mean enable; enable does not mean model execution. A Writer preset can recommend/enable the authoring stack after author consent, but zero-plugin Git still works. Plugin-to-plugin calls are **typed capability uses at pinned revision**; no plugin directly reads another plugin's private storage. If optional dependencies are absent, disable **only** the affected augmentation and truthfully report unavailable.

Every specification uses the same checklist:

1. Product job and scope/non-goals.
2. Canonical data, ownership and source preservation.
3. Public typed actions, read models and proposal effects.
4. Host-rendered UI and Mobile return-to-writing path.
5. Source inventory: Scriptorium first, Loom backfill where needed.
6. Execution dependencies / failure / resource constraints.
7. Plugin-specific, real-data acceptance criteria.

The [Recovery Inventory](../RECOVERY-INVENTORY.md) is mandatory when claiming parity with the previously shipped product. The [Host Contract](../HOST-PLUGIN-CONTRACT.md) is mandatory before declaring a plugin that needs paged reads or interactive UI functional.


The exact required dependency graph and canonical ownership for overlaps are in [Architecture](../ARCHITECTURE.md#partition-and-single-owner-audit). Optional provider outputs are Host-orchestrated values and cannot introduce recursive dispatch. The [machine-readable trace index](../traceability.json) records source action ownership and hard dependencies; `node scripts/verify-authoring-canon.mjs --sources /path/to/source-parent` validates it against pinned sibling repositories and the detailed ledgers. Each plugin feature row has an observable local acceptance reference, indexed in the [recovery ledger](../RECOVERY-INVENTORY.md).
