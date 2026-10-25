# Proprium Gateway configuration and operations

The Gateway is a single Go executable. It needs no root account, database, Node.js runtime, container or writable data directory. It serves GitHub OAuth Device Flow, restricted Git Smart HTTP fallback and, when configured with an owner key, the optional Live Workspace MCP control plane. It does not store GitHub tokens, repositories, workspace contents, search indexes or Git objects.

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
| `PROPRIUM_PUBLIC_URL` | yes | Exact public Gateway origin, for example `https://gateway.example.org`; used for Host and proxy request validation |
| `GITHUB_CLIENT_ID` | OAuth use | GitHub OAuth App client ID for Device Flow; public identifier, not a secret |
| `PROPRIUM_OWNER_KEY` | Live MCP use | Random owner bearer secret of at least 32 bytes; keep private. If absent, Live MCP owner management is disabled |
| `PROPRIUM_UPSTREAM_TIMEOUT` | no | Maximum upstream request time, default `2m` |

All configured origins must be canonical origins without credentials, path, query or fragment. The Host origin must match the deployed static Host exactly. `PROPRIUM_PUBLIC_URL` must match the HTTPS hostname routed to this Gateway. The GitHub OAuth client ID must belong to the OAuth App configured for Device Flow. The executable contains no client secret or token.

Generate an owner key locally and enter it only into the Host's Live MCP settings:

~~~sh
openssl rand -base64 48
~~~

Do not put the owner key in a `VITE_*` setting, command argument, MCP endpoint URL, shell history or log. Keep it in an environment file readable only by the Gateway user. The Host keeps it in memory only. If the owner key is absent, OAuth and Git relay can still run but Live MCP publication is unavailable.

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

[Gateway CI](../../.github/workflows/verify-gateway.yml) runs Go tests with the race detector, `go vet` and a static Linux build. Browser Verification installs the pinned Go toolchain, starts the actual Gateway with the Browser Host, and exercises Live MCP in Chromium and mobile WebKit. Those loopback tests do not verify a public Cloudflare Tunnel. [Gateway release](../../.github/workflows/release-proprium-gateway.yml) repeats tests and vet, builds Linux amd64/arm64, Windows amd64, and macOS amd64/arm64 binaries, embeds the version and source commit, and publishes checksums and artifacts to a GitHub Release for `proprium-gateway-vX.Y.Z` tags. Manual dispatch requires an existing matching tag that points to a commit on `main`. Ordinary CI does not publish releases.

The Host release remains separate and deploys Workers Static Assets only; it does not deploy or remove a Gateway. See [Cloudflare static Host deployment](CLOUDFLARE.md), [MCP contract](../architecture/MCP-GATEWAY.md), and [security boundaries](../architecture/DELIVERY-AND-SECURITY.md).
