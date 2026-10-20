# Scriptorium — Modular Workspace Architecture

**Status:** Implemented on `main` under the Modular Workspace goal; implementation boundaries and acceptance evidence are recorded in [Modular Workspace verification](../verification/MODULAR-WORKSPACE.md).

**Baseline inspected:** `main@a0419c499d47d51584bda649790c45082998bfed` (2026-10-19).  
**Authority:** This document defines the new modular workspace, local-first read UX, and extensibility direction. Existing `CORE.md`, `FULL-MIGRATION.md`, Git durability, module security and recovery contracts remain authoritative for behavior not explicitly addressed here. The completed P00–P13 migration ledger is not reopened.

> **将来設計との関係:** 本書は既に実装済みのComposable Workspaceと**信頼された内蔵Module**の現在の契約を説明する。2026-10-20に合意した**公開Plugin SDK・外部リポジトリ・強制実行隔離**の目標は[PLUGIN-PLATFORM.md](PLUGIN-PLATFORM.md)に定義した。既存のin-process ModuleやBrowser `import()`を第三者コードに対する安全Sandboxと見なさない。導入は別Waveで実装・検証する。

## 1. Product decision

Scriptorium is a Git-backed writing environment whose interface is assembled from movable, replaceable components. It ships usable workspace presets and allows users to construct and persist arbitrary layouts. Search, terminology linking, NLP, Semantic and other advanced features are optional modules on top of a small, usable Core.

The three product goals are:

1. **Perceived immediacy.** Local reads, editor input and navigation take precedence over auxiliary or remote work. Only state required to perform the current action is on its critical path; everything else runs independently, lazily or in parallel where dependencies allow.
2. **Composable workspace.** Editor, outline, search, terminology, inspector, history and module panels are independently positionable. Presets are starting configurations, not locked UI modes; the user may customize them completely.
3. **Optional discoverability.** Full-text search, term resolution and non-destructive automatic links are standard *plugin capabilities*, not prerequisites for Core authoring. Advanced NLP/Semantic features retain separate, optional ownership.

These goals must not weaken manuscript durability, revision preconditions, authentication, project isolation, accessibility, or the minimal Core profile.

## 2. Existing foundation and gaps

Verified against the baseline:

| Area | Existing implementation | Intended evolution |
| --- | --- | --- |
| Git/Core | `packages/core/src/index.ts`: local project clones, immutable Snapshot reads, explicit observation, checkpoint, reconcile, publish; hierarchy cache and paired scene reads | Separate the minimal foreground read path from nonessential coordination; expose efficient document enumeration/change deltas to optional consumers |
| Core contracts | `packages/contracts/src/index.ts`: `SnapshotId`, `SnapshotReader`, actions, `ModuleManifest`, `UiContribution` | Add only the minimal versioned ports required by workspace composition and incremental indexing |
| Module runtime | `packages/module-runtime`: manifest/profile gating, activation, capabilities, worker lifecycle | Reuse; do not create a second plugin framework |
| Browser contributions | `ContributionHost.tsx`: lazy browser loader, `mount`/`dispose` and abort signal; `UiContribution.slot` fixed to editor/dock/inspection/review/settings | Host registered panel instances in user-controlled layout positions; preserve lifecycle and capability checks |
| UI | `SharedApplication.tsx`, desktop/mobile shells and scene editor | Introduce a workspace composition controller independent of individual panels |
| Existing advanced modules | `modules/{story,nlp,diagnostics,semantic,speaker,assistant,publishing,mcp}`; `profiles/core.json` excludes them | Preserve these boundaries; add lexical search/terminology as optional capabilities without dragging model dependencies into Core |
| Search today | Core snapshot search actions and optional Semantic search already exist | Do not claim search is absent or remove existing entrypoints before migrating consumers; distinguish Core's current lexical read operation from the proposed optional indexed search |

The diagram below describes responsibility boundaries; concrete implementation and verification are recorded in the linked acceptance record.

```text
Browser Workspace
  ├─ Layout Controller (presets, arbitrary dock/split/resize, persistence)
  ├─ Core panels: Editor / Outline / History / Review
  └─ Optional contribution instances: Search / Terms / NLP / Semantic / ...
        │ permitted actions + read-only contexts
        ▼
Composition Host (existing ModuleRuntime + BrowserModule host)
        │
        ├─ Optional Search & Terminology capabilities
        ├─ Existing NLP / Semantic / Story / other modules
        └─ Shared Core document-source capability
                  │
                  ▼
Core: Local Git / Snapshot / Document Read / Change Coordinator
                  │
           Explicit Observe / Fetch / Publish
                  ▼
                GitHub
```

**Dependency direction:** Core never imports an optional module or its index; modules use Core-owned snapshot/document contracts. Workspace owns arrangement and panel lifetimes, not project mutation. Modules never become independent Git writers.

## 3. Foreground vs background execution

### 3.1 Foreground contract

The foreground consists of: user input, current scene (including the best recoverable draft), current navigation context, visible panel chrome and only the data required by the active action. Rendering the current document cannot require GitHub availability, a Semantic/NLP model, a complete search index, an invisible panel, or a successful optional module load.

A panel requesting data must bind to the project, repository identity, author scope (if authorized) and selected `SnapshotId`. A response for a superseded navigation generation or mismatched snapshot must never overwrite the current document.

### 3.2 Independent work

Remote HEAD probing, fetching when changed, proposal-status refresh, optional module discovery, search indexing, terminology rebuild and non-visible panel activation are independently scheduled. When safe, parallelize unrelated tasks instead of serializing them behind initial navigation. Lazy-load browser entrypoints only when a registered and enabled contribution is actually needed; heavy analysis and models remain optional.

**Correctness boundary:** Browser recovery of pending drafts/checkpoint receipts is not merely decorative auxiliary work. The current scene may be displayed promptly, but until its authoritative local recovery state has been reconciled, it must not be represented as a fully recovered, writable canonical editor. Journal recovery, conflict gates and generation checks take precedence over cosmetic immediacy. Failure preserves the recovery record and surfaces a truthful state; it must not silently discard or overwrite typing.

### 3.3 Remote observation

A remote HEAD check is the cheap *change detector*, not a reason to re-fetch or re-index an unchanged commit. If repository identity/default branch and remote HEAD are unchanged **and** relevant local checkpoint/operation state is unchanged, avoid remote fetch, tree rebuilding and unnecessary reconciliation of that same revision.

A changed HEAD is not automatically safe to apply: verify identity, fetch, preserve local work, reconcile and report conflicts through existing Core rules. Publish/checkpoint authorization and revision validation retain the freshness requirements defined by the existing durability contract. Observation failure reports unknown/stale freshness while already available local data remains readable.

Do not use only the remote SHA as a universal invalidation key: checkpoint overlay, local operation revisions, author-scope draft generations and module-specific indexed document revisions can change without remote HEAD moving.

### 3.4 Read model and cache

Core owns a reconstructible read surface keyed by repository identity plus immutable remote/overlay revision. A bounded cache may hold hierarchy, scene/path lookup and immutable Git object metadata; current mutable draft state must be kept separate. Preserve symlink, path, revision and snapshot reachability validation at the trust boundary.

Expose efficient **document enumeration, bulk reads and changed-path calculation** via the existing snapshot abstractions where needed. Avoid introducing a separate materialized database as the manuscript authority. An index is disposable and rebuildable; failures do not block Core writing.

## 4. Workspace composition

### 4.1 Vocabulary and ownership

- **Panel definition:** A stable contribution ID, provider module, title, capabilities and supported contexts. It specifies *what* can be mounted, not *where*.
- **Panel instance:** A placement of a definition in a layout, with an instance ID and only permitted view-local settings. One definition may support more than one instance if the implementation declares that safe.
- **Workspace layout:** A tree of split, stack/tab and leaf nodes with panel-instance references and sizes. The layout controller manages drag/drop, docking, resize, tabs, hide/show and focus.
- **Preset:** A versioned initial layout plus a declared fallback for unavailable optional panels. Applying a preset creates an editable user layout.
- **Workspace state:** User/device UI preference; never manuscript YAML/Markdown, repository commits or Git history by default.

Core authoring panels (including Editor) remain available without modules. Optional modules may contribute full panels, editor adornments or contextual actions. These are distinct contribution kinds; do not force an inline text decoration into a dockable panel. One module may contribute several items, and multiple modules may contribute to one editor surface.

### 4.2 Composition constraints

The workspace host owns component mounting and lifetime. The module owns its rendered content, but cannot set global layout or bypass host actions. Modules receive only permitted, snapshot-scoped context; they cannot read another project or invoke mutation APIs without the existing proposal/approval flow.

Minimum layout semantics:
- Arbitrary user reordering and placement across allowed containers; horizontal/vertical splits, tab groups, resizing and hiding.
- Presets for **Writing**, **Research** and **Review** as initial compositions (exact default panel selections are UX configuration, not Core semantics).
- Save and restore a custom workspace, distinguish desktop/mobile arrangements, and persist schema version.
- Unknown/disabled/uninstalled contributions are omitted from rendering with a recoverable placeholder or reversible layout fallback; other panels remain usable.
- Mobile offers accessible alternative panel navigation without assuming desktop drag gestures; keyboard controls and focus restoration remain supported.
- Loading/closing/switching panels cancels pending requests, disposes module mounts and releases optional resources; unsaved manuscript drafts are not discarded.

The layout schema must be validated before use, including depth, size, IDs, duplicate panel instances and permission to mount each contribution. Malformed persisted state falls back to an accessible Core preset without deleting the prior state until the user explicitly saves a replacement.

### 4.3 Persistence and synchronization

Workspace layout is scoped to user/author identity and device class. It is not part of the Git canonical manuscript data and must not be written by repository sync. Initially, host-managed browser persistence is sufficient; cross-device user settings synchronization is a separate decision and must not be assumed.

The layout stores declarative IDs/settings, never executable component source, secrets, arbitrary paths or full manuscript contents. Persist preferences independently from IndexedDB draft/checkpoint recovery, with different storage keys and failure handling.

## 5. Search and terminology as optional capabilities

### 5.1 Ownership

- **Core document source:** Snapshot-scoped enumeration, reads and incremental changed-document descriptions. It supplies no semantic ranking and does not depend on search/NLP packages.
- **Standard lexical-search module:** An optional, lightweight local index; full-text, exact term/alias and prefix lookups, scope filters, ranking of lexical hits and bounded result navigation. No model dependency.
- **Terminology capability:** A canonical term registry/aliases/target references and a resolver returning document spans for visible text. Initially it may ship alongside lexical search to reuse the index; splitting into a separate module is not mandatory.
- **Existing NLP/Semantic modules:** Optional tokenization, extraction, embeddings and semantic ranking. They may enhance or contribute separate search modes through declared capabilities; no implicit model loading for lexical search.

Because Core already offers snapshot search and Semantic already implements search behavior, implementation must inventory existing consumers and preserve their observable contracts before replacing or rerouting them. Avoid building a parallel third search engine by default.

### 5.2 Index lifecycle

An indexed revision is identified by repository/snapshot (including overlay) and the indexed document-set definition. Start from Core's canonical document list; apply deltas for changed paths when available. A remote HEAD change, local checkpoint, document creation/removal, terminology dictionary update or relevant module settings change invalidates only the affected index entries. An index ready for an older revision must not be projected as current.

Build/warm indexes after the foreground scene is ready, in bounded, cancellable work; visible searches may request priority. Plugin installation/enablement controls code loading and any background work. Disabled search leaves Core editor, navigation, history, checkpoint and publish operational.

Index bytes are derived data in bounded plugin-owned cache, not project Git, not the browser recovery journal and not authoritative data. Corruption is discarded and rebuilt without affecting the manuscript.

### 5.3 Automatic links

Resolve known canonical terms and aliases against visible text, producing transient ranges of `(document revision, start, end, target term ID)`. Do **not** mutate Markdown source or Git commits to insert automatic links. Resolve collisions/overlaps deterministically and provide a way to dismiss or inspect an ambiguous match rather than guessing a target.

An editor decoration must not break caret position, IME composition, selection, ruby typography or input latency. Recompute on bounded visible ranges or idle tasks and invalidate on document revision changes. The link target is project-scoped and must be validated on navigation; missing targets degrade to plain text.

The user can navigate links from writing/reading views, search results and terminology panels; no separate untrusted HTML rendering or model output is allowed to introduce executable links.

## 6. Plugin registration and runtime evolution

Extend, rather than replace, the existing `ModuleManifest`, `UiContribution`, `BrowserModuleDefinition` and `ModuleRuntime` contracts. The existing `UiContribution.slot` is a **fixed placement slot** and cannot alone express user-owned arbitrary layouts. A versioned evolution should identify contribution *kind* and supported host context independently of workspace position.

The runtime remains the single activation and capability authority. An unavailable/disabled module contributes neither activated workers nor invisible heavy browser code. Profiles continue controlling the artifact closure; the `core` profile must not transitively depend on NLP/Semantic, optional search or model assets. An enabled module without a visible panel may still run **only explicitly declared, necessary** background indexing/jobs; hiding a panel by itself does not silently start work.

No arbitrary third-party script execution, hot-install system, module-container orchestration or new plugin marketplace is implied. The first implementation targets trusted, build-time-installed modules in the existing profile system.

## 7. State and failure invariants

1. Repository Git remains the durable project authority; `Draft`, `Checkpoint` and confirmed `Saved to GitHub` never collapse into a single save state.
2. Current author edits and recovery state are never replaced by a stale asynchronous read, module result or layout switch.
3. A module's failure cannot prevent minimal Core authoring or delete user work.
4. Optional analysis never mutates manuscripts directly. Changes require Core proposal, authenticated approval and checkpoint.
5. Snapshot-indexed output may be shown as current only for the exact bound revision; stale results are labeled or discarded.
6. Module and panel identity, enabled profile, authorization and repository scopes are checked by the host before mounting/invocation.
7. Layout changes and derived indexes are not persisted as manuscript commits.
8. Unavailable remote service does not block reading locally verified objects; it does block actions whose existing contract requires fresh remote confirmation.

## 8. Implementation sequence and acceptance boundaries

Phases A–C were implemented under the explicit Modular Workspace goal. The following phase boundaries remain the accepted scope; the verification record identifies the production source and observed acceptance results.

**Phase A — Foreground integrity and read scheduling.** Establish an explicit editor-recovery readiness gate, separate render-essential reads from proposal/remote/index work, deduplicate unchanged observation and reconcile work using remote plus local revision keys. Preserve current safety behavior. Core remains usable offline from an existing checkout.

**Phase B — Workspace composition.** Introduce versioned layout/panel identity and validated persistence; adapt the existing contribution host; supply Writing/Research/Review presets and fully editable custom placement on desktop, with accessible mobile equivalents. Keep existing shells operational while consumers migrate; do not permanently maintain parallel UI architectures.

**Phase C — Indexed search and terminology.** Inventory the existing Core lexical search and Semantic module first. Add only required document-source delta/bulk APIs, create a lightweight optional search+terminology capability, wire search panel and editor decoration through existing UI contributions. Add no unconditional NLP/LLM dependency.

Each phase uses the repository's existing validation entrypoints to prove observable behavior, including failure cases and Core-only profile startup; see the verification record for the completed checks and explicit limits. No latency benchmark is required by this architecture decision. Performance is assessed by the elimination of unnecessary critical-path work and code-path review; no unmeasured speed claims.

## 9. Explicit non-goals

- Rewriting the Git storage or durability state machine.
- Replacing existing NLP/Semantic modules or duplicating their indexes without a demonstrated gap.
- Introducing an entire external plugin SDK, arbitrary third-party code sandbox, new database authority or module orchestration service.
- Coupling layout choices to repository data or requiring all optional modules for the Core profile.
- Treating a design-only PR as proof that these features are implemented.

## 10. Architectural decision summary

**Decision:** Local Git Core with a minimal, responsive foreground read model; a host-owned composable Workspace with presets and complete customization; search/terminology and advanced intelligence as optional, capability-based modules.

**Why:** One immutable document authority and one module runtime provide consistent revision identity, minimal startup dependency closure and freely assembled UX without duplicating Git I/O or forcing heavy features onto ordinary editing.
