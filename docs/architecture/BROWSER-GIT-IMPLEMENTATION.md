# Browser Git implementation contract

**Status: selected technical baseline.** Proprium starts with **isomorphic-git + LightningFS**, both running on the device. This is an explicit initial adoption, not a guarantee that every mobile browser and failure mode has been certified. Do not reopen the library selection without a concrete failure or incompatible requirement.

## Authority and responsibility

The contracts in [Git and storage](GIT-AND-STORAGE.md) remain normative: **GitHub is the remote source of truth**. A browser worktree, commits and object database are disposable until a push is confirmed. Only the Browser Host may create local commits, manipulate refs, or request remote publication. Plugin code may propose changes, never publish.

- Git implementation: isomorphic-git, invoked through a Host-owned browser adapter; do not call Node's Git CLI or inherit server-managed clones.
- Filesystem: LightningFS backed by IndexedDB. The repository path, object data, refs and worktree must share the same scoped virtual FS. Pin exact dependency versions in the implementation lockfile rather than introducing unreviewed CDN script imports.
- Execution: move potentially long Git operations to a Web Worker. The adapter should not leak git internals, filesystem handles or credentials to plugins. Expose revision-aware repository operations and explicit commit/fetch/publish flows.
- Workspace identity: bind origin, GitHub repository immutable ID, owner, repository name, branch and local workspace ID. Refuse accidental repository/branch substitution; never assume all projects use 'main'.
- Storage: explicit flushing, transaction behavior and object/ref ordering must be tested using actual LightningFS APIs. A flush resolving does not establish remote durability. Storage eviction may destroy every local commit and draft.
- Concurrency: one active writer per local workspace; use a supported browser locking technique and conflict/revision guards, with explicit fallback/denial where locking is unavailable. Do not claim multiple tabs safe based on IndexedDB alone.
- Repository formats: handle UTF-8 plus binary files; preserve Git paths and unchanged content. Do not require the Scriptorium manuscript hierarchy. Disallow path traversal and unsafe symlink traversal at the Host boundary.
- Feature gate: unsupported repository features (e.g. LFS filters, submodules, hooks) must be documented as unsupported instead of silently rewriting content or history.

## GitHub transport selection

The Host-owned adapter uses **GitHub REST Git Data API** where it can preserve the local Git objects and exact commit SHA. It verifies returned object IDs and preserves tree modes, parent commits, identity and timestamps. When REST cannot represent a commit or safely perform an update, the adapter uses the narrowly scoped Git Smart HTTP relay. It must never fabricate equivalent history or claim an ordinary push when the resulting remote commit differs.

Normal non-force branch updates are protected by a current remote ref/ancestry check, with Smart HTTP used where REST cannot safely update the ref. Verify the intended commit is reachable after publication; an HTTP 2xx response alone is not a remote-save receipt. Live concurrent-writer and lost-response behavior remains part of deployment acceptance.

Auth uses GitHub's device authorization flow through the optional restricted Worker, which keeps the public Host from embedding a client secret. The Worker is a network edge component only; it is never a user workspace store or compute server. Never expose tokens to WASM guest imports. The configured endpoint and real account permission behavior must be verified before live sync is advertised.

## Required implementation tests

1. Desktop Chromium, Android Chromium and mobile Safari/WebKit: initialize or materialize a repository, edit text and binary files, create two commits, reload, inspect refs and exact SHA.
2. Browser storage: forced shutdown/reload, incomplete flush, quota error and two-tab contention. On failure, report local state as unknown/corrupt rather than committed.
3. GitHub: authenticate against disposable repositories; upload exact objects, preserve commit SHA, reject diverged ancestry, simulate a second writer and lost response; verify remote reachable commit.
4. Offline: edit/commit from a warm local repository without fetching new assets, and report unavailable remote sync honestly.
5. No plugin, remote API, self-hosted server or Git CLI is necessary for local editing and local Git operations.

The Browser Git adapter, GitHub authorization/transport code and browser fixture acceptance cases are implemented. Those fixtures do not by themselves certify live GitHub behavior, storage crash consistency, or mobile device support; use the required checks above before claiming those environments are verified.
