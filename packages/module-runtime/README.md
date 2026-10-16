# Module runtime

The runtime resolves installed module metadata before evaluating any module code. It accepts only the eight published module IDs from `@scriptorium/contracts`; work data can choose among installed IDs but cannot supply package names or entry points. `resolveModulePlan` validates module and contract versions, dependencies, cycles, and required capabilities without importing packages.

`ModuleRuntime` receives metadata and lazy `createModule(context)` loaders from the selected profile. An absent module reports `redeployment_required` when enabled. An installed module stays unimported while disabled. `activate()` imports enabled module code and exposes its action and UI registrations; capability factories run only when a module explicitly acquires a required or self-provided capability. A loaded definition must register every capability in its manifest. Disabling a provider while enabled consumers still require it is rejected; disabling consumers releases their leases first. Module disable cancels jobs, releases capability leases, disposes worker services and calls `dispose()`. It does not touch module-owned author data.

One-shot jobs run in a supervised Node child process over Node's dedicated IPC channel and exit after their result. A capability provider can create a reusable `WorkerService` for its own declared worker entry; that process starts on the first lease, serves bounded requests for every consumer, and exits when the last lease is released. Cancelling a service job aborts that request; a worker that does not drain within the grace period is terminated. Workers receive JSON-bounded job requests and a minimal environment containing only `PATH`, locale, timezone, and configured native-library paths. Git and provider credentials, `HOME`, and `NODE_OPTIONS` are not inherited. Worker logs belong on stderr. The supervisor enforces request deadlines, validates module/model/snapshot identity and output size, and waits for child processes to exit after cancellation or release.

The `ModuleContext` capability pool pins one provider version per capability ID and shares one value across consumers. Capability providers should keep configuration-sensitive model routing in their bounded worker request metadata; the worker must distinguish incompatible model configurations rather than silently reusing one allocation. The profile generator reads pure `scriptoriumModule` package metadata, validates the selected dependency closure, and emits lazy server and browser loaders only for modules in that profile. `--verify-deploy` checks the actual deployed package tree and built imports.

## Worker entry

Compiled worker entry points may use `installWorkerHandler`:

```ts
installWorkerHandler(async (request, signal) => {
  return runBoundedAnalysis(request.input, signal);
});
```

The helper accepts one `job` IPC message, passes an `AbortSignal` to the handler, and returns one machine-readable result or error over IPC. A cancellation message aborts the handler; the supervisor then terminates the process if it does not drain within the configured grace period.
