# OCI image build and verification

The repository builds one production image from the root `Dockerfile`. It contains the compiled API, the static web app, only the API's production dependency graph, Git, and CA certificates. The image runs as UID 1000, keeps project data under `/data`, listens on port 3000, and requires `SCRIPTORIUM_AUTH_TOKEN` at startup. `SCRIPTORIUM_GITHUB_TOKEN` is optional and is read at runtime for GitHub operations.

Build from the repository root:

```sh
docker build --pull --tag scriptorium:local .
```

Start the image with durable data and a strong authentication token:

```sh
mkdir -p ./scriptorium-data
export SCRIPTORIUM_AUTH_TOKEN="$(openssl rand -hex 32)"
docker run --rm --name scriptorium \
  --publish 3000:3000 \
  --env SCRIPTORIUM_AUTH_TOKEN \
  --env SCRIPTORIUM_DATA_DIR=/data \
  --volume "$(pwd)/scriptorium-data:/data" \
  scriptorium:local
```

The host directory mounted at `/data` must be writable by the image's UID 1000. The API exposes readiness at `/api/health`; the web UI is served at `/`.

For a complete local build and startup probe with either Docker or Podman, run:

```sh
bash scripts/verify-oci.sh
```

The probe creates a temporary random authentication token, builds the image, checks the readiness API and web assets, confirms the process runs as UID 1000, and verifies `/data` is writable. Podman builds explicitly in OCI format and reports the local manifest digest. The probe removes its temporary container on exit. Set `OCI_ENGINE`, `SCRIPTORIUM_OCI_IMAGE`, or `SCRIPTORIUM_OCI_PORT` to select the engine, image tag, or host port.

The Docker build runs `scripts/audit-runtime-deps.mjs --production` against the production pnpm virtual store and the compiled API, Core, and web output. The audit fails on packages or compiled imports associated with NLP, model providers, tokenizers, embeddings, rerankers, or speaker inference. Production mode also fails if TypeScript, test, or bundler tools enter the image. The local `pnpm audit:core` command checks the Core dependency set and compiled outputs while allowing development tools installed for local work.

## Integration host notes

The initial OCI verification host is NixOS x86_64 with no Docker daemon. Podman 5.8.8 is available ephemerally through `nix shell nixpkgs#podman`; its rootless mode is enabled. This Podman package does not install a default image signature policy. For the local build only, the verifier used a temporary policy that rejects images by default and permits the pinned official Node image repository and the local container-storage transport used to assemble/re-tag the locally built image. The file was removed when the command exited:

```sh
policy_path="$HOME/.config/containers/policy.json"
test ! -e "$policy_path"
mkdir -p "$(dirname "$policy_path")"
trap 'unlink "$policy_path"' EXIT
printf '%s\n' '{"default":[{"type":"reject"}],"transports":{"docker":{"docker.io/library/node":[{"type":"insecureAcceptAnything"}]},"containers-storage":{"":[{"type":"insecureAcceptAnything"}]}}}' > "$policy_path"
nix shell nixpkgs#podman -c bash scripts/verify-oci.sh
```

The Dockerfile pins the Node multi-platform image index by digest, so this temporary policy does not change which base image the build accepts.

## Local verification record

The values below are recorded from an actual local OCI build and container run on main commit `2067a9292d4f4670e0824ead59955fca2a8613e0`. The image ID identifies the locally built image; this project does not publish container images as part of source verification.

| Field | Result |
| --- | --- |
| OCI engine and version | Rootless Podman 5.8.8 on NixOS x86_64, provided ephemerally by Nix |
| Image tag | `localhost/scriptorium:final-2067a92` |
| Image ID and platform | `f9ee951a8985d047734bf5eca687bd7256c1fa8e2cdaba18eaf960f3bc05ea6a`; manifest `sha256:cd0752b6a7cfba5328a69c18702aba331ab287fedb30b68caf9cbcccfd5fbfe5`; `linux/amd64`; 189,360,435 bytes |
| Build and startup probe | Passed: OCI build, `/api/health`, UI HTML/CSS/JavaScript MIME types, UID 1000, and writable `/data` |
| Production dependency audit | Passed: one runtime package version, `yaml@2.9.1`; no NLP, model, or build/test dependencies |
