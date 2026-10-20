# C48/C57 candidate verification

The linear attachment-validation fix passed the canonical basic gates on the rebased candidate before any adoption decision. The tested source revision was `aa4cd8b5b133523307ea0ff51257d6f88a631677`, based on main `22aac284cac6dca5e371e118349b0b615cb195bd`. The API source tree matched the payload cohort candidate exactly (`8149908e137ec74b599fc36ff7f6073e3c7928f3`); `server.ts` SHA-256 was `38f9e3856ea31c03b23ced81355cb42661b061c3b4cfd6227ac02255efb62885`, and `server.test.ts` SHA-256 was `e6963971cd9dd429571e10e6d0692c17a53accc06e9850a1602d3dd52ec8dbe2`.

All commands ran with CPU affinity 8–11. The frozen offline install was reused from the recorded candidate build; the lockfile tree remained `4f4ef4aada13bfb9111de0ca7b8ecec63df8bab6` after rebasing onto main.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | PASS, exit 0 |
| `pnpm test` | PASS, exit 0; 426 tests, 425 passed, 1 skipped, 0 failed. API package: 56/56 passed, including the three new large, malformed, and over-cap attachment tests. |
| `SCRIPTORIUM_PROFILE=core pnpm build` | PASS, exit 0; Core composition generated and API built. Vite emitted existing non-fatal chunk-size warnings for the desktop/mobile bundles. |
| `pnpm audit:core` | PASS, exit 0; 128 production dependency versions scanned. |

This record supplements the [fixed real API/Core payload cohort](payload-2026-10-20T17-35-15-272Z-3362716.json) and preserves the original [baseline 500 failure](payload-2026-10-20T17-26-14-731Z-3239566.json). The canonical install, typecheck, test, Core-profile build, and dependency audit are now verified for this API candidate. Full-profile, browser, and OCI combined checks remain central verification work.
