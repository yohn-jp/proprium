# OCI build and startup verification

The root `Dockerfile` builds Core and Full profiles of one application container. Runtime packages include the compiled API and browser assets, Git and CA certificates. The image runs as UID 1000 and listens on port 3000. Core excludes optional analysis and model dependencies; Full includes its selected trusted module packages.

```sh
podman build --format oci --build-arg PROFILE=core --tag scriptorium:local .
export SCRIPTORIUM_AUTH_TOKEN="$(openssl rand -hex 32)"
podman run --rm --publish 127.0.0.1:3000:3000 \
  --env SCRIPTORIUM_AUTH_TOKEN --env SCRIPTORIUM_GITHUB_TOKEN \
  --mount type=volume,src=scriptorium-data,dst=/data \
  --mount type=volume,src=scriptorium-history,dst=/history \
  scriptorium:local
```

Use `PROFILE=full` for the Full build. Standalone startup requires an owner token; the GitHub token is optional for public reads and required for authorized private access or publication. Mount directories must be writable by UID 1000. `/data` holds project state; `/history` holds private usage/job history outside Git. Do not share one writable workspace between containers. Use a trusted HTTPS reverse proxy for access beyond localhost.

Run the local acceptance probe for each profile:

```sh
SCRIPTORIUM_PROFILE=core bash scripts/verify-oci.sh
SCRIPTORIUM_PROFILE=full bash scripts/verify-oci.sh
```

The probe builds the image, starts a temporary container, checks health/readiness, HTML and built assets, profile/module metadata, nonroot execution, writable data and graceful shutdown, then removes its container. It reports the image identity and startup resource observations. Those observations describe that execution; they are not universal performance budgets.

Podman is the default when available. Set `OCI_ENGINE`, `SCRIPTORIUM_OCI_IMAGE` and `SCRIPTORIUM_OCI_PORT` to override the engine, local image tag and host port; Docker remains a supported fallback for CI/other hosts. Provision a suitable engine trust policy through the host's normal administration; the verification procedure does not alter host trust configuration.

The production dependency audit rejects build/test tools in runtime closure. Core auditing additionally rejects optional NLP, model-provider, tokenizer, embedding, reranker and speaker dependencies in packages or compiled imports. The local `pnpm audit:core` command allows development tools installed for source work, so it does not substitute for the image's production audit.

For hosted assignments and credential handling, use [Hosted deployment](../HOSTED-DEPLOYMENT.md). For publication, use [OCI releases](OCI-RELEASE.md).
