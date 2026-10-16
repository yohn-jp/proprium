# Security Policy

Scriptorium Core is a single-owner writing application. No supported public release or external hosting service is claimed by this initial source delivery.

## Reporting

Report suspected vulnerabilities through private GitHub Security Advisories. Do not publish tokens, manuscript contents, private repository URLs, or unredacted server logs in public Issues.

## Deployment boundary

Set a unique `SCRIPTORIUM_AUTH_TOKEN` of at least 32 characters. The browser exchanges it for an HttpOnly, SameSite=Strict session cookie; session state lives in server memory. Restarting the server requires signing in again. Every authenticated session can access all projects registered with that instance. Separate tenants require separate instances and data directories.

The default local listener is localhost. The OCI image listens on all container interfaces; bind its published port to localhost or put it behind a trusted HTTPS reverse proxy. Set `SCRIPTORIUM_TRUST_PROXY=1` only when that proxy controls and replaces `X-Forwarded-Proto`; this enables Secure cookies for externally HTTPS requests. Mutating API requests require a matching Origin. Never expose the instance through plain HTTP on an untrusted network.

Use a least-privilege `SCRIPTORIUM_GITHUB_TOKEN` for the intended work repositories. The token stays in server process state and Git authentication environment, outside clone URLs, Git configuration, browser assets, and image layers. Do not use token-bearing URLs. Work repositories and the persistent data directory contain private writing: restrict filesystem access and protect backups accordingly.

## Persistence and recovery

Git-controlled YAML/Markdown is canonical. Saves compare the loaded revision under project writer coordination and retain unsaved browser drafts on conflict. Synchronization refuses divergent histories; reconcile those histories with Git before retrying. A reported commit or sync failure must be inspected before assuming the remote has the new text.

Browser drafts are local recovery copies and may contain private text. They remain on the browser after logout; use a trusted browser profile and clear it deliberately when retiring the device. Private browsing, storage limits, or clearing site data can prevent recovery. The UI reports inability to store a draft; save or copy the text before leaving.

Keep the data volume persistent, owned by the application user, and exclusively assigned to one running instance. Never mount unrelated host directories or user Git configuration into the container. Excluded analysis files may remain in work repositories; Core does not load models, run repository hooks, or initialize submodules.

If a crash leaves `dataDir/.locks/<project-id>` behind, the Core fails closed rather than reclaiming it during another writer’s operation. Stop every process using that data directory, inspect the project’s Git status, and remove only the abandoned lock directory named by the error before restarting. Inspect any uncommitted files after interrupted saves before synchronizing.
