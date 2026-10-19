# Scriptorium

A modular Git-backed writing workspace migrated from Arcadia Loom. Git-controlled YAML and Markdown remain the source of truth. The Core profile runs without optional analysis or model dependencies; the full profile composes nine independent add-ons.

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

Scene YAML identifies its Markdown file with `manuscript: manuscript/.../scene.md`. Unsupported metadata and files are preserved. The writing UI can create and reorder volumes, chapters, and scenes through reviewed Core operations.

Draft means browser recovery storage; Checkpoint means a local Git commit; Saved means publication to GitHub has been confirmed. Checkpoint retains the browser recovery record. Remote observation probes the repository's default branch and fetches when its HEAD changes; canonical snapshots remain separate from unpublished local work. Revision checks protect editing and report conflicts without automatically resolving manuscript text. Retried operations retain their identities across response loss and clone reconstruction. Browser recovery uses the same browser and origin; clearing browser storage removes that recovery copy.

Writing, Research, and Review presets assemble independent Editor, Outline, Inspector, History, and Review panels. Use panel grips and dock targets on desktop, or the keyboard-accessible move controls, to split, tab, reorder, resize, show, and hide panels. **Save layout** stores the arrangement for the current author and desktop/mobile device class in this browser, separately from draft recovery and Git. Invalid saved layouts fall back without erasing the prior setting until an explicit save.

Search/Terminology is optional: it indexes snapshot revisions, including local checkpoints, and supports lexical, exact, prefix, and scoped queries. The term dictionary is changed through reviewable proposals. Automatic term links are temporary editor/reading decorations and never insert links into Markdown; use Ctrl/Command-click or Ctrl/Command-Enter on an editor term to navigate. Ambiguous aliases remain plain text and can be inspected in the terminology panel. Search can explicitly request existing NLP or Semantic capabilities; ordinary search does not load models. Core-only builds retain authoring without this plugin.

To build and run the full composition, use `SCRIPTORIUM_PROFILE=full pnpm build` and `SCRIPTORIUM_PROFILE=full pnpm start`. It includes Story, Diagnostics, NLP, Semantic, Speaker, Assistant, Publishing, MCP, and Search/Terminology. Module settings distinguish absent, disabled, enabled-idle, and active modules. Heavy engines run in supervised child processes. Assistant provider execution requires provider configuration and author consent; selecting no provider keeps local writing and review available.

## Single OCI image

```sh
docker build --build-arg PROFILE=core -t scriptorium:local .
docker run --rm -p 127.0.0.1:3000:3000 \
  --env SCRIPTORIUM_AUTH_TOKEN --env SCRIPTORIUM_GITHUB_TOKEN \
  --mount type=volume,src=scriptorium-data,dst=/data \
  --mount type=volume,src=scriptorium-history,dst=/history \
  scriptorium:local
```

Use `PROFILE=full` with the same Dockerfile for the full composition. Keep `/data` and `/history` persistent: `/history` holds private usage and job history separately from Git work repositories. Use HTTPS through a trusted reverse proxy when accessing the instance beyond localhost. Do not run multiple containers against one workspace volume. This is a single-owner application.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm audit:core
```

For browser verification, install Chromium with `pnpm exec playwright install chromium` and run `pnpm test:e2e`. The full migration acceptance report is [docs/verification/FINAL-MIGRATION.md](docs/verification/FINAL-MIGRATION.md); [docs/verification/ACCEPTANCE.md](docs/verification/ACCEPTANCE.md) retains the historical Core evidence. CI and GitHub Actions are intentionally outside this initial recovery; local results do not imply remote CI success.

`pnpm verify` runs the frozen install, type and test checks, then builds and checks both Core and full profiles in Chromium and OCI. It also exercises both MCP transports, the NLP/Diagnostics persistence round trip, and the composed legacy migration through approval, publication, recloning, and module reactivation. It requires an OCI engine, Chromium, and the tokenizer artifacts used by that acceptance. The separate real-provider, model-lifecycle, GitHub, and container-recovery gates have reproduction instructions under `docs/verification`; the local command alone does not certify those gates.

The [Full Migration Architecture](docs/architecture/FULL-MIGRATION.md) and [fixed migration plan](docs/migration/FULL-MIGRATION-PLAN.md) define Epic #7. [Core Architecture](docs/architecture/CORE.md) remains the baseline where not superseded. Core does not import individual add-ons. Migration implementation and acceptance status are tracked in the plan's feature/data ledgers; older Core acceptance records describe their recorded commits.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [MIT license](LICENSE). [Epic #7](https://github.com/yohn-jp/scriptorium/issues/7) tracks the full migration; Epic #1 is the initial Core recovery history.
