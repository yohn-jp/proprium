# Scriptorium — Internal Boundaries and Maintainability Contract

> This is a normative architecture contract, not an audit log or implementation-status report. It defines the desired responsibility boundaries regardless of branch, release or verification date. Execution evidence belongs in tests, Issues, PRs and verification records.

## 1. Authority and architectural decision

This contract refines the internal implementation boundaries of [Core](CORE.md), [Full Migration](FULL-MIGRATION.md) and [Modular Workspace](MODULAR-WORKSPACE.md). It does not replace their canonical Git, recovery, module, authorization or presentation contracts. The independently planned [Public Plugin Platform](PLUGIN-PLATFORM.md) is a separate architectural capability; an internal refactor does not confer untrusted-plugin isolation.

**Decision:** retain one Git authority, one browser recovery authority, one HTTP admission boundary and one shared authoring coordinator. Reduce complexity by removing duplicated behavior and separating pure computation from effects and presentation. Do not introduce a second state owner or a new framework to accomplish the separation.

### Dependency direction

```text
DesktopShell / MobileShell / Workspace presentation
                   |
     Shared authoring coordinator
       |             |             |
  browser journal  checkpoint   typed HTTP client
  (draft authority)  protocol          |
       |             |          Fastify admission
       +-------------+                 |
                                 CoreStore (writer)
                                       |
                           immutable Git snapshots / Git

Built-in module registry (contracts) -> Module Runtime and browser DTO validation
Optional modules -> host capabilities / proposals -> the same Core writer
Workspace manifests + CI inventory -> verification -> exact-source certification
```

Dependency arrows express authority, not direct package imports: the browser does not import server Core. Module code is never an owner of Git writes, browser recovery, authentication or HTTP admission.

## 2. Invariants that every refactor preserves

1. **Canonical data:** Git-controlled project files and immutable snapshots are the document authority. Browser IndexedDB is the authority for the local recoverable draft until its durable transition is confirmed; caches, layouts and derived indexes are not manuscript authorities.
2. **Separate durability states:** Draft, local Checkpoint, confirmed GitHub publication and publication-unknown remain distinct. A local commit, network acknowledgement or optimistic UI does not mean remote publication.
3. **Single writer and optimistic concurrency:** project mutations pass through the existing Core lock, authorization, repository identity, read/write preconditions, proposal approval and safe normal Git push. No forced publish, prose auto-merge or hidden mutation.
4. **Recoverability:** retry retains operation ID, generation, repository/author scope, proposal binding and receipt semantics. Abort, response loss, stale snapshot, IndexedDB error and container replacement do not silently discard outstanding records.
5. **Foreground correctness:** CodeMirror input/IME and the latest editable text remain immediately authoritative. Slow network, background polling, deferred React publication or stale navigation responses cannot replace that text.
6. **Profiles and trust:** Core-only authoring has no dependency on optional model or module execution. Built-in modules remain trusted; supervised child processes and dynamic browser imports are not third-party security sandboxes.
7. **Verification truth:** the same submitted source revision must satisfy every required source, test, browser, OCI and native Hosted check in the canonical CI inventory. Conditional skips and external acceptance not exercised are not passing evidence.

## 3. Browser checkpoint protocol: one side-effect sequence

The normal user checkpoint and recovery of an authorized pending entry shall invoke **one internal checkpoint protocol**. This is an orchestration of existing IndexedDB and HTTP effects, not a fictional atomic transaction across the browser, server and Git.

The protocol owns exactly this ordered effect chain:

1. Confirm the caller-provided entry, immutable repository identity and author scope are the ones authorized for this attempt. The normal and recovery callers retain their own eligibility checks.
2. Persist the existing journal entry as `checkpointing`, retaining its operation ID, generation, proposal identity and recovery metadata. Emit the state transition to presentation only *after* the IndexedDB write resolves.
3. Propose the unchanged operation through the existing typed API; durably retain the accepted proposal in the browser journal and its binding to the entry.
4. Request author approval through the existing boundary, then checkpoint that exact operation.
5. Persist the returned checkpoint receipt and `checkpointed` state before removing the now-redundant local proposal record. Proposal cleanup is best effort, never the source of a false save confirmation.

The checkpoint protocol should be a small non-React application module (for example `app/src/application/checkpoint-protocol.ts`) receiving the existing API and BrowserJournal interfaces. It must not independently construct a Core writer, maintain a second global edit store, or implement a parallel save/recovery state machine.

The normal checkpoint caller owns busy/status and immediate editor presentation. Recovery owns replay eligibility, error preservation and reconciling remote operation receipts. The coordinator owns navigation/author-generation fencing. Network effects in flight may complete after navigation; only still-current results may update the visible scene. An unused generation argument must either acquire a defined purpose at the caller boundary or be removed.

Any ambiguous checkpoint result remains recoverable and must be reconciled against existing operation/receipt identity. A 409/412 conflict is projected as a conflict only under the existing validated contract; transient errors and lost responses must not be interpreted as successful publication. Replay must never allocate a new semantic operation identity or double-apply a completed operation.

## 4. Shared authoring coordinator and presentation

`SharedApplication` is the composition root for authoring behavior, not a place to implement a second copy of each service. It owns only the active author/work/editor session, navigation generation, coordination of recovery, network observation and commands exposed to Desktop and Mobile.

- Keep the existing synchronous editor/session reference and bounded deferred React publication: render state is a projection, not a second write authority.
- Extract **presentation-only** sections (library/outline, document/inspector, status/recovery visibility, and available panels) into small components receiving explicit data and callbacks. A component extracted solely for its line count is not an improvement.
- Keep the existing Desktop and Mobile entrypoints and distinct Shell implementations. Sharing behavior must not collapse touch/keyboard and desktop interactions into a viewport-switched component.
- Keep journal reconciliation and navigation guards owned once. If a self-contained application hook is extracted, it must not duplicate the session, timers, abort signals, author scope or polling across hooks.
- Workspace layout and module panels consume permission-checked host contributions; they do not own manuscript durability, write receipts, repository synchronization or Git authority.

Minimal design target: the authoring coordinator chooses *what* state and commands are available; presentational components decide *how* to render them; the checkpoint protocol decides *how one checkpoint attempt proceeds*. Do not add Redux, an event bus, a DI container or new observable state infrastructure.

## 5. Built-in module identity and extensibility

Define a single `BUILTIN_MODULE_IDS` readonly tuple in `@scriptorium/contracts` and derive the internal `ModuleId` union from its values. The existing IDs and contract wire values remain compatible.

- Module Runtime's membership validation and browser HTTP DTO guards consume this value rather than independently maintaining a list of recognized built-in IDs.
- Build profiles, manifests, registered workspaces and CI inventories may retain their own *responsibilities*; where they enumerate the installed built-ins, executable conformance checks must reject missing or extra IDs. Do not rely on `satisfies readonly ModuleId[]` alone as proof that every ID is registered.
- Importing the identifier metadata must not load module implementations, native models or workers into the Core-only dependency closure. Runtime activation stays lazy and capability-scoped.
- This internal, closed built-in vocabulary is not the public Plugin ID namespace. Public manifest/ABI negotiation and untrusted execution isolation remain governed by `PLUGIN-PLATFORM.md` and require separate acceptance.

## 6. Core computation versus Git effects

`CoreStore` remains the sole owner of project registry, identity, Git I/O, immutable snapshot lookup, lock, proposal lifecycle, approval, reconciliation, checkpoint, publish and failure projection. Its large size does not authorize splitting these effects across multiple competing services.

Extract a cohesive internal pure operation/proposal-record module when reorganizing Core (for example `packages/core/src/operation-records.ts`): canonical normalization, record validation and deterministic digest helpers. Import these helpers back into `CoreStore`; do not change the public Core API or persist a second copy of the record.

**Byte identity is a contract:** preserve operation normalization field order and `JSON.stringify` hashing semantics where used; preserve canonical JSON semantics for proposal digests. The two algorithms must not be unified for style. Persisted metadata, receipts, revision hashes and reconciliation must remain readable across old/new binaries. Locking and cached immutable read-model behavior must remain unchanged.

Do not use this extraction to rework `observe`, `reconcile`, snapshot caching, the Git process layer, the HTTP routes or performance candidates already declined by evidence. Those changes require their own contract and measured need.

## 7. API admission stays centralized

Fastify's shared request handler remains the admission boundary for authentication, Hosted authorization, CSRF/origin checks, quiesce/drain, request cancellation, activity accounting and error serialization. Domain handlers may be isolated **inside** this boundary when a specific behavior change is proven; route-table fragmentation or a second authorization adapter is not part of internal maintainability work.

Hosted authorization dependency outages must remain distinguishable from authentication failures (502/503 versus 401/403), and previously successful JSON responses must continue to be validated at the browser boundary. Neither concern warrants weakening authorization or duplicating validators.

## 8. Verification graph is declarative, not inferred from prose

`scripts/ci-contract.mjs` retains authority for the required CI job inventory, browser/profile coverage and exact-source certification. Each package's own `package.json` defines its test command and necessary self-build; workspace dependency manifests determine dependency preparation.

`scripts/ci-workspace.mjs` must **not** infer per-workspace unit-build requirements by splitting and regex-matching the root `package.json` `test` command. A formatting change to root orchestration must not change per-workspace test prerequisites. Prefer existing package scripts and the declared workspace dependency graph over additional parallel registries or custom task runners.

Preserve mandatory coverage detection, frozen installs, production and test-source typing, scoped safety checks, unit tests, Core/Full build and dependency audit, browser matrices, OCI startup, native Hosted composition and the exact-main-SHA fail-closed certification. Maintain release immutability and explicit `NOT_CHECKED` reporting for unavailable external prerequisites. Do not trade away any accepted gate to make the workflow look simpler.

## 9. Structural acceptance contract

| Boundary | Executable proof required |
| --- | --- |
| Checkpoint protocol | Normal and recovery entrypoints use one effect sequence; injected failures at journal/propose/approve/checkpoint/receipt/cleanup preserve recovery, ID and scope; lost response is reconcilable; existing real browser/Core durability tests pass |
| Shared authoring UI | Desktop and Mobile use the same session and authorized commands without shared layout; editor/IME, scene-navigation generations, replay after reload, panel unmount and error/status visibility retain their behavior in real browser cases |
| Built-in registration | Type derives from one canonical value; Runtime and DTO guard accept exactly the known built-ins; all supported profiles, manifests and CI registrations are checked for omissions and extras; Core-only closure stays clean |
| Core pure helpers | Golden operation/proposal digests, serialized records, stale preconditions, replay, conflict, path safety and one-writer semantics match the prior behavior and acceptance fixtures |
| CI workspace preparation | Independent unit-target preparation remains valid if root test orchestration is reordered without semantic change; current CI inventory, all gates, exact-source attestation and release-policy deny cases still pass |

Run focused assertions at each changed boundary before full integrated verification. Report source SHA, commands, test outcomes and conditional skips precisely. A typecheck or a green historical run is not an executed browser, hosted deployment, release or model acceptance.

## 10. Implementation and evolution rules

- Consolidate the checkpoint protocol before extracting UI presentation that depends on it. The built-in ID, Core pure helper and CI workspace-preparation changes are otherwise independent and may be implemented in isolated worktrees.
- Assign exactly one owner to each shared contract or touched implementation file. Integrate dependent changes against the actual accepted producer SHA, not sibling uncommitted files. Keep the set of changes bounded; finish each boundary with its focused tests before composing the next.
- Prefer deletion of duplicate code and dependencies to new interfaces. If an extraction adds more concepts than it removes, keep the existing owner and narrow the extraction.
- Issue state, implementation state and verification state are separate. Resolve historical lifecycle Issues by mapping each original criterion to real evidence; an open Issue alone does not mean an absent feature. Do not reopen completed migration work or silently claim previously unexecuted external validation.
- Evolve this document when the *design contract* changes, not by appending audit dates, HEAD snapshots, transient job counts, benchmark tables or implementation diaries. Store those in Issues, PRs and versioned verification evidence.

## 11. Non-goals

Rewriting Core Git persistence, adding an ORM or database authority, changing user-visible checkpoint semantics, automatically publishing a checkpoint, unifying Desktop/Mobile visual shells, creating a new routing framework, introducing a state-management platform, implementing the public third-party Plugin SDK/sandbox/marketplace, re-running completed migration phases, changing production resources or publishing OCI images solely because of this refactor.
