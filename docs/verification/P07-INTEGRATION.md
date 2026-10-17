# Focused Publishing HTTP acceptance

This check composes the compiled Core store, Fastify API, module runtime, and the real compiled Publishing module through a lazy profile loader. It exercises Publishing actions over authenticated HTTP, approves and checkpoints their Core proposals, and confirms pushes against a private synthetic GitHub repository. It also renders the actual anonymous `/r/publishing/:repositoryId/:token` reader in Chromium and verifies scoped scene reads, expiry, privacy headers, and pushed revocation without an owner session. Finally, it removes the complete Core data root and registers the same repository again to verify that GitHub retains the episode and share-grant bytes and remains the public reader's source.

This is a focused Publishing composition check. The API runtime contains only Publishing; the full browser bundle is built so the public page can mount its real module view. It does not certify full-profile API composition, browser recovery, optional workers, or OCI packaging. A skipped run is `NOT_CHECKED`, never a pass.

## Fixture and safety

Use an authorized, disposable private synthetic GitHub repository with a default branch and at least two scenes. The test appends clearly marked synthetic Japanese prose and writes its Publishing episode map, share grants, character profile, id-less voice helper, and binary cover through approved Core proposals. It pushes commits to the repository's default branch. Run it only against that synthetic repository; the test never deletes a GitHub repository, deletes a branch, or force-pushes.

Provide the repository URL through `SCRIPTORIUM_ACCEPTANCE_GITHUB_URL`. Supply a GitHub token through `SCRIPTORIUM_GITHUB_TOKEN`, or authenticate the `gh` CLI so the test can read the token in memory. The token is passed to Core and GitHub API requests without being printed. Do not enable request tracing for this credential-bearing run.

## Run

Build the current checkout first so Core, API, module runtime, and Publishing have fresh compiled output, then run the focused test:

```sh
SCRIPTORIUM_PROFILE=full pnpm build
SCRIPTORIUM_ACCEPTANCE_GITHUB_URL=https://github.com/OWNER/SYNTHETIC-PRIVATE-REPOSITORY \
  SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
  node --test tests/integration/publishing-acceptance.test.mjs
```

Set `SCRIPTORIUM_GITHUB_TOKEN` in the environment instead of using `gh auth token` when needed; avoid placing token values in shell history or command output. If the repository URL is not configured, Node reports the test as skipped with `NOT_CHECKED`.

The test checks plaintext and EPUB output against committed synthetic source text, Japanese ruby and XHTML escaping, byte-exact binary cover embedding, structured notes, and exclusion of the id-less `voice.yaml` helper from the character appendix. It exercises episode field clears while preserving other episodes and unknown YAML fields; verifies that an uncommitted share is unreadable; checks public scope, expiry, and privacy headers after confirmed publish; and then repeats public and owner reads after deleting the complete Core data directory and re-cloning the same GitHub repository. Finally it publishes a revocation and confirms that the fresh remote public read is denied.
