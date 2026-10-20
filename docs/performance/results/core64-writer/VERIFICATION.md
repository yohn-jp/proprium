# Canonical Core verification

The C23 writer candidate passed the required canonical verification on
requested and effective CPUs 4–7. Verification ran with Node `v24.21.0` and
pnpm `12.10.1`.

## Source and dependency binding

The verified checkout was `1efa1ed78565f0358317ff8bf0cb89400b8db4fe`; its
Core implementation remained frozen at source commit
`0152e9211f00abdbfdbc36939505d48162a3c1a1`. The `packages/core/src/index.ts`
SHA-256 was `0408ab8500555060bc1efc6a1cdb21ed1036ed8904ad7f0bc356fc5a25e36ee4`
both before and after verification. The lockfile SHA-256 was
`107821c3fdeb50571c891e7de500c0b477bc01206c1f4caa63d830fd8be7e768`. Core
and contracts compiled entry hashes after build were
`8f339dacbea1ad40ae60d358c7fba12e74bfd390337a7cbbadceef4247264e68` and
`b33421f57a9ba54adebdf06fee5c298ed2cdd65ea0a710d885d87d0f974b15be`.
No workspace or package manifest, lockfile, or workspace configuration
changed between the frozen source commit and the verified checkout.

The worktree already contained `node_modules`. The exact frozen install command
was `pnpm install --frozen-lockfile`; it reported that the lockfile passed
supply-chain policy, was up to date, and required no resolution step. The
install completed successfully in 57 ms.

## Gate results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm test` | Pass: 425 tests, 424 passed, 0 failed, 1 explicitly skipped |
| `SCRIPTORIUM_PROFILE=core pnpm build` | Pass; generated profile contains 0 optional modules |
| `pnpm audit:core` | Pass; 128 production dependency versions scanned |

The build emitted the existing Vite advisory that minified chunks exceed 500
kB; all Core, API, app, desktop, and mobile build steps completed successfully.
The full test log contained simulated provider-unavailable and module-shutdown
warnings inside passing tests. No test failed, so no retry was used. The one
skipped test is explicitly marked skipped by the suite. No performance
measurements were run during canonical verification.

## Raw command logs

Full raw outputs remain in the authorized external scratch area. These SHA-256
values bind the captured command output:

| Log | SHA-256 |
| --- | --- |
| `install.log` | `020cba479fddc2de80dfa4ca15a1a3a145bf2b1f2b12b791dea0190ea4eeb311` |
| `typecheck.log` | `feb9f0737a5d45717a689a8503b8597ae0b388ec3340494233dd94660e0e5a6b` |
| `test.log` | `7734f4c3e352f8845f8c244429b164e5977f2280aa2360782569b90ba49983f4` |
| `build-core.log` | `1ebfce0e44384dfda5d3ef7a4aaba9e9df3570aa90e9ae7312882a1f5519a26b` |
| `audit-core.log` | `b4926aaaf9c2a51c388d729a342e24e792f2e7387fbc7bf201df0fe6b40d1030` |

This verification was limited to the requested commands and the C23 candidate;
it did not run browser or OCI acceptance checks or other CI workflows.
