# Live Workspace MCP Gateway

**Status: normative transport and ownership contract.** Local tests establish only the covered protocol cases. Production Tunnel and browser/device behavior require their own acceptance checks.

## Product boundary

MCP exposes only the workspace currently open in a Proprium Browser Host. It does not read or write GitHub's published state on behalf of an MCP client. GitHub remains the remote authority; the Gateway has no repository database, workspace files, search index or Git objects. It holds only active connection and request state in memory.

The Gateway terminates MCP Streamable HTTP, authenticates paired clients, checks their granted tool capabilities and relays calls to the matching Browser Host. The browser owns workspace reads, local Git, capability decisions, WASM plugin execution, mutation proposals and approval. A closed or disconnected browser makes its workspace unavailable. The Gateway never retries a mutation after browser disconnection.

## Transports and protocol

The MCP protocol revision is pinned to the current stable [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

- MCP endpoint: `POST /mcp` using JSON-RPC over the current stable Streamable HTTP protocol revision `2026-07-28`.
- Current clients discover supported versions and capabilities with authenticated `server/discover`. Successful current-protocol results carry `resultType: complete` and server identity metadata; discovery and tool lists use `ttlMs: 0` and `cacheScope: private` so grants are checked on each request. This revision needs no `Mcp-Session-Id`. The server also accepts legacy initialization from revision `2025-11-25` for clients that use that handshake.
- MCP requests and notifications use HTTP. The server may return a JSON response or a Streamable HTTP SSE response as allowed by the negotiated protocol. `GET /mcp` is rejected when no server-initiated stream is active.
- Browser-to-Gateway live transport is a separate authenticated SSE connection at `GET /live/sessions/{id}/events`, with JSON result delivery over HTTP POST. This is an outbound browser connection. There is no WebSocket and no periodic poll.
- Each call has a request ID, workspace ID, connection generation and deadline. The Host rejects stale or duplicate work. Disconnect cancels pending reads and proposals and invalidates that generation. Reconnecting creates a new session and requires fresh client authorization.
- Client cancellation and request deadlines propagate through Gateway to the browser. A late response to a timed-out, cancelled or previous-generation request is rejected.

## Pairing and authorization

Live MCP is off by default. The owner configures the Gateway URL, enters the Gateway owner key, and explicitly publishes the current workspace. The Host registers its workspace identity, a fresh connection generation and the capabilities it is willing to expose. It then holds the session owner token in memory and listens to the Gateway SSE stream only while publication is enabled.

The owner pairs MCP clients from the Host UI. Each client receives a randomly generated bearer token shown once to the owner for secure entry in that MCP client's settings. The Gateway keeps client token material in memory only, bound to one live workspace and a subset of its published capabilities. The Host can list and revoke grants; disconnecting or disabling Live MCP revokes the session and every client grant. Restarting Gateway also expires all grants, so the owner pairs again.

Owner and client tokens are sent only in Authorization headers. They are not put in URLs, local storage, plugin calls, GitHub OAuth, logs or errors. GitHub OAuth access tokens authorize GitHub operations and do not grant MCP access.

MCP clients commonly connect without a browser Origin header. If an Origin is present, it must match the configured Host origin. Gateway validates HTTP Host against its configured public URL or permitted local listen address. It does not trust forwarding headers as authentication. Browser management routes require the exact configured Host Origin and the existing owner/session bearer token. When Cloudflare Access protects the Gateway hostname, the browser sends its Access edge cookie only to that configured Gateway; the cookie does not replace the Gateway bearer token or its authorization checks. External MCP clients do not inherit the Host browser's Access cookie and must independently satisfy the Access edge policy if it protects `/mcp`. Use an Access mechanism supported by the MCP client, such as separate service-token headers; keep `Authorization: Bearer` for the Proprium-paired client token, which the Gateway checks after Access admits the request. Deploy an HTTPS public endpoint through a trusted reverse proxy such as Cloudflare Tunnel, limit its origin to loopback, and keep the Gateway listen socket private.

## Browser event envelope

The authenticated SSE stream sends `ready`, `request` and `cancel` events. Each request includes request ID, workspace ID, generation, tool name, arguments and deadline. The Browser Host replies through the matching session's HTTP response route with status `completed`, `failed` or `cancelled`, the same workspace and generation, and a bounded result or error. The Gateway verifies session token, request ID, workspace, generation and one-time completion before returning the MCP result. It rejects stale events, cross-client calls and responses from another workspace.

Session creation, event and response bodies, pairing changes and MCP calls have byte, concurrency and deadline limits. If a bounded queue is full, the request fails closed. Logs report startup and Live connection lifecycle events without request bodies, file contents, workspace identifiers or credentials.

## Initial tools

The Gateway advertises these tools only when the Browser Host exposes them and the MCP client has the required grants. The Host maps each call to existing repository, Git and plugin APIs; it does not create a second workspace implementation.

| Tool | Effect |
| --- | --- |
| `workspace_info` | Read current workspace and repository identity |
| `files_list` | List paths in the current workspace |
| `file_read` | Read a scoped workspace file |
| `git_status` | Read current local Git status |
| `git_log` | Read local commit history |
| `capabilities_list` | Inspect capabilities available to the current workspace/client |
| `plugin_call` | Invoke an operation the Host already exposes through its WASM plugin runtime and capability broker |
| `proposal_submit` | Submit a revision-bound file change proposal for Host review |

`proposal_submit` queues a review item; it never writes to the worktree. The user reviews and accepts or rejects the proposal through the Host's normal approval surface. Applying an accepted proposal uses existing Host revision checks and mutation flow. Plugins do not receive Gateway, OAuth or MCP tokens.

## Errors and availability

Invalid JSON-RPC calls receive the corresponding protocol error. An unknown tool is a method/tool error; an unavailable browser or disconnected workspace returns a clear unavailable error. Authentication and capability failures do not include secret details. Cancellation, timeout and browser failure remain distinct so clients can report whether a request completed. The Gateway never claims a local change was committed or published.

A browser refresh or tunnel loss closes the live session. The owner must re-enable the workspace and reauthorize clients as required. Background execution on iOS or Android is not guaranteed. MCP availability is therefore tied to a foreground, connected Browser Host, not to GitHub or a stored server workspace.

See [Gateway operations](../deployment/GATEWAY.md), [Host UX](WORKSPACE-UX.md), and [delivery and security](DELIVERY-AND-SECURITY.md).
