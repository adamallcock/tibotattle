---
title: End-to-End Release Readiness Plan
date: 2026-07-29
type: plan
status: ready-for-human-gates
---

# End-to-End Release Readiness Plan

## Goal

Deliver a privacy-first Usage Monitor pilot that a new user can discover,
install, understand, run, revisit, and optionally contribute to without
Terminal, developer documentation, manual export selection, or access to raw
content. Complete every safe in-repository and disposable-environment action,
then stop only at a precisely identified human authorization or external
account gate.

The pre-implementation first-run baseline is
[`docs/audits/2026-07-28-new-user-first-run-journey-audit.md`](../audits/2026-07-28-new-user-first-run-journey-audit.md).
It is explicitly superseded by this plan and the
[pilot readiness report](../reports/2026-07-29-end-to-end-pilot-readiness-report.md).

## Non-negotiable boundaries

- Raw prompts, responses, paths, repositories, commands, credentials, emails,
  and direct account identifiers remain local and never enter browser or hosted
  contribution contracts.
- A public website does not claim it can read `~/.codex`; the signed local app
  owns detection, scanning, projection, pricing, and exact pre-upload review.
- Community collection remains disabled by default.
- No paid cloud resource, public deployment, real-user collection, Apple
  notarization submission, or publication occurs without the corresponding
  human authority.
- Existing dirty-worktree changes are preserved and validated rather than
  overwritten or silently discarded.

## Acceptance journey

1. A public-site build presents a consumer installation/open-app path.
2. A release build produces a reproducible macOS app payload and a
   deterministic-layout, artifact-bound DMG with a recorded per-build digest.
3. Production builds fail closed without HTTPS service configuration,
   Developer ID signing inputs, hardened runtime, and notarization inputs.
4. The app starts its loopback companion, explains the privacy boundary, and
   provides Retry and diagnostics on failure.
5. The dashboard distinguishes Codex absent, no tasks, unreadable history,
   custom location, writable state, and ready-to-analyze states.
6. The user obtains a recent useful result before deep 31-day accounting
   completes.
7. Deep work has bounded progress, cancellation, resume, crash-safe cache
   publication, and actionable failure states.
8. The first dashboard is results-first; methodology, metadata diagnostics,
   contribution, and operator readiness are progressively disclosed.
9. The optional contribution journey is linear:
   invite → consent → enroll → pair app → prepare → exact review → send →
   receipt → private result. The ordinary product neither displays nor stores
   the legacy server recovery code.
10. Prepared contribution volume cannot consume an accidental lifetime quota
    or fail only after expensive work.
11. A disposable backend completes encrypted ingest, deduplication, private
    results, recovery, export, deletion, retention, restart, and restore replay.
12. Return use loads cached results immediately and performs a bounded
    incremental refresh.
13. Updating, diagnostics, local erase, Keychain reset, hosted deletion, and
    uninstall are documented and testable.
14. A final report contains exact commands, receipts, timings, unresolved
    risks, and human-only gates.

## Parallel implementation tracks

### Track A: consumer web journey

- No-companion Install/Open App experience.
- Actionable Codex and local-state preflight.
- Consistent Analyze/Refresh/Continue terminology.
- Results-first progressive disclosure.
- Linear contribution UI and visible expiry/timing guidance.

### Track B: fast and resilient local analysis

- Separate quick recent projection from deep accounting.
- Publish valid intermediate cache state without pretending deep calibration
  is complete.
- Support cancel, resume, and timeout recovery.
- Reuse safe unchanged caches and avoid rescanning raw history unnecessarily.
- Validate no-Codex, empty, small, large, stale, interrupted, and restart
  paths.

### Track C: macOS release foundation

- Stable bundle metadata, icon wiring, and safe app-open URL.
- Developer ID/hardened runtime/notarization hooks.
- Deterministic logical DMG layout, per-build artifact digest, and clean-Mac
  validation. Byte-for-byte DMG identity is not promised because Apple disk-
  image tooling creates fresh filesystem/image metadata.
- First-run, Retry, diagnostics, update strategy, erase, and uninstall.

### Track D: hosted pilot

- Resolve contribution-volume contract.
- Remove circular enrollment and pairing dependencies.
- Preserve fail-closed collection controls.
- Complete staging, operations, recovery, and lifecycle evidence.
- Verify the entire HTTP lifecycle in disposable state.

Local/disposable contracts are complete. Actual staging is safely
unprovisioned and collection remains unauthorized. The read-only live probe is
blocked by `STAGING_RESOURCE_IDENTIFIERS_NOT_CONFIGURED` and `R2_NOT_ENABLED`;
no remote mutation or deployment has occurred.

### Track E: integrated verification

- Focused tests per track.
- Full UI, local, Worker, Cloud Run, and macOS suites.
- Browser verification of clean/no-Codex, real-local, contribution, recovery,
  deletion, and return flows.
- Resource, performance, crash, restart, and privacy-canary checks.
- Packaged-app smoke with isolated home and state.

## Human gates

These are not grounds to stop until all preceding local work and runbooks are
complete:

- Apple Developer Team membership and a valid Developer ID Application
  identity.
- App-specific notarization credentials or an approved Keychain profile.
- Approval to submit to Apple notarization.
- Cloudflare R2 enablement, real D1/R2 resource creation, domain/DNS control,
  production secrets, and approval to deploy.
- Approval of consent/privacy text, invitation policy, jurisdictions, and real
  user collection.
- Authorization to publish a GitHub release or public website.
- Any paid account or billing acceptance.
- Approval of backup and deletion-tombstone horizons, stopped-service restore
  rehearsal, R2 reconciliation/deletion retry, operational alerts, spend
  limits, invitation/support ownership, and recovery/re-pairing support copy.
- A second bounded Apple-silicon machine-class R7 measurement plus approval of
  the engineering rounding/ceiling-selection policy. Current retained R7
  decisions deliberately remain `release_open`.

## Completion evidence

The final report must distinguish:

- implemented and freshly tested;
- implemented but requiring external credentials;
- deliberately disabled;
- known limitation;
- human decision required; and
- unsupported future expansion.

Passing a containment test is not evidence that an accepting hosted service is
online, and passing source tests is not evidence that a downloaded app survives
Gatekeeper on a clean Mac.

## Completion status

| Acceptance item | State | Evidence or remaining gate |
| --- | --- | --- |
| 1. Public acquisition build | Implemented and tested | Artifact-bound site build, six contract tests, a rendered baseline, and the source-qualified/rebuilt final recovery delta in the [browser QA receipt](../qa/2026-07-29-current-source-browser-qa-receipt.md); publication remains human-controlled |
| 2. App and DMG | Development artifact implemented and tested; production human-gated | Reproducible app payload, deterministic-layout DMG, recorded digest, and development clean-install validation passed; Developer ID signing, notarization, approved artwork, publication, and clean-Mac release rehearsal remain human gates |
| 3. Production build fail-closed gates | Implemented and tested | Eleven macOS contracts; real Developer ID, notarization, origin, and artwork remain human inputs |
| 4. Native disclosure and companion | Implemented and tested | Compiled first-run, owner-only persistence, Retry, and watchdog smokes |
| 5. Local readiness states | Implemented, tested, and rendered | Missing, empty, unreadable, custom-location, writable-state, and ready contracts plus source-bound absent/empty-Codex browser evidence |
| 6. Early useful result | Implemented, observed, and receipted | The rendered-baseline disposable run exposed a useful result within a 25-second observed upper bound; a cached continuation recorded a 2.180-second quick result and 110.099-second complete pass; the final delta does not touch analysis |
| 7. Bounded deep analysis | Implemented and tested | Cancellation, resume, cache, crash, timeout, and source-consistency checks |
| 8. Results-first dashboard | Implemented and rendered | 57 UI contracts plus source-bound overview, timeline, and weekly browser QA; the final narrow delta affects only stale-device recovery |
| 9. Optional contribution journey | Implemented and rendered in loopback development | Fresh invite, consent, recovery rotation, upload-only pairing, one-hour preparation, exact review, Send, receipt, and private result passed; the rendered lifecycle used an isolated in-memory credential backend, while the final packaged source separately detects a stale Keychain/binding conflict, exposes one content-free recovery state, routes to the native two-confirmation reset with zero automatic mutation, and has an exact-function native WebKit visual receipt; the current DMG has no central service and remote staging is unprovisioned |
| 10. Contribution admission | Implemented and tested | Participant allowance/preflight and dense-week fail-closed contracts |
| 11. Disposable backend lifecycle | Implemented, rendered, and receipted | Worker/D1/R2 ingest, private result, export, recovery, single-batch deletion, participant deletion, scheduled maintenance, restart, and reconciliation receipts |
| 12. Return use | Implemented and rendered | Immediate cache plus bounded incremental refresh in local-only browser QA |
| 13. Update, erase, reset, deletion, uninstall | Implemented as contracts and help | The stale-device retry loop is closed and both pairing paths route to the existing targeted native reset; actual signed/notarized clean-Mac reset, replacement, deletion, and uninstall execution remain a human rehearsal |
| 14. Final evidence | Complete to human boundary | The [source qualification receipt](../qa/2026-07-29-current-source-qualification-receipt.md), browser receipt, exact artifacts, dual-runtime totals, staging blockers, unsupported scope, and human-only gates are consolidated in the [readiness report](../reports/2026-07-29-end-to-end-pilot-readiness-report.md) |

The complete Node 24/26 qualification, integrated product gate, retained R7
regeneration, current DMG/site build, rendered first-run and disposable
lifecycle receipt, and live read-only staging probe are recorded in the
readiness report and
[source qualification receipt](../qa/2026-07-29-current-source-qualification-receipt.md).
The repository is ready for the listed human permissions and physical release
actions; it is not ready for public distribution or participant collection.
