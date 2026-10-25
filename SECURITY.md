# Proprium security policy

Report vulnerabilities privately through GitHub Security Advisories. Never publish repository credentials, private workspace content, artifacts containing secrets, or unredacted diagnostics in public issues.

## Target trust boundaries (not yet implemented)

- GitHub is the authenticated remote authority for published user data. The browser retains a local work copy, unpushed commits, drafts and optionally a credential. No credential belongs in Git files, plugin-visible state, static assets, browser logs or artifact URLs.
- The Browser Host alone authorizes persistent mutations and Git operations. Plugins receive bounded, versioned capabilities, not direct tokens, unrestricted filesystem access, DOM access, or Git publishing authority.
- WASM code runs under a host-controlled Web Worker and explicit imports. WebAssembly alone does not bound total CPU, memory use, or malicious host bindings; quotas, cancellation, Worker termination, and fault tests are required before an isolation claim.
- Artifact digests establish byte integrity, **not publisher trust**. Install/upgrade must verify identity and authorization, constrain origins and egress, and fail closed for incompatible or tampered artifacts.
- Local browser storage may be evicted or cleared. Uncommitted and unpushed data may be lost; only a verified GitHub push establishes remote publication. Display that state honestly.
- The intended static web deployment does not require a Proprium application server. Optional Git transport or identity services, if actually required, must be documented and threat-modeled rather than concealed as 'serverless'.

The current source still includes Scriptorium's Node.js single-owner server and OCI deployment code. Those paths are **legacy code**, not a supported Proprium production architecture. Do not publish the inherited server as a Proprium service without a separate security review. The historical [Scriptorium security document](https://github.com/yohn-jp/scriptorium/blob/main/SECURITY.md) describes that upstream runtime.

See [delivery and security](docs/architecture/DELIVERY-AND-SECURITY.md) for the target operational contract.
