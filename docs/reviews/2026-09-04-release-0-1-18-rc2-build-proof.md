---
title: Release 0.1.18 RC2 optimized local build proof
date: 2026-09-04
type: review
status: release-gated
---

# Release 0.1.18 RC2 optimized local build proof

Historical attempt on `e0f35518`; the later approved compatibility fix and its
qualification are tracked in the [paginated export review](./2026-09-04-paginated-export-qualification.md).
The observations below remain bound to this earlier source and artifacts.

## Verdict and source

Both optimized architecture builds and all twelve isolated native smoke checks
pass on combined source `e0f35518d8e85fa35d40af54871f3013b13673fe`.
**Fresh R7 qualification is blocked, so this is not a release-ready candidate.**
This checkpoint supersedes the build and R7 status in the earlier
[integrated validation](./2026-09-04-release-0-1-18-integrated-validation.md),
without rewriting its historical observations or its Astra pricing audit.

The owner approved combined dogfood allocation `1025.1` and a protected,
local-only complete R7 run. The allocation tests prove
`1025 < 1025.1 < 1026`; stable remains `1026`. The earlier Intel-only signed
RC1, its source tag, DMG, checksum, receipt and tester README remain unchanged.
No new annotated source tag or signed RC2 artifact has been produced.

## Protected R7 attempt

The generator ran with the preregistered interval
`2026-06-24T09:00:00.000Z` through `2026-07-25T09:00:00.000Z`, exact
hash-verified Node 24.14.0 and 26.2.0 binaries, and owner-only receipt targets.
Repository workload inputs were frozen before measurement; no builds competed
with the attempted run. No frozen shared real-history plan was reached.

All six synthetic-semantics, synthetic-pressure and materialized-boundaries
profiles completed across both runtimes. At the shared real-history source-plan
stage, the generator exited **1** with the closed reason
`export_source_codex_rollout_checkpoint_history_unsupported`. The attempt ran
from 19:59:13 to approximately 20:05:42 UTC on 2026-09-04. It did not reach a
frozen shared plan, lifecycle measurements, decision reconstruction or the
successful ten-receipt installation summary.

A same-interval, read-only structural check found complete discovery with no
quarantined sources. All 1,469 accepted Codex sources explicitly declare
paginated history; all are plain, have valid start ordinal zero and no physical
history base. This is genuine format detection, not a Zstd, Astra pricing or
compaction-header error. No raw histories, paths or identifiers were retained.

The [source-plan guard](../../src/application/export-sources/codex-source-plan.js)
intentionally refuses this mode on both creation and resume. It predates this
release: resumable export checkpoints cannot represent exact physical-history
cutoffs, although the direct scanner and local index can. A paginated source
without a history base also needs the correct logical-parent/reset semantics;
simply removing the blanket refusal is not a safe fix.

After failure, **all ten retained receipts are byte-identical to Git**, and
no generation transaction controls remain. Both pinned-runtime freshness
checks still fail their same two tests on source provenance. No source was
removed, interval narrowed, result relabelled, guard bypassed or test weakened.
Inherited `release_open` export-ceiling decisions remain historical; this
source-plan refusal is a distinct blocker to refreshing their evidence.

Next decision: evaluate full ordinal-aware resumable checkpoints versus a
narrowly proved no-base/ordinal-zero reset subset. Either requires correct
logical-parent semantics, persisted-state compatibility, restart/resume and
replay/double-counting tests; full support additionally needs exact physical
cutoffs. Then rerun the entire protected workflow on the final source. Retrying
unchanged input cannot close this gate.

## Exact local artifacts

The builds use the builder's default **release compiler profile** (`-O` and
whole-module optimization), not `--test-build`. Build logs explicitly report
`Compiler profile: release`. They remain **development-channel, ad-hoc-signed**
apps with bundle version `2000.1.18`, updater disabled and central service
unconfigured. They do not qualify signed dogfood build `1025.1`.

Both are version `0.1.18`, minimum macOS `14.0`, with common runtime-source
digest `5a8566a280ab129f4fed7e23844e7ea36ea083e91137953e5f4bff92e0eeacc2`.
This digest covers the reviewed build-source inputs, not the whole Git tree,
compiler profile or architecture-specific Node binary. The build logs and
payload digests supply those separate evidence boundaries.

| Architecture | Normalized payload SHA-256 | Payload bytes |
| --- | --- | ---: |
| ARM64 | `c5208c59fe91f25b9f51297a6d796ec5ffd644dea6fefeff7218a822a09444d7` | 155,128,249 |
| Intel x64 | `43b63d3528c85a184894c1337113ed1fe26e128b132e407d84b48f94764df9b6` | 156,917,369 |

`inspectMacOSApp` verifies each complete payload, plist and architecture.
Independent `lipo` checks require exactly the launcher, bundled Node and
migration-helper Mach-O files, each containing only its intended slice.
Intel Node 26.2.0 was preserved and reverified against the official binary
digest `51ef33e35c9cd96192baba41dfb592a9568380a5b2190d64e63332c4bd807e0f`;
the builder also verifies its license bytes.

Six explicit smoke modes pass per architecture:

- disabled-updater contract;
- fake Login Item contract, with zero real service calls;
- in-memory Keychain launch/broker contracts, with zero Keychain access;
- migration-UI contract, with no automatic prompt or Keychain access;
- normal companion startup; and
- JIT-less companion startup.

Each smoke uses its own empty temporary profile and a minimal environment.
Startup verifies loopback readiness and an owner-only state directory; no
LaunchAgent or LaunchDaemon is created. The harness refuses any configured
central service before launching. No app was installed or normally launched
against the owner's profile. Intel execution is under Rosetta on Apple silicon,
not physical Intel qualification.

## Test run report

| Check | Result |
| --- | --- |
| RC2 ordering and metadata | 2 passed |
| macOS source lane | 123 passed, 3 expected artifact exclusions |
| Exact optimized artifacts and isolated smokes | Both inspected; 12/12 smoke modes passed |
| R7 generation | Six profiles completed; real-history source plan refused; exit 1 |
| Retained R7 freshness, each pinned runtime | 0 passed, 2 stale-provenance failures, no skips |
| Retained macOS suite | 108/108 passed, no skips or failures; 237.3 seconds |
| Full root suite | 3,791 total: 3,772 passed, 2 stale-R7 failures, 17 Windows-only skips; 476.7 seconds |
| Documentation and preflight | Governance and whitespace checks pass; 20/20 preflight tests pass |

No flaky failure has been observed. The R7 stop is a deterministic guarded
refusal of an unsupported export format; its downstream freshness failures are
genuine, not stale test expectations. The full root run exited 1 solely for
those two retained-evidence tests; no other failure or cancellation occurred.
Worker, web/admin rendering and Astra accounting results remain
the exact earlier observations in the integrated validation, not newly claimed
checks from this build-only follow-up.

Task-owned ignored evidence is under `.release-build/`: `rc2-r7-regeneration.log`,
`rc2-r7-validation-node24.log`, `rc2-r7-validation-node26.log`,
`rc2-build-arm64.log`, `rc2-build-x64.log`, `rc2-local-proof.json`,
`rc2-local-proof.log`, `rc2-local-proof.mjs`, `rc2-retained-macos.log`, and
`rc2-root-tests.log`. The apps are in separate
`rc2-proof-arm64` and `rc2-proof-x64` directories. These are local verification
outputs, not public downloads.

## Remaining gates

Resolve the resumable checkpoint decision and obtain fresh R7 evidence before
calling combined source release-qualified. Then freeze a clean common source
with a new annotated RC2 source tag and obtain explicit signing/notarization
authority. Signed ARM and Intel artifacts need their own receipts and approved
installation/update tests. No tester feedback or confirmed physical Intel
upload result exists in the supplied handoff.

No push, production signing, notarization, source-tag creation, real Keychain
mutation, system installation, hosted writes, updater/feed activation or
publication occurred in this build-proof follow-up.
