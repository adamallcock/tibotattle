---
title: 0.1.27 HTTP cache advisory exception decision
date: 2026-10-03
type: decision-record
status: pending-owner-decision
---

## Pending decision and exact scope

The local 0.1.27 release preparation has the reviewed max-stale mitigation,
regenerated pnpm lock metadata and passing focused tests. Its OSV exception is
**inactive**: no root `osv-scanner.toml`, temporary guard or changed OSV workflow
has been applied. The earlier owner approval for PR #262 is not treated as
approval to carry its exception into this candidate. This proposal requires the
owner to accept the remaining limitation, exact advisory scope and expiry.

The affected dependency is build-only `electron-builder@26.15.7` through
`app-builder-lib@26.15.7 → @electron/get@3.1.0 → got@11.8.6 →
cacheable-request@7.0.4 → http-cache-semantics@4.2.0`. It is outside the closed
packaged runtime staging list. Proposed suppression covers only the root pnpm
lock's GHSA-ch52-4w7c-c8xp and its CVE alias; child locks and unrelated findings
remain outside scope. This decision does not authorize signing, publication,
deployment, merging or any external write.

## Current official status

Read-only npm registry and GitHub API checks on 2026-10-03 confirmed
[npm latest](https://registry.npmjs.org/http-cache-semantics/latest) remains 4.2.0;
its full published version list has no later release. The active
[GitHub advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) still affects
`<= 4.2.0`, has no patched version and was updated at
2026-10-02T22:36:44Z. [Upstream PR #58](https://github.com/kornelski/http-cache-semantics/pull/58)
is open and unmerged at `14a8c2ad51740dc39bf3e8f1a11c845a5003f217`.
No compatible published fix is available in this checked package inventory.

## Local mitigation evidence

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

## Fresh scanner evidence

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
The release worktree's exception remains inactive. The scanner artifacts are
`/private/tmp/tibo-osv-root-review-Ccy1r8` and
`/private/tmp/tibo-osv-child-review-tlS0iQ/results.json`.
Documentation governance and all 20 preflight tests passed. These are local
lock/scope proofs and do not qualify the hosted action-wrapper workflow.

## Remaining risk and proposed enforcement

A synthetic check on these installed bytes confirms an explicitly enabled
shared cache can still reuse `no-cache` or shared `proxy-revalidate` responses
through `stale-if-error` after a server error. That independent limitation is
outside the selected max-stale patch. Disabled downloader HTTP caching limits the
current build chain's exposure; no default application or cross-user exploit has
been demonstrated by this review. Enabling shared HTTP caching invalidates the
risk basis and requires independent review.

Proposed expiry is **2026-10-10T00:00:00Z**, without automatic renewal. The exact
proposed guard refuses invalid/backdated clocks, expiry, expanded config,
additional root locks, changed lock/workspace/patch/test bytes, installed source
drift or enabled got cache defaults. Fresh official npm/advisory reads are
required; unavailable status, a new published release, a declared fixed version,
withdrawal or advisory scope change refuse the exception and require removal or
replacement review. Root-local config applies to root locks, with no global
`--config` and no child-lock inheritance.

The proposed workflow runs guard, focused tests and direct scanning in one
failing check. It keeps `pull_request`, contents-read only, credential persistence
disabled, no SARIF upload, no cache sharing and no continue-on-error. Checkout and
Node setup retain their reviewed immutable source SHAs.

The inherited Google wrappers used a mutable scanner image tag, mapped a
no-package result to success and allowed missing/malformed reporter input to
become empty results. The bounded pending change replaces only that wrapper pair
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

## Concrete approval packet

The isolated local preview is
`/private/tmp/tibotattle-0.1.27-http-cache-exception-preview`.
The exact five-file pending guard/config/workflow patch is
`/private/tmp/tibotattle-0.1.27-http-cache-exception-pending.patch`; it passes
`git apply --check` against the current release preparation. Applying it remains
pending the owner's concrete decision. If approved, record the decision here,
index the accepted authority, rerun the exact integrated guard/tests and obtain
a fresh OSV result. Hosted CI and all release artifact gates remain separate.
