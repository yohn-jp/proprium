# Static delivery, Gateway operations and trust

**Status: normative delivery and security contract.** CI builds the static Browser Host and tests/builds the Go Gateway. Local checks do not establish that a production Host, Gateway, Tunnel or R2 artifact origin is deployed and working.

## Delivery model

- The Host is built as static HTML/CSS/TypeScript bundles plus essential runtime data. Deploy it to an ordinary static asset host/CDN; it requires no Node application server or container.
- Workspace editing, local Git operations and enabled plugin WASM compute run in the user's browser.
- Independent plugin builds produce immutable versioned artifact sets. A registry publishes identities, compatibility and verified digests; a static object store such as Cloudflare R2 can hold large WASM and optional resources.
- Host deploys, Gateway binaries and plugin artifacts have separate release lifecycles.
- Proper cache headers and digest-based asset paths permit browser/CDN reuse. Configure correct MIME for WASM, CORS for cross-origin fetch, CSP and any WebAssembly/Worker isolation headers supported by deployed browser targets.
- The Host permits HTTPS and loopback HTTP connections in CSP so an owner can choose a self-hosted Gateway after the static build. Selecting a Gateway is a trust decision: it receives OAuth relay traffic and explicitly exposed live tool results. Plugin network access remains governed by the capability broker; a CSP connection allowance grants no plugin capability.
- A downloaded WASM file's origin does not by itself make the code trusted. Integrity validation precedes execution, and Host-granted capabilities determine what it may do.

A static delivery model removes home-server bandwidth and compute from ordinary Host traffic, not all network or provider costs. Initial Host/assets downloads, GitHub synchronization, cache misses, Gateway traffic and optional external services still use network. CDN, Tunnel and GitHub services have usage limits and costs; no unlimited capacity is promised.

## Browser data and Gateway boundary

GitHub is the remote authority for published repositories. Initial UI and plugin downloads are static delivery. No Proprium-managed database, account service, daemon or continuous sync worker is required for local editing. An operator may run the optional Go Gateway as a non-root process for GitHub OAuth Device Flow, restricted Git Smart HTTP fallback and Live Workspace MCP.

The Host makes authenticated GitHub REST requests directly when the existing adapter can preserve the local commit SHA. For Smart HTTP fallback, the Gateway validates the requested repository ID and read/write permission before streaming Git traffic. Device OAuth and Git relay use fixed GitHub upstreams and routes; the Gateway is not a generic HTTP proxy. It does not persist GitHub tokens, workspaces, workspace files, search indexes or Git objects.

Live MCP connects only to a workspace currently open in the browser. The owner explicitly publishes that workspace and authorizes clients. The Gateway maps each authorized MCP client to its selected live workspace and relays tool calls through a browser SSE connection. Workspace and Git operations, WASM plugin execution and user approval remain in the Browser Host. The Gateway keeps only in-flight session and request state in memory; restart invalidates grants and disconnects MCP access. There is no WebSocket or timer-driven polling.

For private repositories, credentials must not reach plugins, remote artifact origins, analytics, URLs or logs. GitHub OAuth tokens and MCP client tokens are different credentials and cannot be substituted for each other. A static Host does not embed a client secret or a shared long-lived MCP credential.

## Threat model

| Threat | Required boundary |
| --- | --- |
| Tampered plugin bundle | Immutable artifact digest plus publisher trust/signature or approved registry admission |
| Arbitrary plugin JS / DOM / storage access | External plugins provide WASM and declarative UI; no publisher-controlled JS executes in the Host origin |
| Excessive plugin compute | Per-plugin Worker, bounded Host RPC, cancellation and termination; disclose limits of browser OOM containment |
| Forged Host request or stale revision | Host validates workspace, generation, capability, expected revision and proposal state on each operation |
| Git credential theft or cross-repository writes | Host-owned credentials; Gateway restricts relay routes and verifies repository identity and permission |
| Token disclosure | No credential in a URL or log; owner and client tokens are not exposed to plugins or GitHub OAuth calls |
| Unauthorized MCP client | Explicit owner pairing, per-client capability subset, revocation and in-memory client/workspace binding |
| Cross-origin, CSRF or DNS rebinding | Exact allowed Origin/Host checks, no cookie authorization, bounded inputs and public-URL validation |
| Stale browser response or duplicate mutation | Workspace/generation/request identity checks, deadlines, cancellation and no mutation retry after disconnect |
| Unintended off-device data transmission | Default-deny plugin network capability; user-visible consent and restricted destinations where allowed |
| Evicted browser storage | Draft/commit/publish states remain distinct; no guaranteed local recovery |
| Stale CDN cache or artifact replacement | Content-addressed immutable URLs, pinned versions, atomic publication and integrity checks |

Separate-origin iframe UI is an exceptional path for plugins that need custom rendering; it is not the default runtime for WASM plugins. Third-party JavaScript in a sandbox still requires CSP, origin checks, schema validation and device crash tests.

## Offline and mobile

After a user has loaded the Host and required plugin bytes, offline authoring can work from a local workspace. The Gateway is unavailable when its process or browser connection is down. Mobile background execution is not guaranteed; a suspended or terminated browser may disconnect Live MCP. A cold visit or missing uncached dependency cannot be claimed offline-capable without an actual tested caching plan. Safari and Android differ in storage eviction, task suspension, threading and memory limits.

## Release verification

Require exact-source checks for the static production bundle, Go Gateway tests and build, browser storage/plugin behavior, supported Chromium/WebKit classes, actual GitHub sync, request security, credentials inspection and any deployed Tunnel. Report skipped environment checks as unverified, not passed.

See [plugin platform](PLUGIN-PLATFORM.md), [Git/worktree contract](GIT-AND-STORAGE.md), [MCP Gateway](MCP-GATEWAY.md), and [Gateway deployment](../deployment/GATEWAY.md).
