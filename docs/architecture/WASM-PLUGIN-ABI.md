# WASM plugin ABI and Host adapter contract

**Status: normative implementation boundary.** The selected baseline is **WebAssembly Component Model + WIT** for plugin compute; browser delivery uses a tested component-to-core-WASM/JS-binding toolchain such as jco. The plugin host remains TypeScript. Actual engine support and generated bindings must be verified in desktop and mobile browsers.

The currently implemented `proprium:plugin@1.0.0` WIT world and `PluginPanel` are **compute-demo-scale**: bulk snapshot list/read, change proposals and title-only panel/command contributions. A fully functional authoring plugin requires the versioned paged readers, typed actions, Host-rendered interactive UI and guarded navigation/ChangeSet review specified in [the recovery Host/Plugin Canon](../canon/HOST-PLUGIN-CONTRACT.md). The v2 authoring world and corresponding Host runtime are implemented separately from v1; availability of a specific surface still requires its signed manifest and Host admission. Never silently alter an existing WIT major version.

## Contract authority

- Maintain one versioned source of truth for the public component interface: WIT packages/worlds, with generated bindings and separately validated manifest/distribution metadata. Do not independently hand-maintain contradictory TypeScript/WIT business contracts.
- Public plugin ABI version, capability-family versions, manifest schema version and artifact version are distinct. A incompatible major ABI or missing required capability rejects activation before guest execution.
- Plugin identity is a publisher-scoped stable ID, not Scriptorium's nine built-in ModuleId values. Host is free to retain TypeScript for editor, Git and standard UI; external computation defaults to WASM.
- A host-approved Web Worker owns component instantiation and IPC. Expose **only named capability functions** as guest imports, never raw DOM/FS/IndexedDB/Git credentials/network. JS glue is generated or host-reviewed code, not arbitrary publisher-supplied code executing in the Host origin.
- Worker MessagePort envelope binds session, plugin ID/version/digest, workspace, snapshot/revision, activation epoch, request ID, capability, method, deadline and bounded payload. Every request and response is schema-validated and rejects stale epochs/revisions, exceeding quotas and missing grants.

## Minimum public surface

The first supported families are read-only snapshot listing/read, proposed change sets with explicit revisions, declared UI contributions, scoped navigation/events, and bounded plugin-specific derived cache. The standard UI is Host-rendered from validated descriptors. Heavy model downloads, optional network egress and custom iframe UIs are additional explicit opt-in capabilities, not V1 defaults.

Guest lifecycle needs initialization/compatibility declaration, a bounded invocation mechanism, cancellation (host may terminate Worker) and disposal. The host provides a stable error contract including incompatible_abi, capability_denied, invalid_input, snapshot_stale, overloaded, timeout, canceled, guest_trap and unavailable. Avoid promising that guest-side cancel can interrupt a synchronous infinite loop; host termination remains authoritative.

A plugin cannot call commit, publish, approval or direct file write. It submits a proposed mutation with read/write sets and expected revisions. Host UI retains actual user authorization; the single Host Writer checks revisions before applying. Derived indexes never become Git authorities.

## Minimum deterministic behavior

- Unknown mandatory capability, dependency cycle, invalid manifest/digest or version -> reject before execution.
- Disabled/uninstalled plugin -> zero Workers, timers, model allocations and background fetch.
- Enabled-idle plugin -> metadata only; lazily instantiate on real demand.
- Worker trap, timeout, malformed message or cancellation -> dispose plugin state without stopping Core Editor. Do not claim OS-level isolation or hard memory bounds that a browser cannot enforce.
- Snapshot changes during a plugin request -> reject stale results; cannot overwrite editor input or commit.
- A plain UI plugin must be representable without shipping publisher JavaScript. Custom canvas/editor integration requires separately approved isolation and is deferred with Atlas.

Do not add bespoke runtime abstractions where Component Model tooling and browser Web Worker primitives already satisfy the contract. Exact WIT world/function signatures and tested tooling versions must be committed along with the first executable ABI implementation, not independently fabricated in prose.


## Authoring v2 profile

The [fixed H0 logical schema](../canon/HOST-PLUGIN-CONTRACT.md#h0-authoring-profile-v2-fixed-logical-schema) specifies the incompatible `proprium:plugin@2.0.0` recovery profile: paged immutable bytes, typed read/propose actions, caller policy, Host UI/navigation, recoverable proposal units and Host-owned artifacts. The `app/src/browser/proprium/plugin-runtime/wit-v2/main.wit` world, v2 Host transport, signed authoring registry and official authoring components implement this profile, subject to each plugin's declared capabilities and admission. Do not reinterpret v1 `invoke(string)` or title-only UI as that profile. Public v2 `snapshot_stale`/`cancelled` normalize legacy `stale_precondition`/`canceled`; source files' unknown keys remain preserved even while action input schemas reject extra fields.
