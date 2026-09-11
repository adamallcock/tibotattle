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
applied. Its derived public rebuild has begun; this does not prove the new app
is released or that an accountless installation has yet published measurements.
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
The remaining retained R7 receipts require current-workload regeneration.
Early synthetic release admission passed 168 tests on the exact current inputs;
the changed profile is not marked reusable.
These results do not yet qualify new signed artifacts or actual hosted uploads.

The timing sidecar's existing protected-storage contract supports macOS/Linux.
Windows immediately reports timing unavailable without starting its worker;
all three locales state this limitation. Do not replace its owner checks with a
platform conditional or broaden native security APIs as a quick release fix.

Version 0.1.22, Mac bundle 1029 and artifact provenance build 2026091108 are
allocated locally. No signed candidate has yet been produced.
