# Static delivery, resource distribution and trust

**Status: delivery and security contract for the implemented static Host build.** CI checks the local bundle and Wrangler package with dry-run. The repository does not provision Cloudflare resources or establish that a production Host, R2 artifact origin or auth Worker has been deployed and tested.

## Delivery model

- The Host is built as static HTML/CSS/TypeScript bundles plus any essential runtime data. Deploy through an ordinary static asset host/CDN; no Node/Fastify/OCI process runs for each Proprium user.
- Browser computation (Git object operations, Markdown, analysis and enabled plugin WASM) stays on the user's device.
- Independent plugin builds produce immutable versioned artifact sets. A registry publishes identities, compatibility and verified digests; a static object store such as **Cloudflare R2** can hold large WASM, dictionaries, model weights and optional resources.
- Host deploys and plugin deploys have separate release lifecycles. No container composition, server runtime install, or bundle regeneration per plugin installation.
- Proper cache headers and digest-based asset paths permit browser/CDN reuse. Configure correct MIME for wasm, CORS for cross-origin fetch, CSP and any WebAssembly/Worker isolation headers supported by deployed browser targets.
- The origin of a downloaded WASM file does not by itself make the code trusted. Integrity validation precedes execution, and Host-granted capabilities determine what it may do.

A static delivery model removes **home-server bandwidth and compute from ordinary application traffic**, not all network or provider costs. Initial host/assets downloads, GitHub synchronization, cache misses and optional external services still consume network. R2, CDN and GitHub have usage limits/costs; no claim of limitless free distribution is made.

## Browser-only data boundary

The only mandatory remote service for publishing is the user's GitHub repository. Initial UI and plugin downloads are static delivery. No Proprium-managed database, user account service, daemon or continuously running sync worker is required for local editing.

Browser GitHub sync is implemented through the Host-owned Git transport and the optional restricted Worker under `workers/github-auth` for device authorization and Smart HTTP relay. The Worker checks repository identity and permissions, then streams Git traffic; it is not a worktree store or plugin runtime. Live authorization and publishing still depend on configuring and testing the intended GitHub and Worker endpoints.

For private repositories, prevent credentials from reaching plugins, remote artifact origins, analytics, URLs or logs. Prefer short-lived/scoped grants where feasible; token acquisition and persistence strategy require threat-model and browser verification. A static page is not an authorization server and cannot safely embed a long-lived shared secret.

## Threat model

| Threat | Required boundary |
| --- | --- |
| Tampered/misattributed plugin bundle | Immutable artifact digest plus publisher trust/signature or approved registry admission |
| Arbitrary plugin JS / DOM / storage access | Standard external plugins provide WASM plus declarative UI; no publisher-controlled JS executing in Host origin |
| Excessive compute / hang / memory exhaustion | Per-plugin Worker, bounded Host RPC, cancellation and termination; disclose limits of browser OOM containment |
| Forged Host requests / stale revision | Host validates instance/epoch/workspace, capabilities and expected revision on each operation |
| Git credential theft / cross-repo writes | Host-only credentials, explicit repo scope, least privilege and GitHub permission/revision checks |
| Unintended off-device data transmission | Default-deny plugin network capability; user-visible consent and restricted destinations where allowed |
| Evicted browser storage | Local draft/commit/push state clearly distinguished; optional export, no guaranteed local recovery |
| Stale CDN cache or artifact replacement | Content-addressed immutable URLs, pinned versions, atomic publication of registry metadata and integrity checks |

Separate-origin iframe UI is a future exceptional path for plugins that genuinely need custom rendering. It is not the default runtime for WASM-only plugins; isolate only what is actually executable in that realm. Third-party JS in an opaque sandbox still requires CSP, origin checks, schema validation and device crash tests.

## Offline and mobile

After a user has loaded the Host and required plugin bytes, offline authoring can work from a local workspace. A cold visit or a missing uncached dependency **cannot** be claimed offline-capable without an actual tested service-worker/cache plan. Safari and Android differ in storage eviction, long-task suspension, thread/WebGPU support and memory limits. R2 placement does not make a plugin available while offline unless cached.

## Release verification

Require exact-source build and checks: static production bundle without Node runtime dependencies, bounded cold-start asset set, offline/restart tests, plugin integrity/capability fault injection, mobile WebKit/Android/desktop Chromium, actual GitHub sync and conflict paths, security headers/CORS, cache/version pinning and credentials inspection. Report skipped checks as unverified, not passed.

See [plugin platform](PLUGIN-PLATFORM.md) and [Git/worktree contract](GIT-AND-STORAGE.md).

For actual Wrangler command structure, R2 publication, release ordering, and the no-deploy-before-browser-build constraint, see [Cloudflare deployment](../deployment/CLOUDFLARE.md).
