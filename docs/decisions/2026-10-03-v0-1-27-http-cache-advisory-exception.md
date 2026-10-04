---
title: 0.1.27 HTTP cache advisory exception decision
date: 2026-10-03
type: decision-record
status: accepted
---

## Accepted boundary

The owner explicitly approved the reviewed 0.1.27 release route, including this
build-only exception, remaining limitation and exact expiry, on 2026-10-03
(America/New_York). The root-local OSV config, exact-source/status guard and
checksum-pinned direct-scanner workflow are applied to the release preparation
based on `b2cefc8d282b4be8518671fbaf613a8f822c370e`. The earlier PR #262 approval
is not the authority for this candidate; this accepted decision is.

The affected dependency is build-only `electron-builder@26.15.7` through
`app-builder-lib@26.15.7 → @electron/get@3.1.0 → got@11.8.6 →
cacheable-request@7.0.4 → http-cache-semantics@4.2.0`. It is outside the closed
packaged runtime staging list. Accepted suppression covers only the root pnpm
lock's GHSA-ch52-4w7c-c8xp and its CVE alias; child locks and unrelated findings
remain outside scope. This decision defines only the security exception. Artifact qualification and
publication remain separate gates under the owner's approved release route.

## Initial official-status snapshot

Fresh read-only npm registry and GitHub API checks at 2026-10-04T02:12Z confirmed
[npm latest](https://registry.npmjs.org/http-cache-semantics/latest) remains 4.2.0;
its full published version list has no later release. The active
[GitHub advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) still affects
`<= 4.2.0`, has no patched version and was updated at
2026-10-02T22:36:44Z. [Upstream PR #58](https://github.com/kornelski/http-cache-semantics/pull/58)
is open and unmerged at `14a8c2ad51740dc39bf3e8f1a11c845a5003f217`.
No compatible published fix is available in this checked package inventory.

## Technical retention review after 4.3.0 publication

The first hosted OSV check on release source `745a631f` refused the exception
before tests or scanning because the official publication inventory changed.
Fresh read-only review on 2026-10-04 confirmed npm published
[4.3.0](https://registry.npmjs.org/http-cache-semantics/4.3.0) at
**2026-10-04T02:56:05.593Z**, and latest now points to 4.3.0. The official
tarball passed its registry SHA-512 integrity check:
`sha512-M5t5LlJpS1UHMjvwRQVdFHvPISGeLAxNcrWuJkeGh0KxsqCHZ1O3NXZU/8x7cD0BDcGW8kapxMKTvwlqrNkHkA==`.
Its `index.js` SHA-256 is
`ede1cc404a492fa348eb9d97a3007a0d72aa717bd22cd86a56bd0824c19729ca`,
from package git head
[`b1d4bd682fbab0252985de45219f4e7497c0067c`](https://github.com/kornelski/http-cache-semantics/commit/b1d4bd682fbab0252985de45219f4e7497c0067c).

Five bounded, synthetic probes loaded those verified published bytes in memory
and exercised the existing max-stale regression cases. For shared cookie,
`proxy-revalidate`, `no-cache`, `no-store` and `private` responses, 4.3.0 returned
both `satisfiesWithoutRevalidation: true` and a reusable response. The installed,
exact patched 4.2.0 source returned false and no reusable response for every
case. These are synthetic package-policy checks, not an application exploit or
native packaging claim. The published release changes Vary/status behavior and
does not satisfy the approved mitigation's security regressions.

The official advisory still states `<= 4.2.0`, no first patched version, and the
same update timestamp. Upstream PR #58 is now closed and unmerged with unchanged
head `14a8c2ad51740dc39bf3e8f1a11c845a5003f217`. Neither a new version number nor
the advisory's unchanged range establishes a compatible published fix.

Technical retention review therefore preserves the owner's already approved
exact patched 4.2.0 build chain, root-only advisory scope, disabled downloader
HTTP cache and **2026-10-10T00:00:00Z** expiry. It changes only the reviewed
official-status snapshot and its proof fixture, with no dependency, patch,
config or mitigation-test identity change. The original decision requires
removal or replacement review after official-state drift; it does not require
fresh human approval for this review within the authorized release route.
This record does not claim a new owner approval or renew the exception.

The guard now pins the reviewed 30-version inventory and latest 4.3.0. Every
subsequent added or removed version, latest-tag change, advisory scope/fix or
withdrawal change still refuses the exception and requires another review.
The proof fixture additionally covers an inventory removal, next regular/beta
publication with latest unchanged, and latest-tag rollback.

Focused validation of this three-file repair passed the live exact-source/status
guard and all 10 tests in `test/http-cache-exception.test.js` plus
`test/http-cache-semantics-security.test.js`, with no skips. Node syntax checks
and whitespace checks passed. The public R7 workload-provenance function returned
452 files and SHA-256
`5a24910c95dc84f98837982d753d0e767b47c705067ca4022fadc718ae7949d9`
both before and after the repair. These three files are outside that workload
closure; no package, lock, workspace, runtime or receipt input changed.
No full suite, dependency installation, heavy build or protected R7 operation
was started by this review. Hosted CI on the reviewed repair remains a separate
gate.

## Preapproval local mitigation evidence

The four-file mitigation is carried selectively from PR #262 exact head
`b499bf99cae3e27ca64e6733892e8064f4bb744d`; its public reader work is excluded.
The patch extracts existing security reuse restrictions and requires them to
hold before client max-stale can permit reuse. A fresh frozen installation with
pnpm 11.9.0, Node 26.2.0 and lifecycle scripts disabled verified the installed
source against the exact pinned upstream PR source.

| Reviewed input | SHA-256 |
|---|---|
| Root pnpm lock | `4a0cb72c3ad8cc6147518e6b937c662ef4844a64e6e5cd618578c52edcccd004` |
| pnpm workspace | `27e1d718a6a5e5525635c0e2571e53627a3bedbdfe827f64a2c012edee1005ff` |
| HTTP cache patch | `6e7076d25b3bdb7a6e9cd709a5d6f63c3b9f0d9308f12659b2dddb08dc904a93` |
| Installed HTTP cache index and pinned upstream PR source | `fc7b3f0265b7a7d0fee83bafa47186a66495720d3179801c2be3083de6d0cf76` |
| Unchanged app-builder-lib patch | `5821cdf7573fa16696c7b0440c919f360393e91520a42fd81360eb6a5de555b8` |

The installed downloader, got core and intervening module entrypoint hashes
match the proposed guard's exact reviewed identities. `got` HTTP cache defaults
remain disabled (`undefined`); the separate artifact filesystem cache is not an
HTTP shared cache.

The release worktree based on `396204d306c927d8c51d22df9396f7f9a534da8c` passed
19/19 focused installed-byte, security restriction, ordinary-cache, CommonJS,
synthetic loopback adapter and Windows builder signing-contract tests. The
proposed guard and six exception regression tests passed in an isolated preview
using the same dependency installation. These checks prove source/lock and
synthetic builder compatibility, not native packaging, signing or hosted CI.

## Preapproval scanner evidence

Official OSV-Scanner 2.5.1 for Darwin arm64 was verified by SHA-256
`75c44d6332f892a1e56286f4105a98ed751ae28d215ca0a8b65cc00d84103054` before
read-only scans of temporary exact lock snapshots. The unsuppressed root
snapshot scanned 288 packages and exited 1 for only GHSA-ch52-4w7c-c8xp and its
CVE-2026-93748 alias. With only the proposed root-local config, the same snapshot
filtered that finding and exited 0. A recursive proof with an identical root
lock plus a synthetic child lock scanned 288 root packages and one child
package: the root advisory was filtered, the child's same advisory remained,
and the scan exited 1. The proposed reason consistently identifies reviewed
upstream commit `14a8c2ad`.

These commands used `scan source --all-vulns` and explicit temporary outputs.
At that preapproval snapshot, the release worktree's exception remained inactive. Content-free evidence labels are `preapproval-root-lock-scan` and
`preapproval-child-lock-scope-proof`.
Documentation governance and all 20 preflight tests passed. These are local
lock/scope proofs and do not qualify the hosted workflow.

## Accepted remaining risk and enforcement

A synthetic check on these installed bytes confirms an explicitly enabled
shared cache can still reuse `no-cache` or shared `proxy-revalidate` responses
through `stale-if-error` after a server error. That independent limitation is
outside the selected max-stale patch. Disabled downloader HTTP caching limits the
current build chain's exposure; no default application or cross-user exploit has
been demonstrated by this review. Enabling shared HTTP caching invalidates the
risk basis and requires independent review.

Accepted expiry is **2026-10-10T00:00:00Z**, without automatic renewal. The exact
integrated guard refuses invalid/backdated clocks, expiry, expanded config,
additional root locks, changed lock/workspace/patch/test bytes, installed source
drift or enabled got cache defaults. Fresh official npm/advisory reads are
required; the current reviewed 30-version npm publication inventory is pinned,
including existing beta/next releases and reviewed 4.3.0. Any added, removed or changed version key
refuses the exception even when the latest tag remains 4.3.0; unavailable status, a new published release, a declared fixed version,
withdrawal or advisory scope change refuse the exception and require removal or
replacement review. Root-local config applies to root locks, with no global
`--config` and no child-lock inheritance.

The integrated workflow runs guard, focused tests and direct scanning in one
failing check. It keeps `pull_request`, contents-read only, credential persistence
disabled, no SARIF upload, no cache sharing and no continue-on-error. Checkout and
Node setup retain their reviewed immutable source SHAs.

The inherited Google wrappers used a mutable scanner image tag, mapped a
no-package result to success and allowed missing/malformed reporter input to
become empty results. The bounded integrated change replaces only that wrapper pair
with the [official OSV-Scanner 2.5.1 Linux AMD64 binary](https://github.com/google/osv-scanner/releases/download/v2.5.1/osv-scanner_linux_amd64),
pinned to SHA-256
`f9f25499a2c8cc367b3af45df2ea7eeca7fbccceab9c35079968f4b3652194be`.
The reviewed bytes match the [official checksum asset](https://github.com/google/osv-scanner/releases/download/v2.5.1/osv-scanner_SHA256SUMS).
The workflow verifies that fixed digest before execution, then directly runs
`scan source --all-vulns --recursive ./` with strict shell failure handling. It
has no reporter, fallback or status translation. Existing root-local suppression
scope is preserved; any unignored finding and any nonzero scanner error stop the
job.

Two additional preview tests check the executable pin/verification order and
execute the actual workflow shell block with synthetic downloader, checksum and
scanner adapters. They prove download/checksum failures stop before scanning,
and scanner exits 1, 127, 128 and 130 survive unchanged. All six preview exception
tests passed. The Linux binary has not been executed on this Darwin host; the
previous hash-verified native OSV 2.5.1 scans establish current root/child scope.
Actual hosted Linux workflow evidence remains a separate gate.

Remove the exception earlier when a compatible published fix is adopted, the
advisory is withdrawn/corrected or any evidence condition fails. At removal,
delete root config/allowance and temporary guard/test/workflow proof steps,
validate the replacement dependency and normal OSV failure behavior, and retain
appropriate mitigation regressions. Do not extend expiry or update accepted
hashes merely to pass CI.

## Integrated validation

The reviewed five-file guard/config/workflow patch is applied. Acceptance does
not extend expiry or change the reviewed lock, workspace, dependency source or
mitigation-test identities. The original preview and pending patch remain local
review artifacts; current authority is this indexed decision and the integrated
source. Fresh integrated validation completed on this base plus the eight owned
exception/workflow/documentation changes under Node 26.2.0 and pnpm 11.9.0:

| Command or check | Outcome |
|---|---|
| `node scripts/check-http-cache-exception.mjs` | Passed exact-source/config/installed bytes, expiry and fresh official status |
| `node --test --test-concurrency=1 test/http-cache-semantics-security.test.js test/electron-windows-production-signing.test.js test/http-cache-exception.test.js test/http-cache-exception-workflow.test.mjs` | 25/25 passed |
| `node scripts/check-release-workflow-policy.mjs` | 20 workflow/action files verified |
| `pnpm run release:trust:check` | Codex contract check passed; 86/86 tests passed |
| `pnpm run docs:check` | Documentation governance passed |
| `pnpm run test:preflight` | Root hygiene, whitespace and documentation passed; 20/20 tests passed |
| Parsed YAML trust/order assertions | Passed contents-read, ordinary PR trigger, static runner and proof-before-scan structure |

The fresh actual recursive native OSV scan used
`scan source --all-vulns --recursive ./ --format=json` with output outside the
checkout. It scanned 288 root-lock packages and 188 Worker-lock packages,
filtered only the selected root advisory/alias and exited 0 with zero unignored
findings. The content-free receipt label is `integrated-recursive-lock-scan-2026-10-04`.
A fresh temporary copy of the integrated root lock/config plus the synthetic
child lock scanned 288 root packages and one child package: root advisory
filtered, child advisory retained, exit 1. The content-free receipt label is
`integrated-child-lock-scope-proof-2026-10-04`.

The functional shell proof is explicitly scoped to
`test/http-cache-exception-workflow.test.mjs`, invoked by the Ubuntu OSV job and
our local integration command. All assertions remain; no test is skipped.
Portable guard/schema/source assertions remain in the root `.test.js` suite.
The Windows portable and production gates use explicit test manifests that do
not include this Ubuntu shell proof. Hosted Linux CI, artifact packaging/signing,
installation and publication remain separate gates.

The integrated guard also pins both exception proof files, the actual OSV
workflow and the root-hygiene contract, alongside every earlier approved source,
patch, lock and compatibility identity. The publication-inventory regressions
cover latest remaining 4.3.0 while a new regular or beta version appears,
published-version removal, and latest-tag rollback.
