# Core-64 network and startup evidence

**Scope:** C38, C43, C44, C49, and C64. This bounded evidence unit changes no
production code. The initial cohort captured C38 and no-added-RTT C44, then
ended during headful-browser profile cleanup. A separate remaining-only cohort
completed C44's added-RTT sample and the C49 SSE checks without rerunning C38.
Sections not captured are explicitly left unchecked.

## Run identity and limitations

The runner used the immutable small synthetic fixture at
`/data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/small`, the
frozen Core runtime at `/home/sophia/src/scriptorium-c64-resize`, and
`runtime-manifest.json` with SHA-256
`f16e9db3d4e99c39985044ef44fa677dde62678be54f0d36f53693bf095a9031`. Its actual
source commit and checkout HEAD were both
`ffd02739ab095dfda2854a3ff487434c84f6b536`; the runner verified 85 artifacts
(5,095,497 bytes), the six artifact roots, and the recorded production tree
identity before starting. The fixture seed remained at
`e70bb509cc41b383451335e05af36d78f1cb31db`, clean, and the canonical bare
remote retained only `refs/heads/main` at that same commit. These values also
match the runner's post-run fixture check and an independent read-only check.

The run used Node v24.21.0, Playwright 1.64.1, Chromium 155.0.8059.79, CPUs
0–3, Xvfb `:97`, and raw headful Chromium attached with
`connectOverCDP({ noDefaults: true })` to its default context. This naturally
produced same-window hidden/visible transitions; visibility was not overridden.
Other benchmark lanes were running concurrently, so wall-time observations are
diagnostic and not adoption-quality latency comparisons.

The initial raw result is [`network-small.json`](results/core-network64/network-small.json)
and preserves `status: failed`. After the hidden/focus measurements, Chromium
profile cleanup raised `ENOTEMPTY` while removing its `Default` directory. That
run ended before the added-RTT and SSE resource scenarios. The separate
[`network-small-remaining-2.json`](results/core-network64/network-small-remaining-2.json)
has `status: complete` and contains only the added-RTT startup and C49 scenarios.
An intermediate remaining-only attempt is preserved as
[`network-small-remaining.json`](results/core-network64/network-small-remaining.json);
it stopped on an incorrect unauthenticated-job status expectation before
producing reportable metrics. Each run checked the fixture before and after; the
per-run worker remotes were disposable clones.

## C38 — remote observation polling

In the visible loopback idle window (35,003 ms), the page made 6 requests:
two each to recent activity, observation, and proposals. The observation count
was 2. The native headful visible window (35,000 ms) also made 6 requests, with
2 observation requests; `document.visibilityState` was `visible` and
`document.hasFocus()` was true.

After a synthetic push to the disposable local bare remote while visible, the
authoritative observation path reflected its new head in 9,459 ms. A separate
push while the page was naturally hidden yielded 2 non-observation requests and
0 observation requests in 35,192 ms. On foreground return, the page observed
the pushed head 321 ms after focus returned (35,365 ms after the push). The
original and foreground pages shared Chromium window ID `1016796073`; the
captured hidden state was genuine. No project-SSE event arrived for either
external push.

**Disposition for this evidence unit:** retain the existing authoritative
observation and current foreground/focus freshness behavior. The hidden window
made no observation calls, and the visible local-push result does not support
reducing or replacing authoritative freshness checks. This one 35-second local
synthetic cohort says nothing about long-idle or native GitHub timing.

## C43 — project event SSE

The owner project event stream was open during the two local bare-remote pushes;
it emitted zero frames for them. This confirms that this SSE stream is not an
authority for remote GitHub changes. Retain remote observation as the
authoritative path and treat project SSE only as a local sync hint. No browser
subscription or polling replacement was implemented, and no savings from such
a subscription were measured.

**Disposition:** defer client subscription/replacement. The measured external
change behavior does not establish a project-event optimization case; native
GitHub/GHES detection remains `NOT_CHECKED`.

## C44 — startup bootstrap

The two completed no-added-RTT startup samples each captured 22 request starts
(19 API starts, including the persistent jobs event stream), 818,890 Resource
Timing transfer bytes, and 812,590 encoded body bytes. Loopback reached the
selected synthetic scene's editor-ready condition in 806 ms; raw headful
Chromium did so in 1,088 ms. Both samples had the same request count and byte
totals. These are single observations under concurrent host load; the readiness
endpoint is the selected scene content, not a browser-standard TTI measure.

The remaining-only cohort applied 80 ms to each API request in the Playwright
route and captured the same 22 starts, 818,890 transfer bytes, and 812,590
encoded body bytes. The selected-scene readiness measurement was 1,702 ms. This
is a single observation, collected separately from the no-added-RTT samples
under concurrent host load; it is not a paired causal latency comparison.
Resource Timing records the event-stream request start but not its continuing
body bytes.

**Disposition:** do not add a bootstrap API from this partial local result.
The request/byte shape is now measured with and without routed RTT, but the
single samples do not justify an aggregation, and authorization-denial and
abort-equivalence cases were not part of this probe.

## C49 — job/project SSE resource and reconnect behavior

The remaining-only cohort tested the existing distinctions. No credentials
returned 401 for both streams. A valid API bearer token returned 200 for project
events and 403 for owner-only job events; an owner cookie returned 200 for both.
A manual sync produced a completed project event whose `projectId` matched the
registered synthetic project. Unknown `Last-Event-ID` values reconnected with
200 on both streams and produced zero replay data frames in 500 ms.

Four 35-second windows captured no stream, job only, project only, and both
streams. API-process CPU deltas were 4.2 ms, 2.1 ms, 44.5 ms, and 3.4 ms. RSS
was 105,955,328 bytes through the job-only window, then 92,553,216 bytes after
the project-only and combined windows; the API process's cumulative peak RSS
rose from 103,472 KiB to 104,356 KiB in the project-only window. Git process and
async readFile counts did not change during these windows. The isolated 44.5 ms
project-only CPU sample and RSS movement are noisy single-run observations under
other host load, not a demonstrated per-connection cost. With both streams open,
shutdown exited successfully in 188 ms; both readers closed and reported no
read error.

**Disposition:** keep the separate job and project streams and their current
authorization boundaries; this probe gives no measured case for a shared
envelope or protocol rewrite. Backpressure/queue saturation and native hosted
event traffic remain `NOT_CHECKED`.

## C64 — request/error/performance correlation

Fastify 5.12.7 ([pinned in the lockfile](../../pnpm-lock.yaml#L2000)) exposes a
per-request `request.id` and calls its default ID generator for routed requests
even though this API constructs Fastify with `logger: false`
([server initialization](../../packages/api/src/server.ts#L566)). That ID is
internal here: the HTTP handlers do not read it for correlation, add it to
response headers or error bodies, or pass it into Git or storage work.
[`sendError`](../../packages/api/src/server.ts#L243) returns the public error
code and message (or a generic internal error), without a request ID. The [G3
source review](CORE-64-G3-PLAN.md#candidate-triage) correctly found no shared
opaque ID across the layers; this clarifies that an internal Fastify ID exists
but is not a correlation mechanism in the application.

This probe can compare Playwright request-event method/path/start rows with API
method/path/status/duration rows at a coarse endpoint level. They have no
shared request key; Playwright event timestamps use the parent Node clock,
Resource Timing uses page-relative time, and API timestamps use the worker's
Node clock. Repeated calls to the same path cannot be joined reliably.
Resource Timing contributes URL-relative start/end and byte counts, not an ID
that links to the API row. The network run records API request rows and
process-level Git child-process/readFile counts as separate aggregates; it
does not retain per-command Git spans or join Git work to an API request. It
does not collect IndexedDB events. Other browser probes instrument IndexedDB
separately, without a shared ID in this cohort. No Browser↔API↔Git/IDB span
chain was captured.

No accepted C38/C43/C44/C49 implementation leaf in this evidence unit is
blocked on missing trace correlation: these decisions are about preserving
existing observation and stream contracts or declining unproven optimizations.
This is a bounded statement about these examined leaves, not a claim that
current counters explain all production latency. The captured startup and SSE
windows are single samples; representative p95 distributions, the fraction
of target p95 samples that existing counters can attribute, trace-on/off CPU
and RSS overhead, and error/conflict scope protection under tracing are all
`NOT_CHECKED`.

**Disposition: DECLINED — add no production tracing for this evidence unit.**
There is no demonstrated accepted change or measured p95 question that requires
cross-layer IDs, and adding tracing without a named question would incur
unmeasured cost. Reconsider when an accepted leaf or a production incident has
a measured p95 target that remains unexplained after the existing per-layer
counters. First trial the smallest opaque request correlation needed for that
target, measure join coverage and matched trace-on/off CPU/RSS, and test that
error/conflict scope is preserved; never include manuscript content,
credentials, or private repository data in telemetry. This declines new
instrumentation now, not the fixed goal's ability to reopen the question on
that evidence.

## Final bounded decisions

| ID | Decision | Evidence and boundary |
| --- | --- | --- |
| C38 | **Retain existing authoritative observation and focus-return freshness.** | Visible windows each made 2 observation calls in 35 seconds; a visible local bare-remote push was observed in 9,459 ms. Native hidden state made 0 observation calls for 35,192 ms; its push was observed 321 ms after focus returned. This supports the current visible/hidden contract only; long idle and native GitHub/GHES detection are `NOT_CHECKED`. The C38 capture remains valid partial evidence in a raw file whose overall status is failed due to later profile cleanup. |
| C43 | **Decline replacing remote polling with project SSE.** | The open project stream emitted no frames for either local external push, so it is a local sync hint, not remote-change authority. No polling savings were measured; hosted remote behavior is `NOT_CHECKED`. |
| C44 | **Decline a bootstrap endpoint or aggregation change.** | The two no-added-RTT samples and separate 80 ms/API-route sample each recorded 22 starts and the same byte totals; selected-scene readiness was 806 ms, 1,088 ms, and 1,702 ms respectively. These are unpaired single samples under competing load, not causal latency evidence. Authorization-denial and abort equivalence are `NOT_CHECKED`. |
| C49 | **Keep job and project SSE protocols and authorization boundaries separate.** | The bounded probe verified distinct bearer outcomes, owner-cookie access, a project-scoped completed sync event, and 200 reconnects for unknown `Last-Event-ID` values with no data frames in 500 ms. Both streams closed cleanly on shutdown in 188 ms. Per-connection cost is not isolated by the noisy single-window CPU/RSS samples; backpressure and hosted event traffic are `NOT_CHECKED`. |
| C64 | **DECLINED — no new production tracing in this unit.** | Fastify has an internal request ID, but it is neither consumed nor propagated. Existing benchmark rows and counters permit coarse per-layer inspection, not reliable request-to-browser/Git/IDB joins. No leaf here requires that join; attribution ratio, p95 causality, and instrumentation overhead remain `NOT_CHECKED`. Reopen only for a measured p95 target still unexplained by existing counters. |

## Verification record

- `node --check scripts/performance/core64-network.mjs` and
  `node --check scripts/performance/core64-network-server.mjs` passed before the
  cohort; `git diff --check` passed for the implementation files.
- The bounded cohort exited 1 after C38 and loopback C44 capture because of the
  profile-cleanup `ENOTEMPTY` error. Its raw result and earlier failed setup
  attempts are preserved separately in
  [`results/core-network64/README.md`](results/core-network64/README.md).
- The remaining-only cohort exited 0 and completed added-RTT C44 plus C49; an
  earlier harness assertion failure is retained as its own raw attempt.
- The fixture was independently confirmed unchanged after the run. No install,
  build, full test suite, native GitHub flow, backpressure experiment, or repeat
  latency cohort was run here.
