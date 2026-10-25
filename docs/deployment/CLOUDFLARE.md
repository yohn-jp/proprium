# Proprium static delivery

The repository builds a dedicated Browser Host at `dist/proprium/`. `wrangler.jsonc` serves that directory through Cloudflare Workers Static Assets and routes navigation fallbacks to `index.html`. The Host release and plugin registry publication workflows are manual dispatches from `main`. Neither workflow is run by ordinary CI. No Cloudflare account, domain, Worker or R2 bucket is provisioned by this repository, and local verification does not establish a production deployment. A separate Go Gateway may run behind an operator-configured Cloudflare Tunnel; see [Gateway operations](GATEWAY.md).

## Runtime and build boundary

- The Host is a React/Vite static site. Workspace editing, local Git, GitHub sync and WASM plugin compute run in the browser.
- Workers Static Assets serves the Host without a request handler, R2 binding, D1, KV, scheduled job or per-user application server.
- The former GitHub OAuth/Smart HTTP Relay Worker is retired. The Host release workflow publishes static Host assets only; it has no Git Relay deployment step. The Gateway is a separately built binary and is not deployed by this workflow.
- Cloudflare Tunnel is a separate `cloudflared` process that forwards a public HTTPS hostname to a non-root Gateway listener such as `127.0.0.1:8080`. On Linux, the Proprium CLI supplies a pinned `cloudflared` binary in the verified Gateway bundle and manages both processes through one systemd user service. It does not embed Tunnel functionality in the Gateway or make a Gateway database necessary.
- Plugin artifacts use an independently versioned R2 origin. R2 serves immutable WASM and signed registry data; the Host validates publisher identity and artifact digests before execution.

The selected toolchain is Node 24, pnpm 12.10.1 and Wrangler 4.152.0, pinned in the repository. The static build uses `app/vite.proprium.config.ts` and `app/index.html`; it does not use the inherited profile build. The build validates the output location, writes a `_headers` file whose connection policy permits HTTPS and loopback HTTP for owner-selected Gateways, and rejects the test-only Host seam. A generated service worker precaches only the entry page and hashed static JavaScript, CSS, workers and fonts so a warm workspace can reopen offline. It does not cache repository data or downloaded plugin artifacts; those have their own browser storage and digest checks.

## Local checks

Run these commands from the repository root:

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck:browser
pnpm test:browser:unit
pnpm test:browser:e2e
pnpm build:browser
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
~~~

`pnpm verify:browser` runs the browser typecheck, focused unit tests, static build and Wrangler dry-run. CI also installs Chromium and WebKit and runs the browser acceptance suite. The dry-run verifies the local static asset bundle and configuration without authenticating to Cloudflare or changing remote state.

The Host release workflow is `.github/workflows/release-proprium-host.yml`. It is available only by manual dispatch from `main`, requires a selected GitHub environment (`proprium-preview` or `proprium-production`), accepts an optional public Gateway URL and validates the public registry key, reruns Browser Host checks and publishes static Host assets with a scoped Cloudflare token. Configure `VITE_PROPRIUM_GATEWAY_URL`, `VITE_PROPRIUM_PLUGIN_REGISTRY_URL`, `VITE_PROPRIUM_PLUGIN_REGISTRY_KEY`, and `VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS` as GitHub environment variables. The Gateway URL and registry settings are public and embedded in the Host bundle. Do not put owner keys, private signing keys or API tokens in a `VITE_*` variable.

The workflow does not create account resources, DNS records, custom domains, Tunnel routes or R2 buckets. Configure those separately. A successful static Host deployment does not prove the Gateway, OAuth flow, HTTPS Tunnel, streaming SSE path, GitHub authorization or cache policy works. Test each deployed endpoint and approved sync flow before advertising it. Existing Cloudflare account Workers are not deleted by repository changes; inspect and retire only the exact old Relay after a new Gateway deployment has been confirmed in use.

## R2 plugin artifacts

`.github/workflows/publish-plugin-registry.yml` is a manual release workflow. It builds the independent example plugin with `scripts/build-plugin-registry.mjs`, verifies the signed registry and every artifact against the registry's separately pinned Ed25519 public key, and invokes `scripts/publish-plugin-registry.mjs` to upload content-addressed immutable files. The publisher fetches each object from the public origin and checks its bytes, MIME, cache headers, `nosniff`, and Host CORS response before it publishes the signature sidecar and registry index last. It requires an existing R2 bucket and public custom domain; it never creates either resource.

With `PROPRIUM_PLUGIN_R2_BUCKET`, `PROPRIUM_PLUGIN_ARTIFACT_BASE`, and `PROPRIUM_HOST_ORIGIN` set, `node scripts/publish-plugin-registry.mjs artifacts --plan` prints the exact local source files and R2 object keys it would publish without Cloudflare credentials or network access.

Configure the `proprium-plugin-release` GitHub environment with:

- `PROPRIUM_PLUGIN_R2_BUCKET`: an existing bucket name.
- `PROPRIUM_PLUGIN_ARTIFACT_BASE`: the HTTPS custom-domain directory ending in `/plugins/`.
- `PROPRIUM_HOST_ORIGIN`: the exact HTTPS Host origin allowed by bucket CORS.
- `VITE_PROPRIUM_PLUGIN_REGISTRY_KEY`: the pinned base64 Ed25519 public key used by the Host and release verification.
- `CLOUDFLARE_ACCOUNT_ID` and a least-privilege `CLOUDFLARE_API_TOKEN` secret.
- `PROPRIUM_PLUGIN_REGISTRY_PRIVATE_KEY` and `PROPRIUM_PLUGIN_PUBLISHER_PRIVATE_KEY` secrets, available only to this environment.

The R2 custom domain must return `application/wasm`, the configured CORS allow-origin, and immutable cache headers for versioned WASM. The mutable signed registry uses short cache lifetimes. The release workflow uploads its immutable artifacts first, checks the public origin, and updates the signed registry sidecar and index after those checks. It does not run during normal verification.

Do not upload user repositories, credentials, browser storage or plugin private keys to R2. Host builds pin the public registry key; registry metadata cannot introduce a new trust root. Artifact signature and byte-digest validation remains mandatory after download.

## References

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Wrangler R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
- [R2 custom domain caching](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)

## Optional Gateway and Tunnel

The Gateway is a downloadable, versioned Go executable. It runs without root on a non-privileged loopback listener and requires neither a DB nor Node/container runtime. The Linux `proprium` CLI installs and manages it with a pinned, separate `cloudflared` executable under one systemd user service; it does not create Cloudflare account resources or replace the static Host deployment. Live MCP uses authenticated Streamable HTTP to the Gateway, which forwards requests over the Browser Host's opted-in SSE/HTTP connection. The browser must be active; the Gateway stores no Workspace data. A local Gateway/CLI check does not prove the public Tunnel, OAuth or MCP path; see [Gateway installation and operations](GATEWAY.md) for production verification limits.

Cloudflare Tunnel is not an unconditional unlimited-traffic service. Static Host and R2 publication remain distinct from this optional runtime. See [Gateway/MCP contract](../architecture/OPTIONAL-GATEWAY-AND-MCP.md).
