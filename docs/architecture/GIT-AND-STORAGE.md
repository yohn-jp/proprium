# GitHub authority, local Git and browser storage

**Status: target contract; browser Git transport and crash behavior have not yet been certified.**

## Repository model

- The GitHub repository, its selected branch and verified remote Git history are the **published source of truth**. Respect the actual default branch, remote identity, permissions and reachable commit graph.
- Each browser/device maintains its own **local Git clone or equivalent Git object database and worktree**. Local repository operations run within the browser; they must not require a constantly running backend.
- The Host, not a plugin, owns Git objects, refs, indexes, worktree contents, mutation authorization and synchronization.
- Repository files are generic. YAML/Markdown writer-specific structures may be supported by optional plugins but cannot be required by the core repository format.
- The initial implementation selects **isomorphic-git + LightningFS (IndexedDB)** with a browser Git adapter and Worker execution. This is an accepted implementation choice, but support claims still require the browser and failure tests in [Browser Git implementation](BROWSER-GIT-IMPLEMENTATION.md).

## User-visible data states

| State | Meaning | Durability guarantee |
| --- | --- | --- |
| Draft | Working content not recorded in a Git commit | Best effort on the current device; may disappear |
| Local committed | A local Git commit and ref are present in browser storage | Recoverable only while that local storage survives |
| Publishing / remote unknown | Push underway, lost response or remote reachability not yet proved | Not confirmed; do not mark published or duplicate an uncertain update |
| Published | Selected commit verified reachable from the target GitHub branch after authorized, non-force publication | Remotely recoverable under the GitHub repository's retention/permissions |
| Conflict | Local changes or ancestry diverge from the authenticated remote | Preserve local changes for explicit resolution; do not silently overwrite |

The user explicitly accepts that local work may disappear before publication. Do not promise local data durability, cross-device recovery, or rescue of uncommitted work after browser eviction. Losing an unpushed local commit remains possible even though the commit was locally successful. Make this distinction visible before the user leaves the device.

## Local Git and mutation protocol

1. Obtain workspace and branch identity from a validated repository binding. Local files/snapshots must be keyed to that identity; a plugin cannot substitute another repository ID or base revision.
2. Edits modify the browser worktree. An explicit local commit creates normal Git objects and advances the local ref; a commit is **not** a GitHub save.
3. Serialise Host writes for the same workspace. Enforce path scope, expected file/repository revisions, and conflict detection. An interrupted local write must not be represented as a completed commit; verify object/ref consistency before reporting success.
4. A plugin may request versioned snapshot reads or propose changes. Only Host UI, after user authorization and revision checks, applies a change, creates a commit or publishes.
5. Local drafts, caches, indexes, model artifacts and workspace layouts must not silently become Git tracked source. Plugin-authored canonical metadata is committed only through Host-approved file changes.

The browser storage adapter needs a tested crash-consistency policy. Atomic IndexedDB transactions, virtual filesystem flush semantics, and Git ref/object ordering are implementation-specific; none may be assumed safe without failure/reload tests. A single local writer per workspace is preferred; use coordination and explicit conflict failures for multiple tabs.

## Sync and GitHub interaction

- Fetch, compare and push are explicit remote operations. Offline editing and local commits must not wait for network access.
- Verify GitHub permissions at the operation boundary and target only the intended repository/branch. Use least-privilege credentials; keep them in Host-controlled state and never hand them to plugins.
- Normal Git push requires a browser-compatible transport. Cross-origin Git Smart HTTP may require a restricted proxy; GitHub REST/Git Data APIs may be another path with different semantics. The selected first candidate is REST Git Data transport. Its exact-SHA, CORS/auth, ancestry and race semantics remain **unverified until real-browser tests** as specified in [Browser Git implementation](BROWSER-GIT-IMPLEMENTATION.md). A restricted Smart HTTP relay is a fallback only when evidence requires it. Do not quietly insert a permanent server into the architecture.
- Publication uses a normal non-force update with optimistic remote ref validation. Check that the intended local commit is actually reachable from the authenticated remote branch before displaying Published; network success alone is insufficient.
- If remote HEAD has advanced or histories diverge, stop automatic publication and expose review/rebase/merge choices. Never auto-merge manuscript prose, reset pending changes, or force push without separately authorized policy.
- If a push response is lost or ambiguous, re-read remote state. Until confirmed, show a remote-unknown state. Retried operations must not overwrite a newer remote ref.
- Multiple devices are separate clones of the GitHub authority, not implicitly synchronized workspaces. A stale clone cannot write over a new branch head.

## Mobile and storage risk

Browser-managed persistence such as IndexedDB and OPFS is subject to quota, eviction, private-browsing restrictions, implementation bugs and device policy. Mobile Safari may terminate suspended tabs/workers. Avoid long-running foreground-blocking Git jobs; provide cancellation and honest progress; test WebKit independently.

An installable PWA, persistent-storage request or service-worker caching can improve UX but **does not establish guaranteed durability**. No claim of durable local commit, offline cold start or mobile Git support is accepted without real-device/browser validation.

## Acceptance conditions for implementation

- Desktop Chromium, mobile Safari/WebKit and Android Chromium can open a repository, edit, create a local Git commit, restart and inspect local files and commit history under available storage.
- Local commit never displays as GitHub-published before remote verification.
- Two tabs, quota errors, interrupted writes, process termination and stale revisions fail without a false commit/publish confirmation.
- Authenticated GitHub fetch/push, remote advancement, lost push response, conflicts and credential revocation are verified against disposable synthetic repositories, with exact API/transport behavior recorded.
- No privileged Git code or remote token is exposed through plugin capabilities.

See [overall ownership](OVERVIEW.md) and [workspace UX](WORKSPACE-UX.md).
