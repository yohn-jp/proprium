# Authoring suite certification evidence

`implementation.json` is generated from the current Canon and recovery inventory by:

```sh
node scripts/build-authoring-evidence.mjs
node scripts/build-authoring-evidence.mjs --check
node --test scripts/build-authoring-evidence.test.mjs
```

It enumerates R01–R14 with each canonical job and required proof, all 114 feature rows with the author-visible result, their 104 acceptance gates with each Canon scenario/pass condition and direct anchor, all 136 source actions, all 42 registered UI contributions, the 33-tool MCP surface, and every immutable source path/revision recorded in `traceability.json`. Feature and acceptance rows carry the exact traceability action/UI anchors and source commits they map to, plus every commit revision cited by their plugin Canon. `UNMAPPED` means no direct traceability action/UI row maps to that feature; it remains `NOT_CHECKED` and does not imply parity. New or removed Canon requirements cause verification to fail until the evidence ledger is reconciled.

All implementation records initially say `NOT_CHECKED`. A record can become `PASS` only with a full Git SHA, exact fixture and command, browser/platform, exact input/output and Host receipt, all immutable source revisions exercised, actual signed plugin and registry digests for plugin feature/acceptance rows and R02/R13, and an archived CI/evidence URL. Feature PASS also requires every linked acceptance case and every directly mapped source action/UI parity row to pass on the same SHA and archived run. `BLOCKED` requires the specific missing dependency or external constraint; an attempted or unlaunched check never counts as a pass. Unit tests, source review, a build, synthetic registry builder tests, and `compute-sum` do not substitute for the signed installed product workflows in the canon.

`node scripts/authoring-evidence-e2e.mjs` is the real-artifact browser entry point. It requires `PROPRIUM_AUTHORING_REGISTRY_DIR` and the separately pinned public key in `PROPRIUM_AUTHORING_REGISTRY_PUBLIC_KEY` (or `PROPRIUM_PLUGIN_REGISTRY_PUBLIC_KEY`), verifies the signed registry, then launches the dedicated Desktop Chromium and Mobile WebKit suite. It generates no registry key, publisher signature or WASM fixture. The current browser smoke installs and enables the eight actual products through the Host catalog, reloads the real Browser Git workspace and IndexedDB plugin store, and attaches the signed digests and UI state. This distribution/install smoke is only a subset of R02/R13; it does not certify feature outputs, typed MCP parity, proposal receipts, or source migration, and it leaves the full matrix `NOT_CHECKED`.

Do not edit the generated inventory to make a check green. Add immutable execution evidence and update only the matching result fields after verifying its command, revision and archived artifacts.
