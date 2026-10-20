# C38/C43/C44/C49/C64 network probe artifacts

The decision record is [`CORE-64-NETWORK.md`](../../CORE-64-NETWORK.md). The
attempt files are deliberately kept separate:

| Artifact | Result |
| --- | --- |
| `network-small-attempt-1-preflight.json` | Preflight stopped before browser/server startup because the task temporary directory was absent. Not a measurement. |
| `network-small-attempt-2-ui-flow-failure.json` | Setup failed waiting for the scene heading before selecting the synthetic scene. Not a measurement; the fixture stayed unchanged. |
| `network-small.json` | Actual bounded cohort. Contains completed loopback/headful bootstrap samples and visible/hidden/focus/local-push observations; `status` is `failed` because profile cleanup raised `ENOTEMPTY`, before the added-RTT and SSE resource cohorts. Do not read missing fields as zero or as passing. |
| `network-small-remaining.json` | Remaining-only attempt stopped on an incorrect unauthenticated job-stream status assertion. It is retained as a failed attempt and is not a measurement result. |
| `network-small-remaining-2.json` | Completed remaining-only cohort. Contains the 80 ms added-RTT startup sample and C49 auth, local sync, reconnect, 35-second resource windows, and shutdown result. It does not rerun C38 or native visibility. |

The initial full cohort used the exact runner snapshot retained as
`network-small-runner-full.mjs`. The successful remaining-only cohort used the
exact `network-small-runner-remaining.mjs` snapshot. The committed runner adds
the optional phase to its usage error text after that capture:

| File | SHA-256 |
| --- | --- |
| `network-small-runner-full.mjs` | `20444749ecec984dcc403e2b7fd98cf28911fc89c832a39c8c0172e76b61260d` |
| `network-small-runner-remaining.mjs` | `843fd66240775391abc29120a1f9a139ca6622cdf66ac09a23e7f9f616e27cbb` |
| `scripts/performance/core64-network.mjs` | `e868e2e38ccd073b339487a6c644f4a7d64b0ebfadfbbdd2a25b49100124299e` |
| `scripts/performance/core64-network-server.mjs` | `61cde0c8b18f5025bf0d85eedd3618048a5b0ba2a0653969a179c893c0966767` |
| `network-small.json` | `7e37a2d8ab49811bb55386cec5e8001884b63e95e605714ddb2663ec86a227a8` |
| `network-small-remaining.json` | `a584a939f04422968d6b513431835072bf4ffd613d06b572051552cfbca8d5ab` |
| `network-small-remaining-2.json` | `f4f398aeaa6292b0565ac6ceb1cdaf8f7d48c6f71005d19f1fdebf14b4ca8f6c` |

The result embeds the frozen runtime manifest path, SHA, full source commit,
actual HEAD, artifact hashes and fixture before/after state. The manifest itself
is external and remains frozen at
`/home/sophia/src/scriptorium-c64-resize/docs/performance/results/core64-resize/runtime-manifest.json`.

The initial full command was:

```sh
taskset -c 0-3 env \
  DISPLAY=:97 \
  TMPDIR=/data/scriptorium-c64-network-tmp \
  SCRIPTORIUM_E2E_NATIVE_VISIBILITY=1 \
  SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
  node scripts/performance/core64-network.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/small \
  /home/sophia/src/scriptorium-c64-resize \
  /home/sophia/src/scriptorium-c64-resize/docs/performance/results/core64-resize/runtime-manifest.json \
  ffd02739ab095dfda2854a3ff487434c84f6b536 \
  docs/performance/results/core-network64/network-small.json \
  35000 80 35000
```

The successful remaining-only command used the same fixture/runtime and result
identity, omitted the native visibility environment, and added the final
`remaining` phase argument:

```sh
taskset -c 0-3 timeout --signal=TERM --kill-after=10s 285s env \
  TMPDIR=/data/scriptorium-c64-network-tmp \
  SCRIPTORIUM_E2E_CHROMIUM=/nix/store/ini1ifgvcsvw48x4mxawrv9jvbdwn70p-chromium-155.0.8059.79/bin/chromium \
  node scripts/performance/core64-network.mjs \
  /data/scriptorium-core64-g0-a1587e78-20261020-2318/synthetic/small \
  /home/sophia/src/scriptorium-c64-resize \
  /home/sophia/src/scriptorium-c64-resize/docs/performance/results/core64-resize/runtime-manifest.json \
  ffd02739ab095dfda2854a3ff487434c84f6b536 \
  docs/performance/results/core-network64/network-small-remaining-2.json \
  35000 80 35000 remaining
```

The attempt logs are not combined with the actual sample. No CI, remote service,
or canonical source fixture mutation was part of this probe.
