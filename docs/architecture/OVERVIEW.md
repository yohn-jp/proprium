# Proprium — browser-native architecture

**Status: normative target contract.** The inherited Scriptorium source does not yet implement this architecture. Component and transport choices noted as candidates require technical validation, not silent assumptions.

## Product boundary

Proprium is a general-purpose, user-owned, composable workspace running in desktop and mobile browsers. It reads and edits files from Git-backed repositories, provides local Git operations, and executes optional analysis/transformation capabilities via independently distributed WASM-first plugins. No manuscript hierarchy or Arcadia-specific schema is required by Core.

**GitHub is the authoritative remote** for shared/published work. The browser's worktree, local Git object database, and draft cache are disposable local copies. Local work is not remotely durable until the remote push is confirmed. The Host works offline on already available local data; offline operation does not imply offline GitHub synchronization.

A Proprium user's ordinary editing and plugin compute must not traverse a self-hosted or permanently running Proprium application server. Delivery of the Host is static; plugins/assets can be fetched and cached as static artifacts. External services remain optional transport capabilities, never invisible authorities over the local working copy.

## Logical architecture

~~~text
       Static hosting / CDN                         GitHub
   Host JS/CSS + versioned artifacts         authoritative repository
                   |                                  ^
                   v                                  | explicit sync
        +--------------------------+                  |
        | Browser Host             |------------------+
        | - Desktop / Mobile UI    |  Git adapter / optional transport
        | - Local repository port  |
        | - Host-authorized writes |
        | - Plugin manager/broker  |
        +------------+-------------+
                     |
         +-----------+-----------+
         |                       |
    Local Git/worktree       WASM-first plugins
    browser storage         Worker / bounded RPC
    transient local state   declarative UI contributions
~~~

## Ownership and dependency direction

| Area | Authoritative owner | Boundary |
| --- | --- | --- |
| Repository publication | GitHub remote | Branch, commit ancestry and exact remote reachability determine confirmed publication |
| Active worktree, local commits | Browser Host Git adapter | User device; no persistence guarantee beyond that browser's storage |
| Drafts and UI settings | Browser Host storage | Best-effort local convenience; not remote truth |
| File/snapshot reads | Host repository port | Revision-pinned, scoped reads to modules |
| File writes, Git commit, push | Host mutation/sync coordinator | One writer and explicit user authorization; plugins can only propose |
| Optional analyses, indexes, models | Installed plugins | Derived data, never independent repository authorities |
| Workspace layout, editor and navigation | Host UI | Plugins may contribute declared surfaces, not mutate Host DOM or global layout |
| Distribution | Static host and artifact origin(s) | Integrity and publisher trust checked before activation; assets lazy-loaded |

The Host owns document identity, revision, approved change application and Git synchronization. A plugin can be written in any language that produces a supported WASM artifact but obtains no ambient filesystem, network, cookie, browser DOM, or Git permission. A plugin crash must not corrupt saved workspace data; complete process isolation is not guaranteed by WASM alone.

## Architectural invariants

1. **No required runtime server or container.** Building and distributing static assets does not require users to run a server. A transport proxy is not permitted to become a hidden worktree/compute authority.
2. **One GitHub remote authority.** Browser copies and caches are locally useful but are not a second published source of truth.
3. **Honest save states.** Draft, local Git commit, GitHub-confirmed publication, conflict and unknown remote state are distinct.
4. **No implicit publication.** Plugins, navigation and autosave cannot silently push or force-update remote refs.
5. **Zero-plugin availability.** Editing, local Git, viewing history and explicit sync remain usable with no plugins, including when plugin code fails.
6. **Pay only when used.** Disabled/uninstalled plugins have no execution, polling, model allocation or worker process. Installed metadata alone does not activate an engine.
7. **Source-independent Core.** Core operates on repository files. Writer-specific hierarchies, canvases, terms, graphs and model computations belong to optional adapters/plugins, not mandatory file formats.
8. **Target device support.** Desktop and mobile are distinct interaction experiences sharing one storage and mutation contract. Browser-specific limitations must be measured rather than inferred.
9. **Local privacy by default.** User content is processed on-device unless a specific user-authorized feature explicitly transmits it.

## Accepted out of scope

Praetorium Hosting and OCI profile building are not part of Proprium's intended runtime. Atlas integration is deferred. Neither a collaborative CRDT backend nor a permanent synchronization daemon is implicit in this contract. WASM is the default plugin compute format, not a requirement to rewrite all existing trusted TypeScript UI code.

Detailed contracts: [Git and storage](GIT-AND-STORAGE.md), [plugins](PLUGIN-PLATFORM.md), [delivery and security](DELIVERY-AND-SECURITY.md), [UX](WORKSPACE-UX.md), and [legacy code boundary](COMPATIBILITY.md).
