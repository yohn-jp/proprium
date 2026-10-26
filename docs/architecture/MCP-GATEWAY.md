# Proprium MCP Gateway

**Normative contract:** Cloudflare Access authenticates ingress; the Gateway forwards each MCP tool call to the connected Browser Host. No Proprium Owner Key, MCP Client Token, pairing, tool-publishing UI, or capability selection exists.

## Identity and deployment boundary

- The public `/mcp`, `/live/`, `/oauth/`, `/git/`, and `/auth` routes are protected by **the same Cloudflare Access application**. `GET /auth` is only a harmless landing page that points back to the configured static Host; it does not establish or verify an identity, issue credentials, or change Gateway authorization. Keep the landing route covered by Access. Managed OAuth is used for compatible MCP clients. The Cloudflare Access allow policy is the outer authentication boundary. Never configure an unauthenticated bypass for API paths; preflight OPTIONS may bypass Access **authentication only**, to be checked against the exact Browser Host Origin at the Gateway.
- `GET /healthz` is a separate minimal liveness endpoint and does not establish Gateway or user authentication. If an operator intentionally exempts it at the Access edge for automated health checks, keep that exception path-scoped to `/healthz`; it must not cover `/auth` or API routes.
- The Gateway binds **only to loopback**, reached through Cloudflare Tunnel. A user who can execute processes locally on the Gateway machine belongs to the operating-system trust boundary; Cloudflare Access cannot protect the loopback socket against local users. Do not expose the loopback listener on a public network, add an unauthenticated alternate tunnel, or trust forwarded user headers.
- GitHub OAuth remains a separate GitHub API authorization protocol. The Browser Host owns GitHub credentials. MCP never receives GitHub tokens, local files, or implicit GitHub publication authority.
- Restart loses all in-memory Browser Host registrations, pending requests, and in-flight operations. The Gateway stores no Workspace/repository database or Git state.

## Active Browser Host routing

Each Browser Host connects by outbound GET SSE at `/live/sessions/{sessionId}/events`. The Gateway retains a process-local session ID and generation for request correlation. The **most recently explicitly activated** live SSE Browser Host is the sole active MCP destination. Foreground focus/visibility activation uses an authenticated browser-origin POST; the first connected Host is the initial default; an older tab never automatically takes over after the active tab closes. No Host -> MCP client pairing step is required. A new Browser Host connection can replace the active destination; outstanding work remains bound to its original session/generation.

For every `tools/call`, Gateway forwards a bounded request envelope with unique request ID, deadline, tool name, arguments, session ID, and generation. The Browser Host handles the request and POSTs a revision-aware response to the matching session; stale responses, duplicate responses, wrong generations, and out-of-scope file changes are rejected. All Browser Host file-change proposals require visible, explicit review and revision verification before application, with no automatic commit or push. Timeout, cancellation, disconnect, and overflow fail closed.

The Browser Host must be open and connected to execute. On disconnect, **all tool definitions remain visible**, while calls return a clear `503 No active Browser Host`/unavailable result. This is not an always-on server-side workspace.

## MCP transport and tools

Endpoint: `POST /mcp` (JSON-RPC Streamable HTTP); current protocol metadata `2026-07-28`, with supported legacy initialize `2025-11-25`. Discovery and tool list require no active Browser Host. Results are uncached (`ttlMs: 0`, `cacheScope: private`). Only the Cloudflare Access edge authenticates external MCP callers.

The **entire eight-tool registry is always exposed**:

| Tool | Input and behavior |
| --- | --- |
| `repositories_list` | List locally known repositories and branches in the active Browser Host; no `repository_id` needed |
| `repository_info` | Require numeric immutable GitHub `repository_id`, optionally `branch` |
| `files_list` | Require `repository_id`, optionally `branch` |
| `file_read` | Require `repository_id`, `path`; optionally `branch` |
| `git_status` | Require `repository_id`; optionally `branch` |
| `git_log` | Require `repository_id`; optionally `branch` and `limit` |
| `plugin_call` | Require `repository_id`, `pluginId`, `operation`; only active repository plugin runtime is executable |
| `proposal_submit` | Require `repository_id`, title, revision-bound proposed changes; queue review, never auto-apply |

`repository_id` must be provided for target-dependent calls; there is no implicit fallback to the currently displayed repository. If multiple locally known branches share a repository ID, `branch` is required to disambiguate. A repository not yet opened/cached locally, or an unavailable plugin runtime, returns a precise unavailable error. Gateway does not clone GitHub repositories to satisfy an MCP call.

Removed: `workspace_info`, `capabilities_list`, client bearer issuance, owner-key exchange, client-grant management and `Tools published for this workspace`.

## Browser Host UX

MCP connection state, URL, and explicit reviewable proposals are the only relevant UI. A connected Browser Host automatically registers its Live connection while the workspace is open and disconnects when closed. No Owner Key field, token textarea, client-grant form, capability selection, or tool count needs to be displayed. External MCP clients connect using Cloudflare Access Managed OAuth or another Cloudflare-supported credential flow, never a Proprium-issued MCP token.

## Security and verification

Verify Cloudflare Access protection on every externally reachable Gateway hostname and endpoint, including Browser Host management and MCP. Without Access, Gateway's uncredentialed MCP/live handlers must remain private to loopback and must **never** be advertised as secure for public internet traffic. Preserve exact Host and Browser Origin checks and bounded request sizes. Confirm tools/list works disconnected, one active Host dispatches, duplicate/out-of-order responses fail, no wrong-repository reads or proposals, and active-host disconnect never auto-fails over.
