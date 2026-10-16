# Scriptorium

A lightweight Git-backed writing workspace, extracted from Arcadia Loom. Git-controlled YAML and Markdown remain the source of truth. Core runs without NLP, model downloads, or an embedded LLM.

Connect a GitHub work repository, browse volumes, chapters and scenes, edit Markdown, save with revision checks, inspect Git commits, and explicitly synchronize with GitHub. The editor keeps unsaved drafts in this browser and offers Japanese vertical preview. One server instance serves one trusted owner; all registered projects belong to that owner.

## Run locally

Requires Node.js 24+, Git, and pnpm 12.10.1.

```sh
pnpm install --frozen-lockfile
pnpm build
export SCRIPTORIUM_AUTH_TOKEN="$(openssl rand -hex 32)"
# Set SCRIPTORIUM_GITHUB_TOKEN separately for private repositories and push access.
pnpm start
```

Open `http://127.0.0.1:3000` and sign in with `SCRIPTORIUM_AUTH_TOKEN`. Public repository reads need no GitHub token. For private repositories and synchronization, provide a GitHub token with access only to the intended work repositories. Credentials stay on the server; do not put them in a repository URL. See [.env.example](.env.example) for configuration names; environment files are not automatically loaded.

The work repository must use the existing Arcadia layout:

```text
plot/volumes/<volume>/volume.yaml
plot/volumes/<volume>/chapters/<chapter>/chapter.yaml
plot/volumes/<volume>/chapters/<chapter>/scenes/<scene>.yaml
manuscript/<volume>/<chapter>/<scene>.md
```

Scene YAML identifies its Markdown file with `manuscript: manuscript/.../scene.md`. Unsupported metadata and files are preserved. An empty repository can be connected; create its work structure in Git before writing. The Core does not create a complete novel structure or port Arcadia's advanced analysis features.

Each save checks the revision read by the editor and creates a local Git commit. A stale save reports a conflict and retains the draft. Sync fetches, integrates only fast-forward changes, and pushes local commits; divergent histories require reconciliation outside the application. Browser drafts are local recovery copies: use the same browser and origin, and save important work before clearing browser storage.

## Single OCI image

```sh
docker build -t ghcr.io/yohn-jp/scriptorium:local .
docker run --rm -p 127.0.0.1:3000:3000 \
  --env SCRIPTORIUM_AUTH_TOKEN --env SCRIPTORIUM_GITHUB_TOKEN \
  --mount type=volume,src=scriptorium-data,dst=/data \
  ghcr.io/yohn-jp/scriptorium:local
```

Keep `/data` persistent. Use HTTPS through a trusted reverse proxy when accessing the instance beyond localhost. Do not run multiple containers against one workspace volume. This is a single-owner application, not a multi-tenant hosting service.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm audit:core
```

Browser and image acceptance evidence is recorded under [docs/verification](docs/verification). CI and GitHub Actions are intentionally outside this initial recovery; local results do not imply remote CI success.

The [Core architecture](docs/architecture/CORE.md) defines ownership and dependency direction. NLP, embeddings, rerankers, speaker inference, and LLM execution are excluded. Future add-ons must be independent workspace packages; Core must not depend on them.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [MIT license](LICENSE). [Epic #1](https://github.com/yohn-jp/scriptorium/issues/1) tracks the initial recovery.
