# Recovery Inventory — Source, Canon and Acceptance

**Status: normative no-loss ledger.** This indexes decisions and acceptance specifications, not implementation results. Source actions, browser contributions, helpers, data and tests are traced in each linked feature row. Source snapshots are pinned in [the index](README.md); package tests prove only their legacy execution mode. No row becomes implemented because this document or a build exists.

## Classification and ownership

`RECOVERY` identifies actual Scriptorium behavior or narrowly verified Loom UI/API behavior. `DESIGN_TARGET` identifies a new Proprium boundary or a source design that was not implemented. Mixed rows preserve historical intent while explicitly naming the new boundary. Planned persisted character beliefs and the unified Story Lens are not fabricated as shipped. The exact scope/default/error contract in each canon tells implementers what is enabled and what is explicitly unavailable in the declared version. Runtime PASS/FAIL/BLOCKED/NOT_CHECKED belongs in release evidence, separate from these classifications. `FROZEN` records a product lifecycle decision, not implementation status or success; the underlying pre-freeze outcome remains in the evidence ledger.

Scriptorium is primary: actual registered Action, domain implementation, browser contribution and test are all required provenance. Loom is read only for demonstrated missing/reduced/ambiguous operations. Do not copy private manuscripts, credentials, third-party implementations or model weights. Atlas stays excluded.

| Legacy source | Product destination | Partition |
| --- | --- | --- |
| Story | Narrative + Knowledge | Hierarchy/reading continuity versus Bible/semantic facts; one scene/file identity |
| Search + NLP | Research | One lexical/terms/tokenizer workflow; no required embedding model |
| Assistant + Story ChangeSet | Paired Writing — FROZEN | Scoped optional generation and context; owner compilers, one Host review; preserve implementation and author data |
| Diagnostics | Diagnostics; character-style routines in Speaker | One deterministic report/feedback owner; one character-style engine |
| Speaker | Speaker | Attribution/corrections/voice/evaluation are one isolated lifecycle |
| Semantic | Semantic | Heavy optional retrieval; lexical ranking stays Research, dismissals stay Diagnostics |
| Publishing | Publishing | Early local portability and independently conditional sharing |
| MCP | Host + optional Gateway | Fixed eight-tool transport, typed plugin facade; no legacy server or issuer |

## H0 and Host continuity

| Canon | Acceptance | Required observable result |
| --- | --- | --- |
| [H0 profile](HOST-PLUGIN-CONTRACT.md#h0-authoring-profile-v2-fixed-logical-schema) | [H0 scenarios](ACCEPTANCE.md#h0-implementation-scenarios) | Revision-pinned partial reads, discovery/install, typed actions, functioning Host UI/navigation, guarded proposal/review/apply, chunked artifacts and receipts |
| [Host authority](ARCHITECTURE.md#foreground-ux-is-the-product-invariant) | [R01–R06](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) | Original Desktop/Mobile/CodeMirror, IME/undo/reading, draft recovery, local checkpoint and exact confirmed publication; no plugin takes these over |

## Complete feature index

Every row links its single canonical feature contract and explicit observable acceptance cases. Source functions, actual tests (including absent coverage), data schema and UI operations live in that feature contract. Lifecycle labels record product scope, not implementation success. Cross-product handoff rows do not create duplicate owners.

All Paired Writing feature rows `PW-01`–`PW-21`, their plugin gates `accept-pw-01`–`accept-pw-11` and `accept-pw-21`, and the Paired-only Narrative and Diagnostics rows/gates `NAR-10` / `NAR-A10` and `DIA-10` / `DIA-A12` carry lifecycle `FROZEN`. Shared Host, Narrative, Knowledge, Diagnostics, Git, security, distribution and MCP acceptance remains active in its owning rows.

| Feature / Canon | Acceptance |
| --- | --- |
| [NAR-01](plugins/NARRATIVE.md#feature-nar-01) | [NAR-A01](plugins/NARRATIVE.md#accept-nar-a01) |
| [NAR-02](plugins/NARRATIVE.md#feature-nar-02) | [NAR-A02](plugins/NARRATIVE.md#accept-nar-a02) |
| [NAR-03](plugins/NARRATIVE.md#feature-nar-03) | [NAR-A03](plugins/NARRATIVE.md#accept-nar-a03) |
| [NAR-04](plugins/NARRATIVE.md#feature-nar-04) | [NAR-A04](plugins/NARRATIVE.md#accept-nar-a04) |
| [NAR-05](plugins/NARRATIVE.md#feature-nar-05) | [NAR-A05](plugins/NARRATIVE.md#accept-nar-a05) |
| [NAR-06](plugins/NARRATIVE.md#feature-nar-06) | [NAR-A06](plugins/NARRATIVE.md#accept-nar-a06) |
| [NAR-07](plugins/NARRATIVE.md#feature-nar-07) | [NAR-A07](plugins/NARRATIVE.md#accept-nar-a07) |
| [NAR-08](plugins/NARRATIVE.md#feature-nar-08) | [NAR-A08](plugins/NARRATIVE.md#accept-nar-a08) |
| [NAR-09](plugins/NARRATIVE.md#feature-nar-09) | [NAR-A09](plugins/NARRATIVE.md#accept-nar-a09) |
| [NAR-10](plugins/NARRATIVE.md#feature-nar-10) — **FROZEN** | [NAR-A10](plugins/NARRATIVE.md#accept-nar-a10) — **FROZEN** |
| [NAR-11](plugins/NARRATIVE.md#feature-nar-11) | [NAR-A11](plugins/NARRATIVE.md#accept-nar-a11) |
| [NAR-12](plugins/NARRATIVE.md#feature-nar-12) | [NAR-A12](plugins/NARRATIVE.md#accept-nar-a12) |
| [KNO-01](plugins/KNOWLEDGE.md#feature-kno-01) | [KNO-A01](plugins/KNOWLEDGE.md#accept-kno-a01), [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| [KNO-02](plugins/KNOWLEDGE.md#feature-kno-02) | [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| [KNO-03](plugins/KNOWLEDGE.md#feature-kno-03) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| [KNO-04](plugins/KNOWLEDGE.md#feature-kno-04) | [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02), [KNO-A08](plugins/KNOWLEDGE.md#accept-kno-a08) |
| [KNO-05](plugins/KNOWLEDGE.md#feature-kno-05) | [KNO-A08](plugins/KNOWLEDGE.md#accept-kno-a08), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| [KNO-06](plugins/KNOWLEDGE.md#feature-kno-06) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| [KNO-07](plugins/KNOWLEDGE.md#feature-kno-07) | [KNO-A10](plugins/KNOWLEDGE.md#accept-kno-a10), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| [KNO-08](plugins/KNOWLEDGE.md#feature-kno-08) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| [KNO-09](plugins/KNOWLEDGE.md#feature-kno-09) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03) |
| [KNO-10](plugins/KNOWLEDGE.md#feature-kno-10) | [KNO-A04](plugins/KNOWLEDGE.md#accept-kno-a04) |
| [KNO-11](plugins/KNOWLEDGE.md#feature-kno-11) | [KNO-A04](plugins/KNOWLEDGE.md#accept-kno-a04) |
| [KNO-12](plugins/KNOWLEDGE.md#feature-kno-12) | [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| [KNO-13](plugins/KNOWLEDGE.md#feature-kno-13) | [KNO-A05](plugins/KNOWLEDGE.md#accept-kno-a05), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| [KNO-14](plugins/KNOWLEDGE.md#feature-kno-14) | [KNO-A05](plugins/KNOWLEDGE.md#accept-kno-a05), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| [KNO-15](plugins/KNOWLEDGE.md#feature-kno-15) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| [KNO-16](plugins/KNOWLEDGE.md#feature-kno-16) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06) |
| [KNO-17](plugins/KNOWLEDGE.md#feature-kno-17) | [KNO-A07](plugins/KNOWLEDGE.md#accept-kno-a07) |
| [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| [KNO-20](plugins/KNOWLEDGE.md#feature-kno-20) | [KNO-A15](plugins/KNOWLEDGE.md#accept-kno-a15) |
| [KNO-21](plugins/KNOWLEDGE.md#feature-kno-21) | [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12), [KNO-A16](plugins/KNOWLEDGE.md#accept-kno-a16) |
| [KNO-22](plugins/KNOWLEDGE.md#feature-kno-22) | [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09), [KNO-A19](plugins/KNOWLEDGE.md#accept-kno-a19) |
| [KNO-23](plugins/KNOWLEDGE.md#feature-kno-23) | [KNO-A17](plugins/KNOWLEDGE.md#accept-kno-a17) |
| [KNO-24](plugins/KNOWLEDGE.md#feature-kno-24) | [KNO-A18](plugins/KNOWLEDGE.md#accept-kno-a18) |
| [KNO-25](plugins/KNOWLEDGE.md#feature-kno-25) | [KNO-A19](plugins/KNOWLEDGE.md#accept-kno-a19) |
| [RES-001](plugins/RESEARCH.md#feature-res-001) | [RES-A001](plugins/RESEARCH.md#accept-res-a001) |
| [RES-002](plugins/RESEARCH.md#feature-res-002) | [RES-A002](plugins/RESEARCH.md#accept-res-a002) |
| [RES-003](plugins/RESEARCH.md#feature-res-003) | [RES-A003](plugins/RESEARCH.md#accept-res-a003) |
| [RES-004](plugins/RESEARCH.md#feature-res-004) | [RES-A004](plugins/RESEARCH.md#accept-res-a004) |
| [RES-005](plugins/RESEARCH.md#feature-res-005) | [RES-A005](plugins/RESEARCH.md#accept-res-a005) |
| [RES-006](plugins/RESEARCH.md#feature-res-006) | [RES-A006](plugins/RESEARCH.md#accept-res-a006) |
| [RES-007](plugins/RESEARCH.md#feature-res-007) | [RES-A007](plugins/RESEARCH.md#accept-res-a007) |
| [RES-008](plugins/RESEARCH.md#feature-res-008) | [RES-A008](plugins/RESEARCH.md#accept-res-a008) |
| [RES-009](plugins/RESEARCH.md#feature-res-009) | [RES-A009](plugins/RESEARCH.md#accept-res-a009) |
| [RES-010](plugins/RESEARCH.md#feature-res-010) | [RES-A010](plugins/RESEARCH.md#accept-res-a010) |
| [RES-011](plugins/RESEARCH.md#feature-res-011) | [RES-A011](plugins/RESEARCH.md#accept-res-a011) |
| [RES-012](plugins/RESEARCH.md#feature-res-012) | [RES-A012](plugins/RESEARCH.md#accept-res-a012) |
| [RES-013](plugins/RESEARCH.md#feature-res-013) | [RES-A013](plugins/RESEARCH.md#accept-res-a013) |
| [PW-01](plugins/PAIRED-WRITING.md#feature-pw-01) — **FROZEN** | [PW-01](plugins/PAIRED-WRITING.md#accept-pw-01), [PW-11](plugins/PAIRED-WRITING.md#accept-pw-11) — **FROZEN** |
| [PW-02](plugins/PAIRED-WRITING.md#feature-pw-02) — **FROZEN** | [PW-02](plugins/PAIRED-WRITING.md#accept-pw-02) |
| [PW-03](plugins/PAIRED-WRITING.md#feature-pw-03) — **FROZEN** | [PW-03](plugins/PAIRED-WRITING.md#accept-pw-03) |
| [PW-04](plugins/PAIRED-WRITING.md#feature-pw-04) — **FROZEN** | [PW-04](plugins/PAIRED-WRITING.md#accept-pw-04) |
| [PW-05](plugins/PAIRED-WRITING.md#feature-pw-05) — **FROZEN** | [PW-05](plugins/PAIRED-WRITING.md#accept-pw-05) |
| [PW-06](plugins/PAIRED-WRITING.md#feature-pw-06) — **FROZEN** | [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06) |
| [PW-07](plugins/PAIRED-WRITING.md#feature-pw-07) — **FROZEN** | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| [PW-08](plugins/PAIRED-WRITING.md#feature-pw-08) — **FROZEN** | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| [PW-09](plugins/PAIRED-WRITING.md#feature-pw-09) — **FROZEN** | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| [PW-10](plugins/PAIRED-WRITING.md#feature-pw-10) — **FROZEN** | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| [PW-11](plugins/PAIRED-WRITING.md#feature-pw-11) — **FROZEN** | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| [PW-12](plugins/PAIRED-WRITING.md#feature-pw-12) — **FROZEN** | [PW-02](plugins/PAIRED-WRITING.md#accept-pw-02), [PW-03](plugins/PAIRED-WRITING.md#accept-pw-03), [PW-04](plugins/PAIRED-WRITING.md#accept-pw-04), [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06), [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| [PW-13](plugins/PAIRED-WRITING.md#feature-pw-13) — **FROZEN** | [PW-08](plugins/PAIRED-WRITING.md#accept-pw-08) |
| [PW-14](plugins/PAIRED-WRITING.md#feature-pw-14) — **FROZEN** | [PW-09](plugins/PAIRED-WRITING.md#accept-pw-09) |
| [PW-15](plugins/PAIRED-WRITING.md#feature-pw-15) — **FROZEN** | [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10) |
| [PW-16](plugins/PAIRED-WRITING.md#feature-pw-16) — **FROZEN** | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07), [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10) |
| [PW-17](plugins/PAIRED-WRITING.md#feature-pw-17) — **FROZEN** | [PW-01](plugins/PAIRED-WRITING.md#accept-pw-01), [PW-11](plugins/PAIRED-WRITING.md#accept-pw-11) |
| [PW-18](plugins/PAIRED-WRITING.md#feature-pw-18) — **FROZEN** | [PW-02](plugins/PAIRED-WRITING.md#accept-pw-02), [PW-08](plugins/PAIRED-WRITING.md#accept-pw-08) |
| [PW-19](plugins/PAIRED-WRITING.md#feature-pw-19) — **FROZEN** | [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06) |
| [PW-20](plugins/PAIRED-WRITING.md#feature-pw-20) — **FROZEN** | [PW-08](plugins/PAIRED-WRITING.md#accept-pw-08), [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10) |
| [PW-21](plugins/PAIRED-WRITING.md#feature-pw-21) — **FROZEN** | [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10), [PW-21](plugins/PAIRED-WRITING.md#accept-pw-21) |
| [DIA-01](plugins/DIAGNOSTICS.md#feature-dia-01) | [DIA-A1](plugins/DIAGNOSTICS.md#accept-dia-a1), [DIA-A2](plugins/DIAGNOSTICS.md#accept-dia-a2), [DIA-A9](plugins/DIAGNOSTICS.md#accept-dia-a9), [DIA-A14](plugins/DIAGNOSTICS.md#accept-dia-a14), [DIA-A15](plugins/DIAGNOSTICS.md#accept-dia-a15) |
| [DIA-02](plugins/DIAGNOSTICS.md#feature-dia-02) | [DIA-A3](plugins/DIAGNOSTICS.md#accept-dia-a3) |
| [DIA-03](plugins/DIAGNOSTICS.md#feature-dia-03) | [DIA-A4](plugins/DIAGNOSTICS.md#accept-dia-a4) |
| [DIA-04](plugins/DIAGNOSTICS.md#feature-dia-04) | [DIA-A5](plugins/DIAGNOSTICS.md#accept-dia-a5) |
| [DIA-05](plugins/DIAGNOSTICS.md#feature-dia-05) | [DIA-A6](plugins/DIAGNOSTICS.md#accept-dia-a6) |
| [DIA-06](plugins/DIAGNOSTICS.md#feature-dia-06) | [DIA-A2](plugins/DIAGNOSTICS.md#accept-dia-a2), [DIA-A7](plugins/DIAGNOSTICS.md#accept-dia-a7) |
| [DIA-07](plugins/DIAGNOSTICS.md#feature-dia-07) | [DIA-A8](plugins/DIAGNOSTICS.md#accept-dia-a8) |
| [DIA-08](plugins/DIAGNOSTICS.md#feature-dia-08) | [DIA-A9](plugins/DIAGNOSTICS.md#accept-dia-a9) |
| [DIA-09](plugins/DIAGNOSTICS.md#feature-dia-09) | [DIA-A10](plugins/DIAGNOSTICS.md#accept-dia-a10), [DIA-A11](plugins/DIAGNOSTICS.md#accept-dia-a11) |
| [DIA-10](plugins/DIAGNOSTICS.md#feature-dia-10) — **FROZEN** | [DIA-A12](plugins/DIAGNOSTICS.md#accept-dia-a12) — **FROZEN** |
| [DIA-11](plugins/DIAGNOSTICS.md#feature-dia-11) | [DIA-A13](plugins/DIAGNOSTICS.md#accept-dia-a13) |
| [DIA-12](plugins/DIAGNOSTICS.md#feature-dia-12) | [DIA-A10](plugins/DIAGNOSTICS.md#accept-dia-a10), [DIA-A11](plugins/DIAGNOSTICS.md#accept-dia-a11) |
| [DIA-13](plugins/DIAGNOSTICS.md#feature-dia-13) | [DIA-A9](plugins/DIAGNOSTICS.md#accept-dia-a9) |
| [DIA-14](plugins/DIAGNOSTICS.md#feature-dia-14) | [DIA-A16](plugins/DIAGNOSTICS.md#accept-dia-a16) |
| [SPK-01](plugins/SPEAKER.md#feature-spk-01) | [SPK-A01](plugins/SPEAKER.md#accept-spk-a01) |
| [SPK-02](plugins/SPEAKER.md#feature-spk-02) | [SPK-A02](plugins/SPEAKER.md#accept-spk-a02) |
| [SPK-03](plugins/SPEAKER.md#feature-spk-03) | [SPK-A03](plugins/SPEAKER.md#accept-spk-a03) |
| [SPK-04](plugins/SPEAKER.md#feature-spk-04) | [SPK-A04](plugins/SPEAKER.md#accept-spk-a04) |
| [SPK-05](plugins/SPEAKER.md#feature-spk-05) | [SPK-A05](plugins/SPEAKER.md#accept-spk-a05) |
| [SPK-06](plugins/SPEAKER.md#feature-spk-06) | [SPK-A06](plugins/SPEAKER.md#accept-spk-a06) |
| [SPK-07](plugins/SPEAKER.md#feature-spk-07) | [SPK-A07](plugins/SPEAKER.md#accept-spk-a07) |
| [SPK-08](plugins/SPEAKER.md#feature-spk-08) | [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| [SPK-09](plugins/SPEAKER.md#feature-spk-09) | [SPK-A09](plugins/SPEAKER.md#accept-spk-a09) |
| [SPK-10](plugins/SPEAKER.md#feature-spk-10) | [SPK-A10](plugins/SPEAKER.md#accept-spk-a10) |
| [SPK-11](plugins/SPEAKER.md#feature-spk-11) | [SPK-A11](plugins/SPEAKER.md#accept-spk-a11) |
| [SPK-12](plugins/SPEAKER.md#feature-spk-12) | [SPK-A12](plugins/SPEAKER.md#accept-spk-a12) |
| [SEM-01](plugins/SEMANTIC.md#feature-sem-01) | [SEM-A1](plugins/SEMANTIC.md#accept-sem-a1) |
| [SEM-02](plugins/SEMANTIC.md#feature-sem-02) | [SEM-A2](plugins/SEMANTIC.md#accept-sem-a2) |
| [SEM-03](plugins/SEMANTIC.md#feature-sem-03) | [SEM-A3](plugins/SEMANTIC.md#accept-sem-a3) |
| [SEM-04](plugins/SEMANTIC.md#feature-sem-04) | [SEM-A4](plugins/SEMANTIC.md#accept-sem-a4) |
| [SEM-05](plugins/SEMANTIC.md#feature-sem-05) | [SEM-A5](plugins/SEMANTIC.md#accept-sem-a5) |
| [SEM-06](plugins/SEMANTIC.md#feature-sem-06) | [SEM-A6](plugins/SEMANTIC.md#accept-sem-a6) |
| [SEM-07](plugins/SEMANTIC.md#feature-sem-07) | [SEM-A7](plugins/SEMANTIC.md#accept-sem-a7) |
| [SEM-08](plugins/SEMANTIC.md#feature-sem-08) | [SEM-A5](plugins/SEMANTIC.md#accept-sem-a5) |
| [SEM-09](plugins/SEMANTIC.md#feature-sem-09) | [SEM-A4](plugins/SEMANTIC.md#accept-sem-a4), [SEM-A5](plugins/SEMANTIC.md#accept-sem-a5) |
| [PUB-01](plugins/PUBLISHING.md#feature-pub-01) | [PUB-AC01](plugins/PUBLISHING.md#accept-pub-ac01), [PUB-AC02](plugins/PUBLISHING.md#accept-pub-ac02) |
| [PUB-02](plugins/PUBLISHING.md#feature-pub-02) | [PUB-AC03](plugins/PUBLISHING.md#accept-pub-ac03) |
| [PUB-03](plugins/PUBLISHING.md#feature-pub-03) | [PUB-AC04](plugins/PUBLISHING.md#accept-pub-ac04), [PUB-AC05](plugins/PUBLISHING.md#accept-pub-ac05) |
| [PUB-04](plugins/PUBLISHING.md#feature-pub-04) | [PUB-AC06](plugins/PUBLISHING.md#accept-pub-ac06) |
| [PUB-05](plugins/PUBLISHING.md#feature-pub-05) | [PUB-AC07](plugins/PUBLISHING.md#accept-pub-ac07) |
| [PUB-06](plugins/PUBLISHING.md#feature-pub-06) | [PUB-AC08](plugins/PUBLISHING.md#accept-pub-ac08) |
| [PUB-07](plugins/PUBLISHING.md#feature-pub-07) | [PUB-AC09](plugins/PUBLISHING.md#accept-pub-ac09), [PUB-AC10](plugins/PUBLISHING.md#accept-pub-ac10) |
| [PUB-08](plugins/PUBLISHING.md#feature-pub-08) | [PUB-AC11](plugins/PUBLISHING.md#accept-pub-ac11), [PUB-AC12](plugins/PUBLISHING.md#accept-pub-ac12), [PUB-AC13](plugins/PUBLISHING.md#accept-pub-ac13) |

## Exact Scriptorium Action crosswalk

Each registered source Action has an explicit destination and acceptance. Shared broad Story Actions are partitioned by entity type/field; the manifest records the predicate. A legacy Action ID is a provenance/compatibility adapter, never a second implementation or a new Core mutation authority. Source definitions are the eight pinned registration files in [traceability.json](traceability.json).

| Source Action | Canon feature destination | Acceptance |
| --- | --- | --- |
| `story.changes.propose` | [PW-21](plugins/PAIRED-WRITING.md#feature-pw-21) | [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10), [PW-21](plugins/PAIRED-WRITING.md#accept-pw-21) |
| `story.snapshot.materialize` | [KNO-01](plugins/KNOWLEDGE.md#feature-kno-01) | [KNO-A01](plugins/KNOWLEDGE.md#accept-kno-a01), [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `story.entities.list` | [NAR-02](plugins/NARRATIVE.md#feature-nar-02); [KNO-01](plugins/KNOWLEDGE.md#feature-kno-01) | [NAR-A02](plugins/NARRATIVE.md#accept-nar-a02); [KNO-A01](plugins/KNOWLEDGE.md#accept-kno-a01), [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `story.entities.collection-revision` | [NAR-02](plugins/NARRATIVE.md#feature-nar-02); [KNO-01](plugins/KNOWLEDGE.md#feature-kno-01) | [NAR-A02](plugins/NARRATIVE.md#accept-nar-a02); [KNO-A01](plugins/KNOWLEDGE.md#accept-kno-a01), [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `story.entities.get` | [NAR-02](plugins/NARRATIVE.md#feature-nar-02); [KNO-01](plugins/KNOWLEDGE.md#feature-kno-01) | [NAR-A02](plugins/NARRATIVE.md#accept-nar-a02); [KNO-A01](plugins/KNOWLEDGE.md#accept-kno-a01), [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `story.entities.create` | [NAR-04](plugins/NARRATIVE.md#feature-nar-04); [KNO-02](plugins/KNOWLEDGE.md#feature-kno-02) | [NAR-A04](plugins/NARRATIVE.md#accept-nar-a04); [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `story.entities.update` | [NAR-06](plugins/NARRATIVE.md#feature-nar-06); [KNO-02](plugins/KNOWLEDGE.md#feature-kno-02) | [NAR-A06](plugins/NARRATIVE.md#accept-nar-a06); [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `story.scene.metadata.update` | [NAR-06](plugins/NARRATIVE.md#feature-nar-06); [KNO-03](plugins/KNOWLEDGE.md#feature-kno-03) | [NAR-A06](plugins/NARRATIVE.md#accept-nar-a06); [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.entities.reorder` | [NAR-05](plugins/NARRATIVE.md#feature-nar-05) | [NAR-A05](plugins/NARRATIVE.md#accept-nar-a05) |
| `story.entities.backlinks` | [KNO-06](plugins/KNOWLEDGE.md#feature-kno-06) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.entities.appearances` | [KNO-06](plugins/KNOWLEDGE.md#feature-kno-06) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.entities.voice-patterns` | [KNO-06](plugins/KNOWLEDGE.md#feature-kno-06) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.entities.freshness` | [KNO-06](plugins/KNOWLEDGE.md#feature-kno-06) | [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.entities.suggested-tags` | [KNO-07](plugins/KNOWLEDGE.md#feature-kno-07) | [KNO-A10](plugins/KNOWLEDGE.md#accept-kno-a10), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| `story.tags.list` | [KNO-07](plugins/KNOWLEDGE.md#feature-kno-07) | [KNO-A10](plugins/KNOWLEDGE.md#accept-kno-a10), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| `story.scene.context` | [NAR-06](plugins/NARRATIVE.md#feature-nar-06); [KNO-08](plugins/KNOWLEDGE.md#feature-kno-08) | [NAR-A06](plugins/NARRATIVE.md#accept-nar-a06); [KNO-A03](plugins/KNOWLEDGE.md#accept-kno-a03), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.volumes.tree` | [NAR-02](plugins/NARRATIVE.md#feature-nar-02) | [NAR-A02](plugins/NARRATIVE.md#accept-nar-a02) |
| `story.threads.overview` | [KNO-10](plugins/KNOWLEDGE.md#feature-kno-10) | [KNO-A04](plugins/KNOWLEDGE.md#accept-kno-a04) |
| `story.threads.status` | [KNO-10](plugins/KNOWLEDGE.md#feature-kno-10) | [KNO-A04](plugins/KNOWLEDGE.md#accept-kno-a04) |
| `story.threads.lifecycle` | [KNO-11](plugins/KNOWLEDGE.md#feature-kno-11) | [KNO-A04](plugins/KNOWLEDGE.md#accept-kno-a04) |
| `story.graph.query` | [KNO-13](plugins/KNOWLEDGE.md#feature-kno-13) | [KNO-A05](plugins/KNOWLEDGE.md#accept-kno-a05), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.cooccurrence` | [KNO-13](plugins/KNOWLEDGE.md#feature-kno-13) | [KNO-A05](plugins/KNOWLEDGE.md#accept-kno-a05), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.map.query` | [KNO-14](plugins/KNOWLEDGE.md#feature-kno-14) | [KNO-A05](plugins/KNOWLEDGE.md#accept-kno-a05), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.timeline.query` | [KNO-15](plugins/KNOWLEDGE.md#feature-kno-15) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `story.world-state.at-scene` | [KNO-16](plugins/KNOWLEDGE.md#feature-kno-16) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06) |
| `story.world-state.history` | [KNO-16](plugins/KNOWLEDGE.md#feature-kno-16) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06) |
| `story.world-state.workbench` | [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| `story.state-proposals.list` | [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| `story.state-proposals.create` | [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| `story.state-proposals.update` | [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| `story.state-proposals.approve` | [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| `story.state-proposals.reject` | [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| `story.state-proposals.stale` | [KNO-18](plugins/KNOWLEDGE.md#feature-kno-18) | [KNO-A06](plugins/KNOWLEDGE.md#accept-kno-a06), [KNO-A09](plugins/KNOWLEDGE.md#accept-kno-a09) |
| `story.zukan-suggestions.list` | [KNO-05](plugins/KNOWLEDGE.md#feature-kno-05) | [KNO-A08](plugins/KNOWLEDGE.md#accept-kno-a08), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| `story.zukan-suggestions.create` | [KNO-05](plugins/KNOWLEDGE.md#feature-kno-05) | [KNO-A08](plugins/KNOWLEDGE.md#accept-kno-a08), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| `story.zukan-suggestions.approve` | [KNO-05](plugins/KNOWLEDGE.md#feature-kno-05) | [KNO-A08](plugins/KNOWLEDGE.md#accept-kno-a08), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| `story.zukan-suggestions.reject` | [KNO-05](plugins/KNOWLEDGE.md#feature-kno-05) | [KNO-A08](plugins/KNOWLEDGE.md#accept-kno-a08), [KNO-A13](plugins/KNOWLEDGE.md#accept-kno-a13) |
| `story.reader-model.build` | [KNO-17](plugins/KNOWLEDGE.md#feature-kno-17) | [KNO-A07](plugins/KNOWLEDGE.md#accept-kno-a07) |
| `story.series.list` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.get` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.create` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.update` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.delete` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.binding.get` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.binding.update` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.binding.delete` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `story.series.overlay` | [KNO-19](plugins/KNOWLEDGE.md#feature-kno-19) | [KNO-A11](plugins/KNOWLEDGE.md#accept-kno-a11), [KNO-A14](plugins/KNOWLEDGE.md#accept-kno-a14) |
| `search.query` | [RES-001](plugins/RESEARCH.md#feature-res-001) | [RES-A001](plugins/RESEARCH.md#accept-res-a001) |
| `search.terms.list` | [RES-003](plugins/RESEARCH.md#feature-res-003) | [RES-A003](plugins/RESEARCH.md#accept-res-a003) |
| `search.terms.resolve` | [RES-004](plugins/RESEARCH.md#feature-res-004) | [RES-A004](plugins/RESEARCH.md#accept-res-a004) |
| `search.terms.propose` | [RES-003](plugins/RESEARCH.md#feature-res-003) | [RES-A003](plugins/RESEARCH.md#accept-res-a003) |
| `search.terms.remove` | [RES-003](plugins/RESEARCH.md#feature-res-003) | [RES-A003](plugins/RESEARCH.md#accept-res-a003) |
| `nlp.analyze` | [RES-005](plugins/RESEARCH.md#feature-res-005) | [RES-A005](plugins/RESEARCH.md#accept-res-a005) |
| `nlp.countTokens` | [RES-011](plugins/RESEARCH.md#feature-res-011) | [RES-A011](plugins/RESEARCH.md#accept-res-a011) |
| `nlp.discoverCandidates` | [RES-006](plugins/RESEARCH.md#feature-res-006) | [RES-A006](plugins/RESEARCH.md#accept-res-a006) |
| `nlp.termVariants` | [RES-007](plugins/RESEARCH.md#feature-res-007) | [RES-A007](plugins/RESEARCH.md#accept-res-a007) |
| `nlp.dictionary` | [RES-008](plugins/RESEARCH.md#feature-res-008) | [RES-A008](plugins/RESEARCH.md#accept-res-a008) |
| `nlp.saveSynonymGroup` | [RES-008](plugins/RESEARCH.md#feature-res-008) | [RES-A008](plugins/RESEARCH.md#accept-res-a008) |
| `nlp.ignoreCandidates` | [RES-009](plugins/RESEARCH.md#feature-res-009) | [RES-A009](plugins/RESEARCH.md#accept-res-a009) |
| `nlp.features` | [RES-012](plugins/RESEARCH.md#feature-res-012) | [RES-A012](plugins/RESEARCH.md#accept-res-a012) |
| `nlp.updateExternalConsent` | [RES-012](plugins/RESEARCH.md#feature-res-012) | [RES-A012](plugins/RESEARCH.md#accept-res-a012) |
| `assistant.health` | [PW-01](plugins/PAIRED-WRITING.md#feature-pw-01) | [PW-01](plugins/PAIRED-WRITING.md#accept-pw-01), [PW-11](plugins/PAIRED-WRITING.md#accept-pw-11) |
| `assistant.queue.status` | [PW-01](plugins/PAIRED-WRITING.md#feature-pw-01) | [PW-01](plugins/PAIRED-WRITING.md#accept-pw-01), [PW-11](plugins/PAIRED-WRITING.md#accept-pw-11) |
| `assistant.settings.read` | [PW-01](plugins/PAIRED-WRITING.md#feature-pw-01) | [PW-01](plugins/PAIRED-WRITING.md#accept-pw-01), [PW-11](plugins/PAIRED-WRITING.md#accept-pw-11) |
| `assistant.settings.propose` | [PW-01](plugins/PAIRED-WRITING.md#feature-pw-01) | [PW-01](plugins/PAIRED-WRITING.md#accept-pw-01), [PW-11](plugins/PAIRED-WRITING.md#accept-pw-11) |
| `assistant.usage.read` | [PW-01](plugins/PAIRED-WRITING.md#feature-pw-01) | [PW-01](plugins/PAIRED-WRITING.md#accept-pw-01), [PW-11](plugins/PAIRED-WRITING.md#accept-pw-11) |
| `assistant.rewrite` | [PW-02](plugins/PAIRED-WRITING.md#feature-pw-02) | [PW-02](plugins/PAIRED-WRITING.md#accept-pw-02) |
| `assistant.rewrite.propose` | [PW-02](plugins/PAIRED-WRITING.md#feature-pw-02) | [PW-02](plugins/PAIRED-WRITING.md#accept-pw-02) |
| `assistant.summary.scene` | [PW-05](plugins/PAIRED-WRITING.md#feature-pw-05) | [PW-05](plugins/PAIRED-WRITING.md#accept-pw-05) |
| `assistant.summary.chapter` | [PW-05](plugins/PAIRED-WRITING.md#feature-pw-05) | [PW-05](plugins/PAIRED-WRITING.md#accept-pw-05) |
| `assistant.qa` | [PW-04](plugins/PAIRED-WRITING.md#feature-pw-04) | [PW-04](plugins/PAIRED-WRITING.md#accept-pw-04) |
| `assistant.continuation` | [PW-03](plugins/PAIRED-WRITING.md#feature-pw-03) | [PW-03](plugins/PAIRED-WRITING.md#accept-pw-03) |
| `assistant.aspect.review` | [DIA-14](plugins/DIAGNOSTICS.md#feature-dia-14) | [DIA-A16](plugins/DIAGNOSTICS.md#accept-dia-a16) |
| `assistant.dialogue.topics` | [PW-06](plugins/PAIRED-WRITING.md#feature-pw-06) | [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06) |
| `assistant.dialogue.turns` | [PW-06](plugins/PAIRED-WRITING.md#feature-pw-06) | [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06) |
| `assistant.reader.reaction` | [PW-05](plugins/PAIRED-WRITING.md#feature-pw-05) | [PW-05](plugins/PAIRED-WRITING.md#accept-pw-05) |
| `assistant.zukan.suggestions` | [PW-11](plugins/PAIRED-WRITING.md#feature-pw-11) | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| `assistant.synonyms.suggestions` | [PW-08](plugins/PAIRED-WRITING.md#feature-pw-08) | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| `assistant.contradictions.assist` | [PW-09](plugins/PAIRED-WRITING.md#feature-pw-09) | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| `assistant.stateEvents.draft` | [PW-11](plugins/PAIRED-WRITING.md#feature-pw-11) | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| `assistant.speaker.attribute` | [PW-10](plugins/PAIRED-WRITING.md#feature-pw-10) | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| `assistant.summary.scene.preview` | [PW-05](plugins/PAIRED-WRITING.md#feature-pw-05) | [PW-05](plugins/PAIRED-WRITING.md#accept-pw-05) |
| `assistant.summary.chapter.preview` | [PW-05](plugins/PAIRED-WRITING.md#feature-pw-05) | [PW-05](plugins/PAIRED-WRITING.md#accept-pw-05) |
| `assistant.qa.preview` | [PW-04](plugins/PAIRED-WRITING.md#feature-pw-04) | [PW-04](plugins/PAIRED-WRITING.md#accept-pw-04) |
| `assistant.continuation.preview` | [PW-03](plugins/PAIRED-WRITING.md#feature-pw-03) | [PW-03](plugins/PAIRED-WRITING.md#accept-pw-03) |
| `assistant.aspect.review.preview` | [DIA-14](plugins/DIAGNOSTICS.md#feature-dia-14) | [DIA-A16](plugins/DIAGNOSTICS.md#accept-dia-a16) |
| `assistant.dialogue.topics.preview` | [PW-06](plugins/PAIRED-WRITING.md#feature-pw-06) | [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06) |
| `assistant.dialogue.turn.preview` | [PW-06](plugins/PAIRED-WRITING.md#feature-pw-06) | [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06) |
| `assistant.dialogue.turns.preview` | [PW-06](plugins/PAIRED-WRITING.md#feature-pw-06) | [PW-06](plugins/PAIRED-WRITING.md#accept-pw-06) |
| `assistant.reader.reaction.preview` | [PW-05](plugins/PAIRED-WRITING.md#feature-pw-05) | [PW-05](plugins/PAIRED-WRITING.md#accept-pw-05) |
| `assistant.synonyms.preview` | [PW-08](plugins/PAIRED-WRITING.md#feature-pw-08) | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| `assistant.zukan.sandbox.preview` | [PW-11](plugins/PAIRED-WRITING.md#feature-pw-11) | [PW-07](plugins/PAIRED-WRITING.md#accept-pw-07) |
| `diagnostics.checkConsistency` | [DIA-02](plugins/DIAGNOSTICS.md#feature-dia-02) | [DIA-A3](plugins/DIAGNOSTICS.md#accept-dia-a3) |
| `diagnostics.checkContinuity` | [DIA-03](plugins/DIAGNOSTICS.md#feature-dia-03) | [DIA-A4](plugins/DIAGNOSTICS.md#accept-dia-a4) |
| `diagnostics.voiceConsistency` | [SPK-08](plugins/SPEAKER.md#feature-spk-08) | [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| `diagnostics.analyze` | [DIA-06](plugins/DIAGNOSTICS.md#feature-dia-06) | [DIA-A2](plugins/DIAGNOSTICS.md#accept-dia-a2), [DIA-A7](plugins/DIAGNOSTICS.md#accept-dia-a7) |
| `diagnostics.scene` | [DIA-01](plugins/DIAGNOSTICS.md#feature-dia-01) | [DIA-A1](plugins/DIAGNOSTICS.md#accept-dia-a1), [DIA-A2](plugins/DIAGNOSTICS.md#accept-dia-a2), [DIA-A9](plugins/DIAGNOSTICS.md#accept-dia-a9), [DIA-A14](plugins/DIAGNOSTICS.md#accept-dia-a14), [DIA-A15](plugins/DIAGNOSTICS.md#accept-dia-a15) |
| `diagnostics.checkPlotSemantics` | [DIA-07](plugins/DIAGNOSTICS.md#feature-dia-07) | [DIA-A8](plugins/DIAGNOSTICS.md#accept-dia-a8) |
| `diagnostics.lint` | [DIA-04](plugins/DIAGNOSTICS.md#feature-dia-04) | [DIA-A5](plugins/DIAGNOSTICS.md#accept-dia-a5) |
| `diagnostics.proposeLintFix` | [DIA-05](plugins/DIAGNOSTICS.md#feature-dia-05) | [DIA-A6](plugins/DIAGNOSTICS.md#accept-dia-a6) |
| `diagnostics.formatManuscript` | [DIA-05](plugins/DIAGNOSTICS.md#feature-dia-05) | [DIA-A6](plugins/DIAGNOSTICS.md#accept-dia-a6) |
| `diagnostics.voiceProfiles` | [SPK-07](plugins/SPEAKER.md#feature-spk-07) | [SPK-A07](plugins/SPEAKER.md#accept-spk-a07) |
| `diagnostics.voiceDeviations` | [SPK-08](plugins/SPEAKER.md#feature-spk-08) | [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| `diagnostics.stylometricDeviations` | [SPK-08](plugins/SPEAKER.md#feature-spk-08) | [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| `speaker.scenes.list` | [SPK-01](plugins/SPEAKER.md#feature-spk-01) | [SPK-A01](plugins/SPEAKER.md#accept-spk-a01) |
| `speaker.dialogue.list` | [SPK-06](plugins/SPEAKER.md#feature-spk-06) | [SPK-A06](plugins/SPEAKER.md#accept-spk-a06) |
| `speaker.voice.profiles` | [SPK-07](plugins/SPEAKER.md#feature-spk-07) | [SPK-A07](plugins/SPEAKER.md#accept-spk-a07) |
| `speaker.attribute` | [SPK-02](plugins/SPEAKER.md#feature-spk-02) | [SPK-A02](plugins/SPEAKER.md#accept-spk-a02) |
| `speaker.voice.check` | [SPK-08](plugins/SPEAKER.md#feature-spk-08) | [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| `speaker.review.queue` | [SPK-05](plugins/SPEAKER.md#feature-spk-05) | [SPK-A05](plugins/SPEAKER.md#accept-spk-a05) |
| `speaker.override` | [SPK-05](plugins/SPEAKER.md#feature-spk-05) | [SPK-A05](plugins/SPEAKER.md#accept-spk-a05) |
| `speaker.count.update` | [SPK-04](plugins/SPEAKER.md#feature-spk-04) | [SPK-A04](plugins/SPEAKER.md#accept-spk-a04) |
| `speaker.evaluation.latest` | [SPK-09](plugins/SPEAKER.md#feature-spk-09) | [SPK-A09](plugins/SPEAKER.md#accept-spk-a09) |
| `speaker.ruleGates` | [SPK-09](plugins/SPEAKER.md#feature-spk-09) | [SPK-A09](plugins/SPEAKER.md#accept-spk-a09) |
| `speaker.evaluation.run` | [SPK-09](plugins/SPEAKER.md#feature-spk-09) | [SPK-A09](plugins/SPEAKER.md#accept-spk-a09) |
| `speaker.retraining.run` | [SPK-10](plugins/SPEAKER.md#feature-spk-10) | [SPK-A10](plugins/SPEAKER.md#accept-spk-a10) |
| `semantic.index.rebuild` | [SEM-01](plugins/SEMANTIC.md#feature-sem-01) | [SEM-A1](plugins/SEMANTIC.md#accept-sem-a1) |
| `semantic.index.status` | [SEM-01](plugins/SEMANTIC.md#feature-sem-01) | [SEM-A1](plugins/SEMANTIC.md#accept-sem-a1) |
| `semantic.search` | [SEM-02](plugins/SEMANTIC.md#feature-sem-02) | [SEM-A2](plugins/SEMANTIC.md#accept-sem-a2) |
| `semantic.expressions.search` | [SEM-03](plugins/SEMANTIC.md#feature-sem-03) | [SEM-A3](plugins/SEMANTIC.md#accept-sem-a3) |
| `semantic.terms.clusters` | [SEM-04](plugins/SEMANTIC.md#feature-sem-04) | [SEM-A4](plugins/SEMANTIC.md#accept-sem-a4) |
| `semantic.contradictions.rebuild` | [SEM-05](plugins/SEMANTIC.md#feature-sem-05) | [SEM-A5](plugins/SEMANTIC.md#accept-sem-a5) |
| `semantic.contradictions.dismiss` | [DIA-11](plugins/DIAGNOSTICS.md#feature-dia-11) | [DIA-A13](plugins/DIAGNOSTICS.md#accept-dia-a13) |
| `semantic.settings.read` | [SEM-06](plugins/SEMANTIC.md#feature-sem-06) | [SEM-A6](plugins/SEMANTIC.md#accept-sem-a6) |
| `semantic.settings.update` | [SEM-06](plugins/SEMANTIC.md#feature-sem-06) | [SEM-A6](plugins/SEMANTIC.md#accept-sem-a6) |
| `semantic.task.status` | [SEM-01](plugins/SEMANTIC.md#feature-sem-01) | [SEM-A1](plugins/SEMANTIC.md#accept-sem-a1) |
| `semantic.task.cancel` | [SEM-01](plugins/SEMANTIC.md#feature-sem-01) | [SEM-A1](plugins/SEMANTIC.md#accept-sem-a1) |
| `publishing.export.plaintext` | [PUB-02](plugins/PUBLISHING.md#feature-pub-02) | [PUB-AC03](plugins/PUBLISHING.md#accept-pub-ac03) |
| `publishing.export.epub` | [PUB-03](plugins/PUBLISHING.md#feature-pub-03) | [PUB-AC04](plugins/PUBLISHING.md#accept-pub-ac04), [PUB-AC05](plugins/PUBLISHING.md#accept-pub-ac05) |
| `publishing.export.vertical-print` | [PUB-04](plugins/PUBLISHING.md#feature-pub-04) | [PUB-AC06](plugins/PUBLISHING.md#accept-pub-ac06) |
| `publishing.project.tree` | [PUB-01](plugins/PUBLISHING.md#feature-pub-01) | [PUB-AC01](plugins/PUBLISHING.md#accept-pub-ac01), [PUB-AC02](plugins/PUBLISHING.md#accept-pub-ac02) |
| `publishing.episodes.read` | [PUB-06](plugins/PUBLISHING.md#feature-pub-06) | [PUB-AC08](plugins/PUBLISHING.md#accept-pub-ac08) |
| `publishing.episodes.propose` | [PUB-06](plugins/PUBLISHING.md#feature-pub-06) | [PUB-AC08](plugins/PUBLISHING.md#accept-pub-ac08) |
| `publishing.shares.list` | [PUB-07](plugins/PUBLISHING.md#feature-pub-07) | [PUB-AC09](plugins/PUBLISHING.md#accept-pub-ac09), [PUB-AC10](plugins/PUBLISHING.md#accept-pub-ac10) |
| `publishing.shares.create` | [PUB-07](plugins/PUBLISHING.md#feature-pub-07) | [PUB-AC09](plugins/PUBLISHING.md#accept-pub-ac09), [PUB-AC10](plugins/PUBLISHING.md#accept-pub-ac10) |
| `publishing.shares.revoke` | [PUB-07](plugins/PUBLISHING.md#feature-pub-07) | [PUB-AC09](plugins/PUBLISHING.md#accept-pub-ac09), [PUB-AC10](plugins/PUBLISHING.md#accept-pub-ac10) |

## Exact legacy MCP facade crosswalk

All 33 registrations in pinned `modules/mcp/src/tools.ts` are covered here; `modules/mcp/src/http.test.ts` proves legacy discovery/routing/error behavior only. Names below are not new Gateway tools. Plugins use the existing `plugin_call`; proposal status/inspection remains Host-owned and author approval cannot be called by MCP.

| Source tool | Destination | Canon / Acceptance |
| --- | --- | --- |
| `list_projects` | repositories_list | [Host registry/receipts](HOST-PLUGIN-CONTRACT.md#registry-discovery-and-proposal-receipts); [R09/R12](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) |
| `discover_actions` | plugin_call / actions.list | [Host registry/receipts](HOST-PLUGIN-CONTRACT.md#registry-discovery-and-proposal-receipts); [R09/R12](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) |
| `invoke_action` | plugin_call / typed Action Registry | [Host registry/receipts](HOST-PLUGIN-CONTRACT.md#registry-discovery-and-proposal-receipts); [R09/R12](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) |
| `get_entity` | plugin_call / proprium.knowledge | [KNO-01](plugins/KNOWLEDGE.md#feature-kno-01); [KNO-A01](plugins/KNOWLEDGE.md#accept-kno-a01), [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `list_entities` | plugin_call / proprium.knowledge | [KNO-01](plugins/KNOWLEDGE.md#feature-kno-01); [KNO-A01](plugins/KNOWLEDGE.md#accept-kno-a01), [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `get_scene_context` | plugin_call / proprium.paired-writing | [PW-04](plugins/PAIRED-WRITING.md#feature-pw-04); [PW-04](plugins/PAIRED-WRITING.md#accept-pw-04) |
| `get_writing_context` | plugin_call / proprium.paired-writing | [PW-04](plugins/PAIRED-WRITING.md#feature-pw-04); [PW-04](plugins/PAIRED-WRITING.md#accept-pw-04) |
| `get_context_manifest` | plugin_call / proprium.paired-writing | [PW-04](plugins/PAIRED-WRITING.md#feature-pw-04); [PW-04](plugins/PAIRED-WRITING.md#accept-pw-04) |
| `get_volume_tree` | plugin_call / proprium.narrative | [NAR-02](plugins/NARRATIVE.md#feature-nar-02); [NAR-A02](plugins/NARRATIVE.md#accept-nar-a02) |
| `search` | plugin_call / proprium.research | [RES-001](plugins/RESEARCH.md#feature-res-001); [RES-A001](plugins/RESEARCH.md#accept-res-a001) |
| `analyze_manuscript` | plugin_call / proprium.diagnostics | [DIA-06](plugins/DIAGNOSTICS.md#feature-dia-06); [DIA-A2](plugins/DIAGNOSTICS.md#accept-dia-a2), [DIA-A7](plugins/DIAGNOSTICS.md#accept-dia-a7) |
| `get_diagnostics` | plugin_call / proprium.diagnostics | [DIA-01](plugins/DIAGNOSTICS.md#feature-dia-01); [DIA-A1](plugins/DIAGNOSTICS.md#accept-dia-a1), [DIA-A2](plugins/DIAGNOSTICS.md#accept-dia-a2), [DIA-A9](plugins/DIAGNOSTICS.md#accept-dia-a9), [DIA-A14](plugins/DIAGNOSTICS.md#accept-dia-a14), [DIA-A15](plugins/DIAGNOSTICS.md#accept-dia-a15) |
| `get_thread_status` | plugin_call / proprium.knowledge | [KNO-10](plugins/KNOWLEDGE.md#feature-kno-10); [KNO-A04](plugins/KNOWLEDGE.md#accept-kno-a04) |
| `get_status` | git_status | [Host registry/receipts](HOST-PLUGIN-CONTRACT.md#registry-discovery-and-proposal-receipts); [R09/R12](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) |
| `get_history` | git_log | [Host registry/receipts](HOST-PLUGIN-CONTRACT.md#registry-discovery-and-proposal-receipts); [R09/R12](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) |
| `get_observation` | repository_info + git_status + files_list | [Host registry/receipts](HOST-PLUGIN-CONTRACT.md#registry-discovery-and-proposal-receipts); [R09/R12](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) |
| `submit_change_set` | plugin_call / proprium.paired-writing | [PW-21](plugins/PAIRED-WRITING.md#feature-pw-21); [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10), [PW-21](plugins/PAIRED-WRITING.md#accept-pw-21) |
| `list_change_sets` | plugin_call / proprium.paired-writing | [PW-15](plugins/PAIRED-WRITING.md#feature-pw-15); [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10) |
| `get_change_set` | plugin_call / proprium.paired-writing | [PW-15](plugins/PAIRED-WRITING.md#feature-pw-15); [PW-10](plugins/PAIRED-WRITING.md#accept-pw-10) |
| `update_entity` | plugin_call / proprium.knowledge | [KNO-02](plugins/KNOWLEDGE.md#feature-kno-02); [KNO-A02](plugins/KNOWLEDGE.md#accept-kno-a02) |
| `create_scene` | plugin_call / proprium.narrative | [NAR-04](plugins/NARRATIVE.md#feature-nar-04); [NAR-A04](plugins/NARRATIVE.md#accept-nar-a04) |
| `lint_manuscript` | plugin_call / proprium.diagnostics | [DIA-04](plugins/DIAGNOSTICS.md#feature-dia-04); [DIA-A5](plugins/DIAGNOSTICS.md#accept-dia-a5) |
| `suggest_rewrite` | plugin_call / proprium.paired-writing | [PW-02](plugins/PAIRED-WRITING.md#feature-pw-02); [PW-02](plugins/PAIRED-WRITING.md#accept-pw-02) |
| `reload` | Host snapshot refresh; no data reset | [Host registry/receipts](HOST-PLUGIN-CONTRACT.md#registry-discovery-and-proposal-receipts); [R09/R12](ACCEPTANCE.md#acceptance-matrix-all-mandatory-where-applicable) |
| `check_stylometric_deviations` | plugin_call / proprium.speaker | [SPK-08](plugins/SPEAKER.md#feature-spk-08); [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| `check_plot_semantics` | plugin_call / proprium.diagnostics | [DIA-07](plugins/DIAGNOSTICS.md#feature-dia-07); [DIA-A8](plugins/DIAGNOSTICS.md#accept-dia-a8) |
| `check_consistency` | plugin_call / proprium.diagnostics | [DIA-02](plugins/DIAGNOSTICS.md#feature-dia-02); [DIA-A3](plugins/DIAGNOSTICS.md#accept-dia-a3) |
| `check_continuity` | plugin_call / proprium.diagnostics | [DIA-03](plugins/DIAGNOSTICS.md#feature-dia-03); [DIA-A4](plugins/DIAGNOSTICS.md#accept-dia-a4) |
| `compute_cooccurrence` | plugin_call / proprium.knowledge | [KNO-13](plugins/KNOWLEDGE.md#feature-kno-13); [KNO-A05](plugins/KNOWLEDGE.md#accept-kno-a05), [KNO-A12](plugins/KNOWLEDGE.md#accept-kno-a12) |
| `check_voice_consistency` | plugin_call / proprium.speaker | [SPK-08](plugins/SPEAKER.md#feature-spk-08); [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| `check_style_deviations` | plugin_call / proprium.speaker | [SPK-08](plugins/SPEAKER.md#feature-spk-08); [SPK-A08](plugins/SPEAKER.md#accept-spk-a08) |
| `get_dialogue` | plugin_call / proprium.speaker | [SPK-06](plugins/SPEAKER.md#feature-spk-06); [SPK-A06](plugins/SPEAKER.md#accept-spk-a06) |
| `format_manuscript` | plugin_call / proprium.diagnostics | [DIA-05](plugins/DIAGNOSTICS.md#feature-dia-05); [DIA-A6](plugins/DIAGNOSTICS.md#accept-dia-a6) |

## Data authority and preservation

| Data class | Canonical owner and no-loss rule |
| --- | --- |
| Manuscript, hierarchy and reading annotations | Existing Markdown/YAML remain at their explicit paths; Narrative routes scene identity, Host owns editing/recovery. Reading marks are authored metadata, never diagnostic cache. |
| Bible, notes, scene facts, threads, confirmed state, series | Knowledge preserves unknown fields/records and explicit cross-repository provenance. A derived graph or world state is never another authority. |
| Term registry, synonym groups, ignored candidates | Research preserves existing `meta/scriptorium/modules/search/terms.json` and NLP YAML source; Git consent data grants no network capability. |
| Speaker overrides and correction/model data | Current scene overrides are authoritative; append-only correction JSONL is audit/evaluation evidence. Preserve exact existing bytes and conflicting legacy files. |
| Diagnostic dismissals and decisions | Diagnostics is the single active owner, including legacy Semantic dismissals. Unresolved reasonless records stay `legacy_dismissed`, not guessed intentional/false-positive. |
| Settings, summaries, usage and ChangeSets | Paired preserves nonsecret authored settings/accepted summary source and original source ChangeSet; Host owns current receipts, approval, recovery, checkpoint and publication. |
| Episodes, grants and cover | Publishing retains active episode/grant paths and original covers; raw bearer is never Git metadata. Provider absence does not affect local text/EPUB. |
| Legacy SQLite/.arcadia/retained imports | Read-only inspection and explicit owner-specific migration with source/target revisions, round-trip audit, unresolved IDs and original bytes preserved. Never import private source fixtures or reinterpret server state as active Host state. |
| Indexes, vectors, model allocations, temporary exports | Disposable Host-scoped derived artifacts; cache loss rebuilds, disable releases resources, never erases author files. Signed optional model data requires separate rights/admission/size consent. |
| Browser draft/undo/selection/recovery and unpushed commits | Host-local, at risk until exact remote confirmation. Never silently rebind a different document/repository or promise recovery after browser eviction. |

Existing module metadata remains canonical at its existing path until an explicit verified migration is approved. Newly introduced state uses only its owning canon’s declared schema. Differing old/new records are a reviewable conflict, not last-write-wins or permission to create an empty replacement authority. Missing/invalid files are named; unknown data is retained even when a feature cannot interpret it.

## Verification contract

[The trace index](traceability.json) pins registrations, their feature owners and the required dependency graph. `node scripts/verify-authoring-canon.mjs --sources /path/to/source-parent` verifies feature/acceptance links, owner partitions, source registration coverage, pinned source paths and the acyclic DAG. Structural verification does not prove implementation parity: release evidence must execute every linked local case plus [the suite matrix](ACCEPTANCE.md). Source package tests, static builds, labels-only panels and compute-sum are never substituted for that proof.

## Exact legacy UI contribution registration coverage

All **42** registered browser contribution IDs in pinned Scriptorium are assigned in `traceability.json.source_ui_contributions` to an owning official plugin, a feature ID and an actual registered source module/action/slot/title. This list covers both panels and the editor-adornment contribution. The verifier compares original registrations with the mapping in both directions when invoked with `--sources`, and requires the owning Canon to name each original UI ID. A registered legacy UI ID is source evidence only: completion requires an interactive Host equivalent with observable actions, error states, revision/selection behavior and Desktop/Mobile paths. Do not infer availability from its label.

| Original source product | Registered UI contributions |
| --- | --- |
| Story (Narrative and Knowledge) | `story.navigator`, `story.inspector`, `story.continuity`, `story.world-state`, `story.zukan-review`, `story.series` |
| Search | `search.panel`, `search.terms`, `search.terms.adornment` |
| NLP | `nlp.analyzer`, `nlp.candidates`, `nlp.dictionary`, `nlp.privacy` |
| Semantic | `semantic.search`, `semantic.expressions`, `semantic.contradictions`, `semantic.index` |
| Diagnostics | `diagnostics.consistency`, `diagnostics.continuity`, `diagnostics.analysis`, `diagnostics.scene`, `diagnostics.lint`, `diagnostics.voice` |
| Speaker | `speaker.attribution`, `speaker.review`, `speaker.dialogue`, `speaker.voice.profiles`, `speaker.evaluation` |
| Assistant | `assistant.settings`, `assistant.rewrite`, `assistant.summaries`, `assistant.qa`, `assistant.continuation`, `assistant.aspect-review`, `assistant.dialogue`, `assistant.reader-reaction`, `assistant.proposals` |
| Publishing | `publishing.export.plaintext`, `publishing.export.epub`, `publishing.export.vertical-print`, `publishing.episode-map`, `publishing.share-links` |

In particular `search.terms.adornment` must survive as a non-mutating editor adornment, not as a standalone inert panel; the original MCP module has no corresponding UI registrations and stays Host/Gateway-owned. See [latest Scriptorium source delta](SCRIPTORIUM-LATEST-DELTA.md) for recovery and browser lifecycle changes beyond registered UI IDs.
