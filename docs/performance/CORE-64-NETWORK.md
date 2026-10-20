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

The current probe records browser request paths/timings and server request
paths/status/durations separately. The [G3 source review](CORE-64-G3-PLAN.md#candidate-triage)
found no shared opaque request ID carried from browser through API and Git/IDB;
the benchmark's Git Trace2 and browser/API data are separate. Existing counters
can identify which endpoint is polled and provide per-layer timing, but they
cannot reliably join one browser request to API and nested Git/IDB work,
especially for repeated same-path requests. This cohort did not produce
representative p95 distributions or demonstrate that a particular important
p95 is currently unexplainable.

**Disposition:** add no broad tracing framework in this unit. Leave C64 for its
G5 evidence gate; reconsider only if a measured p95 question cannot be answered
with existing per-layer counters, then measure correlation overhead and keep
manuscript content, credentials, and private repository data out of telemetry.

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
