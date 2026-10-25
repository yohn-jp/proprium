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

Use **GitHub REST Git Data API** as the first transport candidate, with a narrow Host-owned adapter. For every object uploaded, verify that returned SHA is the expected local Git object ID. Preserve tree modes, commit parents, identity, timestamps and exact commit SHA; if an endpoint cannot preserve these bytes/semantics, do **not** fabricate equivalent history or claim an ordinary Git push. For that unsupported path, fail closed and test a narrowly scoped Git Smart HTTP relay instead.

Normal non-force branch updates must be protected by an actual current remote ref/ancestry check. A pre-read followed by an unconditional ref update is not a cross-request CAS and may be unsafe; verify GitHub endpoint semantics against concurrent writers before enabling publish. If safe conditional update semantics are unavailable in REST, use a transport that supports a verifiable non-force update without overwriting concurrent changes. Verify commit reachability after upload/update; a request's HTTP 2xx is not a remote-save receipt.

Auth uses an authorized GitHub flow supporting PKCE with a public client where applicable. **PKCE support does not prove a pure SPA can exchange its code directly under CORS or securely hold a long-lived shared secret.** Verify the current GitHub browser/token-exchange contract. If a minimal authentication/transport Worker is necessary, it is an optional narrowly scoped network edge component, never a user workspace store or compute server. Never embed a client secret in Vite assets. Never expose tokens to WASM guest imports.

## Required implementation tests

1. Desktop Chromium, Android Chromium and mobile Safari/WebKit: initialize or materialize a repository, edit text and binary files, create two commits, reload, inspect refs and exact SHA.
2. Browser storage: forced shutdown/reload, incomplete flush, quota error and two-tab contention. On failure, report local state as unknown/corrupt rather than committed.
3. GitHub: authenticate against disposable repositories; upload exact objects, preserve commit SHA, reject diverged ancestry, simulate a second writer and lost response; verify remote reachable commit.
4. Offline: edit/commit from a warm local repository without fetching new assets, and report unavailable remote sync honestly.
5. No plugin, remote API, self-hosted server or Git CLI is necessary for local editing and local Git operations.

Until these run and pass, browser Git and GitHub publishing remain **unverified capabilities**, not shipped behavior.
