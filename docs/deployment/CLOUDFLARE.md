# Proprium static Worker and R2 deployment

**Status: deployment design/runbook for the future browser-native build. This does not authorize production deployment of the inherited Scriptorium Node server or claim that the static Proprium entry already builds.** The Cloudflare account, custom domains, bucket names and permissions must be explicitly configured and tested; no resources are created by documentation.

## Ownership and release topology

- **Host**: static Vite/React browser bundle published through **Cloudflare Workers Static Assets** using Wrangler. A Worker JS handler is **not required** for basic static asset serving. Normal UI/editing/Git compute stays in browser.
- **Plugins and large assets**: immutable WASM, model/dictionary assets, signatures and registry JSON published to a separate Cloudflare **R2** bucket exposed through an explicitly configured custom domain. Reuse existing R2 resources only if their scope, CORS and cache policies are appropriate.
- **Optional edge Worker**: only for demonstrated GitHub OAuth/token exchange or Git Smart HTTP CORS/transport limitations. Must not be an implicit workspace API, Git writer, plugin runtime, repository cache or per-user compute backend. Independent name and access policy; **do not deploy one unless the transport PoC proves necessary**.

## Prerequisites

Use the repository's selected Node/pnpm versions and a reviewed, pinned Wrangler dependency in the eventual deployment workspace. Do not rely on floating CI tools, local interactive Wrangler login or personal credentials in CI. Configure a scoped Cloudflare API token in CI secrets, with only the necessary Workers deploy and R2 bucket/object permissions. Do not store a token in source or public client build. Configure domain/DNS ownership separately and verify the endpoint before marking release successful.

**The inherited Scriptorium \`pnpm build\` output is not a deployable Proprium SPA.** The following example assumes the new implementation emits \`dist/proprium/index.html\` and hashed assets. Change the output directory only after verified build configuration. The configuration is an example, not a claim that the file already exists:

~~~json
{
  "name": "proprium-host",
  "compatibility_date": "2026-10-25",
  "assets": {
    "directory": "./dist/proprium",
    "not_found_handling": "single-page-application"
  }
}
~~~

Use this content in a reviewed \`wrangler.jsonc\` at repo root (or adjust the directory relative to the chosen config file and specify \`--config\`). No \`main\`, R2 binding, D1, KV, cron, or Worker handler is required for the static Host.

## Host deployment commands (once the browser-native build exists)

~~~sh
pnpm install --frozen-lockfile
pnpm build:browser                 # to be added by browser Host implementation
test -f dist/proprium/index.html   # fail if still building legacy Scriptorium
pnpm exec wrangler deploy --config wrangler.jsonc
~~~

For preview/rehearsal use \`pnpm exec wrangler dev --config wrangler.jsonc\` with the same built output. Do not configure \`run_worker_first: true\` for static traffic. SPA fallback is only for navigation; distinguish actual missing JS/WASM assets from successful index fallback responses.

## R2 provisioning and plugin artifact publication

Choose approved bucket and domain names; these examples are **placeholders**, not already-provisioned user resources.

~~~sh
pnpm exec wrangler r2 bucket create <approved-bucket>
# Set up the bucket Custom Domain (and DNS zone ownership), for example:
pnpm exec wrangler r2 bucket domain add <approved-bucket> --domain <approved-assets-domain> --zone-id <approved-zone-id>
# Upload a versioned WASM byte-for-byte; explicit binary MIME and immutable cache control:
pnpm exec wrangler r2 object put <approved-bucket>/plugins/<publisher.plugin>/<version>/<digest>/plugin.wasm --file ./dist/plugin.wasm --content-type application/wasm --cache-control "public, max-age=31536000, immutable" --remote
# Upload the verified manifest/signature and other versioned assets with correct MIME:
pnpm exec wrangler r2 object put <approved-bucket>/plugins/<publisher.plugin>/<version>/<digest>/manifest.json --file ./dist/manifest.json --content-type application/json --cache-control "public, max-age=31536000, immutable" --remote
~~~

Use the official Wrangler command docs for \`r2 object put\` and \`r2 bucket domain add\`; verify flags against the pinned CLI. Registry index JSON is **mutable** and must have short/no-cache policy, atomic publication order and a signature/permission check, unlike immutable hashed WASM bytes. Do not publish index entries before their artifacts are reachable and verified. For large-scale sync, batch upload with an S3-compatible client/rclone when Wrangler one-object commands become inefficient; still verify exact object bytes.

An R2 bucket is private unless explicitly exposed. A Custom Domain enables public CDN delivery/cache. Set and verify bucket CORS for the specific Host origin and methods needed for artifact fetching, as well as \`Content-Type: application/wasm\`, cross-origin worker/CSP behavior, \`Cache-Control\` and \`nosniff\`. Never allow plugin asset hosting to receive private GitHub credentials. Test CORS preflight and actual browser \`fetch()\`; public HTTP download alone does not establish WASM runtime eligibility.

## CI/CD gates

Deploy from GitHub Actions only on an explicitly authorized release. Use frozen dependencies, immutable artifact identity and reviewable source-to-artifact provenance. Required sequence:

1. Validate source, browser tests, plugin ABI/integrity and credentials handling. Freeze package lock and versioned Wrangler.
2. Build **new** browser Host output; inspect manifest/dependency closure to ensure no Scriptorium Node/Fastify server code, secrets, or private fixtures are shipped.
3. Publish plugin assets to immutable R2 keys, verify content digest and CORS/headers using the public custom domain; publish signed registry metadata last.
4. Deploy Host static assets with Wrangler to a preview/production target only as explicitly authorized. Use an environment-specific name/domain and the correct account identity.
5. Smoke-test actual HTTPS URLs, SPA navigation, JS/WASM/cache responses, mobile WebKit/Chromium, offline restart, and explicit GitHub sync. Record exact deployed digests and rollback path.

**Do not** automatically enable deployments or create buckets/domains as part of the first architectural or local Git implementation PR. No Cloudflare control-plane mutation is implied by this runbook.

## Official reference

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [SPA routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Wrangler R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
- [R2 custom domain caching](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)
