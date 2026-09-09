---
title: Incremental graph publication
date: 2026-09-07
type: receipt
status: deployed-verified
---

## Deployed result and scope

Production source `7f541517a79b2746596d4a2e70754eec8716aa8f` deployed at
20:26 UTC on 2026-09-07 as Worker version
`08e5dabe-e7e6-4125-86d9-acdee50fec50`. The exact live source, public
aggregate/plan/model contract and rendered public/admin graphs were verified
afterward. The maintained entrypoint is [current status](../current-status.md).

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
  requirement before deployment dry-run. After committing, the remaining
  development/staging dry-run steps and an additional production-configuration
  dry run passed on `01611a76`. Runtime source was unchanged between these steps.
- Deployment and future web-only asset inventories now explicitly include the
  new refresh module and its regression test; all nine focused inventory tests
  passed. The generated 23-file site preserves both published 0.1.18 installer
  checksums and the existing 1200-by-630 social preview, using verified existing
  artifacts rather than rebuilding desktop apps. Final site, export and
  documentation gates passed after the inventory correction.
- Migration guard suites: 144 tests passed, including real Wrangler application
  and repeat application against disposable local databases. No telemetry
  rewrite or production write was performed during those rehearsals. Migration 0049 SHA-256 is
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

## Production migration and deployment

The owner explicitly approved migration 0049 and this website/backend repair.
Read-only inspection confirmed healthy source `14af4ed1`, exactly one pending
primary migration, and no pending deletion-ledger migration. Current Time Travel
bookmarks were obtained for both databases before the write. No restore, export
of private telemetry, manual maintenance, test upload or policy mutation ran.

Wrangler applied only `0049_preserve_published_graph.sql`: nine statements,
16.72ms reported database execution. At 20:24:52 UTC the full independent stored
schema probe passed (`attribution_objects=1`, `attribution_columns=1`), and both
migration ledgers had no pending entries. The read-back wrote zero rows.
The normal immutable-source production wrapper returned `PRODUCTION_DEPLOYED`,
`no_unapplied_migrations`, healthy pre/post checks and `public-only` routing.
No emergency health exception, raw deployment or migration-gate bypass was used.

The shared snapshot survived migration/deployment with its original
20:17:35 UTC generation, source epoch 2692 and 43,418-byte payload. The new
hard-invalidation epoch was 2692 and append marker -1, as expected before a new
append. Collection remained operational at revision 1; v1.1 remained staged.
Retention and deletion-safe restore checks stayed complete. The deployment
configuration and both published 0.1.18 desktop installers were unchanged.

Recovery remains forward-compatible: retain 0049 and both ledgers. An untouched
older checkout does not know the new migration and its guarded wrapper would
reject the newer ledger. A rollback repair must preserve the migration inventory
and schema guards; do not reverse the schema or restore D1 as a routine rollback.

## Live browser and public contract checks

The flow under test was the live public/admin page, switching graph views and
ranges, then inspecting a selected model without losing chart state. Browser
QA used the existing Chrome extension, without a fallback browser. The public
desktop viewport was 1800 by 984; mobile layout was qualified locally above.

| Check | Observed result |
|---|---|
| Page identity and nonblank rendering | Public TiboTattle and authenticated admin page loaded real graphs |
| Graph contract | v1.1 with validated combined summaries, 69 closed dates and all three views |
| Source and assets | Exact source; 11 live asset hashes matched, including `community-refresh.js` |
| Private boundary | Five private routes returned 404 on the public hostname |
| Controls | Aggregate, plan/model selection, All history, expanded chart, Astra legend and End-key inspection worked |
| Automatic refresh | Three natural HTTP 200 daily-API responses; expanded graph, selected Astra legend, inspected September 6 point and keyboard focus remained intact |
| Console and visual checks | No relevant public/admin warnings or errors; no framework overlay; rendered chart screenshot inspected |
| Existing distribution and metadata | Both 0.1.18 links and Intel Homebrew UI retained; canonical docs/privacy, crawler access and 1200x630 PNG social metadata verified |

At 20:31:31 UTC the public API remained ready with the preserved generation.
It returned 318 activity days, 69 aggregate points, 207 plan points and 26 model
points. All public allowance views end September 6; the owner preview also
includes September 7. This is the existing closed-day public boundary, not a
missing newest calculation. No new "last good" label was added.
The independent admin Growth & activity section also reported history available.
The public activity detail rendered 180.3B all tokens and USD 100,676.73 as the
explicitly partial priced portion across 279 of 318 days, not an actual bill.

Cloudflare/Wrangler guidance kept recovery, migration, guarded deployment and
live verification separate. Frontend-testing-debugging guidance required
rendered interactions and console/screenshot evidence, not just a passing build.
The temporary read-only asset check initially encountered the existing
`/privacy.html` canonical redirect; using the observed `/privacy` target passed
without weakening redirect or asset-integrity checks.

New contribution/correction races and refresh-failure recovery were exercised
with synthetic local tests, not injected into production. This receipt does not
claim a newly observed production append, complete historical model backfill,
or a production throughput benchmark.

A bounded natural cron observation filtered to the deployed Worker version
reported `scheduled_allowance_reconstruction: complete` at 14,779ms with 56
cumulative statements, followed by `scheduled_daily_publication: complete` at
21,603ms with 26 phase / 82 cumulative statements and 18,397ms remaining before
the optional admission deadline. It did not emit a preview-publication event.
The observer stopped its own tail after 60.4 seconds without initiating work.
Exact event UTC timestamps were not retained; these elapsed times describe one
observed pass, not guaranteed throughput or a comparison benchmark.
