---
title: Incremental graph publication
date: 2026-09-07
type: plan
status: ready-for-deployment-review
---

## Scope and decision

Preserve the published public and admin allowance graphs during ordinary new
contributions, without adding a "last good" label. Keep their actual evidence
dates; do not invent newer observations. Work starts from the combined website
and scheduler source `dedc21af379116c9374f9204e64d1e2f102561d1`.

This is hosted-only work. Desktop installers, Homebrew, consent, retention and
successor activation are unchanged. Production migration and deployment remain
separate protected operations; local validation is not live evidence.

## Implementation and acceptance

1. Preserve one validated, atomically published graph snapshot across genuine
   append-only inputs. Withdrawals, corrections, erasure, policy/method changes
   and unknown mutation paths continue to invalidate it immediately.
2. Serve aggregate, plan and model graphs from that same snapshot, independent
   of pending daily calculations. Replace it only when the complete replacement
   passes the current source-epoch fence. Missing or corrupt data remains
   unavailable, never zero.
3. Probe existing per-account revision/window/method caches before loading
   source vectors. Recalculate changed accounts only; preserve strict cached
   output validation and atomic source-fenced publication. Recombining medians
   still requires the compact cohort results, not rescanning raw telemetry.
4. Refresh the open public page automatically with bounded, non-overlapping
   requests. Ordinary refresh failures must not erase a visible graph; an
   authoritative invalidation must not leave withdrawn data visible.
5. Rehearse forward migration, hard/soft invalidation, race/rollback, cache
   corruption, unchanged-account query cost and API contract regressions. Run
   the Worker and web gates and inspect the rendered refresh flow.

## Local evidence

- Full Worker runtime suite: 839 tests across 63 files passed, including 32
  real-D1 preservation/publication regressions. Exact source-epoch races,
  rollback, withdrawal/correction, incompatible schema, incomplete model days
  and atomic replacement are covered.
- Worker package/endpoints/generated-type/TypeScript/generated-asset guards and
  all 207 script tests passed. The composite check reached its clean-commit
  requirement before deployment dry-run; those remaining dry-run steps follow
  the local commit, with no re-running of unchanged runtime tests required.
- Migration guard suites: 144 tests passed, including real Wrangler application
  and repeat application against disposable local databases. No telemetry
  rewrite or production write was performed. Migration 0049 SHA-256 is
  `2de001ced4ee2a9f8fe4f8d0789ac0362699ca8c7e4942bc06f3d78645164ec8`.
- Five unchanged accounts take six database queries (one census plus one
  validated cache probe per account), with no raw-history reads. A one-account
  mutation recalculates only that account and preserves the other four caches.
  A changed account still uses its bounded analysis window; window/method
  changes require revalidation. Final cohort medians are not additive totals.
- UI gate: 562 tests passed. Public-site gate: 36 tests passed. The root suite
  passed 3,917 of 3,941 tests with 21 skips and three failures. The new refresh
  module was then added to the explicit client export allowlist and all three
  exporter tests passed. The two remaining retained-R7 receipt failures were
  reproduced on clean starting source `dedc21af`; the protected desktop source
  closure and receipts are unchanged by this hosted repair.
- Browser checks: local generated site using live public data renders aggregate,
  plan and model views, full history, expanded chart and keyboard inspection.
  Desktop and a 391-CSS-pixel mobile layout have no horizontal overflow or
  application console errors. Separate disposable synthetic v1.1 fixtures prove
  combined values are independent of the immutable activity rows; temporary
  request failure preserves graph, selected legend, focus and open daily table.
  Automatic retry then displayed the updated publication without reloading or
  losing that state. An authoritative invalidation removed the allowance graph
  while daily activity and its open table remained visible. The temporary
  browser tab and previews were closed after QA.

## Remaining gates

- Clean-commit deployment dry runs (remaining composite-gate steps).
- Concrete production migration/deployment review and owner authorization.
- Post-deployment API and rendered public/admin graph verification.
