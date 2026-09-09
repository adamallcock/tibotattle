---
title: Historical per-model allowance reconstruction
date: 2026-09-06
type: plan
status: deployed-awaiting-backfill-verification
---

# Scope and acceptance

Local implementation is complete at `e35008d5`. On 2026-09-06 the owner
authorized applying migration 0048 and deploying the updated Worker, followed
by live backfill verification. Migration and protected deployment succeeded at
source `0207a3c1` on 2026-09-07; historical checkpoint/publication verification
remains open. The [deployment receipt](../receipts/2026-09-07-model-allowance-history-deployment.md)
records exact production identity, preservation and observed behavior.

The owner requested historical per-model points alongside the existing plan
history. Work starts from the completed hosted repair at `e9c56452` in an
isolated branch. The authorization covers only this migration, its guarded
Worker deployment and verification. It does not change contribution consent,
enable v1.1, or touch desktop release artifacts.

Keep the existing model fitting and identification rules, Pro 20x normalization,
and unavailable values. Do not repeat today's vector across historical dates.
Each reconstructed point uses only observations before that day's exclusive UTC
end; current retained corrections and surviving contributors remain authoritative.
This is retrospective reconstruction, not a claim about what was published then.

The existing model analysis has a 100-day acquisition horizon. Preserve that
default while the owner considers an optional 30-day model window. A shorter
window is a separate analytical choice and must not be silently introduced.

# Implementation sequence

1. Add closed, source-bound historical time ranges to the paginated readers and
   acquired model finisher. Test future usage, quota, plan changes and model
   introductions cannot affect an earlier point.
2. Reuse the checkpoint implementation in a distinct fixed storage namespace;
   historical jobs must not supersede current-analysis checkpoints. Preserve
   bounded pages, content hashes, correction fences, leases and deletion safety.
3. Add a bounded, resumable history queue and per-account results. Publish a day
   only after its complete eligible cohort has resolved; no partial medians.
   Leave unsupported, thin, unstable and incomplete history explicitly absent.
4. Read reconstructed points through the existing bounded admin preview. Mark
   the historical basis honestly and preserve forward-recorded snapshots where
   their basis differs. Integrate low-priority work with the existing invocation
   meter without changing required maintenance or current-calculation budgets.
5. Run focused real-D1 and mathematical regressions first, then Worker/UI,
   package-copy, type, architecture and documentation checks. Render the chart
   with clearly synthetic multi-day evidence. Review any new migration before
   requesting separate production authorization.

# Validation boundaries

- Exact 100-day lookback and UTC cutoff; include no future evidence or invented
  pre-launch Astra points. Preserve source selection and plan ambiguity rules.
- Repeated, interrupted, budget-exhausted and concurrently superseded work is
  replay-safe. Current jobs and model-history jobs cannot address each other's
  state. Failed source/lease fences publish nothing.
- Participant withdrawal invalidates reconstructed cohorts and removes their
  private derived work. No source telemetry is deleted by backfill.
- A skipped or unidentifiable day stays a gap; a healthy series appears only
  after complete valid history is available. Local proof is not live recovery.

# Progress

- [x] Read the completed repair and original model-history implementation.
- [x] Create an isolated branch and verify dependency copies against its source.
- [x] Implement date-bounded input and isolated reconstruction.
- [x] Validate preservation, numerical semantics, bounded resources and UI.
- [x] Present qualified source and the separate production gate.
- [x] Apply owner-approved migration 0048 and deploy through the protected lane.
- [x] Verify exact live source, preservation, controls and rendered model UI.
- [ ] Verify natural historical checkpoint and day-publication progress.

# Local evidence, 2026-09-06

- Worker runtime: 61 test files, 790 passing tests. This includes the new
  acquisition, historical scheduling, source-race, lease, privacy and gap cases,
  plus the existing current-calculation regressions. TypeScript and generated
  Worker-binding checks pass.
- Worker scripts: 202 passing checks, including the real local migration
  rehearsal. After removing one trailing blank line, the final migration
  readiness suite passes all 35 checks. Migration 0048 SHA-256 is
  `5b772c33723e2dd2d9f992738c731efea12831ba774806859ce6d16d481ceb29`.
- Repository preflight and documentation governance pass; the focused admin
  chart suite passes 13 checks.
- Synthetic browser preview: desktop at 1280 pixels and mobile at 390 pixels.
  Sol and Terra each have 29 points, split into 12- and 17-point segments around
  an unavailable date. Astra has only the final three points. Mobile document
  width equals its viewport. These are deliberately synthetic values, not live
  community evidence. The preview's unrelated metrics endpoint intentionally
  returns unavailable, and its favicon is absent; no chart script error occurred.
- Full-root regression: 3,886 pass, 2 fail, 21 skip (3,909 total). Its two
  retained desktop R7 receipt failures are confirmed pre-existing: the entire
  362-file workload hashes to
  `b91df4fcacffc39f5ec60d4e318bb98d55f35eecb3207beecdaf931d49911f06`
  both at base `e9c56452` and in this candidate, while the retained base receipt
  records `7b441df76b2f045c4bf22506dd990e9aa182414f00dba518c99cfe17f257cc54`.
  No R7 receipt or desktop workload is changed or requalified here.
- The initial dry-bundle step stopped at the clean, committed source guard.
  After recording `e35008d5`, default, staging and production dry bundles all
  pass (1,611.11 KiB, 335.81 KiB gzip). The 21 public assets were reused only
  after their manifest and unchanged 15-file source closure were verified.
  Their source-closure SHA-256 is
  `37758ac4d9006f09ce53b1f98037dcd02642fb6f99b89825070cb03906f82ddd`.
  This does not claim a new installer download/trust check or public deployment.
- Staging configuration is safely unprovisioned, with collection unauthorized;
  its successful static/dry checks are not a live staging qualification.
  No production migration, deployment, push or desktop release ran. The
  isolated browser and synthetic loopback preview were stopped after QA.

Cloudflare/Worker guidance shaped the shared query budget and isolated state;
the test-runner and browser-check guidance supplied the regression and rendered
verification boundaries. Neither local tests nor dry bundles certify production
corpus cost, progress or completion.

# Deployment boundary

Migration 0048 and the updated Worker must be applied/deployed together through
the normal guarded production lane under the separate owner authorization. Do not
rewrite a published tag, merge unrelated release work, change contribution
consent, enable v1.1, or regenerate desktop evidence for this change.

After deployment, inspect content-free `scheduled_model_history` progress and
verify newly stored retrospective days in the authenticated graph after its
normal preview-cache refresh. The existing reconstruction counters describe
current analyses and daily activity; they are not a model-history completion
meter. Backfill uses spare maintenance budget and makes no completion-time
promise. Unsupported source histories, unidentifiable models and insufficient
evidence remain gaps; a fully continuous curve is not guaranteed.
