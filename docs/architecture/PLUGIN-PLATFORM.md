# Proprium — WASM-first plugin platform

**Status: normative target contract, not a working Plugin SDK.** Existing Scriptorium built-in modules and its container-time profile resolver are legacy implementation assets, not implementations of this contract. Atlas integration is deferred.

## Decision

A user installs and enables independently built, versioned **static plugin artifacts at runtime**, with no Proprium container/image rebuild and no Proprium-specific application server. **WASM is the default execution format for plugin computation.** Host-owned TypeScript renders the application and standardized, declarative UI contributions; a module need not provide JavaScript UI code.

WASM-first is **not** WASM-only: the trusted Host/editor remain TypeScript, and any exceptional complex external UI mechanism requires a separate isolation/security decision. Do not force existing trusted code into WASM without a measurable portability or security benefit.

## Component boundaries

~~~text
Browser Host: Git / files / authorization / Editor / UI renderer
            |         |        |
     Plugin manager    |     Plugin UI descriptors
     manifest, digest  |     -> Host-owned components
            |          |
     Capability broker / validated, versioned RPC
            |
     Per-plugin Web Worker -> WebAssembly module
            |
     CPU / memory / time / message budgets + cancellation
~~~

A plugin cannot read the Host's IndexedDB/OPFS directly, access the DOM, inspect Git credentials, publish Git refs, issue arbitrary API calls, or load unreviewed Host JS. Imports exposed to a WASM instance are an **explicit, versioned allowlist**. Browser JS bindings used to instantiate it are trusted Host runtime code, not arbitrary publisher-controlled glue.

WASM memory isolation does not guarantee browser/process isolation, memory safety of host imports, or enforceable CPU quotas. Run plugin compute in a terminable Worker, bound RPC concurrency and bytes, and surface failure without losing Host editing. Hard isolation and memory caps must be claimed only for environments/tests that actually enforce them.

## Artifact, metadata and identity

- Each plugin has a namespace-qualified stable identifier (publisher + plugin), semantically versioned package identity, supported Host/ABI range, declared capabilities and dependencies, permitted UI contributions, entrypoints, resource sizes and license/provenance metadata.
- Distribute immutable bundles containing a manifest, one or more WASM modules and optional non-executable data assets (dictionaries, model weights, icons, layouts). Bundle/manifest references use validated relative paths; no arbitrary executable URL evaluation.
- Bind every executable/data asset to an immutable digest and verify downloaded bytes before activation. A digest alone cannot authenticate the publisher: maintain approved publisher identities, signatures or a curated trusted registry policy. Reject unknown identities, incompatible ABI, invalid signatures/digests and dependency cycles.
- A single machine-verifiable schema/protocol is the logical source of truth. Derive TypeScript validators and any WASM binding representation from it; do not maintain contradictory schemas or treat existing Scriptorium internal ModuleId values as public ABI.
- Artifact versions are immutable. A user-selected installed version remains pinned until an explicit verified upgrade; a registry index change must not silently swap active code.

The technical baseline is **Component Model + WIT**, with a tested browser transform/binding toolchain; exact generated wire signatures, signing format and publisher trust policy require proof and conformance. See [WASM plugin ABI](WASM-PLUGIN-ABI.md) and [plugin distribution](PLUGIN-DISTRIBUTION.md). Examples in this document name capabilities conceptually; they are not claims of existing SDK endpoints.

## Distribution and installation

1. Plugin authors build/test WASM and assets independently, for example in GitHub Actions; this build does not rebuild the Proprium Host.
2. Publish immutable versioned artifacts and signed/pinned registry metadata to a static origin such as R2 plus a CDN/custom domain. R2 is a distribution location, **not a workspace data authority**.
3. Browser Plugin Manager fetches metadata, validates publisher policy, resolves dependency/ABI compatibility and capability requests, obtains user consent for new privileges, and fetches/validates artifacts as needed.
4. Store installed metadata, approved permissions and cached bytes in browser storage, scoped to user/browser. Installation is not activation. Locally cached artifacts can run offline only if every required verified byte is already available.
5. Enable -> idle -> active happens on demand. Disable or uninstall revokes leases, cancels work and releases Workers/assets. A failed update retains a known-good pinned artifact when safe; it must never erase author files.
6. An optional user-imported offline artifact follows **the same integrity, publisher-policy, ABI and capability admission** as a registry installation. Importing arbitrary bytes does not grant executable trust.

The minimum usable Host has **zero** plugin dependencies. Disabled, not installed and enabled-but-idle are separate lifecycle states; inactive plugins must not poll, load models or allocate compute resources.

## Capability interface

| Family (conceptual) | Permitted effect |
| --- | --- |
| workspace.snapshot.read | Enumerate/read only authorized files at a pinned revision with byte/page limits |
| workspace.change.propose | Submit a read/write-set, expected revision and desired file changes for Host/user review; never commit or push |
| workspace.navigation | Ask Host to navigate to a permitted file/panel without bypassing unsaved edits |
| workspace.ui.contribute | Register declarative panel, command, view or editor-decoration descriptors backed by Host components |
| workspace.events | Receive bounded, scoped hints with snapshot/epoch; reload on gaps |
| plugin.cache | Read/write quota-bound derived indexes and local plugin preferences, not authoritative manuscript data |
| network.egress | Denied by default; explicit opt-in, scope, destination and data-disclosure indication when a feature truly requires it |

Capabilities are granted as the intersection of manifest request, Host policy, selected workspace scope and user consent. Every request and result is validated, versioned and bound to a plugin instance, current workspace, revision, capability and activation epoch. Stale results must not update a newer editor state. A plugin cannot consent on the user's behalf.

Host owns the single writer, approval/commit/push UI, file scopes and recovery semantics. A plugin can produce suggestions and derived data, not acquire independent authority by writing its own state file or making a raw Git call.

## UI model

Standard plugin surfaces use a **declarative contribution protocol** and Host-rendered components. Host supplies common forms, tables, result lists, inspector panels, navigation and other bounded primitives; plugins provide schemas, data and actions through their capabilities. The plugin cannot inject global styles, arbitrary React components or DOM references into the Host.

This is not intended to reimplement sophisticated drawing engines in a declarative schema. Custom full-fidelity Canvas/Editor UIs require a distinct, separately reviewed browser isolation mode (typically cross-origin sandbox iframe + validated MessageChannel) before such plugins can be integrated. **Atlas and Story Knowledge are deferred**; no special-case Atlas dependency, mock SDK or premature canvas-UI privilege is added to the core protocol.

## Resource control and failure

- Verify static metadata without importing executable code. Load WASM/assets lazily and cache by immutable content digest.
- Bound request rates, bytes in flight, number of Workers, active jobs, job duration and output sizes; cancel/reclaim leases on navigation, disable and update.
- A hung Worker can be terminated. JS/WASM heap growth and browser OOM are not perfectly isolatable on all mobile devices; provide feature-level failure and fallback, not an absolute browser-survival claim.
- A plugin failure must not mark derived results current, create a Git commit, discard an unsent change proposal, or disable core editing.
- Device feature absence (WebGPU, threads, large memory) results in supported fallback or an unavailable module; never block the basic Host workspace.

## Required conformance demonstrations

Independent artifact publication and browser installation without Host rebuild; digest/publisher/ABI rejection; capability denial and no token/file bypass; zero-plugin cold start; opt-in lazy activation; disable/cancel/recovery; malformed/oversized RPC; Worker hang/trap/large allocation; offline cached reuse and missing artifact; browser version update/rollback; real Chromium/WebKit/mobile checks. Claims beyond measured configurations are not accepted.

See [architecture](OVERVIEW.md), [delivery/security](DELIVERY-AND-SECURITY.md), and [workspace/Git mutation rules](GIT-AND-STORAGE.md).
