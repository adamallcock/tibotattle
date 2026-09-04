---
title: Release 0.1.18 publication preparation
date: 2026-09-04
type: plan
status: awaiting-authorization
---

# Release 0.1.18 publication preparation

Prepare the combined Astra/Intel candidate to the publication boundary, starting
from clean `c5a10c6de76a6c5b9150832b3552ce35cb22a87c` on
`codex/release-0.1.18`. The [completed local qualification](../reviews/2026-09-04-paginated-export-qualification.md)
binds the implementation, fresh R7 receipts and ARM/Intel development artifacts.
It does not supply signed, installed, physical-Intel or hosted-release proof.
Public release, updater activation and website/Worker deployment remain held.

Local preparation is complete on source
`dc2d0d32a1e82f5b037b0a7094a37c1d4bfdef76`. This is ready for the explicit
credentialed RC2 preparation decision, not publication-ready: the signed,
installed, hardware and remote gates below remain open. No signing credentials
were accessed and no source tag, push, installation or publication occurred.

## Local preparation

- [x] Recheck current Astra pricing and installed Codex contract. The
  [official pricing table](https://developers.openai.com/api/docs/pricing)
  still matches all eight short/long tier rows in the registry. The
  [model page](https://developers.openai.com/api/docs/models/gpt-6-astra)
  retains the strictly-more-than-272K long-context threshold and 1.25x cache
  writes. API documentation lists efforts through `max`; observed Codex
  `ultra` support is a separate client surface, not an inferred API promise.
  Both available installed channels pass with CLI `0.153.0-alpha.5` and
  seventeen PlanType values; two optional channels are absent.
- [x] Release-note validation and release-trust checks pass (78/78 tests).
- [x] Fix the Login Item release CLI's implicit ARM/stable selection and its
  v1 cross-architecture receipt-reuse gap; prove explicit Intel/dogfood
  propagation, source/payload/hardware-bound v2 receipts and fail-closed
  rejection without real credentials or Login Item changes.
  All four focused tests pass, including every missing lifecycle check and
  expected identity, old receipt refusal and cross-target reuse rejection.
- [x] Clarify the current RC2 allocation, Intel first-stable bootstrap and the
  strictly 0.1.17-only manual-matrix deferral in maintained guidance.
- [x] Complete Worker checks and local deployment dry runs, then rerun affected
  native tooling, documentation and R7 freshness gates. Preserve existing
  receipt bytes if the R7 workload closure is unchanged.
- [x] Freeze reviewed local source and record exact final results and remaining
  protected inputs. Do not describe unsigned development apps as signed RC2.

## Final local evidence

| Check on the frozen source | Result |
| --- | --- |
| Focused Login Item regression tests | 4/4 pass, no skips; includes cross-target receipt refusal and every required field/check |
| Complete retained macOS suite | 110/110 pass, no skips; 246.6 seconds |
| Complete Worker qualification | Exit 0; workspace guards/types/TypeScript, 179 script tests and 533 application tests across 43 files pass |
| Default and staging deployment dry runs | Exit 0; staging remains `safe_unprovisioned`, with no configured resource identifiers or collection authorization |
| Explicit production deployment dry run | Exit 0; no deployment or remote migration |
| Architecture | 385 production files, 1,561 imports, zero approved debt edges |
| Documentation preflight | 20/20 pass, no skips; release-note validation passes |
| R7 freshness and exact decision reconstruction | 2/2 pass on Node 24.14.0 and 2/2 on Node 26.2.0, no skips; all ten receipts byte-identical to `ef2d26ac` |
| Independent implementation/documentation reviews | No remaining actionable findings; human-observation and final-DMG limitations explicit |

The source closure for R7 remains 362 files with SHA-256
`76ee96306c297f7e77279e7dc382411c801f6a020a0c26e61864f698d3e782af`.
The changes affect release qualification tooling/tests and documentation, not
the app/accounting workload. The earlier 3,815-pass full root run remains bound
to its earlier source/evidence snapshot; this turn reran the complete affected
native and Worker gates, not the entire root suite. No new signed artifact is
inferred from either test set.

An initial sandboxed Worker invocation stopped during dependency preparation
because registry access was blocked. The exact frozen-lockfile dependencies
were restored (no version/lockfile change). The first full Worker attempt then
passed its tests but correctly refused asset staging because concurrent local
qualification edits made the tree dirty. The complete clean-tree rerun and
explicit production dry run both passed; no clean-tree guard was bypassed.
Nonfatal missing-local-envelope-secret/sourcemap warnings and intentionally
unprovisioned staging are not represented as live-environment qualification.

Logs are retained only in ignored `.release-build/prepublish-*` files. A
read-only remote-ref check found no release branch, stable 0.1.18 tag or RC2
source tag matching this candidate; no exact-head hosted CI claim is made.

## Protected continuation and evidence gates

The canonical [macOS runbook](../runbooks/macos-stable-release-runbook.md)
requires explicit operation/target authority. `--prepare-candidate` continues
into Developer ID signing and Apple submission; it is not a dry run. Obtain
explicit permission for combined ARM/Intel RC2 `1025.1`, its new local annotated
source tag, signing and notarization before that credentialed operation. Use
fresh distinct outputs; preserve Intel RC1 `1025`, source `18c7065b`, its DMG,
receipt, checksum, tester README and verified Node runtime.

| Boundary | Required proof before the corresponding claim |
| --- | --- |
| Signed RC2 | One clean annotated dogfood source tag; independent ARM/Intel Developer ID, notarization, staple, Gatekeeper, exact-byte and replacement receipts |
| Installed ARM | Exact signed same-identity upgrade with preserved state; prompt-free launch/refresh/restart and manual clean-profile/Login Item and failure-path matrix |
| Physical Intel | Physical macOS 14+ clean install, discovery/offline accounting, lifecycle, silent Keychain and installed Intel A-to-B update; actual upload requires the tester's own consent |
| Stable artifacts | New common exact annotated `v0.1.18` source, reviewed release text, build `1026`, ARM previous-stable continuity and explicit Intel first-stable bootstrap; repeat final-byte native gates |
| Hosted model dashboard | Read-only migration/schema confirmation for existing 0041 through applicable current 0044, separately authorized pending migrations/deployment, scheduled warming and authenticated rendered model evidence; health alone is insufficient |
| Public release preparation | Authorized branch/tag push and exact-head CI/merge; native/checksum manifest with truthful null attestation fields, frozen signed appcasts, exact asset set and freshly verified draft downloads |

The model expansion introduces no additional D1 migration beyond the existing
schema through 0044. Its model history depends on 0041; missing migration can
degrade to empty/stale history. The Intel authenticated appcast guard must be
deployed before an Intel feed is published. Optional v1.1 consent activation,
public Intel support and Intel Homebrew remain separate decisions/evidence.

The 0.1.17 clean-profile/Login Item deferral does not carry forward. If physical
Intel evidence remains unavailable, do not silently broaden supported platforms
or treat Rosetta as a substitute. Resolve the intended public architecture scope
with the owner before publication.
