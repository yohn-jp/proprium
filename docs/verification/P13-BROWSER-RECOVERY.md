# P13 browser recovery acceptance

This opt-in check exercises the current Core production path end to end: it builds the real `PROFILE=core` OCI image from the repository Dockerfile, launches rootless Podman or Docker, uses Chromium with real IndexedDB, and writes only to a dedicated private synthetic GitHub repository. It is separate from the local-browser and OCI startup probes; it checks replacement of the container data root while the browser profile survives.

The test checkpoints a synthetic Scene One draft, verifies that checkpointing did not publish to GitHub, closes Chromium, stops and removes the container, deletes and recreates its `/data` volume, and starts the same image at the same origin. It then reopens the persistent Chromium profile, checks that IndexedDB retained the complete operation, reconnects the repository and checks Core replayed it. Only the explicit **Save to GitHub** action may publish it. The test checks the durable browser publication receipt and remote operation record, with exactly one commit for the operation ID. Finally it follows an external update to unedited Scene Two, creates a same-file conflict, and verifies that the rejected publish leaves the external version on GitHub while preserving the author's input in the browser.

## Fixture and credentials

Use a dedicated private GitHub repository with its default branch as the test target. Seed it with exactly the six generic files and contents validated by [container-recovery.acceptance.mjs](../../tests/e2e/container-recovery.acceptance.mjs). The local browser fixture additionally includes optional terminology data; that extra file is not part of this runner's six-file seed. Before every run, restore that six-file tree and exact contents with ordinary commits if a previous attempt changed it; keep all earlier commits. The acceptance validates repository privacy, branch, tree, and all six initial contents before building or mutating anything. It rejects the P07 fixture. Do not use manuscript material, an existing project repository, or a repository with GitHub Actions enabled.

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

The script builds and identifies the image, creates an ephemeral named volume, and runs the browser journey. By default it removes its browser directory, container, and temporary volume even when the journey fails. It prints an image ID and manifest digest only after every scenario passes. `OCI_ENGINE` may select another installed engine. The script has a 60–120 second bounded wait for GitHub-backed operations; live GitHub latency can make the full run take several minutes.

For a failed run where the live IndexedDB state needs inspection, set `SCRIPTORIUM_KEEP_FAILURE_ARTIFACTS=1`. On failure only, the script retains the synthetic Chromium profile and sanitized API request/console metadata under a printed `/tmp/scriptorium-p13-failure-*` directory. It clears the profile's session cookies before retaining it; the IndexedDB data remains available for inspection. The default path still removes the profile and diagnostics, and successful runs always clean them up.

## Evidence and limits

Record the exact source HEAD, OCI engine/version, image ID, manifest digest, platform, initial and final GitHub commits, recovered operation ID and remote commit count from the successful JSON output. Compare the reported source HEAD with the checkout used to build the image. This acceptance certifies only the tested Core tree and these browser recovery/publication/conflict paths. It does not certify optional modules, model behavior, deployment quotas, image registry publication, or the final composed Epic #7 tree; rerun it after integrating production changes that affect Core, the API, the app, packaging, or their contracts.

### Recorded run

The 2026-10-17 run passed on source checkout `4ed8ffd0cfa8e3a247a63d40754a12a23e9cadc5`, whose source tree matched the P02 candidate `f1e621a`. The actual `PROFILE=core` image was built locally with rootless Podman 5.8.9 for `linux/amd64`; image ID `08a863354c46e26a5be168c5f3275c58468ac32fb2fda84491ad8c5f2964f1d2`, manifest `sha256:7f721e9253216e4d4f5ecb914e046126904c8ffcc8ae7cd50811b63e39176e31`.

The run confirmed checkpoint retention in Chromium IndexedDB across browser restart and `/data` deletion/recreation, Core replay of the complete operation, explicit publication with one remote operation commit, observation of an external update to an unedited scene, retention of author text in the latest `Journal.getDocument` row after a same-file conflict, and rejection of the conflicting publish. Before this run, the synthetic fixture tree was restored to its exact six generic seed files through ordinary commits; prior fixture history remains intact. The successful run's remote commits remain preserved. This evidence applies to the recorded source tree only and does not certify later commits or the final composed Epic #7 tree.

### Composed runtime rerun

The coordinator reran the actual container/browser/GitHub acceptance on 2026-10-17 from clean checkout `bc2b0936d418d1d8f5dcd8b16e74d1f9f3d65c0f` (tree `480aadf546cd28944c5a242ef9cd0ac55b215616`). Frozen install and the acceptance process exited successfully. This run built the root Dockerfile with `PROFILE=core`, rootless Podman 5.8.9 and the configured Nix Chromium; it used the dedicated private synthetic fixture after restoring its six seed files through an ordinary commit. No remote history was rewritten.

| Field | Observed result |
| --- | --- |
| Image ID | `93521116f542d3fc3f9fda63ef2411c69dc83f897c54886bc3dc379ed35b3254` |
| Manifest digest | `sha256:cb6d9d3e792fba6020c561946b07c07aa4f7c7043aaed3597cefbeab586d6a05` |
| Platform | `linux/amd64` |
| Seed / confirmed publication | `9ad11f57c50422fdf0c4417a5e17a01cf457e5cd` / `e13aa439bb7c4f33c8ffc8177851c5e94ca4f3e7` |
| Recovered operation | `ec784e0a-c1d2-49d6-ad1c-8352e71d7131`; exactly one remote operation commit |
| Browser and container replacement | IndexedDB retained across Chromium restart; container data volume deleted and recreated; complete operation restored and explicitly published |
| External update | Unedited Scene Two followed remote commit `6f968fef014c2e93b67e9bdc26e91c9fb64fde93` |
| Same-file conflict | Author input and complete operation content retained in the conflict journal; publish returned `conflict`; conflicting operation was absent from GitHub |
| Final fixture commit | `fe37be1e6f25d473c49144de3c318610669551ac` |

The image remained local. This proves the listed Core recovery paths for the composed runtime inputs. Full-profile model lifecycle, the root verification command, source-feature/data-ledger closure, and final campaign acceptance are recorded separately; this result does not claim those gates passed.

### Final frozen-runtime recovery rerun

The final Core recovery run passed against source checkout `f3ef4d34b5e603885ec2cbf204446b6becef3071` (tree `41c3027768948392b8f9a43815c86fa680d636f3`). It built and ran the local `linux/amd64` image with Podman 5.8.9. Only safe result fields are recorded here; the private fixture URL, credentials, and browser journal selection key are omitted.

| Field | Observed result |
| --- | --- |
| Result | `PASS` |
| Image ID | `b33526e4325684b8cf068ec1a442c4c71d9801ac395c75f71053ca598ed9af45` |
| Manifest digest | `sha256:79d59260c436dfa98b9e250eba9ee616058a756b7d62935b71d5dd5740b7f0b0` |
| Platform | `linux/amd64` |
| Seed / confirmed publication | `9f736f5657d9335760aa42dd54979f429c2aa65c` / `eaf00f5a43f105d83193dd57e7c536538c9a5023` |
| Recovered operation | `46155896-88b5-488e-bab2-75b18489d852`; exactly one remote operation commit |
| Browser and container replacement | IndexedDB retained across Chromium restart; data volume deleted and recreated; operation recovered and explicitly published |
| External update | An unedited scene followed remote commit `f4890e712ba48292944f069dc05b419dd3fff50d` |
| Same-file conflict | Author input was preserved; publish returned `conflict`; the conflicting operation was not published |
| Final fixture commit | `e7256bd8aa285ded76a5ea17d6822cc3c9e2a6a6` |

The run used the restored six-file seed and preserved fixture history. The image remains local. This result covers the listed Core recovery, publication, external-follow, and conflict paths on the recorded frozen source tree; it does not certify optional modules or other final campaign gates.

### Modular Workspace recovery rerun

The actual acceptance passed on `8c0eb69109eab7d1f88cd59f7069c9b5e752b41e` (tree `1e5d5d71051357147300194c739d7707b7545daf`). It confirmed the ready/writable transition after checkpoint recovery, Chromium restart, container data-volume replacement, exactly one explicit operation publication, external-scene follow, and rejection of a same-file conflict while retaining author text. Safe image, commit, operation and log identities are recorded in [Modular Workspace verification](MODULAR-WORKSPACE.md#container-replacement-and-github-durability). The dedicated fixture remains private with Actions disabled and remote history preserved; temporary container, volume and browser resources were cleaned up.
