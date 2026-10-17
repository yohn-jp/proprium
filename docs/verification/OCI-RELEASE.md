## OCI releases

A repository-local GitHub Actions workflow publishes two independently verified `linux/amd64` images to GHCR when a semantic version tag such as `v0.1.0` is pushed:

- `ghcr.io/yohn-jp/scriptorium/core:v0.1.0`
- `ghcr.io/yohn-jp/scriptorium/full:v0.1.0`

The workflow builds each profile from the tagged source, starts the resulting image, checks HTTP/assets/profile, non-root execution, writable data and graceful shutdown, then publishes that same tested image. A failed check prevents that profile from being published. The two profile jobs are independent: a partial release is possible if one fails, and must be treated as incomplete by operators. Do not repoint a published version tag; use a new version for corrections. No `latest` or mutable stable alias is published. Deployment should pin the registry manifest digest resolved from the release tag.

This workflow is intentionally local to Scriptorium and does not use organization shared release workflows. The GitHub Actions job requires repository Actions permission and GHCR package write access via `GITHUB_TOKEN`. Package visibility is configured separately in GitHub Packages; a public repository does not automatically make new GHCR packages public. No tag is created or pushed by this change, and no images are published until a release tag triggers the workflow.
