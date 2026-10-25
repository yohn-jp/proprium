# Plugin registry, artifact delivery and lifecycle

**Status: target contract.** Proprium does not install plugins by rebuilding application/container images. Plugins are independently built static artifacts, with WASM as their default compute entrypoint. R2 is a distribution store, not a document database.

## Artifact and immutable identity

- A registry contains publisher-scoped plugin ID, SemVer version, manifest URL, manifest digest, signing identity and compatibility metadata. Canonical manifest binds every WASM/data asset to its byte length, SHA-256 digest, validated relative path, media type and required Host/ABI ranges.
- Artifacts are immutable and content-addressed (version and digest); publishing may add a new version but never overwrite bytes already referenced by an installed digest.
- A digest verifies bytes only. **Publisher authenticity** requires pinned trusted signing keys, a curated allowlist with audited delivery authority or an equivalent explicit trust root. Untrusted registry-provided keys cannot approve their own artifacts. Define a concrete signature/rotation/revocation policy before public third-party plugin admission.
- Download all required bytes, verify identity and integrity, then atomically activate the complete version. Never execute before checking its digest or accept arbitrary JS source from a remote URL.
- Cache verified WASM, model and dictionary assets by immutable digest; store installed version, explicit capabilities and preferences in browser storage. Cache eviction makes offline startup unavailable, not authorization to load unsigned replacements.

## Installation and upgrade

1. Select trusted registry/offline artifact, obtain metadata and validate trusted publisher, version, dependencies, ABI and requested grants.
2. Display permission changes, affected workspaces and large download sizes before user approval.
3. Fetch/hash assets with bounded bytes and CORS/CSP-constrained destinations. Reject any mismatch, missing asset, path escape, signature failure, cycle or incompatible Host range.
4. Install disabled by default or according to an explicit user choice. Enabling does not initialize heavyweight modules.
5. On demand, activate Worker/component behind Capability Broker. Disable/uninstall revokes leases and cancels jobs; deleting a plugin must not delete user Git files.
6. Upgrades stage a complete verified version before cutover. Retain a verified previous version if its data schema remains compatible. Never downgrade canonical plugin-authored data without migration/rollback contract.

## Separation of concerns

- **Build**: plugin-specific GitHub Actions compile/test the plugin. No Proprium Host rebuild or container image is required.
- **Registry**: static, signed/pinned metadata updated only after every artifact is accessible. The registry itself grants no execution permission.
- **R2/CDN**: public immutable bytes, appropriate Content-Type, Cache-Control and CORS for the verified Host origin. Do not store tokens or user manuscripts.
- **Host**: trust root, install state, version pin, permissions, lazy activation and Worker lifecycle.

Operational Wrangler/R2 steps and their deployment safeguards are in [Cloudflare deployment](../deployment/CLOUDFLARE.md). Plugin ABI and UI/capabilities are specified in [WASM plugin ABI](WASM-PLUGIN-ABI.md) and [Plugin platform](PLUGIN-PLATFORM.md).

## Acceptance

Build/publish one plugin without rebuilding Host; cold zero-plugin load; immutable digest mismatch and unauthorized publisher fail closed; cycle/incompatible ABI/permission denial; staged upgrade, rollback and mid-download failure; cached offline activation and cache-miss denial; graceful teardown and Worker cancellation; mobile WebKit/Android testing.
