# Proprium Gateway configuration and operations

The Gateway is a single Go executable. It needs no root account, database, Node.js runtime, container or writable data directory. It serves GitHub OAuth Device Flow, restricted Git Smart HTTP fallback and, when configured with an owner key, the optional Live Workspace MCP control plane. It does not store GitHub tokens, repositories, workspace contents, search indexes or Git objects.

## Automated releases from main

Every push to `main` runs the Gateway release workflow. After the race-enabled Go tests, vet and cross-platform builds pass, GitHub Actions publishes an immutable `proprium-gateway-v0.0.<workflow-run-number>` release containing platform binaries, `SHA256SUMS`, and `SOURCE.txt`. The run number is a monotonically increasing CI build identifier, **not** a claim of semantic-version compatibility. GitHub's latest release points to the newest published successful release; a failed build must not publish one. The workflow retains manual dispatch for an existing canonical Gateway tag on main. Release publication does not deploy or restart the server; operators explicitly fetch and verify the desired release.

## Download and verify

Download the release binary for the target OS/architecture and `SHA256SUMS` from the matching `proprium-gateway-vX.Y.Z` GitHub Release. Verify it before use:

~~~sh
sha256sum --check SHA256SUMS
chmod 0755 proprium-gateway_1.2.3_linux_amd64
./proprium-gateway_1.2.3_linux_amd64 version
~~~

Rename or symlink the platform binary to `proprium-gateway` if convenient. Release artifacts are self-contained executables built with CGO disabled. Linux amd64 and arm64 are supported for Gateway operation; Windows amd64 and macOS amd64/arm64 binaries are also published.

Build from source with the [pinned Go 1.27.3 toolchain](https://go.dev/dl/#go1.27.3):

~~~sh
cd gateway
go test -race ./...
go vet ./...
CGO_ENABLED=0 go build -trimpath -o proprium-gateway .
~~~

## Configuration

| Setting | Required | Meaning |
| --- | --- | --- |
| `PROPRIUM_LISTEN_ADDR` | no | HTTP listen address, default `127.0.0.1:8080`; use an unprivileged port |
| `PROPRIUM_HOST_ORIGIN` | yes | One exact Host origin, for example `https://app.example.org`; local HTTP is permitted only for loopback development |
| `PROPRIUM_PUBLIC_URL` | required for Live MCP or wildcard listen | Exact public Gateway origin, for example `https://gateway.example.org`; used for Host and proxy request validation. May be omitted for loopback-only, relay-only operation |
| `GITHUB_CLIENT_ID` | yes | GitHub OAuth App client ID for Device Flow; 10–128 ASCII letters, digits, underscores or hyphens. It is a public identifier, not a secret |
| `PROPRIUM_OWNER_KEY` | Live MCP use | Random owner bearer secret of at least 32 bytes; keep private. If absent, Live MCP owner management is disabled |
| `PROPRIUM_UPSTREAM_TIMEOUT` | no | Maximum upstream request time, default `2m` |

All configured origins must be canonical origins without credentials, path, query or fragment. `PROPRIUM_HOST_ORIGIN` is always required and must match the Host exactly. `PROPRIUM_PUBLIC_URL` must match the HTTPS hostname routed to this Gateway when Live MCP is enabled or the listen address is a wildcard; it may be omitted only for a loopback relay-only service. `GITHUB_CLIENT_ID` is always required at startup and must belong to the OAuth App configured for Device Flow. The executable contains no client secret or token.

Generate an owner key locally and enter it only into the Host's Live MCP settings:

~~~sh
openssl rand -base64 48
~~~

Do not put the owner key in a `VITE_*` setting, command argument, MCP endpoint URL, shell history or log. It must contain 32–4096 printable ASCII bytes without spaces. Keep it in an environment file readable only by the Gateway user. The Host keeps it in memory only. If the owner key is absent, OAuth and Git relay can still run but Live MCP publication is unavailable. A wildcard listen address such as `0.0.0.0:8080` also requires `PROPRIUM_PUBLIC_URL`; prefer binding to loopback behind the Tunnel.

## Local run

Set configuration in the process environment or a private environment file, then run as an ordinary account:

~~~sh
export PROPRIUM_HOST_ORIGIN=https://app.example.org
export PROPRIUM_PUBLIC_URL=https://gateway.example.org
export GITHUB_CLIENT_ID=Iv1.exampleclientid
export PROPRIUM_OWNER_KEY='generated-random-owner-key'
./proprium-gateway serve --listen 127.0.0.1:8080
~~~

For local Host development, use the exact dev-server origin and a loopback Gateway URL. Do not expose the development listener publicly. `GET /healthz` is a small health response and does not make a Workspace available. SIGTERM and SIGINT request graceful HTTP shutdown. The Gateway writes no persistent application data; logs go to its standard output/error.

## Cloudflare Tunnel

Run `cloudflared` as a separate user process. The Tunnel creates an outbound connection to Cloudflare and forwards HTTPS traffic to the loopback Gateway. The static Host remains a separate Workers Static Assets deployment. Cloudflare Tunnel does not guarantee unlimited request count or bandwidth.

1. Install `cloudflared` using the official instructions for the Linux distribution.
2. Authenticate and create or select a Tunnel for this Gateway account; route only `gateway.example.org` to it. These commands change Cloudflare account state, so review the selected account and hostname before running them.
3. Create `~/.cloudflared/config.yml` with the created Tunnel ID and credentials path:

~~~yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /home/proprium/.cloudflared/YOUR-TUNNEL-UUID.json
ingress:
  - hostname: gateway.example.org
    service: http://127.0.0.1:8080
  - service: http_status:404
~~~

Set `PROPRIUM_PUBLIC_URL=https://gateway.example.org`. Preserve the original public HTTPS Host header; the Gateway validates it against this URL. Configure `PROPRIUM_HOST_ORIGIN` as the static Host's exact HTTPS origin. Do not enable caching or body transformation for `/live/` or `/mcp`. The browser SSE response must carry `Content-Type: text/event-stream`; Cloudflare documents that this response type makes `cloudflared` stream events rather than buffer the response ([Tunnel streaming troubleshooting](https://developers.cloudflare.com/cloudflare-one/troubleshooting/tunnel/)). Allow long-lived responses through any other proxy in the path.

For a foreground Tunnel, after the Gateway is listening, run:

~~~sh
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run YOUR-TUNNEL-NAME
~~~

Check `https://gateway.example.org/healthz` and the Gateway's local `http://127.0.0.1:8080/healthz`. In the Host, enable Live MCP for a workspace and verify that the session becomes connected. Use the browser Network panel to confirm a long-lived `text/event-stream` response on the browser SSE endpoint, then make a read-only tool call and observe its HTTP request and result. Stop/restart the browser or Tunnel and confirm the Host reports disconnected and the MCP call reports unavailable; reconnect from the Host and authorize clients again if their session was revoked. This checks the actual proxy path and reconnection behavior; a local mock does not prove a public Tunnel works.

The Gateway sends a small SSE comment every 30 seconds while a Live stream is connected. This keeps bytes flowing during idle periods without polling or executing tools. Cloudflare documents a [125-second proxy read timeout](https://developers.cloudflare.com/fundamentals/reference/connection-limits/); proxies must pass the SSE comments incrementally. Verify the deployed path by leaving Live MCP idle for at least three minutes, then calling a read-only tool with the same client authorization. A stream write or flush failure expires the session and pending requests; the Browser Host must show the disconnect and require a new connection rather than replay a mutation.

### Cloudflare Access for browser requests

When Cloudflare Access protects the Gateway hostname, sign in to that hostname from the Host before starting GitHub authorization or enabling Live MCP. The Host sends the Access edge cookie only to the explicitly configured Gateway for OAuth, Git Smart HTTP and Live Workspace requests. The Go Gateway still checks the exact Host Origin, HTTP Host, repository identity and its existing bearer/session tokens; the Access cookie does not replace any Proprium authorization.

Cross-origin browser requests send a CORS `OPTIONS` preflight before the credentialed request. In the Access application for the Gateway hostname, enable **Advanced settings → Cross-Origin Resource Sharing (CORS) settings → Bypass options requests to origin**. This sends the preflight to the Gateway, where its exact-Origin CORS handler validates the method and headers. Keep Access authentication on the actual `/oauth/`, `/git/` and `/live/` requests; do not add a broad Access Bypass policy for those paths. The Gateway returns `Access-Control-Allow-Credentials: true` only with the configured Host Origin. See Cloudflare's [Access CORS guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/) for the current dashboard flow and alternatives.

The Host browser's Access cookie is not shared with an external MCP client. If Access also protects `/mcp`, configure the Access application so that the MCP client can independently satisfy its edge policy, for example with separate Access service-token headers if the client supports them. Keep `Authorization: Bearer` for the Proprium-paired MCP token; the Gateway checks it after Access admits the request. Do not configure an Access credential that overwrites the Authorization header expected by the Gateway.

## Optional user services

The following user unit runs the Gateway. Store the environment in `~/.config/proprium/gateway.env` with mode `0600` and replace the binary path with its actual location:

~~~ini
# ~/.config/systemd/user/proprium-gateway.service
[Unit]
Description=Proprium Gateway
After=network.target

[Service]
Type=simple
EnvironmentFile=%h/.config/proprium/gateway.env
ExecStart=%h/bin/proprium-gateway serve --listen 127.0.0.1:8080
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict

[Install]
WantedBy=default.target
~~~

Start and inspect it without a system service or root permission:

~~~sh
systemctl --user daemon-reload
systemctl --user enable --now proprium-gateway.service
systemctl --user status proprium-gateway.service
journalctl --user -u proprium-gateway.service
~~~

A separate user unit can run `cloudflared tunnel --config %h/.cloudflared/config.yml run YOUR-TUNNEL-NAME` with the same restart policy. User services normally stop when the account logs out; continuous operation after logout depends on the host's user-service/linger policy and is not a Gateway requirement. A shared host must permit long-running user processes and outbound Tunnel connections.

Restarting Gateway or cloudflared drops live MCP connections. The Host detects disconnect; the owner re-enables publication and client tokens are reissued after a Gateway restart. No in-flight mutation is replayed.

## Releases and CI

[Gateway CI](../../.github/workflows/verify-gateway.yml) runs Go tests with the race detector and `go vet`, then cross-builds CGO-free Linux amd64/arm64, Windows amd64, and macOS amd64/arm64 binaries with version `dev` and the current commit embedded. It uploads them under the Actions artifact name `proprium-gateway-<commit-sha>` with `SHA256SUMS` and `SOURCE.txt`; this is a build artifact, not a GitHub Release. Browser Verification installs the pinned Go toolchain, starts the actual Gateway with the Browser Host, and exercises Live MCP in Chromium and mobile WebKit. Those loopback tests do not verify a public Cloudflare Tunnel. [Gateway release](../../.github/workflows/release-proprium-gateway.yml) repeats tests and vet, builds the same five targets with the tag version and source commit, and publishes checksums and binaries to a GitHub Release for `proprium-gateway-vX.Y.Z` tags. Manual dispatch requires an existing matching tag that points to a commit on `main`. Ordinary CI does not publish releases.

The Host release remains separate and deploys Workers Static Assets only; it does not deploy or remove a Gateway. See [Cloudflare static Host deployment](CLOUDFLARE.md), [MCP contract](../architecture/MCP-GATEWAY.md), and [security boundaries](../architecture/DELIVERY-AND-SECURITY.md).
