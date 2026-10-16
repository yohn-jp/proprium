# P13 browser recovery acceptance

This opt-in check exercises the current Core production path end to end: it builds the real `PROFILE=core` OCI image from the repository Dockerfile, launches rootless Podman or Docker, uses Chromium with real IndexedDB, and writes only to a dedicated private synthetic GitHub repository. It is separate from the local-browser and OCI startup probes; it checks replacement of the container data root while the browser profile survives.

The test checkpoints a synthetic Scene One draft, verifies that checkpointing did not contact GitHub, closes Chromium, stops and removes the container, deletes and recreates its `/data` volume, and starts the same image at the same origin. It then reopens the persistent Chromium profile, checks that IndexedDB retained the complete operation, reconnects the repository and checks Core replayed it. Only the explicit **Save to GitHub** action may publish it. The test checks the durable browser publication receipt and remote operation record, with exactly one commit for the operation ID. Finally it follows an external update to unedited Scene Two, creates a same-file conflict, and verifies that the rejected publish leaves the external version on GitHub while preserving the author's input in the browser.

## Fixture and credentials

Use a dedicated private GitHub repository with its default branch as the test target. Seed it with exactly the six generic files and contents in `createLocalFixture()` in [test-server.ts](../../tests/e2e/test-server.ts). Before every run, restore that six-file tree and exact contents with ordinary commits if a previous attempt changed it; keep all earlier commits. The acceptance validates repository privacy, branch, tree, and all six initial contents before building or mutating anything. It rejects the P07 fixture. Do not use manuscript material, an existing project repository, or a repository with GitHub Actions enabled.

The run adds a recovered synthetic scene and Core operation/publication records to the default branch, followed by two synthetic external Scene Two updates. Those GitHub commits are intentionally preserved; the test never deletes or rewrites remote history. If a run stops after its first remote publication, preserve the commits and reset only the current tree to the exact six-file seed using ordinary file commits before another run.

Install the repository dependencies with `pnpm install --frozen-lockfile`, authenticate `gh` for the fixture owner, and provide its HTTPS URL. The script reads the token from `SCRIPTORIUM_GITHUB_TOKEN` or `gh auth token`; it passes the token to the container in memory and does not include credentials or the fixture URL in its result. Avoid shell tracing and Playwright traces for live runs. The browser executable can be supplied with `SCRIPTORIUM_E2E_CHROMIUM`.

## Run with rootless Podman on the verification host

The NixOS host provides Podman ephemerally and Chromium at the path below. Podman's temporary signature policy rejects all images by default, permitting only the Dockerfile's pinned official Node repository and local container storage for the locally built image. The trap removes the policy when the process exits.

```sh
policy_path="$HOME/.config/containers/policy.json"
test ! -e "$policy_path"
mkdir -p "$(dirname "$policy_path")"
trap 'unlink "$policy_path"' EXIT
printf '%s\n' '{"default":[{"type":"reject"}],"transports":{"docker":{"docker.io/library/node":[{"type":"insecureAcceptAnything"}]},"containers-storage":{"":[{"type":"insecureAcceptAnything"}]}}}' > "$policy_path"

SCRIPTORIUM_E2E_REPOSITORY_URL='https://github.com/OWNER/PRIVATE-SYNTHETIC-REPOSITORY' \
SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
nix shell nixpkgs#podman -c node tests/e2e/container-recovery.acceptance.mjs
```

The script builds and identifies the image, creates an ephemeral named volume, runs the browser journey, and removes its browser directory, container, and final temporary volume even when the journey fails. It prints an image ID and manifest digest only after every scenario passes. `OCI_ENGINE` may select another installed engine. The script has a 60–120 second bounded wait for GitHub-backed operations; live GitHub latency can make the full run take several minutes.

For a failed run where the live IndexedDB state needs inspection, set `SCRIPTORIUM_KEEP_FAILURE_ARTIFACTS=1`. On failure only, the script retains the synthetic Chromium profile and sanitized API request/console metadata under a printed `/tmp/scriptorium-p13-failure-*` directory. It clears the profile's session cookies before retaining it; the IndexedDB data remains available for inspection. The default path still removes the profile and diagnostics, and successful runs always clean them up.

## Evidence and limits

Record the exact source HEAD, OCI engine/version, image ID, manifest digest, platform, initial and final GitHub commits, recovered operation ID and remote commit count from the successful JSON output. Compare the reported source HEAD with the checkout used to build the image. This acceptance certifies only the tested Core tree and these browser recovery/publication/conflict paths. It does not certify optional modules, model behavior, deployment quotas, image registry publication, or the final composed Epic #7 tree; rerun it after integrating production changes that affect Core, the API, the app, packaging, or their contracts.
