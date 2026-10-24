# Scriptorium

A modular Git-backed writing workspace. Git-controlled YAML and Markdown remain the source of truth. The Core profile runs without optional analysis or model dependencies; the full profile composes nine independent add-ons.

Connect a GitHub work repository, browse volumes, chapters and scenes, edit Markdown, save with revision checks, inspect Git commits, and explicitly synchronize with GitHub. The editor keeps unsaved drafts in this browser and offers Japanese vertical preview. One server instance serves one trusted owner; all registered projects belong to that owner.

[Documentation](docs/README.md) covers authoring, architecture, deployment and verification. The [external Plugin Platform proposal](docs/architecture/PLUGIN-PLATFORM.md) specifies a separate isolation and distribution design; built-in modules execute as trusted application code.

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

## Hosted MCP access

When the optional `mcp` module is included in a Praetorium Hosted composition,
the stable application origin exposes `/mcp` (Streamable HTTP) and
`/.well-known/oauth-protected-resource` (public OAuth resource discovery), also
available at `/.well-known/oauth-protected-resource/mcp` for endpoint-path discovery.
Configure a remote MCP client with `https://<stable-application-origin>/mcp`,
not the physical Pod hostname or the Praetorium browser entry URL.
The resource metadata points to Praetorium for GitHub-based OAuth login,
explicit client consent, PKCE token exchange and refresh. Scriptorium validates
the issued short-lived repository/instance/epoch-bound bearer grant and retains
the existing proposal/author approval boundary.

A stopped Hosted instance is served by Praetorium's Instance Access fallback:
the initial unauthenticated request receives OAuth discovery, while a valid
bearer request can trigger the existing authorized Wake path and returns
`503 Retry-After` until the same stable URL becomes ready. The caller must
retry its request; no MCP request body is queued or replayed by the platform.
This service consumes the reusable [Praetorium service MCP
contract](https://github.com/yohn-jp/praetorium/blob/main/docs/architecture/SERVICE-MCP.md)
rather than implementing an application-specific OAuth issuer.

## Single OCI image

```sh
podman build --format oci --build-arg PROFILE=core -t scriptorium:local .
podman run --rm -p 127.0.0.1:3000:3000 \
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

See [verification](docs/verification/README.md) for browser, OCI, MCP, model, recovery and Hosted producer checks. `pnpm verify` runs the local composed checks; inputs and separate integration gates are documented there. Repository CI certifies the exact source before the [gated release workflow](docs/verification/OCI-RELEASE.md) may publish.

See [Core architecture](docs/architecture/CORE.md), [Modules](docs/architecture/MODULES.md) and [Modular Workspace](docs/architecture/MODULAR-WORKSPACE.md) for ownership and safety contracts. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [LICENSE](LICENSE) before contributing or distributing.
