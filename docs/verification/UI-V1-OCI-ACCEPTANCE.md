# UI Modernization V1 OCI and Hosted Profile Evidence

This file retains **historical diagnostic evidence**. Final candidate gate statuses, exact tested commits and image identities belong to the [PR #10 verification record](https://github.com/yohn-jp/scriptorium/pull/10), as described in [the acceptance map](UI-V1-ACCEPTANCE.md). None of the tables below certify a later commit.

The evidence below records the first integrated production run on `141a2319cb8de34a005e638a4e33aafb64d4b927`. The later integrated HEAD `0a339a9a940b52984ec38f7357f3d32516b0fe7a` changed acceptance tests only, but this report does not treat the earlier results as tests of that later HEAD. The coordinator will rerun the required image checks on the final frozen HEAD. No release image was published.

## Host and runtime

- Rootless Podman `5.8.9`, linux/amd64, with graph root `/data/scriptorium-ui-oci-storage` and temporary files under `/data/scriptorium-ui-oci-tmp`.
- Pinned base image: `docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`.
- Reject-by-default signature policy SHA-256: `652198e248fc5d28b5cfa97fde6b7a89adc0309e41e1a64823bcf22cc14c6305`.
- Container creation through the host's default systemd cgroup manager failed because no user systemd session was available. Reruns set Podman's global `--cgroup-manager=cgroupfs` through a task-local wrapper; namespace, image user (`node`, UID 1000), profile, and application command were unchanged. The wrapper is outside the repository and does not change the OCI image.

## Core and Full images — diagnostic run at `141a2319`

The first build with the default wrapper exited `1` for both profiles at Dockerfile step `RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate`. `crun` reported: `sd-bus call: Access denied as the requested operation requires interactive authentication. However, interactive authentication has not been enabled by the calling program.: Permission denied`. Initial log hashes were Core `699a3a2a20dd505620b338254c06b4a78f1a45511306354ce015930cb8fc9e1b` and Full `2f1e85c195e1fded5cad7f57b27cb2c95391b5f7e338db2a9b4b659a4c2c1fa1`. The runner reused those filenames for the cgroupfs rerun, so the original raw files were overwritten; only their captured hashes and failure output remain in the verification transcript.

With cgroupfs, the inner `scripts/verify-oci.sh` acceptance command passed both profiles. The results are diagnostic because the wrapper did not use the canonical engine basename branch; image inspection below confirms the produced media type was OCI. The aggregate task runner itself exited `2` after both profile runs passed: its script was edited while it was still executing, and the shell reported `unexpected EOF`. A stable, uniquely logged final-HEAD rerun remains required.

| Profile | Inner exit | Included modules / HTTP assets | Image ID | Local manifest digest | Media type | Successful log SHA-256 |
| --- | ---: | --- | --- | --- | --- | --- |
| Core | 0 | 0 modules; 13 assets | `95b8974f23d58caf19397459ba35b7be0a8c149f1a388fe09ed8304b2af02e07` | `sha256:bf1ac5215ddd1b234ac4f92cc1d98b61f53f056161d0840b06f3aae697916901` | `application/vnd.oci.image.manifest.v1+json` | `f6cd3ae528ad9c841f9f0591c444ae3201ea9c74af0311e91458ccf088909f8c` |
| Full | 0 | 8 modules; 34 assets | `83d9ec0dfaea37774f1149520a533900d044fe6d9f30736178c10d2cdf8e3842` | `sha256:c6b0324d71c93cc56413cb49a01cf3b333e0efc3618158200a07c7d196fd7027` | `application/vnd.oci.image.manifest.v1+json` | `269afe74c505578e4d12a9d1ab653924c2a5f7c072f0af7233bd3e65d95570da` |

For both images the HTTP verifier checked health/readiness, launcher, Desktop and Mobile HTML and nonce headers, and the built asset graph. The OCI script also verified runtime UID 1000, writable `/data`, and successful SIGTERM shutdown/drain. The Core image audited 54 production dependency versions; Full package generation verified all eight installed module families. Startup measurements were recorded by the script but are not used as an acceptance threshold here.

The successful logs are copied separately as:

- `/data/scriptorium-ui-oci-evidence/141a2319cb8de34a005e638a4e33aafb64d4b927-core-oci-cgroupfs-rerun.log`
- `/data/scriptorium-ui-oci-evidence/141a2319cb8de34a005e638a4e33aafb64d4b927-full-oci-cgroupfs-rerun.log`

## Selected Hosted packages — diagnostic run at `141a2319`

The clean worktree passed `pnpm install --frozen-lockfile` (log SHA-256 `a40a0e40ef4d7c4c3a93898eb8badbfb7d8f399e3380dfa02cbdf4df0ae5dea3`) and the full workspace build (log SHA-256 `d69596e6101fd87549e9c1b935ce61484e945f74e6fb1cc631c611ca65492877`). `scripts/profile-package.mjs --modules-json ... --prebuilt --out ...` produced the selected production packages. Each package passed deployed-composition verification and the tracked `scripts/verify-ui-hosted.mjs` production runtime smoke in the pinned Node image with networking disabled.

| Selection | Package modules | Manifest SHA-256 | Smoke result | Checked assets | Smoke log SHA-256 |
| --- | --- | --- | ---: | ---: | --- |
| no-addon | none | `7dee75ea480045b83a954e3379d9afbb7bf1d8600072bc020a9acab013d8cb75` | PASS | 13 | `ea65eac9330e133aff77e8f27b95c08dab616a0def93b9b7c8ac8a45057ad9e5` |
| Story | `story` | `7590584ad76177ec0dbc27ec24d07d0e6f238069e74fe5bf6e813ec9363e08c5` | PASS | 16 | `fb181cabb642ba31c75c10e830a55f5deea5a2856f192f6ad45105770c32e53c` |
| MCP | `mcp` | `a7fae8155b9d88840a4c1e6a04f92607c21ed82e6f97b44fe221b0657d982351` | PASS | 13 | `6dc6f27c56a8661657bffe03d5272028e4f62ddeae9d7566e562e845f6e96afc` |

The smoke verifies the real package's module dependency closure, generated server and browser registries, runtime `/api/version` capabilities, same-origin launcher/Desktop/Mobile HTML with request-specific CSP nonces, recursive JavaScript/CSS/static asset closure, MIME types, package path confinement, exact served bytes, and clean runtime shutdown. MCP is expected to have no browser loader; its server loader is present. No composition metadata was synthesized.

Logs and package directories are under `/data/scriptorium-ui-oci-evidence/` with the `141a2319cb8de34a005e638a4e33aafb64d4b927-hosted-` prefix and `packages-141a2319cb8de34a005e638a4e33aafb64d4b927/` directory. The tracked smoke checker SHA-256 in the tested worktree was `8cbd8928c3e98f13ee8b696ce1173ddbc33dfaef3958fe3a4ddfab5e02beba45`.

## Required final checks

- Core and Full image acceptance with a clean, final code SHA and the canonical Podman wrapper basename so `verify-oci.sh` explicitly requests OCI output.
- Selected Hosted package/smoke rerun at that same final code SHA.
- Confirm exact image ID, manifest digest, media type, log hashes, and per-profile exit statuses in the final record.

Live Hosted identity/Praetorium/BuildKit integration remains outside this UI goal and is not used to determine these local profile results.
