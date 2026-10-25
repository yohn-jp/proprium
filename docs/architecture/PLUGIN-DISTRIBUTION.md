# Plugin registry, artifact delivery and lifecycle

**Status: target contract; the signed registry and browser install manager are implemented, while production signing roots, an R2 registry and broad browser certification are not provisioned.** Proprium does not install plugins by rebuilding application/container images. Plugins are independently built static artifacts, with WASM as their default compute entrypoint. R2 is a distribution store, not a document database.

## Artifact and immutable identity

- The V1 signed registry contains publisher-scoped plugin IDs, immutable SemVer versions, manifest paths, digests, detached signatures, delegated publisher keys and version-ranged dependencies. Its canonical manifest binds WASM/data assets to byte length, SHA-256 digest, validated relative path and media type. The browser manager supports exact, `^`, `~` and `*` dependency ranges and persists the resolved version for each installed plugin.
- Artifacts are immutable and content-addressed (version and digest); publishing may add a new version but never overwrite bytes already referenced by an installed digest.
- The Host pins an Ed25519 registry public key and separately allowlists artifact origins. A registry document is signed over its exact bytes; a publisher key and detached manifest signature are delegated by that signed document. A registry-provided key cannot authorize its own registry. Replacing the Host-pinned registry key invalidates cached registry proofs. A newer root-signed registry revokes an installed version if it removes the entry or changes its key, manifest digest/signature or dependency metadata; retain old entries to keep rollback available. Each client accepts only a strictly newer SemVer registry index after observation; replay of the exact current snapshot is idempotent, while older indexes and different bytes under an observed version are rejected. Offline clients enforce the newest signed index they have verified, so a revocation published after the last connection cannot reach a currently offline device.
- Show a signed metadata preview with requested capabilities, dependency pins and total transfer size before downloading artifact bytes. The manager issues a one-use, five-minute plan bound to that registry digest and fetches the signed index again when the user confirms. It rejects a stale plan. Download the complete dependency closure, verify identity and integrity, then save it disabled. Never execute before checking its digest or accept arbitrary JS source from a remote URL.
- Cache verified WASM, model and dictionary assets by immutable digest; store installed version, explicit capabilities and preferences in browser storage. Cache eviction makes offline startup unavailable, not authorization to load unsigned replacements.

The implementation stores registry proofs and verified artifacts in IndexedDB, separate from Git workspaces. Activation rechecks the current signed registry state and recursively verifies every pinned dependency artifact before creating a Worker. Worker creation remains explicit; a guest runs only after the Host enables it and invokes it with a bounded snapshot. Uninstalling a version still used by an installed dependent is rejected.

The independent `proprium.compute-sum` example is built by `node scripts/build-plugin-registry.mjs` and checked by `node scripts/verify-plugin-registry.mjs`. Build inputs include an explicit `PROPRIUM_PLUGIN_VERSION`, registry/publisher Ed25519 PEM signing keys, the separately pinned registry public key and public artifact directory URL. An optional `PROPRIUM_PLUGIN_PREVIOUS_REGISTRY_DIR` supplies the prior signed registry and its referenced artifacts. The producer verifies that snapshot under the pinned root, preserves every prior version, and rejects reuse of an existing plugin ID/version. It writes manifest and WASM files under SHA-256-qualified paths and refuses to overwrite a different file at an immutable path. The verifier requires the registry public key separately; it never trusts a key shipped inside the registry document.

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
