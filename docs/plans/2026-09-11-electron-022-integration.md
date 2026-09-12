---
title: Electron 0.1.22 contribution and feature integration
date: 2026-09-11
type: plan
status: in-progress
---

# Electron 0.1.22 integration

Build from released v0.1.21 (a651ea13), preserving its native replacement,
Sparkle trust, Electron updater, signing and four-platform distribution paths.
The owner requested the next app to include these changes together. Existing
push, signing, notarization and release authorizations remain applicable.

## Included work

- Repair accountless preparation above one million quota observations with
  bounded streaming. Preserve every exported record, attribution ambiguity,
  local opt-out, the existing installation credential and server replay guards.
- Integrate Projects from codex/project-usage-app-integration through e61cbe5d,
  including shared accounting, local name search and simplified notes.
- Integrate model performance from codex/local-inference-timing through
  7554aaac, including its uncommitted legend cleanup. Preserve the source copy.
- Integrate the focused progress-counter patch supplied by the separate task;
  preserve the newer released toolbar actions and refresh behavior.
- Correct the completed-scan status and cache-drop thread-title regressions
  reported during installed-app testing. Preserve generation and ambiguity checks.
- Preserve scoped results when revisiting Model performance and Projects &
  threads, while their background refresh and existing invalidation rules run.

## Delivery sequence

- [x] Diagnose installed 0.1.21: active accountless authorization but no accepted
  batches; reader fails before upload at its fixed quota acquisition limit.
- [x] Implement and independently review the streaming reader; synthetic input
  above one million rows and eager-policy parity checks pass. A read-only
  installed-profile check enumerates retained days and prepares the first day.
- [x] Integrate all ten Projects commits without reverting 0.1.21 app code.
- [x] Integrate performance and legend cleanup, then the progress-counter patch
  and the owner's allowance-history heading wrap.
- [x] Resolve combined export closure, generated compatibility and fallback-icon
  contracts; run the owning local/UI/shared-accounting and architecture gates.
- [x] Inspect the combined rendered app and basic interactivity on each new page:
  isolated real-history preview, project expansion/live search/thread view,
  model/period changes, keyboard model navigation, hover, disclosures and narrow
  layouts. No page errors; toolbar geometry is stable across ten states.
- [ ] Freeze one source and allocate the next Mac bundle/build identifiers;
  package/sign all four targets through the maintained release tooling.
- [ ] Qualify the signed app's actual accountless upload and retained identity;
  test opt-out with a disposable profile, preserving the owner's sharing choice.
- [ ] Publish through the established GitHub, native/Electron feed, Homebrew
  and website sequence; verify exact assets and installed update behavior.

The hosted public-source policy is separately deployed at 03d4217f with 0060
applied. Its scheduled public rebuild has completed and the recent daily API
returns ready results. This does not prove that the new app is released or that
the private canary has completed a public analytical domain.
Do not repeat the completed 0057-0059 migration. Do not put real profile records,
credentials, account identifiers or private source paths into test fixtures.

## Current qualification

Combined UI: 707 passed; companion: 351 passed; telemetry: 13 passed; reader: 16
passed. The later explicit platform-availability change passed 31 owning tests.
Electron source: 614 passed, including a normal-host rerun of the sandbox-denied
synthetic child. Broader source validation exposed pre-existing fixture and
closure mismatches. Original failures are preserved; their owning reruns pass.
The four accounting corpus failures also reproduce on released 0.1.21; all 19
corrected corpus tests pass without changing product code or resource limits.
The retained R7 receipts were regenerated for the integrated baseline: both
runtime decisions report `release_open`, and both retained-evidence tests pass.
Early synthetic release admission passed 168 tests on the exact current inputs;
the changed profile is not marked reusable.
These results cover the integrated baseline before the subsequently identified
upload-resume correction. Any further workload change requires fresh matching
qualification; do not relabel the baseline receipts.

The private arm64 candidate at 46ad70cf passed signing, notarization, Gatekeeper,
both enclosed-app checks and final updater-metadata binding. Ordinary replacement
preserved the stopped profile, predecessor app, installation binding and salt.
The signed app automatically sent accepted usage and quota records using its
existing credential. Projects, live search, thread expansion, performance model
and period controls were also checked in that installed app. A completed public
domain and the final corrected candidate remain separate pending checks.
An ordinary quit/relaunch preserved the binding, salt, credential generation and
sharing choice; a later server observation showed further accepted records.

The live exercise prompted a further liveness review: unchanged nonempty account
markers force saved prefix validation to restart every pass. If that prefix
exceeds the pass budget, the remaining backlog cannot complete. The reviewed
correction is integrated at c2624822: exact pinned projection evidence preserves
unchanged progress and retains marker/root/source-change invalidation. All 76
focused tests and 351 local application tests pass; the independent review is
clear. An independent slow-network, multi-pass day test confirmed that already
stored chunks are skipped without duplicate uploads. Final R7 regeneration and
signed qualification must use the corrected source.

The corrected private candidate c892542f was signed, notarized and ordinarily
installed with another verified stopped-profile backup. Its next automatic
passes preserved the existing credential and sharing choice and added 24,474
accepted quota records and 11,637 accepted usage records. This remains a
historical backfill in progress; a current public domain is not yet active.

Installed testing also exposed two presentation/provenance errors: a completed
source scan was described as unstarted when the separate accounting summary was
unavailable, and cache-drop titles were incorrectly gated on that summary's
generation. The fixes keep validated unified totals visible, distinguish summary
availability from ingestion, and bind local title lookup to the exact diagnostic
generation and fingerprint. A further review caught inherited stale mappings;
changed diagnostic proof or a newly ambiguous result now withdraws those links.
The combined source review found no other actionable regression. Focused
integration tests passed 127 cases before the additional 17-case stale-link fix.

The second R7 run was interrupted deliberately before completion when these
additional source fixes became necessary. Its supported recovery completed and
the earlier successful baseline receipts remain intact. The incomplete run is
not release evidence; final qualification must cover all these corrections.

The summary miss was traced further to a current-writer compatibility gap:
the accounting reader rejected the exact cache-write-zero provenance variants
already emitted by parser v16. The narrow fix at 4269072c admits those current
stamps without rewriting records or dropping their provenance. Unsupported mixed
parsers remain blocked, including in quarantined generations. The production
writer, ordinary accounting subprocess and persisted summary readback passed
together; all 136 owning tests and 351 local tests passed. A copied real-history
rebuild remains a separate acceptance check.

The two page controllers now retain only matching results during revalidation.
Projects respects the existing snapshot lease and disables old drilldown actions
while a replacement builds. Model performance retains at most three period
results in memory. Authoritative unavailable results, changed query scope,
cancellation and late replies are still fenced. All 46 focused tests passed.
An independent source review and repeat of those 46 tests found no actionable
regression. The combined browser suite passes 722 tests; documentation and all
20 preflight checks also pass before final source freeze.

To avoid a serial packaging wait, freeze the final application source once,
then build all four targets and regenerate R7 concurrently in separate checkouts.
R7 receipts are outside the packaged runtime and their own workload closure.
Keep the application/tag commit fixed. Commit new receipts separately, validate
them with the frozen application's canonical validator, compare every workload
path and digest, and run the unchanged retained-evidence tests in that evidence
checkout. The older checked-in receipts at the frozen app commit are not claimed
as qualification for the new source. Publication requires the new matching
receipts and all other applicable artifact and installed checks.

Later reviewed PR119 publication tools and their matching schema are reconciled
in a separate tooling checkout. The app candidate, publication runner and current
hosted-policy source are pinned independently through the maintained contracts.
Never package or deploy the tooling checkout as the application or website.

The timing sidecar's existing protected-storage contract supports macOS/Linux.
Windows immediately reports timing unavailable without starting its worker;
all three locales state this limitation. Do not replace its owner checks with a
platform conditional or broaden native security APIs as a quick release fix.

Version 0.1.22, Mac bundle 1029 and artifact provenance build 2026091108 are
allocated locally. The signed private candidate is intermediate and unpublished;
final artifacts must bind the corrected, qualified application source.
