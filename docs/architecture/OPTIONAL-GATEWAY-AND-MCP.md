# Optional Gateway and Live Workspace MCP

**Status: normative ownership contract.** The Browser Host and optional Go Gateway have separate runtime and distribution boundaries. Their source implementations and tests do not establish that any public deployment or physical mobile device has been verified. See the [MCP wire contract](MCP-GATEWAY.md) and [Gateway operations](../deployment/GATEWAY.md).

## Product boundary: independent Browser Host

Opening the static Proprium site must be sufficient for basic use: creating/opening locally available workspaces, editing generic files, managing browser-stored Git objects and commits, and running already admitted/cached WASM plugins. **No Gateway URL, login, server availability, remote call, or MCP connection is a prerequisite** for initial rendering or local operations. Once cached, supported offline flows work without network. Browser storage can be evicted; a local commit is not publication.

The Gateway is an **optional enhancement**, deployable independently on a server selected by the operator. Connecting one enables user-authorized GitHub Device OAuth, limited Git Smart HTTP fallback, and **Live Workspace MCP only**. GitHub REST reads/writes may occur directly from the authenticated Browser Host. GitHub remains the only published repository authority; the Gateway is never a repository mirror or a compute backend. If the Gateway is absent, unreachable or incompatible, show the relevant remote/MCP capability as unavailable without blocking local editing or plugin execution. Do not silently introduce PAT entry as a fallback.

| Capability | Static Browser Host alone | With compatible Gateway |
| --- | --- | --- |
| Workspace, editor, local Git, local commit | Available | Available |
| WASM plugins on local approved/cached artifacts | Available | Available |
| GitHub OAuth login via this product | Unavailable | Available |
| GitHub sync / Smart HTTP fallback | Only with independently available valid authentication and compatible direct REST operations; never imply unauthenticated push | OAuth through Gateway; direct REST first and bounded Smart HTTP relay as needed |
| Live Workspace MCP | Unavailable | Available only while the authorized Browser Host is connected |

## One optional Go executable

The target distribution is a **single Go executable** running as a regular, unprivileged user on a configurable non-privileged port, normally `127.0.0.1:8080`. No Node server, OCI container, administrator/root privilege, database, durable worktree, queue, KV, Redis or constantly running per-user compute is required. Memory-only session/connection/request metadata is allowed; restart invalidates live sessions and requires reconnection/re-authorization. Binding to a public interface is an explicit operator security decision, never the default.

Only two capabilities are served:

1. **GitHub OAuth/transport**: narrowly scoped device-code and token exchange, and Smart HTTP `upload-pack` / `receive-pack` fallback. Check Host origin, repository immutable identity, permissions, upstream route/method, body limits, redirection and credentials. Do not turn this into an open proxy. GitHub tokens remain Host-owned and must not be persisted by the Gateway.
2. **Live Workspace MCP**: an authenticated Streamable HTTP MCP endpoint that exposes tools for the actively connected Browser Host. No separate GitHub-backed MCP, repository clone, source index or server-side plugin execution.

The Gateway does **not** store user files, Git objects, search indexes, credentials or Workspace snapshots. It must not publish/commit changes or bypass Host approval. A Gateway restart may interrupt outstanding operations; an ambiguous mutation must not be blindly replayed.

## Live Workspace connection and authority

The Browser Host explicitly opts in, initiates an outbound **SSE subscription over HTTP**, receives scoped MCP requests, and returns bounded results using authenticated HTTP POST. No WebSocket or fixed-interval polling is part of the target. The Gateway holds only active connection registrations and pending request correlations in memory. MCP tools delegate to the current Host's existing revision-aware repository and capability interfaces; MCP clients never receive unrestricted browser filesystem, plugin, Git, or credential authority.

- Associate every request/result with an authenticated MCP client, approved Workspace, connection generation, unique request ID, allowed capability and deadline. Reject stale/duplicate/cross-workspace responses and honor cancellation and size budgets.
- Read tools expose only files and metadata permitted by the Host. Mutations are reviewable **proposals**, not direct apply/commit/push; the owner must approve in the Browser Host with expected revisions verified.
- Explicit opt-in, revocation and short-lived connection authorization are mandatory. Do not accept anonymous public MCP access, rely only on browser CORS for authentication, or treat a GitHub access token as a Gateway-wide MCP authorization without validation.
- When the tab/browser is suspended, closed, disconnected or the server restarts, tools report Workspace unavailable; there is no offline/always-on MCP guarantee. Desktop foreground is the principal use case; mobile background execution is not promised.
- The target MCP transport must conform to the selected stable MCP specification; pin and test its initialize, tools/list, tools/call, cancellations and errors. Do not copy deprecated Scriptorium session semantics without verification.

SSE requires a long-lived outbound browser HTTP connection; its liveness must be tested through the actual proxy. An SSE stream and an HTTP result POST are **not** by themselves a shared cross-request registry on Cloudflare Workers: the Gateway executable is the state holder for active connections.

## Deployment and operational boundary

Static Host and immutable signed plugin artifacts remain independently distributable through static hosting/CDN, optionally Cloudflare Workers Static Assets and R2. The Gateway binary is separately built, tested, versioned, checksum-verified and published through GitHub Actions, with Linux amd64/arm64 as required targets. Additional targets are optional after cross-build proof. It can run behind **cloudflared Tunnel** or another HTTPS reverse proxy; `cloudflared` is a separate process and is not bundled into the Gateway executable. User-level services or foreground execution must be supported without root.

Cloudflare Tunnel does not imply unlimited bandwidth/request counts or a particular pricing entitlement. The target removes dynamic **OAuth/MCP/Smart HTTP Worker invocations**, not ordinary static asset delivery, R2 access, GitHub traffic or Tunnel usage. Do not delete an existing deployed Cloudflare Worker until migration and cutover are independently verified.

## Implementation and release gates

The Go relay must pass equivalent security and GitHub interoperability tests when its transport or authorization boundaries change. Browser Host must demonstrate a zero-Gateway cold start and local edit/commit/plugin execution, then opt-in connection, GitHub authorization, exact-SHA publication with fallback, authenticated MCP read and proposal, rejection of unauthenticated/foreign requests, disconnect/restart handling, desktop/mobile browser behavior and actual HTTPS proxy forwarding. Distinguish emulated browser tests from physical-device certification.

The release pipeline must (a) build/test the Go executable with no privileged runtime or persistent database, (b) publish versioned binaries and checksums as artifacts/releases, (c) remove the obsolete relay Worker deployment path while preserving the static Host release, and (d) validate no legacy worker configuration remains active after cutover. Repository removal of the former Relay implementation does not delete any remote Worker. Public Gateway cutover and remote resource retirement require independent operational verification.

Related contracts: [architecture overview](OVERVIEW.md), [Git and storage](GIT-AND-STORAGE.md), [delivery and security](DELIVERY-AND-SECURITY.md), [workspace UX](WORKSPACE-UX.md), and [Cloudflare deployment](../deployment/CLOUDFLARE.md).
