# Core architecture

Scriptorium is a TypeScript/Node application with a Git-backed canonical file store, a Fastify API and React browser shells. Core authoring works without optional modules or model credentials.

## Ownership and dependency direction

```text
Desktop / Mobile / HTTP / MCP
                ↓
Shared read, propose and approved mutation contracts
                ↓
Core project coordinator + immutable snapshot readers
                ↓
Git objects + canonical YAML/Markdown
```

| Area | Owner |
| --- | --- |
| Revision, operation, snapshot and module contracts | `packages/contracts` |
| Project registry, Git clones, canonical file reads and mutation | `packages/core` |
| Authentication, HTTP boundaries, static assets and host integration | `packages/api` |
| Module resolution, activation and supervised workers | `packages/module-runtime` |
| Legacy data import into reviewable operations | `packages/migration` |
| Authoring, browser recovery and shell composition | `app` |
| Domain analysis and optional features | `modules` |

Core does not import optional module packages, model engines or provider SDKs. Modules use public contracts and host capabilities; they do not import Core implementation files or become independent Git writers.

## Canonical state and snapshots

Git-controlled YAML and Markdown are the durable work format. Approved module settings, dictionaries, corrections and other authoritative decisions use versioned work metadata, including `meta/scriptorium/modules/<module-id>/`. Unsupported data is preserved even when its module is disabled.

A `SnapshotId` binds repository, branch, commit and checkpoint overlay identity. Readers use pinned immutable objects rather than mutable checkout paths. Hierarchy caches, search indexes, graphs, downloaded weights and diagnostics are reconstructible derivatives keyed by their source revision and model or schema identity. A response assembled from mismatched snapshots is invalid.

Separate the observed remote view, unpublished checkpoint overlay and browser draft base. Local operations can invalidate a view even if remote HEAD is unchanged. Cache invalidation must account for those revisions.

## Mutation and publication

All persistent work changes use the shared proposal, approval, checkpoint and publication boundary. Each operation carries stable identity, generation, declared read/write sets and revision preconditions. An authenticated author approves the operation; external tools cannot approve their own proposals.

A project coordinator serializes mutations, Git index/ref changes and publication. Revision checks and compare-and-swap reject stale operations. Validation protects repository paths, symlinks and project boundaries. Readers remain pinned to immutable snapshots while writes are coordinated.

A checkpoint records approved changes as a local Git commit and retains the browser recovery entry. Explicit publication fetches and reconciles, performs an ordinary non-force push, then checks that the operation commit is reachable from the fetched remote branch. A later legitimate remote commit does not invalidate that reachability proof.

Operation identities and receipts support bounded retry after a lost response or clone replacement. An ambiguous push remains `publication_unknown`; it is neither success nor authorization to duplicate the operation. Conflicting preconditions retain local work for author review. Do not silently merge prose, reset pending work or force-push.

## Remote observation and recovery

Use the repository's actual default branch. A changed or deleted binding pauses unsafe mutations until an explicit safe rebind. Remote HEAD probing detects changes; fetching and reconciliation perform the validated integration. Unchanged remote and local revision identities avoid redundant work. Observation failure exposes unknown freshness while verified local data remains readable.

The active author workspace observes the remote at project entry, foreground/reconnect and before mutation or publication, with a 15-second observation cadence while actively viewed. The interval is a change-detection schedule, not a freshness guarantee; a failed probe produces unknown freshness. Remote HEAD changes trigger a validated fetch/reconcile, while unchanged HEAD and local operation refs permit safe read reuse. Foreground typing and locally verified reads are not blocked by optional background work, but actions requiring remote freshness still enforce their preconditions.

Browser recovery is scoped to repository, author and origin. Journal records retain operation identities, generations and checkpoint/publication receipts. Reconciliation must complete before an editor is represented as fully recovered and writable. Quota, storage and conflict failures preserve recoverable work and surface their state.

GitHub supplies confirmed shared work history. The local clone and pending checkpoints require recovery until publication. Private host usage/job history lives under `SCRIPTORIUM_USAGE_DIR` independently of Git; replacing a deployment must retain it. Secrets come from host configuration or credential brokers and never enter Git, browser assets or images.

## Authentication and isolation

Standalone mode has one trusted owner. Every authenticated session can access that owner's registered projects; this is not a multi-tenant ACL service. `SCRIPTORIUM_AUTH_TOKEN` authenticates the owner, and an optional server-side `SCRIPTORIUM_GITHUB_TOKEN` supplies repository access. Registry entries cannot select arbitrary filesystem roots.

Hosted mode binds an assigned repository, runtime identity, instance and epoch. Browser/API grants, MCP bearer grants and runtime-control credentials have distinct validation boundaries. Hosted Git credentials are short-lived and repository-scoped; publication rechecks the author's write permission for the exact operation. See [Hosted deployment](../HOSTED-DEPLOYMENT.md).

## Runtime and packaging

Core and Full are reproducible profiles of the root Dockerfile. Each deployment uses one application container. Core excludes optional packages, native model runtimes and weights from its production closure. Full includes trusted modules with lazy activation and supervised computation; module failure must not take basic writing offline.

Shutdown stops new mutations, drains bounded in-flight work and reports unresolved publication state. It does not automatically approve or publish pending changes. Health, readiness and host-control surfaces are owned by the API.

See [modules](MODULES.md), [workspace composition](MODULAR-WORKSPACE.md), [source provenance](SOURCE-PROVENANCE.md) and [verification](../verification/README.md) for the corresponding contracts and checks.
