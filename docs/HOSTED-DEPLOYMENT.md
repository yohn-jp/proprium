# Scriptorium hosted deployment

This guide describes how to build the standalone Core/Full profiles and the hosted Runtime Base, Build Kit, and selected composition using the existing Scriptorium build entry points. Hosted deployment consumes the canonical `scriptorium-build/v1` and `scriptorium-platform/v1` contracts. Praetorium remains the owner of instance lifecycle, Gateway/Instance Access, GitHub App credentials, and the BuildKit worker.

## Core and Full standalone images

Use Node 24 and the pnpm version declared by the Scriptorium root manifest. From a clean Scriptorium checkout:

```sh
docker build --target runtime --build-arg PROFILE=core -t scriptorium:core .
docker build --target runtime --build-arg PROFILE=full -t scriptorium:full .
```

The same package outputs can be prepared outside a container. Each output directory must be new and outside the workspace:

```sh
node scripts/profile-package.mjs --profile core --out /tmp/scriptorium-core
node scripts/profile-package.mjs --profile full --out /tmp/scriptorium-full
```

Run either standalone image with a local `SCRIPTORIUM_AUTH_TOKEN` of at least 32 characters. `SCRIPTORIUM_GITHUB_TOKEN` may be supplied separately when standalone GitHub repository access needs it. Mount `/data` for Core's project state and `/history` for usage history. These standalone settings do not apply to Hosted mode.

## Runtime Base and Build Kit

Hosted images target `linux/amd64`. Runtime Base and Build Kit must be published to the same OCI repository because the `gateway.v0` frontend resolves Runtime Base from the repository in its immutable `source` option. Use a disposable, owned registry for verification. Do not use a branch name as an artifact identity; record each pushed image's manifest digest.

Start from a clean commit and set the image repository and an output directory outside the checkout:

```sh
set -eu
REVISION="$(git rev-parse HEAD)"
test "$(git status --porcelain)" = ""
IMAGE_REPOSITORY='<owned-registry>/<namespace>/scriptorium'
ARTIFACT_DIR='/tmp/scriptorium-hosted-build'
mkdir -p "$ARTIFACT_DIR"
```

Build and push the two immutable inputs to the owned disposable registry. The `SCRIPTORIUM_DOCKERFILE_SHA256` value binds the Build Kit image to the exact Dockerfile bytes:

```sh
DOCKERFILE_SHA256="$(sha256sum Dockerfile | awk '{print $1}')"

docker buildx build --platform linux/amd64 --target runtime-base \
  --build-arg "SCRIPTORIUM_PRODUCER_REVISION=$REVISION" \
  --tag "$IMAGE_REPOSITORY:runtime-base-$REVISION" \
  --metadata-file "$ARTIFACT_DIR/runtime-base-metadata.json" --push .

docker buildx build --platform linux/amd64 --target buildkit \
  --build-arg "SCRIPTORIUM_PRODUCER_REVISION=$REVISION" \
  --build-arg "SCRIPTORIUM_DOCKERFILE_SHA256=$DOCKERFILE_SHA256" \
  --tag "$IMAGE_REPOSITORY:buildkit-$REVISION" \
  --metadata-file "$ARTIFACT_DIR/buildkit-metadata.json" --push .
```

Read `containerimage.digest` from each metadata file and use those `sha256:` values below. The mutable tags above are only push labels; all catalog and BuildInput references use digests. Generate the versioned catalog from the same clean checkout after those digests are known:

```sh
RUNTIME_BASE_DIGEST='<sha256:64-lowercase-hex>'
BUILD_KIT_DIGEST='<sha256:64-lowercase-hex>'

corepack pnpm@12.10.1 install --frozen-lockfile
corepack pnpm@12.10.1 build
node scripts/hosted-build.mjs catalog \
  --producer-revision "$REVISION" \
  --runtime-base-digest "$RUNTIME_BASE_DIGEST" \
  --build-kit-digest "$BUILD_KIT_DIGEST" \
  --out "$ARTIFACT_DIR/build-catalog.json"
```

Catalog generation requires `producerRevision` to equal `git rev-parse HEAD` and a clean worktree. Keep generated files outside the checkout. The catalog records the source, recipe, and lock digests, supported platform, shipped module versions/artifact digests, dependency requirements, resource data, Runtime Base digest, and Build Kit digest.

Resource profiles are allocation policy, not measured workload minima: `small` is 500m CPU, 512 MiB memory, and 1 GiB ephemeral storage; `balanced` is 2 CPU, 4 GiB memory, and 8 GiB ephemeral storage; `large` is 4 CPU, 8 GiB memory, and 16 GiB ephemeral storage. The base runtime allocation is 250m CPU, 256 MiB memory, and 512 MiB ephemeral storage. Modules with a shipped `workerEntry` share one `worker-runtime` allocation (1 CPU, 4 GiB memory, 512 MiB ephemeral storage); the Semantic module adds one shared `semantic-models` allocation (1 CPU, 2 GiB memory, 4 GiB ephemeral storage). The resolver charges each shared group once for the selected dependency closure. The full module closure therefore requires 2.25 CPU, 6,400 MiB memory, and 5,120 MiB ephemeral storage and fits the `large` profile. `workerLimits` records the existing runtime-wide WorkerSupervisor defaults and ceilings: 8 concurrent jobs, 8 queued one-shot jobs, 8 worker services, 1 concurrent job per service, and 4 queued jobs per service. These values describe allocation and admission policy; they do not claim model-workload measurements or per-module worker pools.

## Selected hosted composition

Create a canonical `scriptorium-build/v1` BuildInput from the verified catalog and the requested modules using Praetorium's existing resolver and canonical BuildInput encoder. Its fields are exactly `contractVersion`, `producerRevision`, `runtimeBaseDigest`, `buildKitDigest`, `recipeDigest`, `sourceDigest`, `lockDigest`, `requestedModules`, `resolvedModules`, `platform`, and `options`. Set `platform` to `linux/amd64` and `options` to `{}` for this producer. Every resolved module includes its catalog `id`, `version`, and `artifactDigest`. Base64url-encode the canonical JSON bytes into `INPUT_BASE64URL`; the Build Kit repeats the source, recipe, lock, resolver, and artifact checks before composing an image.

Praetorium's Build Worker runs the following BuildKit frontend command. Keep its `source` bound to the Build Kit digest, and use a unique candidate tag derived from the build key and attempt identity:

```sh
buildctl \
  --addr "$BUILDKIT_ADDR" \
  --tlsservername "$BUILDKIT_TLS_SERVER_NAME" \
  --tlscacert "$BUILDKIT_CA_FILE" \
  --tlscert "$BUILDKIT_CLIENT_CERT_FILE" \
  --tlskey "$BUILDKIT_CLIENT_KEY_FILE" \
  build --progress=rawjson --frontend gateway.v0 \
  --opt "source=$IMAGE_REPOSITORY@$BUILD_KIT_DIGEST" \
  --opt "scriptorium.build-input.v1=$INPUT_BASE64URL" \
  --output "type=image,name=$CANDIDATE_TAG,push=true" \
  --metadata-file "$ARTIFACT_DIR/composition-metadata.json"
```

The BuildKit metadata file's `containerimage.digest` is the candidate image digest. The composed image contains the composition manifest and producer report under `/usr/share/scriptorium`; admission must inspect the pushed image bytes and verify its actual server/browser package closure, native dependencies, and startup smoke before accepting it. The recipe's smoke runs without network access or author credentials. Neither the author's repository nor its content, a user grant, a GitHub credential, or an App key is a build input or shared cache entry.

Core and Full remain standalone presets. Hosted selections use the same shipped module manifests and `resolveBuildCatalogSelection` resolver; dependency modules are included automatically, incompatible or unknown selections fail. The resulting image stores runtime metadata, the composition manifest, the build catalog, and the package lock under `/usr/share/scriptorium`, with the selected runtime under `/app`.

## Hosted runtime files and credentials

Run the composed image with `SCRIPTORIUM_HOSTED_MODE=1`, `SCRIPTORIUM_PROFILE=hosted`, and the generated hosted module profile. Mount the exact canonical RuntimeAssignment JSON read-only at `/run/scriptorium/runtime-assignment.json`; `SCRIPTORIUM_RUNTIME_ASSIGNMENT_PATH` may override that path when the deployment mounts the same file elsewhere. Assignment validation binds the numeric GitHub repository ID and canonical repository URL, instance, runtime epoch, image and composition digests, enabled modules, broker URL, and issuer/JWKS policies. Startup registers only that assigned repository and checks its GitHub numeric identity before serving it.

Project the renewable `praetorium-runtime-identity/v1` JWT separately at `/run/scriptorium/runtime-identity.jwt`. Provisioner refreshes this short-lived proof through Control Plane identity issuance. The proof's `sub` must equal `runtimeId`; Scriptorium compares its instance, numeric repository, and epoch to the assignment, while Gateway checks the active installation and lease binding when it issues a Git credential. Scriptorium reads and verifies the projected file for each Git credential operation. Runtime identity keys are published at the Control Plane issuer's `/.well-known/runtime-identity-jwks.json`; they are separate from the runtime-control JWKS and the Gateway user-grant JWKS. The assignment's `controlServicePolicy.jwksUrl` is used for runtime-control credentials. Public JWKS endpoints expose public keys only. Private signing keys, shared Gateway/Control Plane service credentials, refresh credentials, GitHub App keys, and reusable GitHub tokens stay in their owning services.

`GET /api/platform/v1/metadata` is public and reports the immutable producer revision, listener, health paths, and shutdown contract. It carries no user or repository data. `GET /api/platform/v1/status`, `POST /api/platform/v1/quiesce`, and `POST /api/platform/v1/resume` are private control routes; they require a short-lived signed runtime-control credential verified with the assignment's `controlServicePolicy.jwksUrl`. Browser/API grants use the separate Gateway `grantPolicy.jwksUrl`.

Do not set `SCRIPTORIUM_AUTH_TOKEN` or `SCRIPTORIUM_GITHUB_TOKEN` in Hosted mode: startup rejects either variable. The runtime uses the mounted assignment and renewable identity to request an ephemeral GitHub App installation token scoped to the assigned numeric repository. Fetch/clone uses read permission. Publish requests a write token only after Scriptorium revalidates the current user's write permission with Gateway for the exact operation ID and checkpoint payload digest. Credential responses are short-lived and are not written to a repository URL, Git config, build layer, browser storage, or logs. Failure to verify identity or obtain a scoped token fails the Git operation; there is no standalone-token fallback.

The owned GitHub App installation must cover the selected repository and allow repository Contents read/write for the broker's fetch and publish tokens. A user's current GitHub repository permission is checked separately for each publication. The browser never receives the App token or a refresh credential.

## Browser access and authoring

Route `/_platform/handoff`, `/_platform/refresh`, `/_platform/logout`, and `/_platform/reauth` on the instance's same origin to Praetorium Instance Access. An authenticated Gateway `/entry/:instanceId` creates the one-use handoff for that origin. Instance Access sets the HttpOnly `__Host-praetorium_access` grant cookie and the readable `__Host-praetorium_csrf` cookie. The grant binds user, repository, instance, runtime epoch, permissions, and authorization/session revisions. Scriptorium verifies this grant for browser/API requests; MCP Bearer requests use the same policy and cannot override an ambiguous cookie. Cookie writes require the same origin and matching CSRF header.

The browser refreshes through `POST /_platform/refresh` with the CSRF header. If the grant is stale for a new runtime epoch, a failed refresh goes to `/_platform/reauth`, which clears stale cookies and returns the browser to Gateway for a fresh authorized handoff on the same instance origin. Logout uses `POST /_platform/logout`. Instance Access owns these routes and credentials; Scriptorium does not exchange or persist a refresh token.

Writing follows the existing Scriptorium proposal transaction: the browser keeps its private recovery journal in IndexedDB, submits a revision-bound proposal, records approval and checkpoint receipts, then publishes the selected checkpoint batch. Checkpoint and publish requests remain protected by the user's current write permission. At publish time Gateway rechecks current repository access and returns a short-lived receipt bound to the user, assigned repository/instance/epoch, operation ID, and exact payload digest; Core sends that receipt with its one-operation write-token request. A conflicting remote update is reconciled against the current GitHub revision before replay or publish; keep conflicting or pending browser journal entries for author review instead of dropping them.

GitHub is the durable shared project history. The composition declares readable/writable persistence versions for Core's Git operations v1, proposal bindings/completions v2, publications v1, and browser recovery IndexedDB v3, plus the formats declared by selected modules. Core's operation, proposal, checkpoint, and publication records are committed under `meta/scriptorium`; browser drafts and replay state remain in the versioned browser recovery journal and are reconciled on the same repository origin after restart or redeploy. A successful checkpoint alone does not mean the change is on GitHub: publish must report a confirmed result. Pending checkpoints or an unknown push result must remain available for reconciliation and block destructive replacement. The runtime persistence scan reports the remote Git formats it has verified; it does not claim to inspect browser IndexedDB.

## Producer admission

Use [producer attestation](hosted-producer-attestation.md) to generate and verify the canonical Sigstore bundle from immutable inputs. Statement generation alone does not sign or admit a release. Admission binds the producer revision, source/recipe/lock digests, Runtime Base and Build Kit digests, composition key and pushed composition bytes. Test browser, GitHub and lifecycle behavior against the admitted artifact in an owned verification environment.
