# Scriptorium Core — Target Architecture

**Status:** Target contract; implementation not yet complete.
**Authority:** Epic #1 and accepted child Issues take precedence when they explicitly change this design.

## Product promise

Scriptorium is a lightweight Git-backed writing workspace. Its baseline product must work with only the Core: connect a GitHub repository, navigate a work's volume/chapter/scene hierarchy, author text, save safely, inspect revisions and synchronize with GitHub.

A work repository—not Scriptorium's SQLite indexes or deployment container—is the durable source of truth. Reuse the existing Arcadia Loom YAML/Markdown format where appropriate rather than inventing a new incompatible document schema.

## Ownership

### Core owns
- Git workspace acquisition, synchronization, identity/authorization boundary and project isolation.
- Canonical manuscript/scene read and write, volume/chapter/scene navigation and minimal editing UI.
- YAML/Markdown validation, saved vs unsaved draft state, revision identity and optimistic conflict detection.
- Project mutation serialization, Git history visibility and recoverable failures.
- Browser delivery, minimal HTTP API, health/readiness and one OCI image built from a pnpm/TypeScript monorepo.

### Core excludes
- Embedded LLM/provider routing and model execution.
- NLP/tokenizers, speaker attribution/evaluation, transformers, embedding, rerankers, semantic search.
- Story graph, advanced bible/threads/world-state, narrative diagnostics and generated proposals.
- Full third-party plugin SDK, generic container orchestrator, deployment control plane and unrelated Arcadia UX.

Excluded data may remain in the author's Git repository; the Core never deletes unsupported sections during ordinary writing.

## Data and mutation model

1. **Canonical store**: Git-controlled YAML and Markdown under work-owned paths; indexes/caches are reconstructible derivatives.
2. **Project isolation**: no cross-project reads, shared writable workspace roots, or credentials in build artifacts.
3. **Single writer**: all persistent project mutation flows through a project-scoped coordination boundary, independent of REST transport.
4. **Freshness**: each save checks a revision or content hash. Stale saves fail without overwriting other changes.
5. **Failure semantics**: report partial Git sync, conflicts, and persistence errors truthfully. No silent fallback to a stale snapshot.
6. **History**: a user can inspect saved revisions and safely distinguish local commits from remote synchronization.

UI/browser state may cache unsaved drafts, but must not replace the canonical repository or erase those drafts on a server conflict.

## Modules and dependency direction

```text
Web / REST
    ↓
Application actions + Core project services
    ↓
Git workspace + canonical file store
```

Optional future modules depend on an explicit Core capability surface; Core must never import optional modules. Modules are separate pnpm workspace packages. The default image is a **single** OCI image and must exclude unused heavy packages, native runtimes and model weights from its dependency closure.

A disabled module is not merely hidden UI. Module code, routes, jobs, startup hooks, model loading and unnecessary native dependencies must be absent from a minimal build or provably dormant in a feature-bearing build.

Independent module containers are out of scope. Only adopt them later when remote compute, fault isolation or independent scaling measurably warrants the extra operational complexity.

## Migration sources and provenance

Source: `yohn-jp/arcadia-loom` (private), reviewed at main `edc033c2c9466274a334299dadfa426661d957d9` (2026-09-27).

Review source areas by responsibility before copying:
- `packages/schema`, `packages/core-shared`: manuscript/scene types and format validation.
- `packages/workspace`: Git clone, project ownership, synchronization and credential boundary.
- `packages/core/src/projectStore.ts`, `authoringService.ts`, `queryService.ts`: project storage, reading, writing and indexes.
- `packages/api`: authenticated project routes, writer lock, mutation safety, revision checks.
- `app/src`: essential editing, navigation, draft resilience and manuscript typography.

These are **candidate sources**, not a wholesale copy list. Avoid importing source `packages/core` as-is: it includes LLM, ONNX, Transformers, tokenizer and speaker/NLP dependencies. Reconcile transitive dependencies before import.

Import only source for which public release rights and provenance are established. Do not copy private Git history, manuscripts, user workspaces, tokens, cached model files, or third-party assets without publication rights.

## Fixed minimal acceptance

- Core works end-to-end without optional modules or model credentials.
- GitHub repository connection, work navigation, draft editing, safe save, history view and remote sync are demonstrable.
- No NLP/LLM runtime imports in the built Core application.
- `pnpm` is the workspace/build tool; TypeScript remains the product implementation language.
- Release is built from one Dockerfile into `ghcr.io/yohn-jp/scriptorium` (target; not yet published).
- Public source, security documentation, development and contribution path are complete and accurate.

## Out of scope until accepted separately

No feature parity claim for Arcadia Loom's extensive Narrative IDE, no module container fleet, and no assumptions that existing incomplete MCP-first migrations have already been certified.
