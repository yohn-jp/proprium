# Security Policy

Scriptorium is in its initial pre-release migration stage; no production-ready or supported release is available yet.

## Reporting

Use private GitHub Security Advisories for suspected vulnerabilities. Do not publish reproduction material containing tokens, manuscript contents, or private Git repository URLs in public Issues.

## Trust boundaries

- Manuscript and setting repositories are user-controlled and may be private.
- GitHub credentials and API secrets must remain outside source control and built frontend assets.
- Browser, REST and future MCP operations must share an authorization and project-scoped mutation boundary.
- A module cannot bypass the canonical manuscript writer or read unrelated projects.
- Persistent writes require revision/precondition validation, conflict signaling and auditable history.
- Derived indexes and caches must never become authoritative manuscript state.

Security compatibility and deployment claims must be verified against the implementation; this document alone does not establish them.
