# Recovery Architecture — Generic Git Host + Authoring Products

## Decision, not a proposal

Proprium Core **MUST remain a generic Git/file editor**. Its one authoritative publisher is the selected GitHub repository; it owns Browser Git, file reads/writes, revision/branch identity, editor life cycle, journaling, checkpoint, explicit publish, proposal admission, navigation, layout, plugin signing/admission, scheduling and Host-rendered UI. It MUST NOT require `plot/`, `bible/` or `manuscript/` to open a repository.

The authoring product is an **official independently distributed plugin suite**. A curated Writer installation/preset may install/enable the entry plugin after explicit user consent; the generic zero-plugin editor remains operational. A plugin may interpret a repo as an Arcadia-format work only after validating its files. It must not silently upgrade, rewrite, relocate or discard unknown files. Author experience is a user-visible product capability, not a developer-oriented `plugin_call` textbox.

Recovery is prioritized by the ability to **resume, write, protect and verify a scene**; not by historical package/module counts, implementation convenience or plugin size.

## Runtime and trust topology

~~~text
GitHub remote (published authority)
            ^    explicit non-force publish, verified reachability
            |
Browser Host (trusted TypeScript; static, local-first)
  ├── Browser Git worker / journal / draft / checkpoint / reconciliation
  ├── Editor + Japanese typography + IME + reading + layout + mobile sheet
  ├── Typed Action Registry + snapshot/revision + single writer
  ├── Approved ChangeSet review/apply + Host UI renderer/navigation
  ├── Registry trust/admission + plugin lifecycle + derived-cache broker
  └── Plugin Workers (independent signed WASM components; no DOM/Git tokens)
       ├── proprium.narrative ── required authoring work format
       ├── proprium.knowledge ── Bible, entities, threads, world state, lenses
       ├── proprium.research ── scoped lexical search, terminology, light NLP
       ├── proprium.paired-writing ── context, evidence, ChangeSets, MCP workflow
       ├── proprium.diagnostics ── textual, continuity and structural diagnostics
       ├── proprium.speaker ── attribution, corrections, dialogue/voice evaluation
       ├── proprium.semantic ── opt-in embedding/reranking acceleration
       └── proprium.publishing ── local export and opt-in publication features

MCP client --Cloudflare Access--> optional Go Gateway --SSE/HTTP--> active Browser Host
                                      no repository database or tool grants
~~~

The eight names above are **plugin product boundaries**, not eight top-level tabs. Multiple contributions from one plugin belong in the relevant existing Host panels; a capability provider can be loaded without its own UI panel. Do not forcibly combine all knowledge/diagnostics into one module, nor split each small feature into its own package.

### Why these boundaries

- `narrative` owns the **work format and hierarchy**, including volume/chapter/scene navigation and authoring continuity. It does not own the generic editor's DOM, Git or recovery journal.
- `knowledge` owns **structured narrative semantics**: entities, relations, world state, events, reader knowledge, threads and time-bound graph projections. It can run without LLMs.
- `research` combines lexical search, terminology, lightweight Japanese text analysis and term discovery because author navigation and terminology share one indexed source. It has **no required embedding/model download**.
- `paired-writing` combines context provision, canonical narrative actions and reviewable ChangeSet workflows that UI and MCP must share. It does **not** host models or duplicate the MCP HTTP transport.
- `diagnostics` owns provenance-bound warnings and editable suggestions (structural, lexical, style, declared-state) but never auto-fixes the manuscript.
- `speaker` owns the separately calibrated, feedback-heavy attribution/evaluation pipeline and authoritative corrections. It deserves independent lazy lifecycle.
- `semantic` owns optional model/digest/embedding/reranker lifecycle; it augments research/diagnostics rather than fragmenting search UX. High-memory work can be disabled without disabling search.
- `publishing` owns export scope, EPUB/print/text and controlled sharing metadata. Browser export is usable without a hosted server; share links require separately available service support and MUST NOT pretend to work offline.

The Core/Gateway `repositories_list`, `file_read` etc remain stable regardless of plugin presence. Official plugin-specific actions are discovered and called **through the same typed action registry / existing `plugin_call` facade**; missing/disabled plugins return typed unavailable, not hidden subsets or invented core APIs.

## Data authority and typed identity

All calls and results carry a scope key (`repository_id`, `branch`, optional `localWorkspaceId`, `snapshot/commit+overlay`, generation), and when scene-related, (`work/series identity`, `volumeId`, `chapterId`, `sceneId`, `manuscriptPath`, `document revision/hash`). The project ID from an old server is **not** interchangeable with the immutable GitHub repository ID. Mapping legacy source IDs requires an explicit verified association.

Accepted story files retain the existing on-disk layout:

~~~text
bible/characters/*.yaml              bible/locations/*.yaml
bible/items/*.yaml                   bible/factions/*.yaml
bible/lore/*.yaml                    bible/timeline/events/*.yaml
bible/dialogue_sketches/*.yaml       plot/threads/*.yaml
plot/arcs/*.yaml
plot/volumes/<volume>/volume.yaml
plot/volumes/<volume>/chapters/<chapter>/chapter.yaml
plot/volumes/<volume>/chapters/<chapter>/scenes/<scene>.yaml
manuscript/<volume>/<chapter>/<scene>.md
meta/scriptorium/modules/<module>/...   (existing author state)
meta/proprium/plugins/<plugin-id>/...   (newly approved plugin state only)
~~~

A scene YAML references its body using `manuscript`. Do not derive the authoritative Markdown path from scene ID when the explicit link differs. Preserve ID, ordering, unknown YAML keys, markdown frontmatter, author annotations, Ruby/Aozora syntax and unrelated files. Reordering is a guarded semantic operation; never rewrite a whole hierarchy from a stale list. Non-Arcadia repositories continue to edit as normal Git workspaces.

**Four classes of state**: (A) Git-authoritative story/author corrections/settings/approved changes, (B) browser-recoverable unsaved Draft, (C) local unpublished Git checkpoint, (D) disposable derived indexes, embeddings, diagnostics and worker caches. Do not confuse a verified local checkpoint with remote publication; ambiguous publish remains unknown, not success. Old `.arcadia/`, `meta/scriptorium/` and migration records remain accessible/read-only until a separately approved conversion is verified. Never delete before identity, byte and semantic round-trip audit.

## Single mutation boundary

- Plugin code **cannot mutate** Git, local storage, the DOM or remote refs. Its persistent effects are versioned `ChangeSet` proposals containing goal, ordered operation IDs, affected paths/entities, exact snapshot/revision/preconditions, complete read/write sets, evidence/quote/source location, risk/confidence, and a deterministic preview.
- UI, MCP and plugin actions call **one** typed action implementation. The Host single writer checks branch/workspace scope, revision and stable idempotency key before applying a *reviewed subset of dependency-closed units*; operation success and resulting revisions must be returned for each approved operation. A multi-file unit is all-or-nothing in the local writer or reports truthful partial state with a recoverable receipt; never label partial application atomic.
- No external assistant, background job, plugin or retry can approve its own proposal, rewrite an uncommitted editor draft, automatically checkpoint, auto-publish or silently replay an uncertain operation. The author can reject without changing Git.
- UI active editing and MCP proposals use the same authoring constraints. A changed base -> `stale_precondition`, explicit rebase/review; content is never merged by generic string concatenation. Use browser journal/operation IDs to guard asynchronous responses after scene switch, focus change or disconnect.

## Foreground UX is the product invariant

**Desktop**: structure/navigation as the left default; manuscript and reading as the central stable surface; Context / Inspect / Changes as selection-following contributions, with full Review or Lens in normal Host dock/modal for complex work. **Mobile**: writing-first navigation, continue/capture, read, structure/reference sheets, review queue and sync status. No surprise editor remount on panel switches. Plugin failure cannot unmount or cover an unsaved manuscript.

A *Writer preset* is a saved editable arrangement (`Writing`, `Research`, `Review`) of Host panels and enabled plugin contributions, not three products or three permanent state machines. Plugins declare stable panel IDs, context and shortcuts; the Host alone mounts them, manages focus/IME, keyboard/mouse/touch and layout persistence. Japanese vertical-rl, ruby, typography presets, 400-character sheet counts and reading continuity remain available through the Host editor even without plugins; narrative plugin supplies scene semantics and location. The plugin supplies no DOM/CSS.

**Required writer loop**:

~~~text
Open repository → discover validated work → resume volume/chapter/scene
→ draft and recover Japanese manuscript → context / search / story knowledge
→ optional external LLM via MCP gets exact scoped context and evidence
→ ChangeSet proposal → author review / selective accept / reject
→ revision-checked apply → diagnostics/history tied to resulting snapshot
→ return to same manuscript scene + caret/selection/scroll → explicit checkpoint/publish
~~~

A no-provider, no-Semantic, no-Gateway path must still open, write, inspect, checkpoint and return. Where MCP is enabled, Gateway forwards to the active Browser Host; it never imports old Scriptorium Node server behavior.

## Execution and dependencies

~~~text
Hard dependency DAG (A -> B means B requires A):
H0 -> Narrative
H0 -> Research                         (generic-file mode)
Narrative -> Knowledge, Paired Writing, Diagnostics, Publishing
Knowledge -> Speaker                   (Speaker also requires Narrative)
Research -> Semantic

Optional Host-orchestrated enrichments (not activation dependencies):
Narrative labels -> Research
Knowledge/Research/Speaker/Semantic results -> Diagnostics
Research tokenization/Diagnostics generic text values -> Speaker
Knowledge/Research/Diagnostics/Speaker/Semantic values -> Paired Writing
Semantic results -> Research search UI / Knowledge term candidates
Knowledge values -> Semantic richer hypotheses
~~~

P0/P1/P2 are **dependency and author-value priorities**, not fixed dates or permission to omit P2. Shared Host interfaces and a narrow certified first authoring slice come first; other plugin algorithms, documentation and fixtures can be ported in parallel as soon as their contracts are defined. See [Acceptance & Execution](ACCEPTANCE.md) for a parallel single-integration-branch plan and no-false-green gates.

## Compatibility and non-goals

- No switch back to an always-on Node application, OCI profile composition, mandatory schema in Git Core, new per-user DB, arbitrary WASM DOM access, hidden cloud model orchestration or server-side Git workspace.
- Retained `modules/*`, `packages/core`, `packages/migration` and Scriptorium UI are **sources to port**, not activated plugin code. Scriptorium's 9 package names are not the plugin partition, and TypeScript Node-only modules must not be loaded directly as browser/WASM guest code.
- Never trade Japanese IME correctness, draft durability or author approval for faster feature-completion claims.
- Owner-authorized extraction from Arcadia must respect source provenance: port application logic and owned UI intent, never private manuscripts, credentials, model weights or third-party assets without redistribution rights.
- No force push, global Git rewrite, hidden bulk YAML formatting or compatibility alias that keeps a second writer alive.

**Source anchors:** [Scriptorium Modules](https://github.com/yohn-jp/scriptorium/blob/95a66c2c985a66bc2d535392dcc450d8c9df18d5/docs/architecture/MODULES.md), [Scriptorium UX Contract](https://github.com/yohn-jp/scriptorium/blob/95a66c2c985a66bc2d535392dcc450d8c9df18d5/docs/design/UX-CONTRACT.md), [Arcadia PRODUCT](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/PRODUCT.md), [MCP-first Narrative IDE](https://github.com/yohn-jp/arcadia-loom/blob/edc033c2c9466274a334299dadfa426661d957d9/docs/design/mcp-first-paired-writing-target-architecture.md).


## Partition and single-owner audit

The eight product boundaries are retained. The historical Story package is split by canonical responsibility: Narrative owns hierarchy/manuscript routing, Knowledge owns authored entities and semantic scene metadata; neither creates a second scene identity. Search+light NLP are merged into Research because aliases, source spans and lexical navigation complete one author task. Heavy Semantic and Speaker remain independently disableable due to distinct model, calibration and memory lifecycles. Publishing keeps local portability separate from service sharing within one independently packaged product; no ninth tiny export plugin is required.

| Shared-looking feature | One canonical owner | Consumer rule |
| --- | --- | --- |
| Generic file/editor/draft/save/recovery/checkpoint/publish | Host | Narrative supplies IDs and navigation intent; no plugin save authority |
| Hierarchy/create/reorder/manuscript linkage | Narrative | Knowledge cannot alter hierarchy fields through entity metadata patches |
| Bible, voicePatterns, appears/mentions, saved dialogue sketches | Knowledge | Speaker consumes authored voice intent; Paired generates sketch suggestions |
| Lexical ranking, aliases, term registration, NLP term candidates | Research | Semantic contributes optional scores/clusters, never duplicate lexical index authority |
| Deterministic continuity and contradiction decisions/dismissals | Diagnostics | Semantic contributes uncertain embedding candidates; merge by source/rule identity once |
| Dialogue attribution/confirmed override/evaluation | Speaker | Diagnostics consumes values; no mutual required package imports |
| Assistant first-read, rewrite/continuation, provider settings, context/ChangeSet ingress | Paired Writing | Diagnostics displays external commentary separately from deterministic findings |
| Export assembly, episode mapping, conditional reader sharing | Publishing | Host owns artifacts/download/print and explicit Git publication |

A conceptual consumer arrow is not permission for recursive action dispatch. Host orchestration resolves required providers in topological order, passes immutable values to optional consumers, and detects recursion. Research -> Semantic required dependency cannot become Semantic -> Research -> Semantic invocation. Every required provider missing/disabled is a visible feature-specific error; optional missing providers produce an explicit coverage warning and preserve the baseline task.

### Author data precedence

Existing YAML/Markdown and module metadata remain canonical at their existing path. New plugin metadata paths are used for genuinely new data or an explicitly approved migration with a verified no-loss round trip; never select a new path merely because the plugin has been renamed. Duplicate old/new records with different values produce a migration conflict, not last-writer-wins. Scene YAML `speakerOverrides` is current attribution authority; correction JSONL is immutable audit/evaluation evidence. Authored Knowledge `voicePatterns` is intent; Speaker/Diagnostics measurements remain derived observations. Git-stored consent/model preference is never an execution grant. Diagnostic dismissals are authoritative human decisions even when the originating candidate was Semantic.

### Delivery priorities

H0 includes discovery/installation and functional UI as well as the v2 logical schema in the Host contract. P0 then completes recognized-work -> correct manuscript -> continue writing -> local save/recovery -> reviewed chapter/scene creation/reorder. P1 makes long-form work practically usable: Knowledge references/state, model-free Research, optional external collaboration and provenance-bound Diagnostics. P0 completion alone never means complete product restoration. Basic UTF-8/EPUB export is an **early portability slice after H0+Narrative**, implementable in parallel with P1; advanced print/sharing remains P2. Speaker/Semantic remain independent P2 compute, never prerequisites to write, search or export. Model absence and Gateway absence must not break any local baseline.
