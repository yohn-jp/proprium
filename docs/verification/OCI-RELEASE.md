## OCI releases

A repository-local GitHub Actions workflow publishes two independently verified `linux/amd64` images to GHCR when a semantic version tag such as `v0.1.0` is pushed:

- `ghcr.io/yohn-jp/scriptorium/core:v0.1.0`
- `ghcr.io/yohn-jp/scriptorium/full:v0.1.0`

The workflow builds each profile from the tagged source, starts the resulting image, checks HTTP/assets/profile, non-root execution, writable data and graceful shutdown, then publishes that same tested image. A failed check prevents that profile from being published. The two profile jobs are independent: a partial release is possible if one fails, and must be treated as incomplete by operators. Do not repoint a published version tag; use a new version for corrections. No `latest` or mutable stable alias is published. Deployment should pin the registry manifest digest resolved from the release tag.

This workflow is intentionally local to Scriptorium and does not use organization shared release workflows. The GitHub Actions job requires repository Actions permission and GHCR package write access via `GITHUB_TOKEN`. Package visibility is configured separately in GitHub Packages; a public repository does not automatically make new GHCR packages public. No tag is created or pushed by this change, and no images are published until a release tag triggers the workflow.

## Exact-source verification and immutable publication

Issue #29 defines a canonical 50-job verification contract in `scripts/ci-contract.mjs`: 49 required leaf jobs plus one `certification` gate. The leaf set contains 16 workspace unit jobs, five production typecheck groups, three test-source typecheck scopes, scoped safety, Core and Full builds, Core audit, Core and Full OCI checks, 14 browser jobs (seven suites for each profile), four Hosted Native selections, and complete-coverage validation. Matrix entries have individual job names, and matrix fail-fast is disabled so one failure does not stop unrelated checks.

Before either OCI profile can be published, `scripts/verify-release-source.mjs` requires a completed successful **main push** verification for the exact tagged commit SHA. It checks the exact 50 names from the canonical contract and requires each exactly once with `completed` / `success` status, including the certification gate. Missing, duplicate, unexpected, failed, cancelled, skipped, queued, or in-progress jobs block release. It excludes PR runs, other SHAs, and other events. The GitHub Actions API run listing and job listing are read through every page using `total_count`; malformed, incomplete, inconsistent, or failed page requests stop the gate. A tag or a successful PR check alone is insufficient. Publication rechecks the tag-to-commit binding immediately before pushing.

`verify-unpublished-image.mjs` checks GHCR immediately before each image push. An existing version tag is refused; only a registry 404 with `MANIFEST_UNKNOWN` or `NAME_UNKNOWN` confirms absence. Authorization, service, malformed-response and network failures stop publication. The workflow serializes events for the same Git ref. A partial publication must use a new version; rerunning it must not replace the profile already published.

The workflow's `Publish verified Release` job runs only after both image jobs succeed and rechecks exact-source verification. It retains an existing GitHub Release unchanged. This tag-triggered workflow is the verified publishing entrypoint; do not manually create an unverified Release. These repository checks cannot prevent an administrator from manually moving Git/registry tags, publishing a Release, or changing the workflow. No account-level protection is claimed.

PR #30 performs verification only: no version tag, Release, registry image, or production deployment is published. See [the audit evidence](AUDIT-HARDENING-29.md) for the acceptance matrix and explicit external exclusions.
