# Canon P2 — `proprium.semantic` (Optional Embeddings and Semantic Acceleration)

**Product job:** Add opt-in semantic retrieval, expression similarity, term clustering, contradiction candidates and optional reranking without slowing or gating everyday writing, lexical search or Context.

## Partition rationale

Heavy model/asset lifecycle, versioned vector storage, CPU/WebGPU/memory compatibility, user consent and indexing cost are substantially different from lexical search. This provider may be independently enabled and updated, but **uses Research's search UI** and Knowledge/Diagnostics' evidence views. Do not introduce a second equal-priority search entry or force the writer to install it just to find a term.

## Data and typed capability

- Inputs are pinned eligible passages from the Host's paged file reader (scene ID, exact sentence index, text, source path/revision, corpus generation). Embeddings/vectors/indexes/reranker results are **derived only**; no vectors become Git authority. Accepted user term dictionaries and contradiction dismissal state remain owned by Research/Diagnostics or a declared author metadata path, not hidden in the model cache.
- Model identity = exact approved model ID+version+digest, tokenizer/quantization identity, dimensionality, implementation version. Stale index from another version/branch/config must not be treated as current or substituted without disclosure. Do not fetch unknown weights, interpret arbitrary URLs as trusted providers, or silently send manuscripts to third-party APIs.
- Capability provider APIs (logical names): `semantic.index.status/build/cancel`, `semantic.passages.query`, `semantic.rerank`, `semantic.expressions.find`, `semantic.terms.cluster`, `semantic.contradictions.candidates`. All are **read/derived compute**, except `semantic.dismissal.propose` which yields author-reviewed metadata changes.
- Result includes snapshot, excerpt or bounded semantic evidence, source path/scene/span, model/version, score components/rank, indexing coverage, warnings and limit; a similarity score is not a proof of semantic fact.

## UI and consent

- Research view offers explicit **意味検索** / **ハイブリッド** modes when installed and ready, with current indexing progress and model/bytes/device status. Ordinary lexical search remains immediate and model-free.
- Knowledge/Diagnostics can opt into candidate clusters or contradiction hypotheses, showing raw source citations and evidence. An uncertain match cannot create a relationship or canonical correction automatically.
- Before model download or outbound activity, explain content locality, download size/permission, consent, and memory/performance limits. Prefer local Worker/WebGPU/CPU fallback **only when tested**; otherwise report unavailable and preserve cached work.
- Disable/cancel tears down workers and storage leases; hide all stale derived decorations. Removing semantic never deletes an author term, work state, prose or committed correction.

## Existing sources and backfill

**Scriptorium:** `modules/semantic/src/{actions,browser,contracts,embedding,passages,search,termClustering,contradictions}.ts` and worker, plus `modules/nlp/src/contracts.ts`, `modules/search/src/search-ranking.ts`. Source already distinguishes lexical vs semantic, term clusters and rule/evidence-based contradiction candidates. Node `worker_threads`/cache logic must be converted to the Host/WASM/browser lifecycle; do not bundle an entire legacy model runtime into static Host.

**Arcadia Loom:** `app/src/features/zukan/SynonymGroupRegister.tsx`, `app/src/features/editor/ContradictionDiagnosticsPanel.tsx`, `app/src/features/zukan/SentimentContinuityPanel.tsx` and `packages/core/src/diagnostics/*`; recover exposed controls or evidence display not carried into Scriptorium. Any independent provider credentials in Loom are not plugin assets.

## Dependencies and safety

Requires Host derived-cache broker and Research passage/term contracts. Knowledge/Diagnostics optional consumers; Narrative for scene-scoped content. Vector index cache is scoped to repo, branch, snapshot/overlay, corpus/config generation, model digest and tokenizer identity. Current source worker batch sizes or model names are **implementation evidence**, not automatic runtime compatibility on target devices.

If offline or device unsupported, keep exact lexical search, editing and source-aware diagnostics working; no hidden model initialization during first-page load or text input. Any installed weights must have clear redistribution/provenance and integrity approval.

## Acceptance

1. Signed optional provider installs/activates only on explicit use; disabled initial load triggers zero heavyweight requests and no model allocation.
2. Search hybrid/semantic returns evidence/score/model revision, changes on corpus/config revision, and never leaks another repo/branch's index.
3. Model missing, digest mismatch, memory fault, CPU/WebGPU missing, cancellation, offline and corrupt cache degrade **only semantic acceleration**, not the authoring/editor or lexical search.
4. Contradiction/similarity candidates are uncertain until author review; dismiss/proposal and resulting state are revision-bound. Desktop/Mobile show truthful state and escape paths.
