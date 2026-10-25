# Proprium Gateway installation and operations

The optional Go Gateway provides GitHub OAuth Device Flow, restricted Git Smart HTTP fallback, and explicitly enabled Live Workspace MCP. The static Browser Host still supports local editing, local Git and admitted/cached WASM plugins without a Gateway or login. The Gateway is a transient relay: it does not store GitHub tokens, repositories, workspaces, workspace contents, indexes or Git objects.

## Supported management path

The production management interface is the `proprium` CLI on Linux amd64 and arm64. It installs and updates the Gateway and a pinned `cloudflared` binary in the current user's XDG directories, configures one systemd **user** service for both processes, and supports `install`, `setup`, `start`, `stop`, `restart`, `status`, `update`, `rollback`, `logs`, `doctor`, `version`, and `help`. It does not require root, a system service, Node.js, a container or a database. The Gateway and `cloudflared` remain separate executables; the user service coordinates their lifecycle. Each child receives only its own secrets. Both Tunnel modes use an explicit private managed config, so a pre-existing `~/.cloudflared/config.yml` is not implicitly loaded.

The manager uses `$XDG_BIN_HOME` when set, otherwise `$HOME/.local/bin`; `$XDG_CONFIG_HOME/proprium` when set, otherwise `$HOME/.config/proprium`; and `$XDG_DATA_HOME/proprium` when set, otherwise `$HOME/.local/share/proprium`. Configuration, active release metadata and rollback material are kept in their respective user-owned directories. The installed launcher remembers custom config/data/bin locations for later commands. Do not place these paths in a shared/system directory or run the manager with `sudo`.

The CLI is the supported operational path. Do not install a second `cloudflared`, create a separate Tunnel service, or replace the managed binaries by hand as part of routine setup or updating. A user who needs direct manual operation should use the pinned release's own help and treat the service state as unmanaged until returned to the CLI workflow.

### Requirements and path rules

Use Linux amd64 or arm64, Bash 5 or newer, `curl`, `jq`, `awk`, GNU coreutils, GNU `tar`, util-linux `flock`, and a running systemd user manager (`systemctl --user`). `logs` also requires `journalctl` and a working user journal; `loginctl` is used to report linger state. The CLI refuses to create a system service or escalate privileges when the user manager is unavailable.

The default paths follow `XDG_BIN_HOME` (or `~/.local/bin`), `XDG_CONFIG_HOME/proprium` (or `~/.config/proprium`), and `XDG_DATA_HOME/proprium` (or `~/.local/share/proprium`). Path overrides must be absolute and cannot be `/`. The manager rejects symlink path components, `.`/`..` components, and paths containing newline, carriage return, `%`, double quote, or backslash. It requires configuration/data directories to be owned by the current user, sets them to mode `0700`, and stores secret/configuration files at mode `0600`. Use plain, user-owned directories for all overrides.

### Install and configure

First verify the standalone bootstrap against both the latest-release API asset digest and the matching release checksum file. This captures one release ID/tag from the API, downloads both assets from that tag, checks their API SHA-256 digests, and cross-checks the bootstrap checksum before execution:

~~~sh
set -euo pipefail
api=https://api.github.com/repos/yohn-jp/proprium/releases/latest
release_base=https://github.com/yohn-jp/proprium/releases/download
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 "$api" -o "$tmp/release.json"
tag=$(jq -er '.tag_name | select(test("^proprium-gateway-v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))' "$tmp/release.json")
asset_digest() {
  jq -er --arg name "$1" '[.assets[]? | select(.name == $name)] as $a | if ($a | length) == 1 then $a[0].digest // empty else empty end' "$tmp/release.json"
}
asset_url() {
  jq -er --arg name "$1" '[.assets[]? | select(.name == $name)] as $a | if ($a | length) == 1 then $a[0].browser_download_url // empty else empty end' "$tmp/release.json"
}
bootstrap_api=$(asset_digest bootstrap.sh)
sums_api=$(asset_digest SHA256SUMS)
[[ $bootstrap_api =~ ^sha256:[0-9a-f]{64}$ && $sums_api =~ ^sha256:[0-9a-f]{64}$ ]]
bootstrap_url="$release_base/$tag/bootstrap.sh"
sums_url="$release_base/$tag/SHA256SUMS"
[[ $(asset_url bootstrap.sh) == "$bootstrap_url" && $(asset_url SHA256SUMS) == "$sums_url" ]]
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 "$bootstrap_url" -o "$tmp/bootstrap.sh"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 10 --max-time 60 "$sums_url" -o "$tmp/SHA256SUMS"
printf '%s  %s\n' "${bootstrap_api#sha256:}" "$tmp/bootstrap.sh" | sha256sum --check -
printf '%s  %s\n' "${sums_api#sha256:}" "$tmp/SHA256SUMS" | sha256sum --check -
bootstrap_sum=$(awk '$2 == "bootstrap.sh" { if (n++) exit 1; print $1 } END { if (n != 1) exit 1 }' "$tmp/SHA256SUMS")
[[ $bootstrap_sum =~ ^[0-9a-f]{64}$ && $bootstrap_sum == "${bootstrap_api#sha256:}" ]]
bash "$tmp/bootstrap.sh"
bin_dir=${XDG_BIN_HOME:-$HOME/.local/bin}
"$bin_dir/proprium" install
"$bin_dir/proprium" status
~~~

`bootstrap.sh` installs the verified CLI but does not edit shell startup files. The example invokes it by its default path rather than assuming the directory is already on `PATH`; if a custom `--bin-dir` is used, invoke the CLI from that directory. `install` stages and verifies the Gateway bundle, runs setup to collect required values, checks that both the Gateway listen port and Tunnel metrics port are available, then registers and starts the managed user service. On an initial install, a bounded loopback TCP probe makes `install` fail if either port is occupied or unresponsive, before it changes the release pointer, registers a unit, or stops any existing process. Use `setup` later to change configuration; it saves private settings and tells you to restart the service to apply them. See the migration notes below before stopping any existing service.

The operator verifies the downloaded `bootstrap.sh` bytes against `SHA256SUMS` before running it. The script resolves the latest release through the GitHub Releases API and verifies both the standalone Linux CLI asset and `SHA256SUMS` against their API SHA-256 digests, then cross-checks the CLI checksum before installing it. It pins the selected release metadata for that acquisition; it does not accept an unchecked tag or asset from another release. `proprium install` resolves the Gateway release, selects the Linux amd64 or arm64 bundle, and obtains that release's `SHA256SUMS`. It verifies the API SHA-256 asset digest and release checksum, then validates the embedded archive manifest and component hashes before activation. The bundle contains the Gateway and the pinned, separately executable `cloudflared`. Each stage uses files from the same release ID/tag. A checksum verifies bytes against a release checksum file; it is not a separate publisher signature.

`setup` gathers the public Gateway URL, exact static Host origin, GitHub OAuth App client ID, and Cloudflare Tunnel authentication material. The default Host origin is `https://proprium.yohn.jp`; the default Gateway listener is `127.0.0.1:8080`. The CLI can also accept these setup options:

~~~text
--non-interactive
--maintenance
--config-dir PATH
--data-dir PATH
--bin-dir PATH
--public-url URL
--host-origin ORIGIN
--github-client-id ID
--tunnel-token-file PATH
--tunnel-credentials-file PATH --tunnel-id UUID
--access-credentials-file PATH
--listen 127.0.0.1:8080
--metrics 127.0.0.1:20000
~~~

Use either a Tunnel token file or the credentials JSON file together with its Tunnel ID. Secret input files must be regular files owned by the current user with mode `0600`; copy older root-owned files into a private user directory before setup. The optional Access credentials file is private `KEY=value` data containing `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`; it is used only for the CLI's public health probe and does not change Cloudflare Access policy. The CLI reads secret input files as data; it never sources them as shell code. The Gateway no longer generates an MCP Owner Key or requires Proprium client bearer tokens. Do not pass a Tunnel token, credentials JSON, Access secret, or OAuth secret in arguments, environment dumps, command history, logs or issue reports. Secret input is accepted through these files or hidden terminal input; `--non-interactive` requires the documented file inputs. The GitHub client ID is a public identifier. The CLI does not create or change Cloudflare accounts, Tunnel resources, DNS routes, Access applications, or GitHub OAuth Apps; those provider resources and their authorization must already be available.

The installation creates private configuration, stages the Gateway plus pinned `cloudflared` under the configured user paths, and registers one `systemd --user` unit that starts, stops and restarts both managed processes. It does not promise that user services continue after logout or boot: that depends on the host's systemd user manager and linger policy. `doctor` reports local installation, service, version and connectivity conditions; a local health response alone does not prove the public proxy or Live MCP path.

### Migrate an existing manual Gateway

Preserve the existing GitHub OAuth Client ID, public Gateway URL, Host origin, listen address, and Cloudflare Tunnel credentials. Replace the former `PROPRIUM_OWNER_KEY` environment setting; it is **obsolete**, ignored on import, and removed from the managed private configuration during migration. Do not copy an old MCP Owner Key into new configuration.

The managed `gateway.env` is a plain `KEY=value` file:

~~~text
PROPRIUM_LISTEN_ADDR=127.0.0.1:8080
PROPRIUM_HOST_ORIGIN=https://proprium.yohn.jp
PROPRIUM_PUBLIC_URL=https://your-existing-gateway-host.example
GITHUB_CLIENT_ID=your-existing-public-client-id
~~~

Existing Tunnel credentials must remain private, as described in the setup section above. The installer refuses takeover if the old process owns the required loopback port. Identify and stop only the verified old service, retaining a rollback path. Do not run two Tunnel connectors publishing the same route concurrently. Once the new runtime is active, Browser Host reconnects automatically; previously issued Proprium client tokens are **no longer used**. All MCP callers use Cloudflare Access at the public edge.

### Operate and recover

~~~sh
proprium start
proprium status
proprium logs
proprium doctor
proprium restart
proprium stop
~~~

`status` reports the managed Gateway and Tunnel service state and installed versions. `logs` reads the combined user-service journal. `doctor` checks the local files, permissions, configured listener and public health endpoints; if Cloudflare Access protects the public health route, provide the optional Access probe credentials file. Verify the Host integration separately when validating a live deployment. An unsafe or failed operation returns nonzero; `status` and `doctor` return nonzero when the service is degraded. `help` is informational. If the systemd user manager is unavailable, the CLI fails without installing a system unit. If linger is off, it reports logout persistence as unverified and prints the administrator action needed; it does not escalate privileges or enable linger itself.

Updating is explicit; installing a newer release does not silently replace the running service. `stop`, `restart`, `update`, and `rollback` check the Gateway's private local control socket before changing service state. The default protects active MCP clients: an interactive invocation asks whether to revoke sessions, while a non-interactive invocation fails without changing the service. Use `--maintenance` to explicitly permit the operation and revoke active sessions:

~~~sh
proprium update --maintenance
proprium rollback --maintenance
~~~

An accepted stop, restart or binary switch disconnects live sessions. Gateway restart invalidates in-memory Browser Host registrations and in-flight operations; no pending mutation is replayed. The CLI retains the last known-good Gateway and Tunnel release files and restores them if a staged update fails validation or fails its service health check. `rollback` switches back to that retained release and restarts the managed service. Rollback restores executable versions, not volatile sessions or provider-side configuration.

Do not manually delete the retained release or edit active release metadata. If the service cannot start after a failed operation, use `proprium status`, `proprium logs`, and `proprium doctor` to identify the failure before retrying or restoring the previous release.

## Gateway and Tunnel behavior

The Gateway defaults to `127.0.0.1:8080`; the managed Tunnel publishes its configured HTTPS hostname and forwards to that loopback listener. Configure the public URL to match the routed HTTPS Gateway origin and the Host origin to match the static site's exact origin. Keep the Gateway listener private. Do not enable caching or body transformation for `/live/` or `/mcp`; SSE must stream incrementally through the proxy. Cloudflare Tunnel does not guarantee unlimited request count or bandwidth.

Cloudflare Access authenticates public access to every route of the Gateway hostname, including `/mcp`, `/live/`, `/oauth/`, and `/git/`. The Gateway itself no longer requires a proprietary Owner Key or MCP Client Bearer Token. It still enforces the configured Host Origin for browser calls, the HTTP Host/public URL, bounded requests, and immutable GitHub repository identity and permission checks for Git relay. The Gateway binds only to loopback behind Cloudflare Tunnel. Do not expose the loopback listener to untrusted local processes or publish a second unprotected external hostname.

Cross-origin browser requests send a CORS `OPTIONS` preflight before the credentialed request. In the Access application for the Gateway hostname, enable **Advanced settings → Cross-Origin Resource Sharing (CORS) settings → Bypass options requests to origin**. This sends the preflight to the Gateway, where its exact-Origin CORS handler validates the method and headers. Keep Access authentication on actual `/oauth/`, `/git/` and `/live/` requests; do not add a broad Access Bypass policy for those paths. The Gateway returns `Access-Control-Allow-Credentials: true` only with the configured Host Origin. See Cloudflare's [Access CORS guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/) for current dashboard behavior.

The Host browser's Access cookie is not shared with an external MCP client. Access must also protect `/mcp`. External MCP clients authenticate separately through Cloudflare Access Managed OAuth (or a client-supported Access credential method). Proprium does not issue or ask users to paste an MCP client token; `tools/list` always shows the fixed eight-tool registry. A Browser Host must be actively connected to execute a tool; every repository-scoped tool requires `repository_id`.

The Gateway's Live Workspace transport is authenticated Streamable HTTP to the Gateway and an outbound SSE/HTTP connection to the active Browser Host. The Gateway sends an SSE comment every 30 seconds while a Live stream is connected. Proxies must pass these bytes incrementally; Cloudflare documents a [125-second proxy read timeout](https://developers.cloudflare.com/fundamentals/reference/connection-limits/). A local `/healthz` success does not prove public SSE forwarding. Verify the public path by leaving Live MCP idle for at least three minutes, then making a read-only tool call using the same Cloudflare Access-authorized MCP client. A stream failure expires the session and pending requests; the Host must show the disconnect and require a new connection instead of replaying a mutation.

When validating a deployment, check `https://<gateway-host>/healthz` and `http://127.0.0.1:8080/healthz`, open a workspace in the Browser Host (which automatically connects Live MCP), confirm an SSE response with `Content-Type: text/event-stream`, and make an authorized read-only call. Stop/restart the browser or managed service and confirm the Host reports disconnected and the MCP call reports unavailable. The Browser Host reconnects after Gateway restart; no Proprium client pairing is needed. These checks exercise the actual proxy path; a local mock does not prove a public Tunnel works.

## Release and verification boundaries

Pull request verification runs Go tests with the race detector and `go vet`, then cross-builds CGO-free Linux amd64/arm64, Windows amd64, and macOS amd64/arm64 binaries with version `dev` and the current commit embedded. It uploads a commit-named Actions artifact with `SHA256SUMS` and `SOURCE.txt`; that PR artifact is not a GitHub Release. Browser Verification starts the Gateway beside the Host and exercises Live MCP in Chromium and mobile WebKit. Those loopback tests do not verify a public Cloudflare Tunnel.

The release workflow also runs on every push to `main`. After successful source validation, tests, vet, bundle verification and builds, it publishes `proprium-gateway-v0.0.<workflow-run-number>` as a GitHub Release. A failed build does not publish a release. Manual dispatch is available for an existing canonical `proprium-gateway-vX.Y.Z` tag that points to a commit on `main`. Bootstrap and `proprium install` select the latest published Gateway Release and verify the API SHA-256 digest of each downloaded asset, then the matching `SHA256SUMS`; install also checks the bundle manifest and component hashes.

Each release has these five platform bundles: `proprium-gateway_${VERSION}_linux_amd64.tar.gz`, `proprium-gateway_${VERSION}_linux_arm64.tar.gz`, `proprium-gateway_${VERSION}_windows_amd64.tar.gz`, `proprium-gateway_${VERSION}_darwin_amd64.tar.gz`, and `proprium-gateway_${VERSION}_darwin_arm64.tar.gz`. It also publishes the standalone Linux CLI `proprium`, `bootstrap.sh`, `SHA256SUMS` and top-level `SOURCE.txt`. The bundles contain the Gateway and the pinned `cloudflared` executable, manifest, source metadata, and license/notice files. `THIRD-PARTY-LICENSES.txt` includes the union of cloudflared dependency licenses/notices for all five targets and the pinned Go runtime license/patent texts. The current pinned `cloudflared` version is **2026.10.3**, sourced from the official [Cloudflare cloudflared release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3), with its upstream asset SHA-256 and Apache-2.0 license checksum verified during packaging. The release `SHA256SUMS` covers all five bundles and the standalone CLI/bootstrap assets; GitHub API digests are checked for the published release assets.

Windows and macOS runtime bundles are available, but managed CLI installation and service operations are unsupported on those operating systems. Release integrity checks do not prove Cloudflare provider configuration or a production OAuth/MCP deployment.

The Host release remains separate and deploys Workers Static Assets only; it does not deploy or remove a Gateway. See [Cloudflare static Host deployment](CLOUDFLARE.md), [MCP contract](../architecture/MCP-GATEWAY.md), and [security boundaries](../architecture/DELIVERY-AND-SECURITY.md).
