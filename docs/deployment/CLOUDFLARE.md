# Proprium static delivery

The repository builds a dedicated Browser Host at `dist/proprium/`. `wrangler.jsonc` serves that directory through Cloudflare Workers Static Assets and routes navigation fallbacks to `index.html`. The host release workflow and plugin registry publication workflow are manual dispatches from `main`. Neither workflow is run by ordinary CI. No Cloudflare account, domain, Worker, or R2 bucket is provisioned by this repository, and no production deployment is included in local verification.

## Runtime and build boundary

- The Host is a React/Vite static site. Workspace editing, local Git, GitHub sync and WASM plugin compute run in the browser.
- Workers Static Assets serves the Host without a Worker handler, R2 binding, D1, KV, scheduled job or per-user application server.
- The **target** GitHub OAuth/Smart HTTP and Live MCP service is an **optional non-root Go Gateway** run by the operator, optionally behind Cloudflare Tunnel or another HTTPS reverse proxy. The existing Cloudflare GitHub relay Worker is transitional and must be retired after Go equivalence tests and cutover. It does not define the final deployment architecture.
- Plugin artifacts use an independently versioned R2 origin. R2 serves immutable WASM and signed registry data; the Host validates publisher identity and artifact digests before execution.

The selected toolchain is Node 24, pnpm 12.10.1 and Wrangler 4.152.0, pinned in the repository. The static build uses `app/vite.proprium.config.ts` and `app/index.html`; it does not use the inherited profile build. The build validates the output location, writes a restrictive `_headers` file for the configured GitHub and plugin origins, and rejects the test-only Host seam. A generated service worker precaches only the entry page and hashed static JavaScript, CSS, workers and fonts so a warm workspace can reopen offline. It does not cache repository data or downloaded plugin artifacts; those have their own browser storage and digest checks.

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

The current host release workflow is `.github/workflows/release-proprium-host.yml`. **Current implementation, pending migration:** it still deploys the old Cloudflare GitHub OAuth/Smart HTTP Worker. This is not the target. The implementation migration must remove that Worker step, leaving **static Host delivery only**, and introduce a separate Go Gateway test/binary release workflow. Configure the Host's static plugin registry origin, artifact origins and pinned public signing key independently of any optional Gateway endpoint. A Gateway URL is not a prerequisite for the static Host's initial load. Never put private signing keys, OAuth tokens or API secrets in `VITE_*` variables.

The workflow does not create account resources, DNS records, custom domains, or R2 buckets. Configure those separately. A configured Worker name does not prove the public domain, OAuth redirect, cache policy or GitHub authorization works; test the deployed URL and approved sync flow before advertising a release.

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

## Optional Gateway and Tunnel target (not deployed by this documentation PR)

The target Gateway is a downloadable, versioned Go single executable. It runs without root on a non-privileged loopback listener and requires neither a DB nor Node/container runtime. Its external HTTPS endpoint may be offered by `cloudflared` (a separate operator-managed process) or another HTTPS reverse proxy. Live MCP uses authenticated Streamable HTTP to the Gateway, which forwards requests over the Browser Host's opted-in SSE/HTTP connection. The browser must be active; the Gateway stores no Workspace data. The Go release and replacement of the old relay workflow must be separately implemented and verified.

Cloudflare Tunnel is not an unconditional unlimited-traffic service. Static Host and R2 publication remain distinct from this optional runtime. See [Gateway/MCP contract](../architecture/OPTIONAL-GATEWAY-AND-MCP.md).
