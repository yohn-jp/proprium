# Scriptorium

A Git-backed writing workspace for long-form manuscripts.

> **Status: foundation only.** The minimal writing application is not yet implemented in this repository.

Scriptorium is being extracted and hardened from the private Arcadia Loom project. The goal is a lean editor and project workspace that works without NLP, embedding, model downloads, or an embedded LLM.

## Target Core

- Open and manage a GitHub-hosted work repository.
- Browse volumes, chapters, and scenes.
- Edit manuscripts stored as Markdown with YAML metadata.
- Safely save with revision conflict detection and inspect Git history.
- Synchronize with GitHub from a persistent server-side workspace.
- Build the TypeScript/pnpm application as one OCI image.

Individual works live in separate user-owned Git repositories; they are **not** stored in this product's source tree.

## Status and scope

The canonical target is [Core Architecture](docs/architecture/CORE.md). Track the initial migration under [Epic #1](https://github.com/yohn-jp/scriptorium/issues/1).

Advanced narrative modeling, diagnostics, speaker attribution, NLP, semantic search, and embedded LLM execution are outside the initial Core. They may return as optional modules but must not be required to write.

## Development

The runtime/build commands will be documented once the first functional Core packages are migrated. This initial repository foundation does not yet provide a runnable application.

## Security and contributions

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT; see [LICENSE](LICENSE).
